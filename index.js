/**
 * jk-knowledge-base —— 宿主半入口。
 *
 * 契约：export { name, inject, apply }；所有注册都包在 ctx.effect(() => …, "标签") 里。
 * **刻意不导出 Config**：cordis 的 resolveConfig 会对 runtime.Config["~standard"].validate(...)
 * 取值，空对象会直接抛 TypeError；本插件也没有宿主侧可配置项。
 *
 * 两件事：
 * 1) 注册 jk_kb_* 工具（缺 tools 服务时跳过）；
 * 2) 注册 HTTP 路由（缺 webServer 时跳过）——设置读写、根目录校验、run 编排与溯源。
 * 任何一步缺能力都优雅退化，绝不抛异常。
 *
 * 诊断：工具注册结果留在模块级 toolRegistry，`GET /health` 直接读它；
 * apply 结束打一行 logger.info，apply 抛错打一行 logger.error（都只在有 logger 时）。
 */
import { createSettingsStore } from './host/config.js';
import { registerRoutes } from './host/routes.js';
import { createRunService, resolveRoute, serviceOf } from './host/orchestrator.js';
import * as trace from './host/trace.js';
import { createToolDefinitions } from './host/tools.js';

export const name = 'jk-knowledge-base';

export const inject = ['webServer', 'connection'];

// 收割间隔：60s。
const REAP_INTERVAL_MS = 60 * 1000;

// 模块级诊断状态：/health 与启动日志都读它（成功名单 + 失败清单）。
const toolRegistry = { registered: [], failed: [] };

function resetToolRegistry() {
  toolRegistry.registered.length = 0;
  toolRegistry.failed.length = 0;
}

function toolWarnings() {
  return toolRegistry.failed.map((item) => '工具 ' + item.name + ' 注册失败：' + item.error);
}

function logReady(ctx, routeCount) {
  const ok = toolRegistry.registered.length;
  const total = ok + toolRegistry.failed.length;
  const failedNames = toolRegistry.failed.map((item) => item.name).filter(Boolean).join(',') || '-';
  try {
    const logger = serviceOf(ctx, 'logger');
    if (!logger || typeof logger.info !== 'function') return;
    let providers = [];
    try {
      const subagents = serviceOf(ctx, 'subagents');
      providers = subagents && typeof subagents.list === 'function' ? subagents.list() : [];
    } catch (err) { providers = []; }
    const providerText = Array.isArray(providers) && providers.length ? providers.map(String).join(',') : 'none';
    const routeText = resolveRoute(ctx) ? 'ok' : 'none';
    logger.info(
      '[jk-knowledge-base] host ready: routes=' + routeCount
      + ' tools=' + ok + '/' + total
      + ' failed=[' + failedNames + ']'
      + ' subagents=' + providerText
      + ' route=' + routeText
    );
  } catch (err) { /* 没有 logger / 日志失败都静默 */ }
}

function reportApplyError(ctx, err) {
  try {
    const logger = serviceOf(ctx, 'logger');
    if (logger && typeof logger.error === 'function') {
      logger.error('[jk-knowledge-base] apply failed: ' + (err && err.stack ? err.stack : String(err)));
    }
  } catch (loggingError) { /* 没有 logger 就静默 */ }
}

export function apply(ctx, config) {
  try {
    return applyInner(ctx, config);
  } catch (err) {
    reportApplyError(ctx, err);
    throw err;
  }
}

function applyInner(ctx, config) {
  if (!ctx || typeof ctx.effect !== 'function') return;

  const store = createSettingsStore();
  resetToolRegistry();
  const runs = createRunService({
    ctx: ctx,
    store: store,
    toolWarnings: toolWarnings,
    toolState: () => toolRegistry,
  });

  // 工具是全局可见的；注册失败（例如宿主 schema 子集不认某个关键字）只跳过该工具，
  // 但会被记进 toolRegistry.failed：既写进 run.json 的 warnings[]，也出现在 /health。
  const tools = serviceOf(ctx, 'tools');
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => {
      const disposers = [];
      createToolDefinitions({ store: store }).forEach((definition) => {
        const toolName = definition && definition.name ? definition.name : 'unknown';
        try {
          const dispose = tools.register(definition);
          if (typeof dispose === 'function') disposers.push(dispose);
          toolRegistry.registered.push(toolName);
        } catch (err) {
          toolRegistry.failed.push({ name: toolName, error: err && err.message ? err.message : String(err) });
        }
      });
      return () => {
        disposers.forEach((dispose) => {
          try { dispose(); } catch (err) { /* 忽略 */ }
        });
      };
    }, 'jk-knowledge-base: tools');
  }

  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    logReady(ctx, 0);
    return;
  }

  let routeCount = 0;
  ctx.effect(() => {
    const disposers = registerRoutes(ctx, {
      store: store,
      runs: runs,
      toolState: () => toolRegistry,
      config: config || {},
    });
    routeCount = disposers.length;
    return () => {
      disposers.forEach((dispose) => {
        try { dispose(); } catch (err) { /* 单个路由释放失败不影响其它 */ }
      });
    };
  }, 'jk-knowledge-base: routes');

  // 每 60s 收割一次：超预算 → timed_out，心跳静默 → stalled。没有 root / 没有 running 就跳过。
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const settings = store.get();
        const root = settings && typeof settings.root === 'string' && settings.root ? settings.root : null;
        if (!root) return;
        if (!trace.findRunning(root)) return;
        trace.reap(root);
      } catch (err) { /* 定时任务永不抛 */ }
    }, REAP_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'jk-knowledge-base: reap');

  logReady(ctx, routeCount);
}
