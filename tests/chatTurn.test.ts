import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openForTest, type NarraDB } from '../src/schema/db';
import { appendTurn, createSession, retry } from '../src/domain/turnStore';
import type { FactView, ServiceRef } from '../src/schema/entities';
import { ChatError, type ChatClient, type ChatRequest } from '../src/domain/modelClient';
import { buildTurnPrompt, generateAssistantReply } from '../src/domain/chatTurn';

const MAIN: ServiceRef = { id: 'svc-main', model: 'main-model' };

let db: NarraDB;
let sessionId: string;
let characterId: string;

async function seedCharacter(): Promise<void> {
  characterId = 'char-1';
  await db.characters.add({
    id: characterId,
    name: '阿澄',
    cardSource: { format: 'v2', raw: {} },
    createdAt: 1,
    updatedAt: 1,
  });
  await db.assets.add({
    id: 'asset-desc',
    characterId,
    type: 'description',
    content: '海边长大的少年。',
    metadata: {},
    createdAt: 1,
  });
  await db.assets.add({
    id: 'asset-lore-hit',
    characterId,
    type: 'lorebook_entry',
    content: '灯塔在雨夜会亮起。',
    metadata: { keys: ['灯塔'], insertion_order: 5 },
    createdAt: 1,
  });
  await db.assets.add({
    id: 'asset-lore-miss',
    characterId,
    type: 'lorebook_entry',
    content: '这条不该被注入。',
    metadata: { keys: ['沙漠'], insertion_order: 6 },
    createdAt: 1,
  });
}

async function seedSession(): Promise<void> {
  const s = await createSession(db, {
    characterId,
    title: '测试会话',
    modelBinding: { main: MAIN },
    greetingAssetId: 'asset-greet',
    greetingContent: '你好。',
  });
  sessionId = s.id;
}

function fact(id: string, over: Partial<FactView> = {}): FactView {
  return {
    id,
    sessionId,
    scope: 'character',
    characterId,
    key: `k-${id}`,
    value: `v-${id}`,
    confidence: 'confirmed',
    injectionState: 'active',
    origin: 'user_confirm',
    riskLevel: 'low',
    pinned: false,
    lastSeenTurn: 1,
    stale: false,
    sourceTurnIds: [],
    sourceRevisionIds: [],
    updatedAt: 1,
    ...over,
  };
}

beforeEach(async () => {
  db = await openForTest(`chat-${Math.random()}`);
  await seedCharacter();
  await seedSession();
});

describe('buildTurnPrompt：组装出可用的 messages', () => {
  it('最近轮进 system，cutoff 之后的历史不进', async () => {
    await appendTurn(db, sessionId, { userContent: '第一轮输入', assistantContent: '第一轮回复' });
    await appendTurn(db, sessionId, { userContent: '第二轮输入', assistantContent: '第二轮回复' });

    const all = await buildTurnPrompt({ db, sessionId, userInput: '新问题' });
    expect(all.systemText).toContain('第一轮输入');
    expect(all.systemText).toContain('第二轮回复');
    expect(all.systemText).toContain('海边长大的少年');
    expect(all.messages[0].role).toBe('system');
    expect(all.messages[1]).toEqual({ role: 'user', content: '新问题' });
    // 用户输入不能重复出现在 system 里
    expect(all.systemText).not.toContain('新问题');

    // 重新生成第一轮：第二轮（"未来"）必须被排除
    const cut = await buildTurnPrompt({ db, sessionId, userInput: '第一轮输入', cutoffSeq: 2 });
    expect(cut.systemText).toContain('第一轮输入');
    expect(cut.systemText).not.toContain('第二轮输入');
  });

  it('可注入事实进 prompt，且 id 回传给 UI', async () => {
    await db.facts.add(fact('f1'));
    const p = await buildTurnPrompt({ db, sessionId, userInput: '你好' });
    expect(p.injectedFactIds).toContain('f1');
    expect(p.systemText).toContain('v-f1');

    // stale / inactive 事实不注入
    await db.facts.add(fact('f2', { stale: true }));
    await db.facts.add(fact('f3', { injectionState: 'inactive', inactiveReason: 'disputed' }));
    const p2 = await buildTurnPrompt({ db, sessionId, userInput: '你好' });
    expect(p2.injectedFactIds).toEqual(['f1']);
  });

  it('lorebook 只注入 key 命中的条目', async () => {
    const hit = await buildTurnPrompt({ db, sessionId, userInput: '我们去看看灯塔' });
    expect(hit.systemText).toContain('灯塔在雨夜会亮起');
    expect(hit.systemText).not.toContain('这条不该被注入');

    const miss = await buildTurnPrompt({ db, sessionId, userInput: '今天吃什么' });
    expect(miss.systemText).not.toContain('这条不该被注入');
  });

  it('stub 摘要不注入，其区间转空洞回退', async () => {
    await appendTurn(db, sessionId, { userContent: '旧输入', assistantContent: '旧回复' });
    await db.summaries.add({
      id: 'sum-stub',
      sessionId,
      coversTurnIds: [(await db.turns.where('sessionId').equals(sessionId).toArray())[1].id],
      content: '机械拼凑的伪摘要内容',
      status: 'ok',
      retryCount: 0,
      sourceRevisionIds: [],
      source: 'stub',
      createdAt: 1,
    });
    const p = await buildTurnPrompt({ db, sessionId, userInput: '继续' });
    expect(p.systemText).not.toContain('机械拼凑的伪摘要内容');
    expect(p.systemText).toContain('旧输入'); // 空洞回退补上原始轮
  });
});

describe('generateAssistantReply：流式中断不能吃掉用户输入', () => {
  it('成功时按 delta 累积并返回全文', async () => {
    const chunks: string[] = [];
    const client: ChatClient = {
      complete: async () => '不应走到这里',
      completeStream: async (_req: ChatRequest, onDelta: (c: string) => void) => {
        onDelta('你');
        onDelta('好');
        return '你好';
      },
    } as ChatClient;

    const res = await generateAssistantReply({
      db,
      client,
      sessionId,
      userInput: 'hi',
      onDelta: (d) => chunks.push(d),
    });
    expect(res.error).toBeUndefined();
    expect(res.text).toBe('你好');
    expect(chunks.join('')).toBe('你好');
  });

  it('失败时返回 partial 而非抛异常，并带回已注入的事实', async () => {
    await db.facts.add(fact('f9'));
    const client: ChatClient = {
      complete: async () => '',
      completeStream: async (_req: ChatRequest, onDelta: (c: string) => void) => {
        onDelta('半截');
        const e = new ChatError('连接被重置', true) as ChatError & { partial?: string };
        e.partial = '半截';
        throw e;
      },
    } as ChatClient;

    const res = await generateAssistantReply({
      db,
      client,
      sessionId,
      userInput: 'hi',
      onDelta: () => {},
    });
    expect(res.error).toBeInstanceOf(ChatError);
    expect(res.text).toBe('半截');
    expect(res.injectedFactIds).toContain('f9');
  });

  it('模型名来自会话绑定', async () => {
    let seen = '';
    const client: ChatClient = {
      complete: async (req) => {
        seen = req.service.model;
        return 'ok';
      },
    };
    await generateAssistantReply({ db, client, sessionId, userInput: 'hi' });
    expect(seen).toBe('main-model');
  });
});

describe('UI 的写入形态（发送/重试共用）', () => {
  it('失败落 interrupted revision：用户输入保住，且能被 retry 接续', async () => {
    const client: ChatClient = {
      complete: async () => {
        throw new ChatError('boom', true);
      },
    };
    const res = await generateAssistantReply({ db, client, sessionId, userInput: '别丢我' });
    expect(res.error).toBeDefined();

    const fresh = await db.sessions.get(sessionId);
    const { turn } = await appendTurn(db, sessionId, {
      userContent: '别丢我',
      assistantContent: res.text || '（空回复）',
      injectedFactIds: res.injectedFactIds,
      revisionStatus: res.error ? 'interrupted' : 'active',
      expectedSeq: fresh?.expectedSeq,
    });

    const stored = await db.revisions.get(turn.activeRevisionId);
    expect(stored?.status).toBe('interrupted');
    expect(stored?.userContent).toBe('别丢我');

    await retry(db, sessionId, turn.id, '重试后的回复');
    const after = await db.turns.get(turn.id);
    const latest = await db.revisions.get(after!.activeRevisionId);
    expect(latest?.assistantContent).toBe('重试后的回复');
    expect(latest?.userContent).toBe('别丢我');
  });

  it('连发第二条不会因 expectedSeq 过期而冲突（UI 现读会话）', async () => {
    const snapshot = await db.sessions.get(sessionId); // 渲染时的旧快照
    await appendTurn(db, sessionId, { userContent: 'a', assistantContent: 'x' });

    // 用旧快照的值写第二条 → 必须冲突（这是乐观锁该有的行为）
    await expect(
      appendTurn(db, sessionId, {
        userContent: 'b',
        assistantContent: 'y',
        expectedSeq: snapshot!.expectedSeq,
      }),
    ).rejects.toThrow();

    // 现读后再写 → 成功
    const fresh = await db.sessions.get(sessionId);
    const r = await appendTurn(db, sessionId, {
      userContent: 'b',
      assistantContent: 'y',
      expectedSeq: fresh!.expectedSeq,
    });
    expect(r.turn.seq).toBe(fresh!.expectedSeq);
  });
});
