/**
 * 演示模式（file://）的 UI 行为（阶段五第三轮）。
 *
 * 三条约定见 §6.2，这里只负责把「用户会误解的地方」显式告知：
 * 1. 顶部常驻横幅 —— 不保存数据；
 * 2. 导出按钮旁常驻一行 —— 导出仅用于迁移到正式部署，不是备份；
 * 3. 导入前弹一次确认 —— 导入后数据只在内存，关闭页面即丢失。
 *
 * ⚠️ 第 3 条必须是**阻断式确认**，不能只是一行提示文字：
 * 「我导出了所以能恢复」是演示模式下最容易发生的误解，
 * 而误解的代价是用户真的丢掉数据。
 */
import type { Capabilities } from '../deploy/capabilities';

export const DEMO_EXPORT_HINT = '导出仅用于迁移到正式部署；演示模式本身不保存数据';

export const DEMO_IMPORT_CONFIRM =
  '当前是演示模式：导入后数据只存在于内存，关闭页面即丢失。\n' +
  '要持久保存，请改用 127.0.0.1 部署后再导入。\n\n仍要继续导入吗？';

export function isDemo(caps: Capabilities): boolean {
  return caps.mode === 'demo-file';
}

/** 顶部横幅文案；非演示模式返回 null（不渲染任何东西） */
export function demoBannerText(caps: Capabilities): string | null {
  return caps.demoBanner;
}

/** 导出按钮旁的提示；非演示模式返回 null */
export function demoExportHint(caps: Capabilities): string | null {
  return isDemo(caps) ? DEMO_EXPORT_HINT : null;
}

/**
 * 导入前的阻断式确认。
 * `confirm` 注入为参数，便于测试 —— 真实环境传 `window.confirm`。
 */
export function confirmDemoImport(
  caps: Capabilities,
  confirm: (msg: string) => boolean,
): boolean {
  if (!isDemo(caps)) return true;
  return confirm(DEMO_IMPORT_CONFIRM);
}

/** 渲染演示模式横幅 + 导出提示；非演示模式返回 null */
export function renderDemoNotice(caps: Capabilities, el: (tag: string, attrs?: Record<string, string>, children?: (Node | string)[]) => HTMLElement): HTMLElement | null {
  if (!isDemo(caps)) return null;
  const wrap = el('div', { class: 'demo-notice' });
  const banner = demoBannerText(caps);
  if (banner) wrap.append(el('div', { class: 'demo-banner' }, [banner]));
  const hint = demoExportHint(caps);
  if (hint) wrap.append(el('div', { class: 'demo-hint' }, [hint]));
  return wrap;
}
