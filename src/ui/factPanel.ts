/**
 * FactView 面板（阶段四第 5 步）。
 *
 * 四个设计点全部落在这里：
 *  1. **批量操作默认不选中任何项** —— 「全选」是用户主动动作。
 *     无脑全选会变成第二种确认疲劳：用户不看内容就全确认，
 *     门禁退化为装饰（§1.2 批评 RP-Hub 手动补录的核心理由）。
 *  2. **disputed 入口在聊天界面，不在侧栏** —— 见 `disputedEntry()`。
 *  3. **pin 满员拒绝并提示**，不自动替换最早的 pin（与 `retryNow` 不重置 attempts 同原则）。
 *  4. **expired 与 archived 分区显示** —— 都是 inactive、都不注入，但语义相反：
 *     前者「值可能已失效」，后者「用户一直没处理」。混一起用户分不清要不要管。
 */
import type { NarraDB } from '../schema/db';
import {
  bulkConfirm,
  bulkReject,
  confirmFact,
  correctFact,
  disputeFact,
  loadFactPanel,
  pinFact,
  sweepFactLifecycle,
  unpinFact,
  type FactPanelGroups,
} from '../domain/factStore';
import { INJECTION_LIMITS } from '../domain/factInjection';
import type { FactView } from '../schema/entities';
import { el } from './dom';

export interface FactPanelHost {
  db: NarraDB;
  sessionId: string;
  currentTurn: number;
  /** 面板操作后重绘 */
  rerender: () => void;
}

/** 按钮：`el()` 只收 (tag, attrs, children)，点击回调必须另行挂载 */
function mkBtn(label: string, onClick: () => void, cls?: string): HTMLButtonElement {
  const b = el('button', cls ? { class: cls } : {}, [label]) as HTMLButtonElement;
  b.onclick = onClick;
  return b;
}

function valueText(f: FactView): string {
  return typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
}

/**
 * 面板主体。
 * 分区顺序：disputed（置顶）→ pending（待确认）→ archived（待处理·已归档）→ expired（已过期）→ pinned
 */
export async function renderFactPanel(host: FactPanelHost): Promise<HTMLElement> {
  const { db, sessionId, currentTurn, rerender } = host;
  // 每次打开面板先跑一次生命周期扫描，让「待补/已过期」计数是当前的
  await sweepFactLifecycle(db, sessionId, currentTurn);
  const groups: FactPanelGroups = await loadFactPanel(db, sessionId);

  const wrap = el('div', { class: 'fact-panel' });

  // ---------------- disputed：置顶 ----------------
  if (groups.disputed.length) {
    wrap.append(
      el('div', { class: 'panel-group disputed' }, [
        el('div', { class: 'panel-title' }, [`⚠️ 被标记为「这条不对」（${groups.disputed.length}）`]),
        ...groups.disputed.map((f) => disputedRow(host, f)),
      ]),
    );
  }

  // ---------------- pending：待确认（批量） ----------------
  const pending = groups.pending;
  const unchecked = new Set<string>(); // 默认**不选** → 空集
  const pendingBox = el('div', { class: 'panel-group' }, [
    el('div', { class: 'panel-title' }, [
      `待确认事实（${pending.length}）`,
      el('span', { class: 'dim' }, [
        ` · 注入上限 ${INJECTION_LIMITS.proposed}，超出部分面板可见`,
      ]),
    ]),
  ]);

  if (pending.length === 0) {
    pendingBox.append(el('div', { class: 'dim' }, ['没有待确认事实']));
  } else {
    const rows = pending.map((f) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = false; // 默认不选中
      cb.onchange = () => {
        if (cb.checked) unchecked.add(f.id);
        else unchecked.delete(f.id);
        updateBulkButtons();
      };
      return el('label', { class: 'fact-row' }, [
        cb,
        el('span', { class: 'fact-key' }, [f.key]),
        el('span', { class: 'fact-val' }, [valueText(f)]),
        el('span', { class: 'badge' }, [f.riskLevel]),
        mkPinBtn(host, f),
        mkBtn('确认', async () => {
          await confirmFact(db, f.id, currentTurn);
          rerender();
        }),
      ]);
    });
    rows.forEach((r) => pendingBox.append(r));

    const all = mkBtn('全选当前页', () => {});
    const none = mkBtn('取消全选', () => {});
    const confirmBtn = mkBtn('批量确认（0）', () => {}, 'primary');
    const rejectBtn = mkBtn('批量忽略（0）', () => {});

    const updateBulkButtons = () => {
      confirmBtn.textContent = `批量确认（${unchecked.size}）`;
      rejectBtn.textContent = `批量忽略（${unchecked.size}）`;
      confirmBtn.setAttribute('disabled', String(unchecked.size === 0));
      rejectBtn.setAttribute('disabled', String(unchecked.size === 0));
    };
    updateBulkButtons();

    all.onclick = () => {
      pending.forEach((f) => unchecked.add(f.id));
      pendingBox.querySelectorAll('input[type=checkbox]').forEach((c: Element) => {
        (c as HTMLInputElement).checked = true;
      });
      updateBulkButtons();
    };
    none.onclick = () => {
      unchecked.clear();
      pendingBox.querySelectorAll('input[type=checkbox]').forEach((c: Element) => {
        (c as HTMLInputElement).checked = false;
      });
      updateBulkButtons();
    };
    confirmBtn.onclick = async () => {
      await bulkConfirm(db, [...unchecked], currentTurn);
      rerender();
    };
    rejectBtn.onclick = async () => {
      await bulkReject(db, [...unchecked]);
      rerender();
    };

    pendingBox.append(el('div', { class: 'row' }, [all, none, confirmBtn, rejectBtn]));
  }
  wrap.append(pendingBox);

  // ---------------- archived vs expired：分区 ----------------
  const arch = el('div', { class: 'panel-group' }, [
    el('div', { class: 'panel-title' }, [
      `待处理（已归档 ${groups.archived.length}）`,
      el('span', { class: 'dim' }, [' · 超 100 轮未确认；未处理 ≠ 值失效，仍可恢复']),
    ]),
    ...(groups.archived.length
      ? groups.archived.map((f) => inactiveRow(host, f, '恢复为待确认'))
      : [el('div', { class: 'dim' }, ['无'])]),
  ]);

  const exp = el('div', { class: 'panel-group' }, [
    el('div', { class: 'panel-title' }, [
      `已过期（${groups.expired.length}）`,
      el('span', { class: 'dim' }, [' · low 事实 50 轮未复现；值可能已失效，可手动删除']),
    ]),
    ...(groups.expired.length
      ? groups.expired.map((f) => inactiveRow(host, f, null))
      : [el('div', { class: 'dim' }, ['无'])]),
  ]);
  wrap.append(arch, exp);

  // ---------------- pinned ----------------
  wrap.append(
    el('div', { class: 'panel-group' }, [
      el('div', { class: 'panel-title' }, [
        `已 pin（${groups.pinned.length}/${INJECTION_LIMITS.pin}）`,
        el('span', { class: 'dim' }, [' · 额外配额，豁免预算裁剪']),
      ]),
      ...(groups.pinned.length
        ? groups.pinned.map((f) =>
            el('div', { class: 'fact-row' }, [
              el('span', { class: 'fact-key' }, [f.key]),
              el('span', { class: 'fact-val' }, [valueText(f)]),
              mkBtn('取消 pin', async () => {
                await unpinFact(db, f.id);
                rerender();
              }),
            ]),
          )
        : [el('div', { class: 'dim' }, ['无'])]),
    ]),
  );

  return wrap;
}

function mkPinBtn(host: FactPanelHost, f: FactView): HTMLElement {
  const b = mkBtn(f.pinned ? '取消 pin' : 'pin', () => {});
  b.onclick = async () => {
    if (f.pinned) {
      await unpinFact(host.db, f.id);
      host.rerender();
      return;
    }
    const r = await pinFact(host.db, f.id);
    if (!r.ok) {
      // 拒绝并提示 —— 不自动替换最早的 pin
      alert(
        r.reason === 'limit-reached'
          ? `pin 已满（上限 ${INJECTION_LIMITS.pin} 条）。请先取消一条再 pin —— 不会自动替换，避免「以为 pin 成功了」。`
          : '事实不存在',
      );
    }
    host.rerender();
  };
  return b;
}

function disputedRow(host: FactPanelHost, f: FactView): HTMLElement {
  const input = el('input', { value: valueText(f) }) as HTMLInputElement;
  return el('div', { class: 'fact-row' }, [
    el('span', { class: 'fact-key' }, [f.key]),
    el('span', { class: 'fact-val' }, [`原值：${valueText(f)}`]),
    input,
    mkBtn('改写', async () => {
      await correctFact(host.db, f.id, input.value, host.currentTurn, '用户纠正');
      host.rerender();
    }),
    mkBtn('删除', async () => {
      await host.db.facts.delete(f.id);
      host.rerender();
    }),
  ]);
}

function inactiveRow(host: FactPanelHost, f: FactView, restoreLabel: string | null): HTMLElement {
  const row = el('div', { class: 'fact-row' }, [
    el('span', { class: 'fact-key' }, [f.key]),
    el('span', { class: 'fact-val' }, [valueText(f)]),
  ]);
  if (restoreLabel) {
    const b = mkBtn(restoreLabel, () => {});
    b.onclick = async () => {
      // 恢复 = 重新走写路径，产生新的 active 行
      const { writeFact } = await import('../domain/factStore');
      await writeFact(host.db, {
        sessionId: f.sessionId,
        scope: f.scope,
        characterId: f.characterId,
        key: f.key,
        value: f.value,
        confidence: 'proposed',
        origin: 'model_proposed',
        riskLevel: f.riskLevel,
        lastSeenTurn: host.currentTurn,
        sourceTurnIds: f.sourceTurnIds,
        sourceRevisionIds: f.sourceRevisionIds,
      });
      host.rerender();
    };
    row.append(b);
  }
  const del = mkBtn('删除', async () => {
    await host.db.facts.delete(f.id);
    host.rerender();
  });
  row.append(del);
  return row;
}

/**
 * **聊天界面**的 disputed 入口（§5.7 纠错通路）。
 *
 * 依赖 `assembleBudget` 输出里的 `injectedFactIds` —— 「这条消息注入了哪些事实」
 * 是 UI 的一等需求，没有它这里无从下手。
 *
 * 形态：消息旁的「纠正事实」菜单，列出本条注入的事实，逐条可标记「这条不对」。
 * 不是悬浮在侧栏里的入口 —— 用户是在读回复时发现事实错了，纠错动作必须在那个位置。
 */
export function disputedEntry(
  host: FactPanelHost,
  injectedFactIds: string[],
  factsById: Map<string, FactView>,
): HTMLElement | null {
  if (!injectedFactIds.length) return null;
  const btn = mkBtn('纠正事实', () => {}, 'link');
  btn.onclick = async () => {
    const names = injectedFactIds
      .map((id) => factsById.get(id))
      .filter((f): f is FactView => !!f)
      .map((f) => `${f.key} = ${valueText(f)}`);
    const idx = Number.parseInt(
      prompt(`本条注入了 ${names.length} 条事实，输入要纠正的序号：\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`, '1') ?? '',
      10,
    );
    const target = Number.isFinite(idx) ? injectedFactIds[idx - 1] : undefined;
    if (!target) return;
    await disputeFact(host.db, target);
    host.rerender();
  };
  return btn;
}
