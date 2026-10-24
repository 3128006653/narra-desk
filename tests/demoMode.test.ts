/**
 * 演示模式 UI 行为（阶段五第三轮）。
 * 重点是「用户会误解的地方必须被显式告知」，尤其是导入前必须阻断式确认。
 */
import { describe, expect, it } from 'vitest';
import { probeCapabilities, type Capabilities } from '../src/deploy/capabilities';
import {
  DEMO_EXPORT_HINT,
  DEMO_IMPORT_CONFIRM,
  confirmDemoImport,
  demoBannerText,
  demoExportHint,
  isDemo,
  renderDemoNotice,
} from '../src/ui/demoMode';

const demo: Capabilities = probeCapabilities({ protocol: 'file:', family: 'chromium' });
const served: Capabilities = probeCapabilities({
  protocol: 'http:',
  family: 'chromium',
  navigatorLike: { storage: {}, locks: {} },
  windowLike: { indexedDB: {} },
});

// 最小 DOM 桩：只记录结构，不依赖浏览器
interface StubNode {
  tag: string;
  attrs: Record<string, string>;
  children: unknown[];
  append(...c: unknown[]): void;
}
function stubEl(
  tag: string,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElement {
  const node: StubNode = {
    tag,
    attrs,
    children: children as unknown[],
    append(...c: unknown[]) {
      this.children.push(...c);
    },
  };
  return node as unknown as HTMLElement;
}
const kids = (n: HTMLElement) => (n as unknown as StubNode).children;

describe('演示模式判定', () => {
  it('file: 即演示模式，http 不是', () => {
    expect(isDemo(demo)).toBe(true);
    expect(isDemo(served)).toBe(false);
  });
});

describe('顶部横幅', () => {
  it('演示模式有横幅，正式部署没有', () => {
    expect(demoBannerText(demo)).toContain('演示模式');
    expect(demoBannerText(served)).toBeNull();
  });
  it('横幅说明「不保存数据」并指向正式部署', () => {
    const t = demoBannerText(demo)!;
    expect(t).toContain('不保存数据');
    expect(t).toContain('127.0.0.1');
  });
});

describe('导出提示：不能让用户以为「导出了就能恢复」', () => {
  it('演示模式的导出按钮旁有常驻提示', () => {
    const h = demoExportHint(demo);
    expect(h).toBe(DEMO_EXPORT_HINT);
    expect(h).toContain('演示模式本身不保存数据');
  });
  it('正式部署不显示该提示', () => {
    expect(demoExportHint(served)).toBeNull();
  });
});

describe('导入前阻断式确认', () => {
  it('演示模式：用户取消 → 不导入', () => {
    expect(confirmDemoImport(demo, () => false)).toBe(false);
  });
  it('演示模式：用户确认 → 导入', () => {
    expect(confirmDemoImport(demo, () => true)).toBe(true);
  });
  it('确认文案明确「只在内存 + 关闭即丢 + 如何持久保存」三件事', () => {
    expect(DEMO_IMPORT_CONFIRM).toContain('内存');
    expect(DEMO_IMPORT_CONFIRM).toContain('关闭页面即丢失');
    expect(DEMO_IMPORT_CONFIRM).toContain('127.0.0.1');
  });
  it('正式部署不打断用户', () => {
    let called = false;
    expect(confirmDemoImport(served, () => (called = true))).toBe(true);
    expect(called).toBe(false); // 根本没弹
  });
});

describe('renderDemoNotice', () => {
  it('演示模式渲染横幅 + 导出提示两层', () => {
    const node = renderDemoNotice(demo, stubEl as never);
    expect(node).not.toBeNull();
    expect(kids(node!).length).toBe(2);
  });
  it('正式部署不渲染任何东西', () => {
    expect(renderDemoNotice(served, stubEl as never)).toBeNull();
  });
});
