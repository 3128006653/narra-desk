/**
 * 抽取式占位摘要器（**测试夹具**，已从 `src/domain/` 移出）。
 *
 * 为什么搬而不是删：它是「造出一批 `source: 'stub'` 的伪摘要」的**唯一手段**，
 *    用来测试扫描重建、孤儿清理、覆盖策略这些 I-19/20/21 的行为。
 *    留在 `src/` 会让人误以为它是可选的生产路径；放在 `tests/helpers/` 才名副其实。
 *
 * 它**不调模型**，只是把窗口内每轮首句拼成要点 —— 不是产品行为。
 * 真实摘要应当提炼地点/状态/承诺/冲突（见 `SUMMARY_SYSTEM_PROMPT`）。
 */
import type { ChatClient } from '../../src/domain/modelClient';

export function stubSummarizer(): ChatClient {
  return {
    // 显式声明 stub（I-16）：产物会被标 `source: 'stub'`，禁止注入，
    // 真实 client 接入后由扫描重建清掉。删本文件前先做那次扫描。
    source: 'stub',
    async complete(req) {
      const last = req.messages[req.messages.length - 1];
      const body = last?.content ?? '';
      const lines = body
        .split('\n')
        .filter((l) => l.startsWith('用户：') || l.startsWith('助手：'))
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      const picked = lines.filter((_, i) => i % 2 === 0).slice(0, 8); // 抽稀，避免摘要跟原文一样长
      return picked.map((l, i) => `${i + 1}. ${l.slice(0, 60)}`).join('\n');
    },
  };
}
