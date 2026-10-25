/**
 * 阶段一最小 UI（v0.6.2）。
 * 目标不是好看，是把编辑语义、版本历史、greeting 派生、能力指示器全部跑通一遍。
 * 阶段二起由 Prompt 组装器接管对话逻辑；此处模型调用是占位实现。
 */
import '../ui/styles.css';
import { initDatabase } from '../schema/db';
import type { Session } from '../schema/entities';
import { el } from './dom';
import { disputedEntry, renderFactPanel } from './factPanel';
import { confirmDemoImport, renderDemoNotice } from './demoMode';
import { probeCapabilities } from '../deploy/capabilities';

/** 面板的「当前轮」基准：用 expectedSeq（下一个待写入的 seq） */
async function nextSeqForPanel(db: Awaited<typeof dbPromise>, sessionId: string): Promise<number> {
  const s = await db.sessions.get(sessionId);
  return s?.expectedSeq ?? 0;
}

// 事实面板（阶段四第 5 步）
async function mountFactPanel(db: Awaited<typeof dbPromise>, sessionId: string, currentTurn: number) {
  const host = document.getElementById('fact-panel');
  if (!host) return;
  host.innerHTML = '';
  host.append(
    await renderFactPanel({
      db,
      sessionId,
      currentTurn,
      rerender: () => {
        void mountFactPanel(db, sessionId, currentTurn);
      },
    }),
  );
}
import { importCard, listGreetingCandidates } from '../domain/cardImport';
import {
  amend,
  appendTurn,
  createSession,
  currentGreeting,
  listDiscardedBranch,
  listRecentTurns,
  listRevisions,
  regenerate,
  retry,
  restoreDiscarded,
  restoreToRevision,
  switchGreeting,
  truncate,
  INITIAL_PAGES,
} from '../domain/turnStore';
import {
  capabilityLevel,
  capabilityMessage,
  detectStorageCapability,
  requestPersistence,
} from '../domain/storageCapability';
import { withSessionLock } from '../domain/webLock';
import { downloadBackup } from '../domain/exportJson';
import { Runtime } from '../domain/runtime';
import { httpChatClient } from '../domain/httpClient';
import { generateAssistantReply, type GenerateReplyResult } from '../domain/chatTurn';
import { formatIndicator } from '../domain/indicator';

const app = document.getElementById('app') as HTMLDivElement;

/** 运行期配置（仅内存；不落主库，避免随导出包泄漏） */
const appConfig: { apiKey?: string } = {};

/**
 * 迁移是否刚发生（I-16 收尾）。
 * 迁移 v4 会把旧摘要回填 `stub` → 全部不注入 → 区间转空洞。
 * 这里只记标志，真正的重建要等 Runtime 建好（它依赖 db），故延后执行。
 */
let pendingMigrationRebuild = false;

const dbPromise = initDatabase({
  confirm: async (msg) => window.confirm(msg),
  exportBackup: async () => downloadBackup(await dbPromise),
  onMigrated: () => {
    pendingMigrationRebuild = true;
  },
});

let activeSessionId: string | null = null;
/** 已加载的页数（§5.11 分页）；切换会话时重置 */
let loadedPages = INITIAL_PAGES;

/**
 * 真实模型客户端（阶段二末关账项）。
 *
 * **推荐部署下 baseUrl = `location.origin`**：单文件二进制同时托管前端与代理，
 * 所以前端与 `/v1/*` 同源，不需要额外配置，也不存在 CORS 问题。
 * 浏览器直连模式（用户填自己服务商地址）时也走同一个 client，只是 baseUrl 不同。
 *
 * 密钥：`resolveApiKey` 注入，本模块不接触密钥（§5.3）。
 * 默认不携带 Authorization —— 推荐部署下由代理侧持有凭证；
 * 浏览器直连时由输入框在运行期写入 `appConfig.apiKey`，**只存内存，不落主库、不进导出包**。
 * ⚠️ 持久化加密密钥存储（Web Crypto + 独立库）推迟，见 ISSUES I-25。
 */
const chatClient = httpChatClient({
  baseUrl: globalThis.location?.origin ?? 'http://127.0.0.1',
  resolveApiKey: () => appConfig.apiKey ?? '',
});

const runtimePromise = dbPromise.then(
  (db) =>
    new Runtime(db, {
      client: chatClient,
      // §5.3：未配置 summarizer 时「跟随主模型」—— 由 UI 决定跟随策略，Runtime 不替用户选
      resolveSummarizer: async (sid) => {
        const s = await db.sessions.get(sid);
        return s?.modelBinding.summarizer ?? s?.modelBinding.main ?? { id: 'svc-default', model: 'gpt-x' };
      },
    }),
);

/** 指示器宿主：局部更新，不触发整页 render（否则会打断用户正在输入的内容） */
let indicatorHost: HTMLElement | null = null;

/**
 * 启动时兜底一次（I-14 / I-15）：崩溃遗留的超时 pending 重新入队 + 同区间重复记录裁剪。
 * 只做一次，且失败不影响对话 —— 后台兜底失败不该挡住用户开始聊天。
 */
let recovered = false;
async function recoverOnce(): Promise<void> {
  if (recovered || !activeSessionId) return;
  recovered = true;
  try {
    await (await runtimePromise).recover(activeSessionId);
  } catch {
    /* 兜底失败不影响对话 */
  }
}

async function refreshIndicator(): Promise<void> {
  if (!indicatorHost || !activeSessionId) return;
  const rt = await runtimePromise;
  const lines = formatIndicator(await rt.indicator(activeSessionId));
  indicatorHost.textContent = lines.length ? `后台：${lines.join(' · ')}` : '后台：空闲';
}

// `el()` 已抽到 src/ui/dom.ts，供 factPanel 等面板共用

async function render() {
  const db = await dbPromise;
  app.innerHTML = '';

  // ---- 演示模式（file://）横幅 + 导出提示 ----
  // 必须在能力指示器之前渲染：它是「当前环境不保存数据」的总告示，
  // 放在任何操作入口之上，用户第一眼就能看到。
  const caps = probeCapabilities({
    protocol: location.protocol,
    navigatorLike: navigator,
    windowLike: window as unknown as Record<string, unknown>,
  });
  const notice = renderDemoNotice(caps, el as never);
  if (notice) app.append(notice as unknown as Node);

  // ---- 能力指示器 ----
  const cap = await detectStorageCapability();
  const level = capabilityLevel(cap);
  app.append(
    el('div', { class: `cap cap-${level}` }, [
      `${capabilityMessage(cap)}（${cap.browserFamily}）`,
      el('button', { id: 'btn-persist' }, ['申请持久化']),
      el('button', { id: 'btn-export' }, ['导出 JSON']),
    ]),
  );

  // ---- 角色卡导入 ----
  const fileInput = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const res = await importCard(db, JSON.parse(text));
    alert(
      `已导入「${res.character.name}」\n资产 ${res.assets.length} 条\n自动修正 ${res.corrections.length} 处\n提示 ${res.warnings.length} 条`,
    );
    render();
  };
  app.append(el('div', { class: 'row' }, [el('span', {}, ['导入角色卡：']), fileInput]));

  // ---- 会话列表 ----
  const sessions = await db.sessions.toArray();
  const chars = await db.characters.toArray();
  const list = el('div', { class: 'sessions' });
  for (const s of sessions) {
    const b = el('button', { class: s.id === activeSessionId ? 'active' : '' }, [
      `${s.title} · seq→${s.expectedSeq}`,
    ]);
    b.onclick = () => {
      activeSessionId = s.id;
      loadedPages = INITIAL_PAGES;
      render();
    };
    list.append(b);
  }
  for (const c of chars) {
    const b = el('button', { class: 'primary' }, [`＋ 与「${c.name}」新开会话`]);
    b.onclick = async () => {
      const { first } = await listGreetingCandidates(db, c.id);
      const s = await createSession(db, {
        characterId: c.id,
        title: `${c.name} · ${new Date().toLocaleString()}`,
        modelBinding: { main: { id: 'svc-default', model: 'gpt-x' } },
        greetingAssetId: first?.id ?? '',
        greetingContent: first?.content ?? '（无开场白）',
      });
      activeSessionId = s.id;
      render();
    };
    list.append(b);
  }
  app.append(list);

  if (!activeSessionId) return;
  const session = (await db.sessions.get(activeSessionId)) as Session;

  // ---- 后台任务指示器（§5.5）----
  indicatorHost = el('div', { class: 'cap cap-not-granted' }, ['后台：…']);
  const btnSum = el('button', { id: 'btn-summarize' }, ['立即生成摘要']);
  const btnPump = el('button', { id: 'btn-pump' }, ['驱动后台队列']);
  app.append(el('div', { class: 'row' }, [indicatorHost, btnSum, btnPump]));
  void recoverOnce().then(async () => {
    // 迁移收尾：stub 摘要重建入队后立刻驱动一次，避免用户先经历一轮「记得更少」
    if (pendingMigrationRebuild) {
      pendingMigrationRebuild = false;
      try {
        const rt = await runtimePromise;
        await rt.rebuildStubSummaries(activeSessionId ?? undefined);
        await rt.pump();
      } catch {
        /* 兜底失败不影响对话 */
      }
    }
    await refreshIndicator();
  });

  // ---- FactView 面板（阶段四第 5 步）----
  const panelHost = el('div', { id: 'fact-panel' });
  app.append(panelHost);
  void mountFactPanel(db, session.id, await nextSeqForPanel(db, session.id));

  // ---- 单活动标签页锁 ----
  const chatHost = el('div', { class: 'chat' });
  app.append(chatHost);

  await withSessionLock(
    session.id,
    async () => {
      chatHost.append(await renderChat(db, session));
    },
    () => {
      chatHost.append(el('div', { class: 'cap cap-unavailable' }, ['另一个标签页正在编辑此会话，当前为只读']));
    },
  );
}

async function renderChat(db: Awaited<typeof dbPromise>, session: Session): Promise<HTMLElement> {
  const wrap = el('div');
  // §5.11：分页加载，初始最近 2 页（100 轮），向上滚动增量加载
  const turns = await listRecentTurns(db, session.id, loadedPages, 'active');
  const greeting = await currentGreeting(db, session.id);

  wrap.append(el('div', { class: 'greeting' }, [`[greeting / seq 0] ${greeting}`]));

  // ---- 流式预览 / 停止 ----
  // 预览单独占一行，流式期间只改它的 textContent，不触发整页 render
  const preview = el('div', { class: 'stream' });
  const stopBtn = el('button', { class: 'warn' }, ['停止']);
  stopBtn.hidden = true;
  /** 演示模式（file://）下没有代理，不可能调到模型 */
  const demoMode = location.protocol === 'file:';

  /**
   * 生成一轮回复（流式期间暂停后台队列）。
   *
   * ⚠️ `setStreaming(true)` 的复位必须在 **finally**：异常类型多（网络/解析/取消），
   *    逐个 catch 一定会漏；漏一次后台任务就永久停摆且没有任何报错。
   */
  const runGeneration = async (
    userInput: string,
    opts: { cutoffSeq?: number } = {},
  ): Promise<GenerateReplyResult | null> => {
    const rt = await runtimePromise;
    const ac = new AbortController();
    stopBtn.onclick = () => ac.abort();
    stopBtn.hidden = false;
    let acc = '';
    preview.textContent = '';
    rt.setStreaming(true);
    try {
      return await generateAssistantReply({
        db,
        client: chatClient,
        sessionId: session.id,
        userInput,
        cutoffSeq: opts.cutoffSeq,
        signal: ac.signal,
        onDelta: (d) => {
          acc += d;
          preview.textContent = `AI：${acc}`;
        },
      });
    } finally {
      rt.setStreaming(false);
      stopBtn.hidden = true;
    }
  };

  for (const t of turns.filter((x) => x.seq > 0)) {
    const rev = await db.revisions.get(t.activeRevisionId);
    if (!rev) continue;
    const revs = await listRevisions(db, t.id);

    const item = el('div', { class: `turn ${t.status}` });
    const head = el('div', { class: 'turn-head' }, [
      `#${t.seq}`,
      revs.length > 1 ? el('span', { class: 'badge' }, [`v${revs.length}`]) : el('span'),
      t.status === 'discarded' ? el('span', { class: 'badge dim' }, ['已移除']) : el('span'),
      rev.status === 'interrupted' ? el('span', { class: 'badge warn' }, ['回复中断']) : el('span'),
    ]);

    // 聊天界面的纠错入口：依赖本轮注入了哪些事实（§5.7）
    if (rev.injectedFactIds?.length) {
      head.append(
        await (async () => {
          const facts = (await db.facts.bulkGet(rev.injectedFactIds!)).filter(
            (f): f is NonNullable<typeof f> => !!f,
          );
          const byId = new Map(facts.map((f) => [f.id, f]));
          const entry = disputedEntry(
            { db, sessionId: session.id, currentTurn: t.seq, rerender: render },
            rev.injectedFactIds!,
            byId,
          );
          return entry ?? el('span');
        })(),
      );
    }

    const menu = el('div', { class: 'menu' });
    const mk = (label: string, fn: () => Promise<void>) => {
      const b = el('button', {}, [label]);
      b.onclick = async () => {
        await fn();
        render();
      };
      return b;
    };
    menu.append(
      mk('编辑我的输入', async () => {
        const v = window.prompt('新的输入', rev.userContent);
        if (v !== null) await amend(db, session.id, t.id, { userContent: v });
      }),
      mk('编辑助手回复', async () => {
        const v = window.prompt('新的回复', rev.assistantContent);
        if (v !== null) await amend(db, session.id, t.id, { assistantContent: v });
      }),
      mk('从此轮重新生成', async () => {
        // 用该轮**之前**的历史组装：cutoffSeq = 该轮 seq，避免模型看到"未来"
        const res = await runGeneration(rev.userContent, { cutoffSeq: t.seq });
        if (!res) return;
        if (res.error && !res.text) {
          alert(`重新生成失败：${res.error.message}\n原内容已保留。`);
          return;
        }
        await regenerate(db, session.id, t.id, res.text || '（空回复）');
        if (res.error) alert(`重新生成中断，已保存已收到的部分内容：${res.error.message}`);
      }),
      mk('删除此轮之后', async () => {
        await truncate(db, session.id, t.seq);
      }),
    );
    // 中断轮：回复只写了一半，重试用 retry（不 discard 后续）
    if (rev.status === 'interrupted') {
      menu.append(
        mk('重试', async () => {
          const res = await runGeneration(rev.userContent, { cutoffSeq: t.seq });
          if (!res) return;
          if (res.error && !res.text) {
            alert(`重试失败：${res.error.message}\n原内容已保留。`);
            return;
          }
          await retry(db, session.id, t.id, res.text || '（空回复）');
        }),
      );
    }
    if (revs.length > 1) {
      menu.append(
        mk('版本历史', async () => {
          const lines = revs
            .map((r, i) => `${i + 1}. [${r.status}/${r.reason ?? '-'}] ${r.assistantContent.slice(0, 30)}`)
            .join('\n');
          const pick = window.prompt(`版本列表：\n${lines}\n\n输入要恢复到的序号（产生新版本，不删除当前）：`);
          const idx = Number(pick) - 1;
          if (Number.isInteger(idx) && revs[idx]) {
            await restoreToRevision(db, session.id, revs[idx].id);
          }
        }),
      );
    }
    item.append(head, el('div', { class: 'user' }, [`我：${rev.userContent}`]),
      el('div', { class: 'assistant' }, [`AI：${rev.assistantContent}`]), menu);
    wrap.append(item);
  }

  // ---- 加载更早（分页）----
  const oldestShown = turns[0]?.seq ?? 0;
  if (oldestShown > 1) {
    const more = el('button', {}, ['加载更早']);
    more.onclick = () => {
      loadedPages += 1;
      render();
    };
    wrap.append(el('div', { class: 'row' }, [more, el('span', { class: 'dim' }, [
      `已加载 ${turns.length} 轮（每页 50）`,
    ])]));
  }

  // ---- 废弃分支恢复 ----
  const discarded = await listDiscardedBranch(db, session.id);
  if (discarded.length) {
    const b = el('button', { class: 'warn' }, [`恢复已移除的 ${discarded.length} 轮`]);
    b.onclick = async () => {
      const res = await restoreDiscarded(db, session.id);
      if (!res.ok) alert(res.reason === 'branch-readonly' ? '已有新写入，废弃分支只读' : '无可恢复内容');
      render();
    };
    wrap.append(el('div', { class: 'row' }, [b, el('span', { class: 'dim' }, [
      `seq ${discarded.map((t) => t.seq).join(', ')}（不回收，恢复后时间线连续）`,
    ])]));
  }

  // ---- greeting 切换 ----
  const gb = el('button', {}, ['切换 greeting']);
  gb.onclick = async () => {
    const v = window.prompt('新的开场白');
    if (v === null) return;
    try {
      await switchGreeting(db, session.id, v);
    } catch (e) {
      alert((e as Error).message);
    }
    render();
  };
  wrap.append(el('div', { class: 'row' }, [gb, el('span', { class: 'dim' }, ['已有回复后将拒绝就地切换'])]));

  // ---- 模型配置（会话级模型名 + 本次运行的密钥）----
  // 模型名写进会话绑定（会随导出包带走，不含密钥）；
  // 密钥只进 `appConfig`，刷新即失效 —— 见 I-25（加密持久化推迟）。
  const modelInput = el('input', {
    value: session.modelBinding.main.model,
    placeholder: '模型名，如 gpt-4o-mini',
  }) as HTMLInputElement;
  modelInput.onchange = async () => {
    const model = modelInput.value.trim();
    if (!model) return;
    await db.sessions.update(session.id, {
      modelBinding: { ...session.modelBinding, main: { ...session.modelBinding.main, model } },
      updatedAt: Date.now(),
    });
  };
  const keyInput = el('input', {
    type: 'password',
    placeholder: 'API Key（仅本次运行，不落库）',
    value: appConfig.apiKey ?? '',
  }) as HTMLInputElement;
  keyInput.oninput = () => {
    appConfig.apiKey = keyInput.value;
  };
  wrap.append(
    el('div', { class: 'row' }, [
      el('span', {}, ['模型：']),
      modelInput,
      keyInput,
      el('span', { class: 'dim' }, ['代理由二进制 -upstream 转发；密钥留空则用代理侧凭证']),
    ]),
  );

  // ---- 发送 ----
  const input = el('textarea', { rows: '2', placeholder: '输入消息…' }) as HTMLTextAreaElement;
  const send = el('button', { class: 'primary' }, ['发送']) as HTMLButtonElement;
  send.disabled = demoMode;
  send.onclick = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    send.disabled = true;
    try {
      const res = await runGeneration(text);
      if (!res) return;
      // 失败也写：interrupted revision 保住用户输入，并让「重试」有落点（§4.2）
      // expectedSeq 必须现读：渲染时拿到的 session 快照在连发两条后会过期，
      // 传给 appendTurn 会直接抛 WriteConflictError（乐观锁），用户看到的是"发送失败"。
      const fresh = await db.sessions.get(session.id);
      await appendTurn(db, session.id, {
        userContent: text,
        assistantContent: res.text || '（空回复）',
        injectedFactIds: res.injectedFactIds,
        revisionStatus: res.error ? 'interrupted' : 'active',
        expectedSeq: fresh?.expectedSeq,
      });
      input.value = '';
      if (res.error) {
        alert(`请求失败：${res.error.message}\n已保存已收到的部分内容，可点「重试」。`);
      } else if (res.prompt.exhausted && res.prompt.hint) {
        alert(res.prompt.hint);
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      send.disabled = demoMode;
      render();
    }
  };
  wrap.append(el('div', { class: 'row' }, [input, send, stopBtn]));
  if (demoMode) {
    wrap.append(
      el('div', { class: 'cap cap-unavailable' }, [
        '演示模式（file://）无法调用模型：请用二进制启动后访问 http://127.0.0.1:8787',
      ]),
    );
  }
  wrap.append(preview);

  // ---- 模型绑定（会话级）----
  wrap.append(el('div', { class: 'dim' }, [
    `会话级绑定：main=${session.modelBinding.main.model}（切换会话时整套配置一并切换）`,
  ]));

  return wrap;
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.id === 'btn-persist') {
    requestPersistence().then((ok) => alert(ok ? '已授予持久化' : '未授予（Safari 可能不支持）'));
  }
  if (target.id === 'btn-export') {
    dbPromise.then(downloadBackup);
  }
  if (target.id === 'btn-summarize' && activeSessionId) {
    runtimePromise.then(async (rt) => {
      const added = await rt.scheduleSummaries(activeSessionId!);
      await rt.pump();
      await refreshIndicator();
      alert(added > 0 ? `已入队 ${added} 个摘要窗口并尝试生成` : '没有待生成窗口（已全部覆盖或在队列中）');
    });
  }
  if (target.id === 'btn-pump') {
    runtimePromise.then(async (rt) => {
      const n = await rt.pump();
      await refreshIndicator();
      alert(n > 0 ? `已处理 ${n} 个后台任务` : '队列为空或正在流式回复（已暂停）');
    });
  }
});

// 空闲时驱动后台队列（§5.11）：低频轮询，不打断交互；流式期间由 Runtime 自行暂停
setInterval(() => {
  runtimePromise
    .then(async (rt) => {
      const n = await rt.pump();
      if (n > 0) await refreshIndicator();
    })
    .catch(() => {
      /* 后台轮询失败不应影响对话 */
    });
}, 8_000);

render();
