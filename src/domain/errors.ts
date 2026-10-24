/** 领域错误（v0.6.1）。错误名进入 UI 文案与测试断言，不要改名。 */

/** 乐观锁冲突：持有的 expectedSeq 与存储侧不一致 */
export class WriteConflictError extends Error {
  constructor(
    public readonly expectedSeq: number,
    public readonly actualSeq: number,
  ) {
    super(`写入冲突：期望 seq=${expectedSeq}，存储侧为 seq=${actualSeq}`);
    this.name = 'WriteConflictError';
  }
}

/** 不变量 #3：已有新写入，废弃分支只读，不可恢复 */
export class ReadOnlyBranchError extends Error {
  constructor() {
    super('截断后已产生新写入，废弃分支只读；替换式恢复请显式执行 truncate');
    this.name = 'ReadOnlyBranchError';
  }
}

/** 该 Turn 不存在或不属于该会话 */
export class TurnNotFoundError extends Error {
  constructor(turnId: string) {
    super(`Turn 不存在：${turnId}`);
    this.name = 'TurnNotFoundError';
  }
}

/** greeting 切换前已有用户回复，必须新开会话 */
export class GreetingLockedError extends Error {
  constructor() {
    super('已有回复，greeting 不可就地切换；请「以此 greeting 新开会话」');
    this.name = 'GreetingLockedError';
  }
}

/** 阶段占位：后续阶段实现 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`尚未实现（后续阶段）：${what}`);
    this.name = 'NotImplementedError';
  }
}
