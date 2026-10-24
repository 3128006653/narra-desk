/**
 * 核心实体类型（v0.6.1 定案）。
 *
 * 命名约定（v0.6.1 patch #6）：
 *   Turn / TurnRevision / SummaryView 用 `status`（各实体枚举不同）
 *   FactView 用 `injectionState`（与 Turn.status 同名不同义，故改名）
 */

// ---------------------------------------------------------------- Character

export interface Character {
  id: string;
  name: string;
  avatar?: string;
  cardSource: { format: 'v2' | 'v3' | 'native'; raw: unknown };
  cardCorrections?: CardCorrection[];
  createdAt: number;
  updatedAt: number;
}

export interface CardCorrection {
  path: string; // 如 "extensions.match_whole_words" / "character_book.entries[3].extensions.match_whole_words"
  from: unknown;
  to: unknown;
  reason: string;
}

export type AssetType =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'greeting'
  | 'mes_example'
  | 'lorebook_entry';

export interface CharacterAsset {
  id: string;
  characterId: string;
  type: AssetType;
  content: string;
  metadata: {
    /** greeting 专用：alternate_greetings 中的下标 */
    index?: number;
    position?: string;
    keys?: string[];
    secondary_keys?: string[];
    constant?: boolean;
    scan_depth?: number;
    case_sensitive?: boolean;
    insertion_order?: number;
    /** 导入时由 match_whole_words 映射而来 */
    matchWholeWords?: boolean;
    enabled?: boolean;
    [k: string]: unknown;
  };
  createdAt: number;
}

// ---------------------------------------------------------------- Session

export interface ServiceRef {
  /** 指向独立密钥存储；此处不存明文密钥 */
  id: string;
  model: string;
  parameters?: Record<string, unknown>;
}

export interface SessionModelBinding {
  main: ServiceRef;
  summarizer?: ServiceRef; // 不设置时「跟随主模型」
  embedder?: ServiceRef; // 不设置时禁用向量视图
  overrides?: { main?: Partial<ServiceRef> };
}

export interface Session {
  id: string;
  characterId: string;
  title: string;
  modelBinding: SessionModelBinding;
  boundAssetIds: string[];
  lorebookBinding: { assetIds: string[]; overrides?: Record<string, unknown> };
  /** 乐观锁：下一个合法写入的 seq；单调递增、永不复用 */
  expectedSeq: number;
  createdAt: number;
  updatedAt: number;
  // 注：无 selectedGreetingId —— 当前 greeting 由 seq 0 的 activeRevision 派生（单一真相源）
}

// ---------------------------------------------------------------- TurnStore

export type TurnStatus = 'active' | 'discarded';

export interface Turn {
  id: string; // turnId
  sessionId: string;
  seq: number; // 单调递增、永不复用；discard 不回收
  activeRevisionId: string;
  status: TurnStatus;
  createdAt: number;
}

export type RevisionStatus = 'active' | 'superseded' | 'interrupted';

export type RevisionReason =
  | 'initial'
  | 'amend'
  | 'regenerate'
  | 'greeting_switch'
  | 'retry';

export type ToolSideEffect = 'none' | 'idempotent' | 'fresh';

export interface ToolTrace {
  id: string;
  stepIndex: number;
  toolName: string;
  arguments: unknown;
  sideEffect: ToolSideEffect; // 默认 fresh
  /** 一级键：hash(requestId, stepIndex, toolName, arguments) —— 命中 = 完全跳过 */
  idempotencyKey: string;
  /** 二级键：hash(sessionId, toolName, arguments) —— idempotent 复用结果用 */
  sideEffectKey: string;
  status: 'pending' | 'done' | 'failed' | 'skipped';
  /**
   * 结果。⚠️ 喂回模型时**必须是字符串** —— `role: "tool"` 的 `content` 是字符串，
   * 传对象进去部分 provider 静默截断、部分报错，且错误信息不指向真正原因。
   */
  result?: unknown;
  /**
   * provider 侧的工具调用 id（OpenAI 格式 `tool_calls[].id`）。
   *
   * 存在的理由：后续每条 `role: "tool"` 消息必须带 `tool_call_id` 引用它 ——
   * 不存下来，重放时 tool 消息拼不出来，模型看到的是一串**没有归属**的工具结果。
   * 可选字段（旧行没有），不触发迁移。
   */
  providerCallId?: string;
  /**
   * 给用户的说明（阶段三）。
   *
   * 典型用途：`fresh` 工具在 **retry** 下会被跳过而非重掷 —— 不能静默跳过，
   * 必须附一句「此步骤有副作用，无法自动重试」。没有这个字段时，
   * 「跳过」与「成功复用」在 UI 上长得一样，用户会以为骰子重掷了。
   */
  note?: string;
}

export interface TurnRevision {
  id: string;
  turnId: string;
  userContent: string;
  assistantContent: string;
  toolTrace?: ToolTrace[];
  status: RevisionStatus;
  reason?: RevisionReason; /** 携带 requestId 供幂等键派生 */
  requestId?: string;
  supersededAt?: number;
  /**
   * 本轮实际注入的 FactView id（可选，来自 `assembleBudget().injectedFactIds`）。
   *
   * 存在的理由：聊天界面的「这条不对」纠错入口需要知道**这条回复读了哪些事实** ——
   * 用户是在读到错误表述的那一刻想纠错，入口必须在那个位置，而它依赖这张清单。
   * 可选字段，老数据无需迁移。
   */
  injectedFactIds?: string[];
  createdAt: number;
}

// ---------------------------------------------------------------- Views

export type SummaryStatus =
  | 'ok'
  | 'pending'
  | 'failed'
  | 'retrying'
  | 'stale'
  | 'superseded';

export interface SummaryView {
  id: string;
  sessionId: string;
  /** 精确覆盖；允许重叠（去重只在注入时发生） */
  coversTurnIds: string[];
  content: string;
  status: SummaryStatus;
  retryCount: number;
  lastError?: string;
  sourceRevisionIds: string[];
  staleReason?: 'turn-edited' | 'turn-discarded' | 'manual';
  createdAt: number;

  /**
   * 生成来源（I-16 / P0）。
   *
   * `stub` = 抽取式占位摘要器的产物，**内容是机械拼凑的伪摘要，禁止注入**。
   *   模型读到一段伪摘要比读不到摘要更糟 —— 它会照着假要点继续编。
   *   真实 client 接入后需扫描全部 `source: 'stub'` 重新生成。
   *
   * ⚠️ 迁移 v4 对缺字段的旧行回填 `stub`（保守方向）：宁可重建，不冒险注入。
   *
   * ⚠️ **写入点必须唯一**（I-21 延伸）：整个代码库里只有一处可以写 `source: 'model'` ——
   *    `summaryService` 中「模型返回成功 → 写 `status: 'ok'`」的那一个事务分支。
   *    其余所有状态转换（`pending` / `retrying` / `failed` / `stale` / `superseded`）
   *    **一律不动 `source`**。
   *
   *    为什么：若失败路径也跟着写 `source`，一次「带着真实 client 但失败」的重试
   *    会把伪摘要标记成 `model`，下次 `isInjectableSummary` 只看 `source !== 'stub'`
   *    就放行 —— 这是**失败伪装成成功**，比「stub 以 ok 状态注入」更隐蔽。
   *    把约定写在这里（字段定义处）比散落在各分支的注释更难失守。
   */
  source: 'stub' | 'model';
  /** 记录更新时间；pending 超时恢复以此判定（I-14） */
  updatedAt?: number;
}

export type FactConfidence = 'proposed' | 'auto' | 'confirmed';
export type InjectionState = 'active' | 'inactive';
export type InactiveReason =
  | 'superseded'
  | 'expired'
  | 'archived'
  | 'disputed'
  | 'rejected';
export type FactOrigin =
  | 'user_manual'
  | 'model_proposed'
  | 'auto_extracted'
  | 'user_confirm';
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * 派生层 stale 标记（I-3 定案 / v0.6.2）。
 *
 * 关键：**stale 与 injectionState 正交，绝不能复用 inactiveReason**。
 *   injectionState=inactive —— 数据层生命周期（superseded/expired/archived/disputed/rejected）
 *   stale=true            —— 派生层重建标记（源 Turn 被 amend/regenerate/truncate 修订）
 * 二者混一会把「被新值覆盖」和「源轮次改了待重建」变成同一件事，
 * 直接违反不变量 #2（discard 只作用于 Turn，stale 只作用于派生物）。
 *
 * 注入规则：injectionState === 'active' && stale === false
 */
export type FactStaleReason =
  | 'turn-amended'
  | 'turn-regenerated'
  | 'turn-truncated'
  | 'manual';

export interface FactView {
  id: string; // uuid，非复合主键
  sessionId: string;
  scope: 'global' | 'character';
  /** global 用哨兵空串 ""，不用 undefined —— IndexedDB 不把 undefined 视为合法 key 成员 */
  characterId: string;
  key: string;
  value: string | Record<string, unknown>;
  confidence: FactConfidence;
  injectionState: InjectionState;
  inactiveReason?: InactiveReason;
  origin: FactOrigin;
  riskLevel: RiskLevel;
  pinned: boolean;
  /**
   * pin 时间戳（v0.6.2 附带新增）。
   * §5.7 规定 pin 层按「用户 pin 顺序」排序 —— updatedAt 会被后续编辑改写，
   * 撑不住稳定顺序，故单独记录 pin 时刻。
   */
  pinnedAt?: number;
  /** 只在写路径刷新；复现检测二期 */
  lastSeenTurn: number;
  /** 派生层：源 Turn 被修订，待后台重建；重建完成后清 false */
  stale: boolean;
  staleReason?: FactStaleReason;
  sourceTurnIds: string[];
  sourceRevisionIds: string[];
  /** 仅调试用，不参与逻辑：同 key 至多保留最近 1 条 inactive，此引用可能悬空 */
  supersedes?: string;
  correction?: { previousValue: unknown; correctedAt: number; note?: string };
  updatedAt: number;
}

/** 派生层 stale 原因（I-3 定案 / v0.6.2） */
export type VectorStaleReason =
  | 'revision-changed'
  | 'embedder-changed'
  | 'quantization-changed'
  | 'manual';

export interface VectorIndex {
  id: string;
  sessionId: string;
  embedderServiceId: string;
  sourceType: 'turn' | 'summary' | 'fact';
  sourceId: string;
  sourceRevisionId?: string;
  vector: Int8Array;
  quantization: { scheme: 'int8'; scale: number };
  /** stale 向量不参与召回，后台重建后清 false */
  stale: boolean;
  staleReason?: VectorStaleReason;
  createdAt: number;
}

export interface BackgroundTask {
  id: string;
  sessionId: string;
  type: 'summarize' | 'merge-summary' | 'reindex' | 'backup' | 'reconcile';
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: number;
  lastError?: string;
  createdAt: number;

  // ---- 阶段二新增（§4.3「只增字段」，均为可选，不建索引 → 不需要新 Dexie 版本）----
  /** 幂等键：同 sessionId + type + dedupeKey 且未终态时不重复排队 */
  dedupeKey?: string;
  /** 任务负载，如摘要窗口的 turnIds */
  payload?: unknown;
  /** 已尝试次数；达到 maxAttempts 后不再自动重试 */
  attempts?: number;
  /** 退避到期时间；未到不取（ts <= now 才可运行） */
  nextRunAt?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------- Capability

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other';

export interface StorageCapability {
  indexedDB: boolean;
  persistSupported: boolean;
  persistGranted: boolean;
  estimatedQuota: number | null;
  fsAccessSupported: boolean;
  fsAccessFallback: boolean;
  browserFamily: BrowserFamily;
  persistNote?: string;
}

export type CapabilityLevel = 'granted' | 'not-granted' | 'unknown' | 'unavailable';

/**
 * Token 校准行（I-24，v5 新增）。
 *
 * **样本与系数合一**：样本只是算中位数的原料，单独建表没有消费端；
 * 合进来后 `factor` 就是这张表的产出，`estimateTokens(text, family)` 直接查。
 */
export interface CalibrationRow_v5 {
  /** = family（单一真相源，避免 family 与 id 不一致） */
  id: string;
  family: string;
  /** 最近的 `usage / est`（滚动窗口，上限见 tokenCalibration） */
  ratios: number[];
  /** 校准后的系数；样本不足时为默认 1.2 */
  factor: number;
  sampleCount: number;
  updatedAt: number;
  /**
   * 上一次**回写系数**时的样本数（可追溯性，I-24 补充）。
   *
   * 用途：用户若觉得「模型突然裁得特别狠」，要能查到是哪个 family 的系数
   * 在什么样本量、什么时间被调上去的。`sampleCount` 是「现在的样本数」，
   * 与「回写时的样本数」不是一回事 —— 两者都要有。
   */
  calibratedAtSampleCount?: number;
  /** 上一次回写系数的时间（可追溯性，I-24 补充） */
  lastCalibratedAt?: number;
}
