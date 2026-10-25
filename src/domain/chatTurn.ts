/**
 * 一轮对话的组装与调用（阶段二末的最后一段接线）。
 *
 * 职责只有两件：
 *   1. 把「角色卡 + lorebook + 最近轮 + 摘要 + FactView + 空洞回退」变成一条 prompt
 *   2. 调模型并**不吞掉**流式中断的 partial
 *
 * 业务规则一律不在这里：预算裁剪在 `assemble`，事实上限在 `factInjection`，
 * 摘要去重在 `summary`，turn 写入在 `turnStore`。
 *
 * ⚠️ 两个「看起来多余、实际不能省」的约定：
 *   - **核心资产按角色取，不按 `boundAssetIds` 过滤**：`createSession` 默认只绑定 greeting，
 *     若这里按绑定过滤，每个新会话都会丢掉 description/personality/scenario，
 *     人设静默消失且没有任何报错。
 *   - **摘要只覆盖「最近窗口之前」的轮次**：否则同一段内容既在摘要里又在原始轮里，
 *     模型会读到两遍、预算被重复扣。
 */
import type { NarraDB } from '../schema/db';
import type { CharacterAsset, ServiceRef } from '../schema/entities';
import type { ChatClient, ChatMessage } from './modelClient';
import { ChatError } from './modelClient';
import type { StreamingCapable } from './httpClient';
import { listTurns } from './turnStore';
import { isSummarizable, dedupeSummariesForInjection } from './summary';
import { selectFactsForInjection } from './factInjection';
import {
  assembleTurnPrompt,
  factBlocks,
  renderPrompt,
  selectHoleFallbackTurns,
  type AssembleBudgetResult,
} from './assemble';
import { estimateTokens, usableBudget } from './tokenEst';

/** 默认上下文上限（token）。会话级覆盖留给后续版本，当前写死并集中在此处 */
export const DEFAULT_CONTEXT_LIMIT = 8000;

/** 原始最近轮窗口（摘要之外的「逐字」部分） */
export const RECENT_WINDOW_TURNS = 20;

const CORE_ASSET_LABEL: Partial<Record<CharacterAsset['type'], string>> = {
  description: '【角色设定】',
  personality: '【性格】',
  scenario: '【场景】',
};

export interface BuildTurnPromptInput {
  db: NarraDB;
  sessionId: string;
  userInput: string;
  /**
   * 只用 `seq < cutoffSeq` 的历史（重新生成时排除该轮及其之后）。
   * 省略 = 用全部 active 轮。
   */
  cutoffSeq?: number;
  contextLimit?: number;
  recentWindow?: number;
}

export interface TurnPrompt {
  messages: ChatMessage[];
  injectedFactIds: string[];
  droppedFactIds: string[];
  usedTokens: number;
  exhausted: boolean;
  hint?: string;
  /** 调试用：实际拼出的 system 文本（与 `messages[0].content` 相同） */
  systemText: string;
}

/** lorebook 是否应注入：禁用的一律不进；constant 无条件进；有 keys 的按最近文本匹配 */
function lorebookEnabled(asset: CharacterAsset, scan: string): boolean {
  const m = asset.metadata;
  if (m.enabled === false) return false;
  if (m.constant) return true;
  const keys = [...(m.keys ?? []), ...(m.secondary_keys ?? [])].filter(
    (k): k is string => typeof k === 'string' && k.trim() !== '',
  );
  if (!keys.length) return true;
  const hay = scan.toLowerCase();
  return keys.some((k) => hay.includes(k.toLowerCase()));
}

function turnText(userContent: string, assistantContent: string): string {
  return `我：${userContent}\n${assistantContent}`;
}

export async function buildTurnPrompt(input: BuildTurnPromptInput): Promise<TurnPrompt> {
  const db = input.db;
  const session = await db.sessions.get(input.sessionId);
  if (!session) throw new Error(`Session 不存在：${input.sessionId}`);

  const contextLimit = input.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const windowSize = input.recentWindow ?? RECENT_WINDOW_TURNS;
  const cutoff = input.cutoffSeq ?? Number.POSITIVE_INFINITY;

  const character = await db.characters.get(session.characterId);
  const assets = character
    ? await db.assets.where('characterId').equals(character.id).toArray()
    : [];

  const coreAssets = assets
    .filter((a) => CORE_ASSET_LABEL[a.type] !== undefined && a.content.trim() !== '')
    .map((a) => ({ id: a.id, text: `${CORE_ASSET_LABEL[a.type]}\n${a.content.trim()}` }));

  const mesExample = assets.find((a) => a.type === 'mes_example' && a.content.trim() !== '');

  // 历史：只取 active、非 greeting、且早于 cutoff 的轮次
  const allTurns = (await listTurns(db, input.sessionId)).filter(
    (t) => t.status === 'active' && isSummarizable(t.seq) && t.seq < cutoff,
  );

  const recentRaw: Array<{ id: string; text: string; seq: number }> = [];
  for (const t of allTurns.slice(-windowSize)) {
    const rev = await db.revisions.get(t.activeRevisionId);
    if (!rev) continue;
    recentRaw.push({ id: t.id, text: turnText(rev.userContent, rev.assistantContent), seq: t.seq });
  }
  const recentIds = new Set(recentRaw.map((r) => r.id));

  // 摘要只覆盖最近窗口之前的轮次 —— 否则与逐字轮次重复注入
  const historyTurns = allTurns.filter((t) => !recentIds.has(t.id));
  const historySeqs = historyTurns.map((t) => t.seq);
  const seqOfTurn = new Map(allTurns.map((t) => [t.id, t.seq]));
  const summariesRaw = await db.summaries.where('sessionId').equals(input.sessionId).toArray();
  const dedupe = dedupeSummariesForInjection(summariesRaw, historySeqs, seqOfTurn);
  const summaries = dedupe.selected.map((s) => ({ id: s.id, text: s.content }));
  const covered = new Set(dedupe.coveredSeqs);

  const scanSource = [
    input.userInput,
    ...recentRaw.slice(-6).map((r) => r.text),
  ].join('\n');

  const lorebook = assets
    .filter((a) => a.type === 'lorebook_entry' && lorebookEnabled(a, scanSource))
    .map((a) => ({
      id: a.id,
      text: a.content,
      insertionOrder: Number(a.metadata.insertion_order ?? 100),
    }));

  const factsRaw = await db.facts.where('sessionId').equals(input.sessionId).toArray();
  const facts = selectFactsForInjection(factsRaw);

  const systemPrompt =
    `你在扮演「${character?.name ?? session.title}」。` +
    '用第一人称回复，只写角色自己的言行与台词；不要替用户说话，不要解释设定。';

  // 空洞 = 历史区间里既没被摘要覆盖、也不在逐字窗口内的轮次
  const holeTurns = historyTurns.filter((t) => !covered.has(t.seq));
  const holeRaw: Array<{ id: string; text: string }> = [];
  for (const t of holeTurns) {
    const rev = await db.revisions.get(t.activeRevisionId);
    if (!rev) continue;
    holeRaw.push({ id: t.id, text: turnText(rev.userContent, rev.assistantContent) });
  }

  // 先算「除空洞外」的占用，剩余预算才给空洞回退（K = min(20, 剩余)）
  const nonHoleTokens = estimateTokens(
    [
      systemPrompt,
      ...coreAssets.map((a) => a.text),
      ...lorebook.map((l) => l.text),
      ...recentRaw.map((r) => r.text),
      ...summaries.map((s) => s.text),
      ...factBlocks(facts).map((b) => b.text),
      mesExample?.content ?? '',
    ].join('\n\n'),
  );
  const remaining = Math.max(0, usableBudget(contextLimit) - nonHoleTokens);
  const hole = selectHoleFallbackTurns(holeRaw, (h) => estimateTokens(h.text), remaining);

  const assembled: AssembleBudgetResult = assembleTurnPrompt({
    systemPrompt,
    coreAssets,
    lorebook,
    recentTurns: recentRaw.map(({ id, text }) => ({ id, text })),
    summaries,
    facts,
    holeFallback: hole.selected,
    mesExample: mesExample ? `【对话示例】\n${mesExample.content.trim()}` : undefined,
    userInput: input.userInput,
    contextLimit,
  });

  const kept = assembled.kept;
  const systemText = renderPrompt(kept.filter((b) => b.id !== 'user_input'));

  return {
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: input.userInput },
    ],
    injectedFactIds: assembled.injectedFactIds,
    droppedFactIds: assembled.droppedFactIds,
    usedTokens: assembled.usedTokens,
    exhausted: assembled.exhausted,
    hint: assembled.hint,
    systemText,
  };
}

export interface GenerateReplyInput {
  db: NarraDB;
  client: ChatClient;
  sessionId: string;
  userInput: string;
  cutoffSeq?: number;
  contextLimit?: number;
  recentWindow?: number;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
}

export interface GenerateReplyResult {
  /** 完整回复；出错时为**已收到的 partial**（可能为空串），不丢用户输入的依据 */
  text: string;
  injectedFactIds: string[];
  prompt: TurnPrompt;
  error?: ChatError;
}

/**
 * 生成一轮回复。
 *
 * ⚠️ 失败**不抛异常，而是返回 `error` + partial**：
 *    调用方必须据此写入 `interrupted` revision（§4.2）—— 中断不能吃掉用户输入。
 *    抛异常会让「已收到的半截回复」无处安放。
 */
export async function generateAssistantReply(
  input: GenerateReplyInput,
): Promise<GenerateReplyResult> {
  const session = await input.db.sessions.get(input.sessionId);
  if (!session) throw new Error(`Session 不存在：${input.sessionId}`);
  const service: ServiceRef = session.modelBinding.main;

  const prompt = await buildTurnPrompt({
    db: input.db,
    sessionId: input.sessionId,
    userInput: input.userInput,
    cutoffSeq: input.cutoffSeq,
    contextLimit: input.contextLimit,
    recentWindow: input.recentWindow,
  });

  const streamer = (input.client as ChatClient & Partial<StreamingCapable>).completeStream;

  try {
    const text =
      input.onDelta && typeof streamer === 'function'
        ? await streamer.call(input.client, { service, messages: prompt.messages, signal: input.signal }, input.onDelta)
        : await input.client.complete({ service, messages: prompt.messages, signal: input.signal });
    return { text, injectedFactIds: prompt.injectedFactIds, prompt };
  } catch (err) {
    const partial = (err as { partial?: unknown }).partial;
    const chatErr =
      err instanceof ChatError
        ? err
        : new ChatError(err instanceof Error ? err.message : String(err), true);
    return {
      text: typeof partial === 'string' ? partial : '',
      injectedFactIds: prompt.injectedFactIds,
      prompt,
      error: chatErr,
    };
  }
}
