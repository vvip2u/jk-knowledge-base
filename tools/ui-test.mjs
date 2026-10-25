#!/usr/bin/env node
/**
 * jk-knowledge-base 任务看板 UI 测试：纯 node 运行、零依赖、不联网、不写盘。
 *
 * 做法与 smoke-test.mjs 一致：stub window.__ModuleLoader__.load 捕获 factory，
 * 用 new Function('window', source) 执行 client.js，stub require('react') 后对
 * __internals 的纯函数与展示组件断言。额外用假 fetch 覆盖请求/错误态，
 * 用假 timer 覆盖轮询的启动、停止与卸载清理。
 *
 * 用法：node tools/ui-test.mjs → 全通过打印 UI TEST OK: n/m 并以 0 退出。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = readFileSync(path.join(root, 'client.js'), 'utf8');

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed += 1; return; }
  failures.push(name + (detail ? '  [' + detail + ']' : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function contains(name, haystack, needle) {
  ok(name, String(haystack == null ? '' : haystack).indexOf(needle) >= 0, '未找到「' + needle + '」');
}

// ───────────────────────────── 元素树工具（与 smoke 同构） ─────────────────────────────
function flatten(node, acc) {
  const out = acc || [];
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  if (node.children) flatten(node.children, out);
  return out;
}
function findAll(tree, key, value) {
  return flatten(tree).filter((el) => el.props && el.props[key] === value);
}
function findIn(tree, key, value) {
  return findAll(tree, key, value)[0];
}
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return textOf(node.children);
  return '';
}

// ───────────────────────────── stub React / loader ─────────────────────────────
let runEffects = false;
const capturedEffects = [];
const effectCleanups = [];

const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol.for('react.fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (reducer, initialArg, init) => [init ? init(initialArg) : initialArg, () => {}],
  useEffect: (fn) => {
    if (!runEffects) {
      capturedEffects.push(fn);
      return () => {};
    }
    const cleanup = fn();
    effectCleanups.push(cleanup);
    return cleanup;
  },
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
};

const stubRequire = (id) => {
  if (id === 'react') return stubReact;
  throw new Error('client.js 试图 require 未授权的模块: ' + id);
};

let captured = null;
const fakeWindow = {
  __ModuleLoader__: { load: (entry) => { captured = entry; } },
  localStorage: { getItem: () => null, setItem: () => {} },
};

let loadThrew = null;
try {
  // eslint-disable-next-line no-new-func
  new Function('window', source)(fakeWindow);
} catch (err) {
  loadThrew = err;
}
eq('执行 client.js 源码不抛异常', loadThrew, null);
ok('__ModuleLoader__.load 被调用', captured !== null);
if (!captured) {
  console.error('UI TEST FAIL: client.js 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}
const mod = captured.factory(stubRequire);
const I = mod && mod.__internals ? mod.__internals : {};
ok('导出 __internals 测试缝', !!I && typeof I.presentRuns === 'function');

// ───────────────────────────── 假 fetch ─────────────────────────────
function installFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init: init || {} };
    calls.push(call);
    const reply = await handler(call, calls.length);
    if (reply && reply.throw) throw new Error('network down');
    return {
      status: reply && reply.status ? reply.status : 200,
      json: async () => (reply && reply.body !== undefined ? reply.body : { ok: false }),
    };
  };
  return {
    calls,
    restore() {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    },
  };
}

const BASE_MS = Date.parse('2026-10-17T06:00:00.000Z');
const NOW_MS = BASE_MS + 65000;

// ═════════════════════════ 1. MENUS ═════════════════════════
eq('MENUS 共五条', I.MENUS.length, 5);
eq('首条是仪表盘', I.MENUS[0].id, 'dashboard');
eq('第二条是业务专家', I.MENUS[1].id, 'experts');
eq('第三条是文件管理', I.MENUS[2].id, 'files');
eq('第四条是任务管理', I.MENUS[3].id, 'tasks');
eq('第五条是使用信息', I.MENUS[4].id, 'usage');
eq('顺序为仪表盘 → 业务专家 → 文件管理 → 任务管理 → 使用信息', I.MENUS.map((menu) => menu.label).join(' → '), '仪表盘 → 业务专家 → 文件管理 → 任务管理 → 使用信息');
eq('首条 id 等于 DASHBOARD_ID', I.MENUS[0].id, I.DASHBOARD_ID);
eq('第二条 id 等于 EXPERTS_ID', I.MENUS[1].id, I.EXPERTS_ID);
eq('第三条 id 等于 FILES_ID', I.MENUS[2].id, I.FILES_ID);
eq('第四条 id 等于 TASKS_ID', I.MENUS[3].id, I.TASKS_ID);
eq('第五条 id 等于 USAGE_ID', I.MENUS[4].id, I.USAGE_ID);
eq('文件管理菜单标签', I.MENUS[2].label, '文件管理');
contains('业务专家描述注明卡片在设置页', I.MENUS[1].description, '卡片在设置页管理');

// 页面分发：业务专家保留页面但隐藏卡片区（卡片迁至设置页）；其余走各自页面
const expertsPage = I.PanelContent({
  rootStatus: 'ready',
  root: '/data/kb',
  activeMenu: I.MENUS[1],
});
eq('业务专家仍挂真实页面', expertsPage.type, I.ExpertsPage);
eq('主页面专家页隐藏卡片区', expertsPage.props.cardsHidden, true);
eq('业务专家不走占位页', findIn(expertsPage, 'data-jk-kb-placeholder', I.EXPERTS_ID), undefined);
// 回归防护：ExpertsPage 曾引用未定义的 unbindSkill 导致 DSH 真渲染白屏——直调本体捕获 ReferenceError。
let expertsRendered = null;
let expertsRenderError = '';
try { expertsRendered = I.ExpertsPage(); } catch (err) { expertsRenderError = String(err && err.message); }
// ExpertsPage 直调 ExpertsView(props)（非 createElement 包装），返回的已是内部元素树，断言根标记而非组件类型。
ok('业务专家页可完整渲染（无未定义引用）', !!expertsRendered && findIn(expertsRendered, 'data-jk-kb-experts', 'active') !== undefined, expertsRenderError);
ok('业务专家副标题用 blockquote 呈现', !!expertsRendered && findIn(expertsRendered, 'className', 'jk-kb-blockquote') !== undefined && findIn(expertsRendered, 'className', 'jk-kb-blockquote').type === 'blockquote');
// 业务专家模块已迁入设置页（基本信息下方）
const expertsModuleSrc = source.slice(source.indexOf("h('div', { className: 'jk-kb-experts-module'"), source.indexOf("h('div', { className: 'jk-kb-experts-module'") + 400);
ok('设置页包含业务专家模块容器', source.indexOf("'data-jk-kb-experts-module': 'true'") >= 0);
ok('业务专家模块套卡片壳（与基本信息同款 Card）', source.indexOf("Card({ 'data-jk-kb-card': 'experts' }") >= 0);
ok('业务专家模块挂载 ExpertsPage', expertsModuleSrc.indexOf('h(ExpertsPage, null)') >= 0);
const rootSectionIdx = source.indexOf("Card({\n        className: p.focusActive === true ? 'jk-kb-focus-pulse'");
const expertsModuleIdx = source.indexOf("'data-jk-kb-experts-module': 'true'");
ok('业务专家模块位于基本信息模块之后', rootSectionIdx >= 0 && expertsModuleIdx > rootSectionIdx);
const tasksPage = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[3] });
eq('任务管理页挂双视图容器', tasksPage.type, I.TasksPage);
const filesPage = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[2] });
eq('文件管理页挂 FilesPage', filesPage.type, I.FilesPage);
eq('文件管理不走占位页', findIn(filesPage, 'data-jk-kb-placeholder', I.FILES_ID), undefined);
const dashboardPage = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[0] });
ok('仪表盘行为不变', !!findIn(dashboardPage, 'data-jk-kb-dashboard', 'true'));
const usagePage = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[4] });
eq('使用信息页挂 UsagePage', usagePage.type, I.UsagePage);
eq('使用信息不走占位页', findIn(usagePage, 'data-jk-kb-placeholder', I.USAGE_ID), undefined);
const genericPlaceholder = I.PlaceholderPage({ id: 'future', label: '未来页' });
contains('其它菜单仍用通用占位说明', textOf(genericPlaceholder), '页面尚未实现。新增页面只需在 MENUS');

// 与 host/trace.js 的枚举对齐：RUN_STATUSES / STEP_STATUSES / degraded 码
eq('run completed → 完成', I.statusLabel('completed'), '完成');
eq('run cancelled → 已中止', I.statusLabel('cancelled'), '已中止');
eq('step start → 进行中', I.stepStatusLabel('start'), '进行中');
eq('step ok → 完成', I.stepStatusLabel('ok'), '完成');
eq('step skip → 已跳过', I.stepStatusLabel('skip'), '已跳过');
eq('step error → 失败', I.stepStatusLabel('error'), '失败');
eq('degraded no-agent 映射中文原因', I.describeDegraded('no-agent'), '未检测到可用的 agent，已降级为规则引擎执行');
eq('degraded no-route 映射中文原因', I.describeDegraded('no-route'), '没有可用的 agent 路由，已降级为规则引擎执行');
eq('未知 degraded 码原样展示', I.describeDegraded('weird'), 'weird');
eq('currentStep 为数字时展示 3/5', I.formatProgress({ stepCount: 5, currentStep: 3 }), '3/5');
eq('currentStep 为标题时展示步数+标题', I.formatProgress({ stepCount: 3, currentStep: '写入顶层目录' }), '3 步 · 写入顶层目录');
eq('两者都缺时展示占位', I.formatProgress({}), '—');

// ═════════════════════════ 2. runs 列表渲染 ═════════════════════════
const emptyView = I.RunsBoardView({ phase: 'ready', runs: [], onRunKind: () => {}, onRetry: () => {} });
ok('空态节点存在', !!findIn(emptyView, 'data-jk-kb-runs-empty', 'true'));
contains('空态显示暂无任务文案', textOf(findIn(emptyView, 'data-jk-kb-runs-empty', 'true')), '暂无任务');
ok('空态带任务图标', findIn(emptyView, 'data-jk-kb-runs-empty', 'true').children.some((child) => child && child.type === 'svg' && child.props.className.indexOf('jk-kb-empty-icon') >= 0));

const runningRun = {
  id: 'run-1',
  title: '建库：个人知识库',
  kind: 'bootstrap',
  status: 'running',
  startedAt: new Date(BASE_MS).toISOString(),
  endedAt: null,
  stepCount: 5,
  currentStep: 3,
  degraded: '未检测到 agent，使用规则引擎降级执行',
};
const doneRun = {
  id: 'run-2',
  title: '体检',
  kind: 'verify',
  status: 'completed',
  startedAt: new Date(BASE_MS).toISOString(),
  endedAt: new Date(BASE_MS + 120000).toISOString(),
  stepCount: 4,
  currentStep: 4,
  degraded: null,
};
const failedRun = {
  id: 'run-3',
  title: '重建索引',
  kind: 'reindex',
  status: 'failed',
  startedAt: new Date(BASE_MS).toISOString(),
  endedAt: new Date(BASE_MS + 30000).toISOString(),
  stepCount: 2,
  currentStep: 1,
  degraded: '',
};

const currentStepRun = Object.assign({}, runningRun, { id: 'run-4', title: '体检：进行中', kind: 'verify', stepCount: 3, currentStep: '写入顶层目录', degraded: 'no-agent' });
const mixedView = I.RunsBoardView({ phase: 'ready', runs: I.presentRuns([currentStepRun], NOW_MS), onRunKind: () => {}, onRetry: () => {} });
contains('字符串 currentStep 展示步数+标题', textOf(findIn(mixedView, 'data-jk-kb-run', 'run-4')), '3 步 · 写入顶层目录');
contains('降级码渲染为中文原因 tooltip', findIn(mixedView, 'data-jk-kb-run-degraded', 'run-4').props.title, '规则引擎');

const opened = [];
const rowsView = I.RunsBoardView({
  phase: 'ready',
  runs: I.presentRuns([runningRun, doneRun, failedRun], NOW_MS),
  onRunKind: () => {},
  onRetry: () => {},
  onOpenRun: (id) => opened.push(id),
});
const runningRow = findIn(rowsView, 'data-jk-kb-run', 'run-1');
ok('运行中的行为表格行', !!runningRow && runningRow.type === 'tr');
ok('运行中的行带 shadcn 表格行标记', runningRow.props['data-jk-kb-table-row'] === 'true');
eq('运行中的行 role=button', runningRow.props.role, 'button');
eq('运行中行的状态标记', runningRow.props['data-jk-kb-run-status'], 'running');
contains('运行中的类型显示「建库」', textOf(runningRow), '建库');
contains('运行中的步骤进度 3/5', textOf(runningRow), '3/5');
contains('运行中的状态文案', textOf(runningRow), '运行中');
eq('运行中耗时带「+」后缀', I.presentRuns([runningRun], NOW_MS)[0].durationText, '1m 05s+');
contains('运行中耗时渲染到行内', textOf(runningRow), '1m 05s+');
const degradedBadge = findIn(runningRow, 'data-jk-kb-run-degraded', 'run-1');
ok('degraded 非空时显示降级徽标', !!degradedBadge);
eq('降级徽标文案', textOf(degradedBadge), '无 agent 降级');
contains('降级徽标 tooltip 说明原因', degradedBadge.props.title, '未检测到 agent');
runningRow.props.onClick();
eq('点击行进入详情页', opened.join(','), 'run-1');

const doneRow = findIn(rowsView, 'data-jk-kb-run', 'run-2');
contains('完成态文案', textOf(doneRow), '完成');
contains('完成态进度 4/4', textOf(doneRow), '4/4');
contains('完成态耗时 2m 00s', textOf(doneRow), '2m 00s');
eq('完成态无降级徽标', findIn(doneRow, 'data-jk-kb-run-degraded', 'run-2'), undefined);

const failedRow = findIn(rowsView, 'data-jk-kb-run', 'run-3');
contains('失败态文案', textOf(failedRow), '失败');
ok('失败行带失败配色类', textOf(failedRow).length > 0
  && findAll(failedRow, 'data-jk-kb-run-status-label', 'failed').length === 1);
eq('失败态状态类名', findIn(failedRow, 'data-jk-kb-run-status-label', 'failed').props.className, 'jk-kb-status jk-kb-status-failed');

// 动作按钮 + 二次确认
const actionCalls = [];
const boardWithConfirm = I.RunsBoardView({
  phase: 'ready',
  runs: [],
  confirm: 'bootstrap',
  onRunKind: (kind) => actionCalls.push(kind),
  onConfirm: () => actionCalls.push('confirmed'),
  onCancelConfirm: () => actionCalls.push('cancelled'),
  onRetry: () => {},
});
const bootstrapBtn = findIn(boardWithConfirm, 'data-jk-kb-run-action', 'bootstrap');
eq('开始建库按钮存在', !!bootstrapBtn, true);
eq('建库/体检/索引三个动作齐全',
  ['bootstrap', 'verify', 'reindex'].filter((id) => !!findIn(boardWithConfirm, 'data-jk-kb-run-action', id)).length, 3);
const confirmBox = findIn(boardWithConfirm, 'data-jk-kb-confirm', 'bootstrap');
ok('未确认时渲染二次确认块', !!confirmBox);
contains('确认块说明不启用 force', textOf(confirmBox), 'force');
findIn(boardWithConfirm, 'data-jk-kb-confirm-yes', 'true').props.onClick();
eq('确认按钮回调', actionCalls.pop(), 'confirmed');
findIn(boardWithConfirm, 'data-jk-kb-confirm-no', 'true').props.onClick();
eq('取消按钮回调', actionCalls.pop(), 'cancelled');

// ═════════════════════════ 3. 详情页时间线 ═════════════════════════
const steps = [
  { id: 's1', role: 'JKKB-ORCH', title: '编排', status: 'start', startedAt: BASE_MS, inputSummary: '目标：建库' },
  {
    id: 's2',
    parentId: 's1',
    role: 'JKKB-BUILD',
    title: '建库',
    status: 'error',
    startedAt: BASE_MS,
    endedAt: BASE_MS + 5000,
    outputSummary: '写入 3 个目录',
    artifacts: [
      { path: '/kb/b.log', label: '日志' },
      '/kb/summary.json',
    ],
    error: { code: 'EACCES', message: '权限不足' },
  },
  { id: 's3', parentId: 's2', role: 'PLUGIN', title: '写文件', status: 'ok', startedAt: BASE_MS, endedAt: BASE_MS + 1000 },
  { id: 's4', parentId: 's2', role: 'PLUGIN', title: '可选步骤', status: 'skip', startedAt: BASE_MS, endedAt: BASE_MS + 1000 },
];
const detail = I.presentRunDetail({ run: runningRun, steps: steps }, NOW_MS);
eq('详情含运行中判定', detail.hasRunning, true);
eq('父链缩进 0/1/2/2', detail.steps.map((step) => step.depth).join(','), '0,1,2,2');
eq('step 状态映射（start/error/ok/skip）', detail.steps.map((step) => step.statusLabel).join(','), '进行中,失败,完成,已跳过');

const detailView = I.RunDetailView({
  phase: 'ready',
  detail: detail,
  onBack: () => opened.push('back'),
  onCancel: () => opened.push('cancel'),
  onRetry: () => {},
});
ok('时间线容器存在', !!findIn(detailView, 'data-jk-kb-timeline', 'true'));
const stepEls = flatten(detailView).filter((el) => el.props && el.props['data-jk-kb-step'] !== undefined);
eq('时间线渲染全部步骤', stepEls.length, 4);
eq('第一层缩进', stepEls[0].props['data-jk-kb-step-depth'], '0');
eq('第二层缩进', stepEls[1].props['data-jk-kb-step-depth'], '1');
eq('第三层缩进', stepEls[2].props['data-jk-kb-step-depth'], '2');
eq('缩进落到 marginLeft', stepEls[2].props.style.marginLeft, '32px');
contains('角色徽标 JKKB-ORCH', textOf(findIn(detailView, 'data-jk-kb-step-role', 'JKKB-ORCH')), 'JKKB-ORCH');
contains('角色徽标 JKKB-BUILD', textOf(findIn(detailView, 'data-jk-kb-step-role', 'JKKB-BUILD')), 'JKKB-BUILD');
contains('角色徽标 PLUGIN', textOf(findIn(detailView, 'data-jk-kb-step-role', 'PLUGIN')), 'PLUGIN');
contains('父步骤可见', textOf(detailView), '父步骤：s1');
contains('inputSummary 渲染', textOf(detailView), '目标：建库');
contains('outputSummary 渲染', textOf(detailView), '写入 3 个目录');
const failedStep = findIn(detailView, 'data-jk-kb-step', 's2');
ok('失败步骤带红框类', String(failedStep.props.className).indexOf('jk-kb-step-error') >= 0);
ok('失败步骤渲染错误框', !!findIn(failedStep, 'data-jk-kb-step-error', 's2'));
contains('错误文案可见', textOf(findIn(failedStep, 'data-jk-kb-step-error', 's2')), '权限不足');
eq('artifacts 按钮总数', flatten(detailView).filter((el) => el.props && el.props['data-jk-kb-artifact'] !== undefined).length, 2);
const logArtifact = findIn(detailView, 'data-jk-kb-artifact', '/kb/b.log');
ok('对象型 artifact 渲染并可点击复制', !!logArtifact && typeof logArtifact.props.onClick === 'function');
eq('对象型 artifact 用 label 展示', textOf(logArtifact), '日志');
ok('字符串型 artifact 渲染', !!findIn(detailView, 'data-jk-kb-artifact', '/kb/summary.json'));

ok('运行中显示中止按钮', !!findIn(detailView, 'data-jk-kb-cancel', 'true'));
findIn(detailView, 'data-jk-kb-cancel', 'true').props.onClick();
eq('中止按钮回调', opened.pop(), 'cancel');
findIn(detailView, 'data-jk-kb-back', 'true').props.onClick();
eq('返回列表按钮回调', opened.pop(), 'back');

const doneDetail = I.presentRunDetail({ run: doneRun, steps: [] }, NOW_MS);
const doneDetailView = I.RunDetailView({ phase: 'ready', detail: doneDetail, onBack: () => {}, onCancel: () => {}, onRetry: () => {} });
eq('已结束任务不显示中止按钮', findIn(doneDetailView, 'data-jk-kb-cancel', 'true'), undefined);
ok('无步骤时给时间线空提示', !!findIn(doneDetailView, 'data-jk-kb-timeline-empty', 'true'));
eq('详情状态文案', textOf(findIn(doneDetailView, 'data-jk-kb-detail-status', 'done')), '完成');
eq('已结束（completed）的 run 不再轮询', I.presentRunDetail({ run: doneRun, steps: [] }, NOW_MS).hasRunning, false);

// ═════════════════════════ 4. 轮询 ═════════════════════════
eq('有 running 时需轮询', I.hasRunningRuns([{ status: 'running' }]), true);
eq('全部结束时不轮询', I.hasRunningRuns([{ status: 'done' }, { status: 'failed' }]), false);
eq('空列表不轮询', I.hasRunningRuns([]), false);
eq('轮询间隔 1.5s', I.POLL_INTERVAL_MS, 1500);

const fakeTimers = { intervals: [], cleared: [] };
let ticked = 0;
const controller = I.createPollController({
  intervalMs: I.POLL_INTERVAL_MS,
  setInterval: (fn, ms) => { fakeTimers.intervals.push({ fn, ms }); return 'timer-' + fakeTimers.intervals.length; },
  clearInterval: (id) => { fakeTimers.cleared.push(id); },
  tick: () => { ticked += 1; },
});
eq('初始未启动', controller.isActive(), false);
eq('sync(true) 启动', controller.sync(true), true);
eq('只建一个 interval', fakeTimers.intervals.length, 1);
eq('interval 间隔 1500ms', fakeTimers.intervals[0].ms, 1500);
fakeTimers.intervals[0].fn();
eq('定时回调触发 tick', ticked, 1);
eq('重复 sync(true) 幂等', controller.sync(true), true);
eq('幂等不新建 interval', fakeTimers.intervals.length, 1);
const allDone = I.hasRunningRuns([{ status: 'done' }, { status: 'failed' }]);
eq('全部结束后 sync 停止', controller.sync(allDone), false);
eq('停止时清理 interval', fakeTimers.cleared.join(','), 'timer-1');
eq('停止后不再活跃', controller.isActive(), false);
controller.sync(true);
eq('重新变 running 可再次启动', fakeTimers.intervals.length, 2);
controller.stop();
eq('stop 清理第二个 interval', fakeTimers.cleared.join(','), 'timer-1,timer-2');

// 走真实 hook 路径：usePollingEffect（组件里调用的就是它）
const prevSetInterval = globalThis.setInterval;
const prevClearInterval = globalThis.clearInterval;
let envStarted = 0;
let envCleared = 0;
const envTimers = [];
globalThis.setInterval = (fn, ms) => { envStarted += 1; envTimers.push({ fn, ms }); return 'env-' + envStarted; };
globalThis.clearInterval = (id) => { envCleared += 1; };
try {
  runEffects = true;
  capturedEffects.length = 0;
  effectCleanups.length = 0;
  let hookTicks = 0;
  I.usePollingEffect(() => { hookTicks += 1; }, true);
  eq('running 时 hook 启动 interval', envStarted, 1);
  eq('hook 使用 1.5s 间隔', envTimers[0].ms, 1500);
  envTimers[0].fn();
  eq('hook 定时回调执行 refresh', hookTicks, 1);
  const cleanup = effectCleanups.pop();
  ok('hook 返回卸载清理函数', typeof cleanup === 'function');
  cleanup();
  eq('卸载时清理 interval', envCleared, 1);
  I.usePollingEffect(() => { hookTicks += 1; }, false);
  eq('全部结束（active=false）不启动 interval', envStarted, 1);
} finally {
  runEffects = false;
  globalThis.setInterval = prevSetInterval;
  globalThis.clearInterval = prevClearInterval;
}

// ═════════════════════════ 5. fetch 失败 → 错误态 + 重试 ═════════════════════════
let retried = 0;
const brokenFetch = installFetch(() => ({ throw: true }));
const failedResult = await I.fetchRuns();
brokenFetch.restore();
eq('host 不可达时 ok=false', failedResult.ok, false);
eq('错误码 host-unreachable', failedResult.error && failedResult.error.code, 'host-unreachable');
const goodState = I.reduceRunsPage(I.createRunsPageState(), { type: 'loaded', runs: [{ id: 'old', status: 'done' }] });
eq('先有一份旧数据', goodState.runs.length, 1);
const errState = I.reduceRunsPage(goodState, I.normalizeRunsResponse(failedResult));
eq('失败态落 error', errState.phase, 'error');
eq('失败态清空旧数据（不拿旧数据装正常）', errState.runs.length, 0);
const errView = I.RunsBoardView({
  phase: errState.phase,
  runs: I.presentRuns(errState.runs, NOW_MS),
  error: errState.error,
  onRetry: () => { retried += 1; },
  onRunKind: () => {},
});
ok('错误态节点存在', !!findIn(errView, 'data-jk-kb-runs-error', 'host-unreachable'));
contains('错误态文案为宿主服务未连接', textOf(errView), '宿主服务未连接');
const retryBtn = findIn(errView, 'data-jk-kb-retry', 'true');
ok('错误态提供重试按钮', !!retryBtn);
retryBtn.props.onClick();
eq('重试按钮绑定回调', retried, 1);
eq('错误态不渲染任务表', findIn(errView, 'data-jk-kb-run-table', 'true'), undefined);

const detailErrState = I.reduceRunDetail(I.createRunDetailState(), I.normalizeRunDetailResponse({ ok: false, error: { code: 'host-unreachable', message: 'x' } }));
eq('详情失败态落 error', detailErrState.phase, 'error');
const detailErrView = I.RunDetailView({ phase: detailErrState.phase, error: detailErrState.error, onBack: () => {}, onRetry: () => {}, onCancel: () => {} });
contains('详情错误态提示宿主未连接', textOf(detailErrView), '宿主服务未连接');
ok('详情错误态有重试', !!findIn(detailErrView, 'data-jk-kb-retry', 'true'));

// ═════════════════════════ 6. 动作按钮：二次确认 / POST / 409 ═════════════════════════
eq('未知 kind 被拒', I.planRunStart({ kind: 'nope' }).code, 'unknown-kind');
eq('体检不需要确认', I.planRunStart({ kind: 'verify' }).ok, true);
eq('建库未确认被拒', I.planRunStart({ kind: 'bootstrap' }).code, 'confirm-required');
eq('建库确认后放行', I.planRunStart({ kind: 'bootstrap', confirmed: true }).ok, true);

const startFetch = installFetch(() => ({ status: 200, body: { ok: true, run: { id: 'run-new', status: 'running' } } }));
const unconfirmed = await I.startRunRequest({ kind: 'bootstrap' });
eq('未确认时不发请求', startFetch.calls.length, 0);
eq('未确认返回 confirm-required', unconfirmed.code, 'confirm-required');
eq('未确认时 started=false', unconfirmed.started, false);
const confirmed = await I.startRunRequest({ kind: 'bootstrap', confirmed: true });
eq('确认后发出一次请求', startFetch.calls.length, 1);
eq('POST 到 /run', startFetch.calls[0].url, I.HOST_RUN_PATH);
eq('请求方法为 POST', startFetch.calls[0].init.method, 'POST');
eq('请求体 kind=bootstrap', JSON.parse(startFetch.calls[0].init.body).kind, 'bootstrap');
eq('默认不传 force', JSON.parse(startFetch.calls[0].init.body).force, undefined);
eq('确认后 started=true', confirmed.started, true);
await I.startRunRequest({ kind: 'verify', confirmed: true });
eq('体检 kind 正确', JSON.parse(startFetch.calls[1].init.body).kind, 'verify');
await I.startRunRequest({ kind: 'reindex', confirmed: true });
eq('重建索引 kind 正确', JSON.parse(startFetch.calls[2].init.body).kind, 'reindex');
startFetch.restore();

const conflictFetch = installFetch(() => ({
  status: 409,
  body: { ok: false, error: { code: 'run-in-progress', message: '已有一个任务在运行' } },
}));
const conflict = await I.startRunRequest({ kind: 'verify' });
conflictFetch.restore();
eq('409 run-conflict 被识别为冲突', conflict.conflict, true);
eq('409 root-missing 不算运行冲突', I.isRunConflict({ status: 409, error: { code: 'root-missing', message: '尚未配置知识库根目录' } }), false);
contains('root-missing 保留宿主原文', I.describeRunError({ status: 409, error: { code: 'root-missing', message: '尚未配置知识库根目录' } }), '尚未配置知识库根目录');
eq('409 不外报 started', conflict.started, false);
contains('409 给出友好提示', conflict.message, '已有任务在运行中');
const conflictNoticeView = I.RunsBoardView({
  phase: 'ready',
  runs: [],
  notice: { kind: 'error', text: conflict.message },
  onRunKind: () => {},
  onRetry: () => {},
});
const noticeEl = findIn(conflictNoticeView, 'data-jk-kb-runs-notice', 'error');
ok('409 提示渲染到通知条', !!noticeEl);
contains('通知条文案友好', textOf(noticeEl), '已有任务在运行中');

// ═════════════════════════ 7. 宿主半未加载 / 版本不一致 诊断 ═════════════════════════
async function withFetchStub(stub, fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
}

const notLoaded = await withFetchStub(
  async () => ({ status: 404, json: async () => { throw new Error('not json'); } }),
  () => I.loadHostConfig()
);
eq('HTTP 404 非 JSON → host-half-not-loaded', notLoaded.error.code, 'host-half-not-loaded');
contains('404 文案指向宿主半未加载', notLoaded.error.message, '宿主半未加载（HTTP 404）');
contains('404 文案给出 ⌘Q 操作指引', notLoaded.error.message, '⌘Q');
eq('404 文案与常量一致', notLoaded.error.message, I.HOST_NOT_LOADED_MESSAGE);

const json404 = await withFetchStub(
  async () => ({ status: 404, json: async () => ({ ok: false, error: { code: 'run-not-found', message: 'run 不存在' } }) }),
  () => I.fetchRunDetail('nope')
);
eq('JSON 404（run-not-found）不被误判为宿主半未加载', json404.error.code, 'run-not-found');

const mismatchProbe = await withFetchStub(
  async () => ({ status: 200, json: async () => ({ ok: true, host: true, version: '0.9.0' }) }),
  () => I.probeHost()
);
eq('探活成功但版本不一致 → mismatch', mismatchProbe.status, 'mismatch');
eq('版本提示文案', I.describeHealth(mismatchProbe, I.PLUGIN_VERSION).text,
  '宿主半版本 0.9.0 与界面 ' + I.PLUGIN_VERSION + ' 不一致，请重启应用');

const netProbe = await withFetchStub(async () => { throw new Error('down'); }, () => I.probeHost());
eq('探活网络失败 → error', netProbe.status, 'error');
const netHealth = I.describeHealth(netProbe, I.PLUGIN_VERSION);
contains('网络失败仍是「宿主服务未连接」', netHealth.text, '宿主服务未连接');
ok('网络失败不误报 404', netHealth.text.indexOf('宿主半未加载') < 0, netHealth.text);

const okProbe = await withFetchStub(
  async () => ({ status: 200, json: async () => ({ ok: true, host: true, version: I.PLUGIN_VERSION }) }),
  () => I.probeHost()
);
eq('探活成功且版本一致 → ready', okProbe.status, 'ready');
eq('版本一致时不显示诊断', I.describeHealth(okProbe, I.PLUGIN_VERSION).text, '');

const notLoadedSection = I.RootSection({
  host: { status: 'error', error: { code: 'host-half-not-loaded', message: I.HOST_NOT_LOADED_MESSAGE } },
  probe: { status: 'not-loaded', version: '', error: { code: 'host-half-not-loaded', message: I.HOST_NOT_LOADED_MESSAGE } },
  settings: {},
  draftRoot: '',
});
contains('设置页展示宿主半未加载文案', textOf(notLoadedSection), '宿主半未加载（HTTP 404）');
eq('404 诊断标记', findIn(notLoadedSection, 'data-jk-kb-host-error', 'host-half-not-loaded').props['data-jk-kb-host-error'], 'host-half-not-loaded');
eq('诊断信息只显示一处', flatten(notLoadedSection).filter((el) => el.props && el.props['data-jk-kb-host-error'] !== undefined).length, 1);

const mismatchSection = I.RootSection({
  host: { status: 'ready' },
  probe: { status: 'mismatch', version: '0.9.0', error: null },
  settings: {},
  draftRoot: '',
});
contains('设置页展示版本不一致', textOf(mismatchSection), '与界面 ' + I.PLUGIN_VERSION + ' 不一致，请重启应用');
eq('版本不一致标记', findIn(mismatchSection, 'data-jk-kb-host-error', 'host-version-mismatch').props['data-jk-kb-host-error'], 'host-version-mismatch');
contains('探活成功时徽标为已连接', textOf(I.RootSection({ host: { status: 'ready' }, probe: okProbe, settings: {}, draftRoot: '' })), '宿主已连接');
eq('探活成功且配置成功时无诊断行',
  flatten(I.RootSection({ host: { status: 'ready' }, probe: okProbe, settings: {}, draftRoot: '' }))
    .filter((el) => el.props && el.props['data-jk-kb-host-error'] !== undefined).length, 0);

// ═════════════════════════ 8. 设置页与引导态打磨 ═════════════════════════
// ── 假 DOM：只提供结构选择器需要的那一小块 ──
function makeNavRow(text) {
  const attrs = {};
  return {
    textContent: text,
    attrs,
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    removeAttribute(name) { delete attrs[name]; },
  };
}
// 只实现 [role="dialog"] nav button 与标记/style 选择器；故意不提供 .navLabel / querySelector。
function makeNavDoc(texts) {
  const rows = (texts || []).map(makeNavRow);
  const styles = [];
  const selectors = [];
  const head = {
    appendChild(node) { node.parentNode = head; styles.push(node); return node; },
    removeChild(node) {
      const at = styles.indexOf(node);
      if (at >= 0) styles.splice(at, 1);
      node.parentNode = null;
    },
  };
  const doc = {
    rows,
    styles,
    selectors,
    head,
    body: {},
    createElement(tag) {
      const node = {
        tagName: tag,
        attrs: {},
        textContent: '',
        setAttribute(name, value) { node.attrs[name] = String(value); },
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null; },
        remove() { head.removeChild(node); },
      };
      return node;
    },
    querySelectorAll(selector) {
      selectors.push(selector);
      if (selector === I.NAV_ROW_SELECTOR) return rows.slice();
      if (selector === '[' + I.NAV_ICON_MARKER + ']') {
        return rows.filter((row) => Object.prototype.hasOwnProperty.call(row.attrs, I.NAV_ICON_MARKER));
      }
      if (selector === I.NAV_STYLE_SELECTOR) return styles.slice();
      return [];
    },
  };
  return doc;
}
function makeFakeObserver() {
  const instances = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; instances.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    trigger() { if (!this.disconnected) this.callback([], this); }
  }
  return { FakeObserver, instances };
}
function makeMicrotaskQueue() {
  const queue = [];
  return {
    enqueue(fn) { queue.push(fn); },
    flush() { const pending = queue.splice(0); pending.forEach((fn) => fn()); return pending.length; },
    size() { return queue.length; },
  };
}
function makeFakeTimers() {
  let next = 1;
  const pending = new Map();
  const delays = [];
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, fn); delays.push(ms); return id; },
    clearTimeout(id) { pending.delete(id); },
    pendingCount() { return pending.size; },
    delays() { return delays.slice(); },
    fire(which) {
      const keys = Array.from(pending.keys());
      const id = which === undefined ? keys[0] : keys[which];
      if (id === undefined) return false;
      const fn = pending.get(id);
      pending.delete(id);
      fn();
      return true;
    },
  };
}
function makeStorage(seed) {
  const data = Object.assign({}, seed || {});
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
  };
}

// ── 1) 设置左栏图标：结构选择器 + 标记 + mask 样式 ──
eq('结构选择器固定为 [role="dialog"] nav button', I.NAV_ROW_SELECTOR, '[role="dialog"] nav button');
eq('标记属性名', I.NAV_ICON_MARKER, 'data-jk-kb-nav-icon');
eq('空标签不匹配任何行', I.isOwnNavRow('JK知识库', ''), false);
eq('纯空白标签不匹配任何行', I.isOwnNavRow('', '   '), false);
eq('文本严格相等才匹配', I.isOwnNavRow('JK知识库', 'JK知识库'), true);
eq('文本相近但不相等不匹配', I.isOwnNavRow('JK知识库 2', 'JK知识库'), false);
eq('rowText 为 null 时安全', I.isOwnNavRow(null, 'JK知识库'), false);

const navDoc = makeNavDoc(['插件', 'JK知识库', 'JK知识库 2', '']);
const navMicro = makeMicrotaskQueue();
const navObs = makeFakeObserver();
const disposeNav = I.installSettingsNavIcon({
  document: navDoc,
  MutationObserver: navObs.FakeObserver,
  queueMicrotask: navMicro.enqueue,
  resolveLabel: () => I.NAV_LABEL_TEXT,
});
eq('命中行被打标记', navDoc.rows[1].attrs[I.NAV_ICON_MARKER], '');
eq('其它行没有标记', Object.prototype.hasOwnProperty.call(navDoc.rows[0].attrs, I.NAV_ICON_MARKER), false);
eq('文本相近的行没有标记', Object.prototype.hasOwnProperty.call(navDoc.rows[2].attrs, I.NAV_ICON_MARKER), false);
eq('空文本行没有标记', Object.prototype.hasOwnProperty.call(navDoc.rows[3].attrs, I.NAV_ICON_MARKER), false);
eq('只查结构选择器（首帧）', navDoc.selectors[0], I.NAV_STYLE_SELECTOR);
ok('查过结构选择器', navDoc.selectors.indexOf(I.NAV_ROW_SELECTOR) >= 0);
eq('从不查询 CSS Module 类名', navDoc.selectors.filter((sel) => sel.indexOf('navLabel') >= 0).length, 0);
eq('假行没有 querySelector（证明实现没按类名找）', typeof navDoc.rows[0].querySelector, 'undefined');

// 空标签：整栏都不该被标记
const emptyDoc = makeNavDoc(['插件', 'JK知识库']);
const emptyMicro = makeMicrotaskQueue();
const emptyObs = makeFakeObserver();
const disposeEmpty = I.installSettingsNavIcon({
  document: emptyDoc,
  MutationObserver: emptyObs.FakeObserver,
  queueMicrotask: emptyMicro.enqueue,
  resolveLabel: () => '',
});
eq('标签为空时一行都不标', emptyDoc.rows.filter((row) => Object.prototype.hasOwnProperty.call(row.attrs, I.NAV_ICON_MARKER)).length, 0);
disposeEmpty();

// 样式：隐藏原齿轮 + mask 书本
const styleNode = navDoc.styles[0];
ok('注入了一份 style', !!styleNode);
eq('style data-plugin', styleNode.attrs['data-plugin'], 'jk-knowledge-base');
eq('style data-plugin-css', styleNode.attrs['data-plugin-css'], 'jk-knowledge-base/settings-nav-icon');
contains('隐藏原齿轮', styleNode.textContent, '[data-jk-kb-nav-icon] > svg{display:none;}');
contains('mask-image 使用运行时编码', styleNode.textContent, 'mask-image:url("' + I.bookMaskUrl() + '")');
contains('含 -webkit-mask-image', styleNode.textContent, '-webkit-mask-image:url("');
contains('mask 尺寸 16x16', styleNode.textContent, 'mask-size:16px 16px');
contains('mask 居中且不重复', styleNode.textContent, 'mask-position:center');
ok('mask URL 已编码（不含裸 <svg）', I.bookMaskUrl().indexOf('<') < 0 && I.bookMaskUrl().indexOf('%3Csvg') >= 0);
contains('书本是实心填充', I.bookMaskSvg(), 'fill="#000"');
contains('书本单 path 双子路径', I.bookMaskSvg(), 'Zm.7 0');
eq('书本不用 stroke', I.bookMaskSvg().indexOf('stroke='), -1);
eq('书本 viewBox 16x16', I.bookMaskSvg().indexOf('viewBox="0 0 16 16"') >= 0, true);

// 幂等：连续同步两次标记集合不变；重复安装不叠加 style
navObs.instances[0].trigger();
navObs.instances[0].trigger();
eq('微任务防抖只排一次', navMicro.size(), 1);
navMicro.flush();
eq('同步后命中行仍是唯一标记', navDoc.rows.filter((row) => Object.prototype.hasOwnProperty.call(row.attrs, I.NAV_ICON_MARKER)).length, 1);
navObs.instances[0].trigger();
navMicro.flush();
eq('再次同步不改变标记集合', navDoc.rows.filter((row) => Object.prototype.hasOwnProperty.call(row.attrs, I.NAV_ICON_MARKER)).length, 1);
eq('标记值仍为空串', navDoc.rows[1].attrs[I.NAV_ICON_MARKER], '');
const navMicro2 = makeMicrotaskQueue();
const navObs2 = makeFakeObserver();
const disposeNav2 = I.installSettingsNavIcon({
  document: navDoc,
  MutationObserver: navObs2.FakeObserver,
  queueMicrotask: navMicro2.enqueue,
  resolveLabel: () => I.NAV_LABEL_TEXT,
});
eq('重复安装不叠加 style', navDoc.styles.length, 1);

// 观察器参数
eq('observer 监听 childList', navObs.instances[0].options.childList, true);
eq('observer 监听 subtree', navObs.instances[0].options.subtree, true);
eq('observer 监听 characterData', navObs.instances[0].options.characterData, true);

// 卸载：断开、清标记、移除 style
disposeNav();
eq('dispose 断开 observer', navObs.instances[0].disconnected, true);
eq('dispose 移除所有标记', navDoc.rows.filter((row) => Object.prototype.hasOwnProperty.call(row.attrs, I.NAV_ICON_MARKER)).length, 0);
eq('首个实例卸载不误删新 style', navDoc.styles.length, 1);
disposeNav2();
eq('二次 dispose 移除 style', navDoc.styles.length, 0);
eq('二次 dispose 安全', navDoc.styles.length, 0);

// document 缺失时 no-op
eq('没有 document 时返回 noop', typeof I.installSettingsNavIcon({ document: null }), 'function');

// ── 2) 开关说明 tooltip ──
eq('hover 打开 tooltip', I.reduceInfoTip(false, { type: 'hover' }), true);
eq('focus 打开 tooltip', I.reduceInfoTip(false, { type: 'focus' }), true);
eq('leave 关闭 tooltip', I.reduceInfoTip(true, { type: 'leave' }), false);
eq('blur 关闭 tooltip', I.reduceInfoTip(true, { type: 'blur' }), false);
eq('Escape 关闭 tooltip', I.reduceInfoTip(true, { type: 'escape' }), false);
const tipOpenTree = I.SwitchInfoView({ open: true });
const tipEl = findIn(tipOpenTree, 'data-jk-kb-tooltip', 'true');
ok('打开时渲染气泡', !!tipEl);
contains('气泡是原说明全文', textOf(tipEl), '打开后，主界面侧边栏「插件」行的正下方出现「知识库」菜单');
contains('气泡含 localStorage 说明', textOf(tipEl), 'jk-knowledge-base:v1');
contains('气泡含刷新保持说明', textOf(tipEl), '刷新 / 重启后保持');
eq('关闭时不渲染气泡', findIn(I.SwitchInfoView({ open: false }), 'data-jk-kb-tooltip', 'true'), undefined);
const infoBtn = findIn(tipOpenTree, 'data-jk-kb-info', 'true');
eq('信息图标是 button（可 focus）', infoBtn.type, 'button');
eq('信息图标 aria-label=说明', infoBtn.props['aria-label'], '说明');
eq('title 兜底为原说明', infoBtn.props.title, I.SWITCH_HINT_TEXT);
eq('hover 绑定', typeof infoBtn.props.onMouseEnter, 'function');
eq('focus 绑定', typeof infoBtn.props.onFocus, 'function');
let escapeClosed = 0;
const tipEscTree = I.SwitchInfoView({ open: true, onEscape: () => { escapeClosed += 1; } });
findIn(tipEscTree, 'data-jk-kb-info', 'true').props.onKeyDown({ key: 'Escape', preventDefault() {} });
eq('Escape keydown 关闭回调', escapeClosed, 1);
contains('设置页仍有信息图标', textOf(findIn(I.SettingsSection({}), 'data-jk-kb-info', 'true')), '');
ok('长说明已移出设置页正文', textOf(I.SettingsSection({})).indexOf('打开后，主界面侧边栏') < 0);

// ── 3) 引导卡 ──
let guideCalls = 0;
const guideTree = I.GuidancePage({ reason: 'no-root', onOpenSettings: () => { guideCalls += 1; } });
contains('引导卡标题', textOf(guideTree), '还没有配置知识库根目录');
const guideSteps = flatten(guideTree).filter((el) => el.props && el.props['data-jk-kb-guide-step'] !== undefined);
eq('三个可点击步骤', guideSteps.length, 3);
eq('步骤顺序', guideSteps.map((el) => el.props['data-jk-kb-guide-step']).join(','), 'root,ack,save');
contains('步骤①文案', textOf(guideSteps[0]), '选择知识库根目录');
contains('步骤②文案', textOf(guideSteps[1]), '勾选风险确认');
contains('步骤③文案', textOf(guideSteps[2]), '点击「保存」');
guideSteps.forEach((el) => el.props.onClick());
eq('三个步骤各调一次 openSettingsForRoot', guideCalls, 3);
const guideCta = findIn(guideTree, 'data-jk-kb-guide-open-settings', 'true');
ok('主按钮存在', !!guideCta);
eq('主按钮文案', textOf(guideCta), '去设置里设置根目录');
guideCta.props.onClick();
eq('主按钮也只调一次', guideCalls, 4);
contains('脚注说明不会白屏', textOf(guideTree), '不会白屏');
eq('无 hint 时不渲染提示行', findIn(guideTree, 'data-jk-kb-guide-hint', 'true'), undefined);
const guideWithHint = I.GuidancePage({ reason: 'no-root', hint: I.GUIDE_STEP_HINT, onOpenSettings: () => {} });
contains('invoke 缺失时显示设置路径提示',
  textOf(findIn(guideWithHint, 'data-jk-kb-guide-hint', 'true')), '请打开 设置 → JK知识库');
const guideHost = I.GuidancePage({ reason: 'host-unreachable' });
eq('宿主不可用仍用旧标记', findIn(guideHost, 'data-jk-kb-guidance', 'host-unreachable').props['data-jk-kb-guidance'], 'host-unreachable');
eq('宿主不可用不渲染引导步骤',
  flatten(guideHost).filter((el) => el.props && el.props['data-jk-kb-guide-step'] !== undefined).length, 0);

// ── 4) openSettingsForRoot（ctx.get('shortcuts')） ──
const focusStore = makeStorage();
let invoked = null;
const shortcutCtx = {
  get(name) {
    if (name !== 'shortcuts') return undefined;
    return { invoke: async (id, context) => { invoked = { id, context }; } };
  },
};
const openedResult = await I.openSettingsForRoot({ storage: focusStore, ctx: shortcutCtx });
eq('打开设置返回 ok', openedResult.ok, true);
eq('先写 focus=root', focusStore.getItem(I.FOCUS_KEY), 'root');
eq('invoke 的 id', invoked.id, 'settings.open');
eq('invoke 的 context.modal 为 null', invoked.context && invoked.context.modal, null);
const missingCtx = { get: () => undefined };
const missing = await I.openSettingsForRoot({ storage: makeStorage(), ctx: missingCtx });
eq('拿不到 shortcuts → ok=false', missing.ok, false);
eq('拿不到 shortcuts → code', missing.code, 'shortcuts-unavailable');
eq('拿不到 shortcuts → 提示', missing.message, '请打开 设置 → JK知识库');
const throwingCtx = { get: () => ({ invoke: () => { throw new Error('boom'); } }) };
const thrown = await I.openSettingsForRoot({ storage: makeStorage(), ctx: throwingCtx });
eq('invoke 抛错 → ok=false', thrown.ok, false);
eq('invoke 抛错 → 提示', thrown.message, '请打开 设置 → JK知识库');
const noCtx = await I.openSettingsForRoot({ storage: makeStorage() });
eq('没有 ctx 也不崩', noCtx.ok, false);

// ── 5) focus 标记消费 + 高亮 ──
const focusStorage = makeStorage({ [I.FOCUS_KEY]: 'root' });
eq('focus=root 被消费', I.consumeFocusFlag(focusStorage), true);
eq('消费后删除 key', focusStorage.getItem(I.FOCUS_KEY), null);
eq('再次消费返回 false', I.consumeFocusFlag(focusStorage), false);
const otherFocus = makeStorage({ [I.FOCUS_KEY]: 'other' });
eq('非 root 值返回 false', I.consumeFocusFlag(otherFocus), false);
eq('非 root 值同样一次性删除', otherFocus.getItem(I.FOCUS_KEY), null);

const scrolled = [];
const highlightTimers = makeFakeTimers();
let highlightEnded = 0;
const highlight = I.startFocusHighlight(
  { scrollIntoView: (arg) => scrolled.push(arg) },
  {
    setTimeout: highlightTimers.setTimeout,
    clearTimeout: highlightTimers.clearTimeout,
    onEnd: () => { highlightEnded += 1; },
  }
);
eq('高亮 active', highlight.active, true);
eq('滚动到视口中间', JSON.stringify(scrolled), JSON.stringify([{ block: 'center' }]));
eq('高亮持续 2500ms', highlightTimers.delays()[0], I.FOCUS_HIGHLIGHT_MS);
highlightTimers.fire();
eq('2.5s 后移除高亮回调', highlightEnded, 1);
eq('没有元素时不高亮', I.startFocusHighlight(null, {}).active, false);

const focusSection = I.RootSection({ host: { status: 'ready' }, settings: {}, draftRoot: '', focusActive: true });
ok('高亮标记 data-jk-kb-focus=root', !!findIn(focusSection, 'data-jk-kb-focus', 'root'));
contains('高亮 class 加上', focusSection.props.className, 'jk-kb-focus-pulse');
const plainSection = I.RootSection({ host: { status: 'ready' }, settings: {}, draftRoot: '' });
eq('未消费时无高亮标记',
  flatten(plainSection).filter((el) => el.props && el.props['data-jk-kb-focus'] !== undefined).length, 0);
ok('未消费时无高亮 class', String(plainSection.props.className).indexOf('jk-kb-focus-pulse') < 0);

// 设置页 mount 真正消费 focus 标记（走真实 hook：stub useEffect 立即执行）
const prevRunEffects = runEffects;
const prevLocalStorage = globalThis.localStorage;
const prevSetTimeout = globalThis.setTimeout;
const prevClearTimeout = globalThis.clearTimeout;
const mountedStorage = makeStorage();
const mountedTimers = makeFakeTimers();
const prevWindowStorage = fakeWindow.localStorage;
fakeWindow.localStorage = mountedStorage;
globalThis.localStorage = mountedStorage;
globalThis.setTimeout = mountedTimers.setTimeout;
globalThis.clearTimeout = mountedTimers.clearTimeout;
const settingsFetch = installFetch((call) => {
  if (call.url === I.HOST_HEALTH_PATH) return { body: { ok: true, host: true, version: I.PLUGIN_VERSION } };
  return { body: { ok: true, settings: {}, discovery: null } };
});
mountedStorage.setItem(I.FOCUS_KEY, 'root');
try {
  runEffects = true;
  I.SettingsSection({});
} finally {
  runEffects = prevRunEffects;
  settingsFetch.restore();
  globalThis.setTimeout = prevSetTimeout;
  globalThis.clearTimeout = prevClearTimeout;
  fakeWindow.localStorage = prevWindowStorage;
  if (prevLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = prevLocalStorage;
}
eq('设置页 mount 后 focus key 被删除', mountedStorage.getItem(I.FOCUS_KEY), null);

// ═════════════════════════ 9. S1 run 状态与心跳 ═════════════════════════
const HB = Date.parse('2026-10-17T06:00:00.000Z');
const hbIso = (offsetMs) => new Date(HB + offsetMs).toISOString();
const emptyDetailView = (run) => I.RunDetailView({
  phase: 'ready',
  detail: I.presentRunDetail({ run: run, steps: [] }, HB),
  onBack: () => {},
  onCancel: () => {},
  onRetry: () => {},
});

// 状态映射
eq('timed_out → 已超时', I.statusLabel('timed_out'), '已超时');
eq('stalled → 已卡住', I.statusLabel('stalled'), '已卡住');
eq('abandoned → 已放弃', I.statusLabel('abandoned'), '已放弃');
eq('timed_out tone', I.normalizeRunStatus('timed_out'), 'timed_out');
eq('stalled tone', I.normalizeRunStatus('stalled'), 'stalled');
eq('abandoned tone', I.normalizeRunStatus('abandoned'), 'abandoned');
eq('未知状态原样展示', I.statusLabel('weird_status'), 'weird_status');
eq('未知状态仍为 unknown', I.normalizeRunStatus('weird_status'), 'unknown');
ok('已超时用红色', I.PANEL_STYLE.indexOf('.jk-kb-status-timed_out{color:var(--dsw-alias-state-error-primary);') >= 0);
ok('已卡住用红色', I.PANEL_STYLE.indexOf('.jk-kb-status-stalled{color:var(--dsw-alias-state-error-primary);') >= 0);
ok('已放弃用灰色', I.PANEL_STYLE.indexOf('.jk-kb-status-abandoned{color:var(--dsw-alias-label-tertiary);}') >= 0);

// 心跳年龄（秒 / 分 / 时）
eq('心跳 5 秒', I.formatHeartbeatAge(hbIso(0), HB + 5000), '5s');
eq('心跳 2 分', I.formatHeartbeatAge(hbIso(0), HB + 130000), '2m');
eq('心跳 1 小时', I.formatHeartbeatAge(hbIso(0), HB + 3700000), '1h');
eq('心跳缺失 → —', I.formatHeartbeatAge(null, HB), '—');
eq('心跳非法值 → —', I.formatHeartbeatAge('not-a-date', HB), '—');
eq('心跳未来时间按 0s 处理', I.formatHeartbeatAge(hbIso(5000), HB), '0s');
eq('now 缺失也不抛', typeof I.formatHeartbeatAge(hbIso(0)), 'string');

// 阈值与疑似卡住
eq('agent 阈值 120s', I.heartbeatThresholdMs('agent'), 120000);
eq('engine 阈值 300s', I.heartbeatThresholdMs('engine'), 300000);
eq('heartbeatBy 缺失按 agent', I.heartbeatThresholdMs(null), 120000);
const beatRun = (status, ageMs, by) => ({
  status: status,
  heartbeatBy: by,
  heartbeatAt: new Date(HB - ageMs).toISOString(),
});
eq('agent 119s 不标', I.isSuspectedStall(beatRun('running', 119000, 'agent'), HB), false);
eq('agent 121s 标', I.isSuspectedStall(beatRun('running', 121000, 'agent'), HB), true);
eq('engine 299s 不标', I.isSuspectedStall(beatRun('running', 299000, 'engine'), HB), false);
eq('engine 301s 标', I.isSuspectedStall(beatRun('running', 301000, 'engine'), HB), true);
eq('非 running 不标', I.isSuspectedStall(beatRun('completed', 999000, 'agent'), HB), false);
eq('无心跳不标', I.isSuspectedStall({ status: 'running' }, HB), false);

// 预算：优先由 startedAt + deadlineAt 推导（契约里没有预算字段）
const deadlineBudgetRun = {
  status: 'running',
  startedAt: new Date(HB - 65000).toISOString(),
  deadlineAt: new Date(HB + 235000).toISOString(),
};
const deadlineBudget = I.presentRun(deadlineBudgetRun, HB);
eq('预算按 deadlineAt-startedAt 推导', deadlineBudget.budgetText, '1m 05s/5m 00s');
eq('推导预算来源', deadlineBudget.budgetSource, 'deadline');
eq('推导预算未超额', deadlineBudget.budgetOver, false);
const pastDeadline = I.presentRun({
  status: 'running',
  startedAt: new Date(HB - 200000).toISOString(),
  deadlineAt: new Date(HB - 100000).toISOString(),
}, HB);
eq('超过截止时间预算文本', pastDeadline.budgetText, '3m 20s/1m 40s');
eq('超过截止时间标红', pastDeadline.budgetOver, true);
const derivedWins = I.presentRun(Object.assign({}, deadlineBudgetRun, { budgetUsed: 99, budgetTotal: 1 }), HB);
eq('时间推导优先于显式字段', derivedWins.budgetText, '1m 05s/5m 00s');
eq('时间推导优先时来源正确', derivedWins.budgetSource, 'deadline');
eq('回退 budgetUsed/budgetTotal', I.presentRun({ budgetUsed: 3, budgetTotal: 20 }, HB).budgetText, '3/20');
eq('回退字段来源', I.presentRun({ budgetUsed: 3, budgetTotal: 20 }, HB).budgetSource, 'fields');
eq('回退字段超支标红', I.presentRun({ budgetUsed: 21, budgetTotal: 20 }, HB).budgetOver, true);
eq('回退兼容 stepsUsed/stepBudget', I.readBudget({ stepsUsed: 2, stepBudget: 5 }).text, '2/5');
eq('只有 deadlineAt 无 startedAt → —', I.presentRun({ deadlineAt: new Date(HB + 1000).toISOString() }, HB).budgetText, '—');
eq('缺预算 → —', I.presentRun({}, HB).budgetText, '—');
eq('读预算对 null 安全', I.readBudget(null).text, '—');

// 列表：心跳列 / 黄标 / 预算列
const hbTask = {
  id: 'hb-1',
  title: '心跳任务',
  kind: 'bootstrap',
  status: 'running',
  startedAt: hbIso(-600000),
  endedAt: null,
  stepCount: 2,
  currentStep: '执行中',
  heartbeatAt: hbIso(-121000),
  heartbeatBy: 'agent',
  budgetUsed: 21,
  budgetTotal: 20,
};
const hbListView = I.RunsBoardView({
  phase: 'ready',
  runs: I.presentRuns([hbTask], HB),
  onRunKind: () => {},
  onRetry: () => {},
  onOpenRun: () => {},
});
contains('列表显示心跳年龄 2m', textOf(findIn(hbListView, 'data-jk-kb-heartbeat', 'hb-1')), '2m');
const suspectedBadge = findIn(hbListView, 'data-jk-kb-suspected', 'hb-1');
ok('超阈值渲染疑似卡住黄标', !!suspectedBadge);
eq('黄标文案', textOf(suspectedBadge), '疑似卡住');
contains('黄标 tooltip 给出 120 秒阈值', suspectedBadge.props.title, '120 秒');
const budgetCell = findIn(hbListView, 'data-jk-kb-budget', 'hb-1');
eq('预算单元格文案', textOf(budgetCell), '21/20');
eq('预算超支 data 标记', budgetCell.props['data-jk-kb-budget-over'], 'true');
contains('预算超支红色类', budgetCell.props.className, 'jk-kb-budget-over');
const calmTask = Object.assign({}, hbTask, { id: 'hb-2', heartbeatAt: hbIso(-10000) });
const calmView = I.RunsBoardView({ phase: 'ready', runs: I.presentRuns([calmTask], HB), onRunKind: () => {}, onRetry: () => {} });
eq('未超阈值无黄标', findIn(calmView, 'data-jk-kb-suspected', 'hb-2'), undefined);
const deadlineTask = {
  id: 'bd-1',
  title: '预算任务',
  kind: 'verify',
  status: 'running',
  startedAt: new Date(HB - 65000).toISOString(),
  deadlineAt: new Date(HB + 235000).toISOString(),
  heartbeatAt: new Date(HB - 5000).toISOString(),
};
const deadlineListView = I.RunsBoardView({ phase: 'ready', runs: I.presentRuns([deadlineTask], HB), onRunKind: () => {}, onRetry: () => {} });
eq('列表预算来自时间推导', textOf(findIn(deadlineListView, 'data-jk-kb-budget', 'bd-1')), '1m 05s/5m 00s');
eq('列表推导预算未标红', findIn(deadlineListView, 'data-jk-kb-budget', 'bd-1').props['data-jk-kb-budget-over'], undefined);
const noBeatTask = Object.assign({}, hbTask, { id: 'hb-3', heartbeatAt: null, budgetUsed: null, budgetTotal: null });
const noBeatView = I.RunsBoardView({ phase: 'ready', runs: I.presentRuns([noBeatTask], HB), onRunKind: () => {}, onRetry: () => {} });
eq('无心跳显示 —', textOf(findIn(noBeatView, 'data-jk-kb-heartbeat', 'hb-3')), '—');
eq('无预算显示 —', textOf(findIn(noBeatView, 'data-jk-kb-budget', 'hb-3')), '—');
contains('表头心跳', textOf(hbListView), '心跳');
contains('表头预算', textOf(hbListView), '预算');

// 详情：说明条 + 新字段摘要行
const stalledRun = {
  id: 'st-1',
  title: '卡住任务',
  kind: 'verify',
  status: 'stalled',
  startedAt: hbIso(-600000),
  endedAt: null,
  heartbeatAt: hbIso(-400000),
  heartbeatBy: 'engine',
  deadlineAt: hbIso(600000),
  cancelRequestedAt: hbIso(-50000),
  stalledAt: hbIso(-30000),
  timedOutAt: null,
  acceptanceFailed: true,
};
const stalledView = emptyDetailView(stalledRun);
const stalledNotice = findIn(stalledView, 'data-jk-kb-run-notice', 'stalled');
ok('stalled 顶部说明条', !!stalledNotice);
contains('说明条文案', textOf(stalledNotice), '该任务已卡住。默认动作是重新开始，并先备份旧产物到 .jkkb/backup/。');
contains('详情显示心跳时间', textOf(findIn(stalledView, 'data-jk-kb-detail-heartbeat', 'true')), '-');
eq('详情心跳来源 engine', textOf(findIn(stalledView, 'data-jk-kb-detail-heartbeat-by', 'true')), 'engine');
ok('详情截止时间非占位', textOf(findIn(stalledView, 'data-jk-kb-detail-deadline', 'true')) !== '—');
ok('详情中止请求非占位', textOf(findIn(stalledView, 'data-jk-kb-detail-cancel-requested', 'true')) !== '—');
ok('详情卡住标记非占位', textOf(findIn(stalledView, 'data-jk-kb-detail-stalled', 'true')) !== '—');
eq('详情超时标记缺省 —', textOf(findIn(stalledView, 'data-jk-kb-detail-timed-out', 'true')), '—');
eq('详情验收失败行', textOf(findIn(stalledView, 'data-jk-kb-detail-acceptance-failed', 'true')), '是');
eq('说明条不造动作按钮', flatten(stalledView).filter((el) => el.props && el.props['data-jk-kb-restart'] !== undefined).length, 0);

const timedOutView = emptyDetailView({ id: 'to-1', title: '超时任务', kind: 'reindex', status: 'timed_out' });
contains('timed_out 顶部说明条', textOf(findIn(timedOutView, 'data-jk-kb-run-notice', 'timed_out')), '该任务已超时。');
eq('running 无说明条', findIn(emptyDetailView({ id: 'r-1', status: 'running' }), 'data-jk-kb-run-notice', 'running'), undefined);
eq('completed 无说明条', findIn(emptyDetailView({ id: 'c-1', status: 'completed' }), 'data-jk-kb-run-notice', 'completed'), undefined);
eq('timed_out 状态文案', textOf(findIn(timedOutView, 'data-jk-kb-detail-status', 'timed_out')), '已超时');
eq('abandoned 状态文案', I.statusLabel('abandoned'), '已放弃');

// 缺字段：一律 —，不抛
const bare = I.presentRun({}, HB);
eq('缺心跳时间 → —', bare.heartbeatAtText, '—');
eq('缺心跳年龄 → —', bare.heartbeatAgeText, '—');
eq('缺 heartbeatBy → —', bare.heartbeatByText, '—');
eq('缺 deadline → —', bare.deadlineText, '—');
eq('缺 cancelRequestedAt → —', bare.cancelRequestedText, '—');
eq('缺 stalledAt → —', bare.stalledText, '—');
eq('缺 timedOutAt → —', bare.timedOutText, '—');
eq('缺预算 → —', bare.budgetText, '—');
eq('缺 acceptanceFailed 不显示', bare.acceptanceFailed, false);
ok('缺字段时详情仍渲染摘要行', textOf(emptyDetailView({})).indexOf('心跳来源') >= 0);
ok('空 detail 详情页不抛', !!I.RunDetailView({ phase: 'ready', detail: I.presentRunDetail(null), onBack: () => {}, onRetry: () => {}, onCancel: () => {} }));

// ═════════════════════════ 10. 环境体检 preflight ═════════════════════════
// 通过 / 警告 / 失败三种结论
const pfOkReport = {
  ok: true,
  code: '',
  checks: [{ id: 'structure', level: 'ok', title: '目录结构', detail: '13 个顶层目录齐全' }],
  counts: { files: 12, notes: 34, limit: 500 },
  freeBytes: 512 * 1024 * 1024,
  elapsedMs: 42,
};
const pfOk = I.presentPreflight(pfOkReport);
eq('通过结论', pfOk.level, 'ok');
eq('通过文案', pfOk.label, '通过');
eq('counts 文案', pfOk.countsText, '文件 12 / 上限 500 · 笔记 34');
eq('剩余空间格式化', pfOk.freeText, '512 MB');
eq('耗时格式化', pfOk.elapsedText, '42 ms');
eq('通过时无兜底建议', pfOk.advice, '');
eq('check 保留 ok 级', pfOk.checks[0].level, 'ok');
eq('check 标题', pfOk.checks[0].title, '目录结构');
eq('check 详情', pfOk.checks[0].detail, '13 个顶层目录齐全');

const pfWarn = I.presentPreflight({ ok: true, checks: [
  { id: 'w1', level: 'warn', title: '文件数偏多', detail: '接近上限' },
  { id: 'w2', level: 'warn', title: '索引较旧', detail: '建议重建', fix: '点「重建索引」' },
] });
eq('警告结论', pfWarn.level, 'warn');
eq('警告文案计数', pfWarn.label, '2 项警告');
eq('警告 check 级别', pfWarn.checks[0].level, 'warn');

const pfErrorReport = {
  ok: false,
  code: 'ROOT_NOT_WRITABLE',
  checks: [
    { id: 'writable', level: 'error', title: '目录不可写', detail: 'EACCES: permission denied', fix: '请检查权限或磁盘挂载' },
    { id: 'files', level: 'warn', title: '文件数偏多', detail: '接近上限' },
    { id: 'structure', level: 'ok', title: '目录结构', detail: '正常' },
  ],
  counts: { files: 1 },
  freeBytes: null,
  elapsedMs: null,
};
const pfError = I.presentPreflight(pfErrorReport);
eq('失败结论', pfError.level, 'error');
eq('失败文案', pfError.label, '失败');
eq('fix 原样保留', pfError.checks[0].fix, '请检查权限或磁盘挂载');
eq('缺 freeBytes → —', pfError.freeText, '—');
eq('缺 elapsedMs → —', pfError.elapsedText, '—');
eq('缺 counts 子项 → 部分占位', pfError.countsText, '文件 1 / 上限 — · 笔记 —');
eq('有 checks 时不用兜底建议', pfError.advice, '');
eq('未知级别按 ok（灰）', I.presentPreflight({ checks: [{ id: 'x', level: 'weird', title: 't', detail: 'd' }] }).checks[0].level, 'ok');
eq('空报告不抛且默认通过', I.presentPreflight({}).label, '通过');
eq('null 报告不抛', I.presentPreflight(null).level, 'ok');

// 使用信息页顶部：体检行 + 展开卡片（自任务管理页迁来，与 dashboard 数据互不依赖）
const pfUsageView = (pf) => I.UsageView({
  phase: 'ready',
  data: null,
  preflight: pf,
  onRecheck: () => {},
  onTogglePreflight: () => {},
});
const pfErrorView = pfUsageView({ phase: 'ready', report: pfErrorReport, expanded: true });
eq('体检行失败态', findIn(pfErrorView, 'data-jk-kb-preflight', 'error').props['data-jk-kb-preflight'], 'error');
eq('体检结论文案失败', textOf(findIn(pfErrorView, 'data-jk-kb-preflight-summary', 'true')), '失败');
eq('失败时展开卡片', findIn(pfErrorView, 'data-jk-kb-preflight-card', 'error').props['data-jk-kb-preflight-card'], 'error');
const pfChecks = flatten(pfErrorView).filter((el) => el.props && el.props['data-jk-kb-check'] !== undefined);
eq('checks 逐项渲染', pfChecks.length, 3);
eq('error 项标记', findIn(pfErrorView, 'data-jk-kb-check', 'writable').props['data-jk-kb-check-level'], 'error');
contains('error 项红色类', findIn(pfErrorView, 'data-jk-kb-check', 'writable').props.className, 'jk-kb-check-error');
eq('warn 项标记', findIn(pfErrorView, 'data-jk-kb-check', 'files').props['data-jk-kb-check-level'], 'warn');
contains('warn 项黄色类', findIn(pfErrorView, 'data-jk-kb-check', 'files').props.className, 'jk-kb-check-warn');
eq('ok 项标记', findIn(pfErrorView, 'data-jk-kb-check', 'structure').props['data-jk-kb-check-level'], 'ok');
contains('ok 项灰色类', findIn(pfErrorView, 'data-jk-kb-check', 'structure').props.className, 'jk-kb-check-ok');
contains('check 标题渲染', textOf(findIn(pfErrorView, 'data-jk-kb-check', 'writable')), '目录不可写');
contains('check 详情渲染', textOf(findIn(pfErrorView, 'data-jk-kb-check', 'writable')), 'EACCES: permission denied');
contains('fix 渲染', textOf(findIn(pfErrorView, 'data-jk-kb-check', 'writable')), '修复：请检查权限或磁盘挂载');
ok('fix 有独立标记', !!findIn(pfErrorView, 'data-jk-kb-check-fix', 'writable'));
eq('错误码徽标', textOf(findIn(pfErrorView, 'data-jk-kb-preflight-code', 'ROOT_NOT_WRITABLE')), 'ROOT_NOT_WRITABLE');
eq('体检抬头有重新检查按钮', !!findIn(pfErrorView, 'data-jk-kb-preflight-recheck', 'true'), true);

const pfCollapsed = pfUsageView({ phase: 'ready', report: pfErrorReport, expanded: false });
eq('收起时不渲染卡片', findIn(pfCollapsed, 'data-jk-kb-preflight-card', 'error'), undefined);
const pfWarnView = pfUsageView({ phase: 'ready', report: { ok: true, checks: pfWarn.checks.map((check) => ({ id: check.id, level: 'warn', title: check.title, detail: check.detail })) }, expanded: false });
eq('警告结论文案', textOf(findIn(pfWarnView, 'data-jk-kb-preflight-summary', 'true')), '2 项警告');
const pfOkView = pfUsageView({ phase: 'ready', report: pfOkReport, expanded: false });
eq('通过结论文案', textOf(findIn(pfOkView, 'data-jk-kb-preflight-summary', 'true')), '通过');

// 加载 / 不可用 / 未知 降级
const pfLoadingView = pfUsageView({ phase: 'loading' });
eq('体检中文案', textOf(findIn(pfLoadingView, 'data-jk-kb-preflight-summary', 'true')), '体检中…');
eq('体检中禁用重新检查', findIn(pfLoadingView, 'data-jk-kb-preflight-recheck', 'true').props.disabled, true);
const pfUnavailableView = pfUsageView({ phase: 'error', error: { code: 'host-unreachable', message: '连接被拒绝' } });
eq('体检不可用文案', textOf(findIn(pfUnavailableView, 'data-jk-kb-preflight-summary', 'true')), '体检不可用');
eq('体检不可用标记', findIn(pfUnavailableView, 'data-jk-kb-preflight', 'unavailable').props['data-jk-kb-preflight'], 'unavailable');
contains('体检不可用展示原因', textOf(findIn(pfUnavailableView, 'data-jk-kb-preflight-error', 'host-unreachable')), '连接被拒绝');
const pfEmptyView = pfUsageView({ phase: 'ready', report: null });
eq('无结论显示 —', textOf(findIn(pfEmptyView, 'data-jk-kb-preflight-summary', 'true')), '—');
ok('缺省 preflight 不抛', !!I.UsageView({ phase: 'loading', data: null }));
// 任务管理页不再渲染体检（已迁至使用信息页）
const pfRunsView = I.RunsBoardView({ phase: 'ready', runs: [], preflight: { phase: 'ready', report: pfErrorReport, expanded: true }, onRunKind: () => {}, onRetry: () => {} });
eq('任务页不再渲染体检行', findIn(pfRunsView, 'data-jk-kb-preflight', 'error'), undefined);
eq('任务页不再渲染体检卡片', findIn(pfRunsView, 'data-jk-kb-preflight-card', 'error'), undefined);

// 错误码兜底映射（checks 为空时）
eq('TOO_MANY_FILES 兜底', I.presentPreflight({ ok: false, code: 'TOO_MANY_FILES', checks: [] }).advice, '文件数超过上限，请换一个更小的目录作为根，或提高上限配置');
eq('DISK_LOW 兜底', I.presentPreflight({ ok: false, code: 'DISK_LOW', checks: [] }).advice, '磁盘剩余空间不足 200MB');
eq('ROOT_NOT_WRITABLE 兜底', I.presentPreflight({ ok: false, code: 'ROOT_NOT_WRITABLE', checks: [] }).advice, '该目录当前不可写，请检查权限或磁盘挂载');
eq('ROOT_NOT_AUTHORIZED 兜底', I.presentPreflight({ ok: false, code: 'ROOT_NOT_AUTHORIZED', checks: [] }).advice, '根目录授权已失效，请回设置重新确认并保存');
eq('TOOLS_MISSING 兜底', I.presentPreflight({ ok: false, code: 'TOOLS_MISSING', checks: [] }).advice, '宿主工具未全部注册，请重启应用');
eq('未知错误码原样显示', I.presentPreflight({ ok: false, code: 'SOMETHING_NEW', checks: [] }).advice, 'SOMETHING_NEW');
const pfAdviceView = pfUsageView({ phase: 'ready', report: { ok: false, code: 'DISK_LOW', checks: [] }, expanded: true });
contains('兜底建议渲染到卡片', textOf(findIn(pfAdviceView, 'data-jk-kb-preflight-advice', 'DISK_LOW')), '磁盘剩余空间不足 200MB');
ok('checks 为空时给空明细提示', !!findIn(pfAdviceView, 'data-jk-kb-preflight-empty', 'true'));

// 开始前预检拦截：error 不启动，warn / 请求失败放行
eq('error 报告拦截建库', I.shouldBlockBootstrap({ ok: true, report: pfErrorReport }), true);
eq('warn 报告放行', I.shouldBlockBootstrap({ ok: true, report: { ok: true, checks: [{ level: 'warn', title: 'w', detail: 'd' }] } }), false);
eq('请求失败不拦截', I.shouldBlockBootstrap({ ok: false, error: { code: 'host-unreachable' } }), false);
let began = 0;
const blockedGate = await I.beginBootstrap({
  checkPreflight: async () => ({ ok: true, report: pfErrorReport }),
  start: async () => { began += 1; return { started: true }; },
});
eq('拦截时 proceed=false', blockedGate.proceed, false);
eq('拦截原因', blockedGate.reason, 'preflight-failed');
eq('拦截时绝不发 POST（start 未被调用）', began, 0);
const passGate = await I.beginBootstrap({
  checkPreflight: async () => ({ ok: true, report: pfWarnReport() }),
  start: async () => { began += 1; return { started: true }; },
});
eq('warn 时 proceed=true', passGate.proceed, true);
eq('放行时 start 只调一次', began, 1);
const degradeGate = await I.beginBootstrap({
  checkPreflight: async () => { throw new Error('boom'); },
  start: async () => { began += 1; return { started: true }; },
});
eq('体检抛错降级放行', degradeGate.proceed, true);
eq('降级也发 POST', began, 2);
eq('体检抛错记录为 preflight-failed', degradeGate.preflight.error.code, 'preflight-failed');

// preflight 请求本身：路径正确、失败归一为不可用
const pfFetch = installFetch(() => ({ body: { ok: true, code: '', checks: [], counts: { files: 0, notes: 0, limit: 10 }, freeBytes: null, elapsedMs: 1 } }));
const pfResult = await I.fetchPreflight();
pfFetch.restore();
eq('preflight GET 路径', pfFetch.calls[0].url, I.HOST_PREFLIGHT_PATH);
eq('preflight 请求方 GET', pfFetch.calls[0].init.method, 'GET');
eq('preflight 响应归一为报告', I.normalizePreflightResponse(pfResult).ok, true);
const pfDown = installFetch(() => ({ throw: true }));
const pfDownResult = await I.fetchPreflight();
pfDown.restore();
eq('preflight 网络失败 ok=false', I.normalizePreflightResponse(pfDownResult).ok, false);
eq('preflight 失败错误码', I.normalizePreflightResponse(pfDownResult).error.code, 'host-unreachable');

// 422：POST /run 失败原样带回 checks
const run422 = installFetch(() => ({
  status: 422,
  body: { ok: false, error: { code: 'DISK_LOW', message: '磁盘剩余空间不足（宿主）', checks: [{ id: 'disk', level: 'error', title: '磁盘空间', detail: '剩余 120MB' }] } },
}));
const outcome422 = await I.startRunRequest({ kind: 'verify' });
run422.restore();
eq('422 不透传 started', outcome422.started, false);
eq('422 HTTP 状态保留', outcome422.status, 422);
eq('422 错误码', outcome422.code, 'DISK_LOW');
eq('422 checks 原样带回', outcome422.checks.length, 1);
eq('422 checks 内容', outcome422.checks[0].title, '磁盘空间');
contains('422 宿主 message 优先', outcome422.message, '磁盘剩余空间不足（宿主）');
const pf422View = pfUsageView({ phase: 'ready', report: { ok: false, code: outcome422.code, checks: outcome422.checks }, expanded: true });
eq('422 checks 渲染到卡片', findIn(pf422View, 'data-jk-kb-check', 'disk').props['data-jk-kb-check-level'], 'error');
contains('422 check 详情', textOf(findIn(pf422View, 'data-jk-kb-check', 'disk')), '剩余 120MB');

// 小工具：warn-only 报告
function pfWarnReport() { return { ok: true, checks: [{ level: 'warn', title: 'w', detail: 'd' }] }; }

// ═════════════════════════ 11. 验收（acceptance）展示 ═════════════════════════
const ACC_AT = '2026-10-17T06:00:00.000Z';
const accPassed = { ok: true, checkedAt: ACC_AT, errors: [], warnings: [], summary: '结构完整，索引齐全' };
const accFailed = {
  ok: false,
  checkedAt: ACC_AT,
  errors: [
    { id: 'structure', level: 'error', message: '缺少 03_主题 目录', fix: '运行建库补全目录' },
    { id: 'index', level: 'error', message: '索引缺失' },
  ],
  warnings: [],
  summary: '2 项错误',
};
const accOkRun = I.presentRun({ id: 'acc-1', title: '建库', kind: 'bootstrap', status: 'completed', acceptance: accPassed, acceptanceFailed: false }, HB);
const accFailRun = I.presentRun({ id: 'acc-2', title: '建库', kind: 'bootstrap', status: 'failed', acceptance: accFailed, acceptanceFailed: true }, HB);
const accMissingRun = I.presentRun({ id: 'acc-3', title: '旧任务', kind: 'bootstrap', status: 'completed' }, HB);

// 三态
eq('验收通过徽标', accOkRun.acceptanceBadge.state, 'passed');
eq('验收通过文案', accOkRun.acceptanceBadge.label, '验收通过');
eq('验收通过结论', accOkRun.acceptance.ok, true);
ok('验收检查时间非占位', accOkRun.acceptance.checkedAtText !== '—');
eq('验收摘要', accOkRun.acceptance.summary, '结构完整，索引齐全');
eq('验收未过徽标', accFailRun.acceptanceBadge.state, 'failed');
eq('验收未过文案', accFailRun.acceptanceBadge.label, '验收未过');
contains('验收未过 tooltip 说明', accFailRun.acceptanceBadge.tooltip, '步骤可能全绿，但库结构体检未通过');
eq('验收未过 errors 条数', accFailRun.acceptance.errors.length, 2);
eq('缺失 acceptance 无徽标', accMissingRun.acceptanceBadge, null);
eq('缺失 acceptance 为 null', accMissingRun.acceptance, null);

// 列表徽标
const accList = I.RunsBoardView({
  phase: 'ready',
  runs: [accOkRun, accFailRun, accMissingRun],
  onRunKind: () => {}, onRetry: () => {}, onOpenRun: () => {},
});
eq('列表显示验收通过', textOf(findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-1')), '验收通过');
eq('列表通过徽标状态', findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-1').props['data-jk-kb-acceptance-state'], 'passed');
contains('通过徽标绿色类', findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-1').props.className, 'jk-kb-acceptance-passed');
eq('列表显示验收未过', textOf(findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-2')), '验收未过');
contains('未过徽标红色类', findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-2').props.className, 'jk-kb-acceptance-failed');
contains('未过徽标 tooltip', findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-2').props.title, '步骤可能全绿');
eq('旧 run 不显示徽标', findIn(accList, 'data-jk-kb-acceptance-badge', 'acc-3'), undefined);

// 详情：验收区块
const accDetailView = (run, steps) => I.RunDetailView({
  phase: 'ready',
  detail: I.presentRunDetail({ run: run, steps: steps || [] }, HB),
  onBack: () => {}, onCancel: () => {}, onRetry: () => {},
});
const failView = accDetailView({ id: 'acc-2', title: '建库', kind: 'bootstrap', status: 'failed', acceptance: accFailed, acceptanceFailed: true });
eq('详情验收区块未过态', findIn(failView, 'data-jk-kb-acceptance', 'failed').props['data-jk-kb-acceptance'], 'failed');
eq('验收结论未通过', textOf(findIn(failView, 'data-jk-kb-acceptance-ok', 'false')), '未通过');
ok('验收检查时间非占位', textOf(findIn(failView, 'data-jk-kb-acceptance-checked', 'true')) !== '—');
eq('验收摘要渲染', textOf(findIn(failView, 'data-jk-kb-acceptance-summary', 'true')), '2 项错误');
const accErrors = flatten(failView).filter((el) => el.props && el.props['data-jk-kb-acceptance-error'] !== undefined);
eq('验收 errors 逐项渲染', accErrors.length, 2);
contains('error 项 id', textOf(findIn(failView, 'data-jk-kb-acceptance-error', 'structure')), 'structure');
contains('error 项 message', textOf(findIn(failView, 'data-jk-kb-acceptance-error', 'structure')), '缺少 03_主题 目录');
contains('error 项 fix', textOf(findIn(failView, 'data-jk-kb-acceptance-error', 'structure')), '修复：运行建库补全目录');
ok('fix 有独立标记', !!findIn(failView, 'data-jk-kb-acceptance-fix', 'structure'));
contains('无 fix 的项不编造修复', textOf(findIn(failView, 'data-jk-kb-acceptance-error', 'index')), '索引缺失');

const passView = accDetailView({ id: 'acc-1', title: '建库', kind: 'bootstrap', status: 'completed', acceptance: accPassed, acceptanceFailed: false });
eq('详情验收区块通过态', findIn(passView, 'data-jk-kb-acceptance', 'ok').props['data-jk-kb-acceptance'], 'ok');
eq('验收结论通过', textOf(findIn(passView, 'data-jk-kb-acceptance-ok', 'true')), '通过');
eq('通过时无 errors 列表', findIn(passView, 'data-jk-kb-acceptance-errors', 'true'), undefined);
ok('通过时显示空错误占位', !!findIn(passView, 'data-jk-kb-acceptance-errors-empty', 'true'));

const missingView = accDetailView({ id: 'acc-3', title: '旧任务', kind: 'bootstrap', status: 'completed' });
eq('缺失验收显示 missing', findIn(missingView, 'data-jk-kb-acceptance', 'missing').props['data-jk-kb-acceptance'], 'missing');
eq('缺失验收显示占位', textOf(findIn(missingView, 'data-jk-kb-acceptance-missing', 'true')), '—');
eq('缺失验收不渲染 errors', findIn(missingView, 'data-jk-kb-acceptance-errors', 'true'), undefined);

// 顶部说明条
const failNotice = findIn(failView, 'data-jk-kb-run-notice', 'failed');
contains('顶部说明条补验收原因', textOf(failNotice), '该任务因验收未通过被判定失败');
contains('说明重跑但无按钮', textOf(failNotice), 'S5 才有按钮，这里只说明');
eq('验收说明标记', failNotice.props['data-jk-kb-acceptance-notice'], 'true');
eq('没有凭空造重新开始按钮', flatten(failView).filter((el) => el.props && el.props['data-jk-kb-restart'] !== undefined).length, 0);
eq('通过任务无验收说明条', findIn(passView, 'data-jk-kb-acceptance-notice', 'true'), undefined);
contains('stalled 与验收失败说明可拼接', I.describeTopNotice('stalled', true), '该任务已卡住');

// 「步骤全绿但验收红」判定
const greenSteps = [
  { id: 's1', role: 'PLUGIN', title: '建库', status: 'ok' },
  { id: 's2', role: 'PLUGIN', title: '索引', status: 'skip' },
];
const redAcceptanceSteps = [
  { id: 's1', role: 'PLUGIN', title: '建库', status: 'ok' },
  { id: 's2', role: 'PLUGIN', title: '写文件', status: 'error', error: 'EACCES' },
];
eq('全绿判定（ok+skip）', I.stepsAllGreen(greenSteps), true);
eq('含 error 不算全绿', I.stepsAllGreen(redAcceptanceSteps), false);
eq('空步骤不算全绿', I.stepsAllGreen([]), false);
const allGreenFailedView = accDetailView({ id: 'acc-2', title: '建库', status: 'failed', acceptance: accFailed, acceptanceFailed: true }, greenSteps);
contains('步骤全绿但验收红提示', textOf(findIn(allGreenFailedView, 'data-jk-kb-acceptance-mismatch', 'true')), '所有步骤成功，但验收未通过');
const redStepView = accDetailView({ id: 'acc-2', title: '建库', status: 'failed', acceptance: accFailed, acceptanceFailed: true }, redAcceptanceSteps);
eq('步骤有 error 不显示全绿提示', findIn(redStepView, 'data-jk-kb-acceptance-mismatch', 'true'), undefined);
const noStepView = accDetailView({ id: 'acc-2', title: '建库', status: 'failed', acceptance: accFailed, acceptanceFailed: true }, []);
eq('无步骤不显示全绿提示', findIn(noStepView, 'data-jk-kb-acceptance-mismatch', 'true'), undefined);
const greenPassedView = accDetailView({ id: 'acc-1', title: '建库', status: 'completed', acceptance: accPassed, acceptanceFailed: false }, greenSteps);
eq('验收通过时不显示全绿红提示', findIn(greenPassedView, 'data-jk-kb-acceptance-mismatch', 'true'), undefined);

// 缺字段降级
const bareAcc = I.presentRun({ acceptance: {} }, HB);
eq('空 acceptance 不抛', !!bareAcc.acceptance, true);
eq('空 acceptance ok=false', bareAcc.acceptance.ok, false);
eq('空 acceptance 时间 —', bareAcc.acceptance.checkedAtText, '—');
eq('空 acceptance 摘要 —', textOf(findIn(accDetailView({ acceptance: {} }), 'data-jk-kb-acceptance-summary', 'true')), '—');
eq('空 acceptance errors 为空', bareAcc.acceptance.errors.length, 0);
eq('acceptance 非对象按缺失', I.presentRun({ acceptance: 'nope' }, HB).acceptance, null);
eq('acceptanceFailed 缺失默认 false', I.presentRun({}, HB).acceptanceFailed, false);

// ═════════════════════════ 12. S5 恢复三动作 + 历史滚动 ═════════════════════════
// 三按钮可用条件矩阵
const actionMap = (actions) => actions.reduce((acc, item) => { acc[item.id] = item.enabled; return acc; }, {});
const matrixResume = actionMap(I.buildRecoverActions({ status: 'failed' }, { action: 'resume', reason: 'r' }));
eq('resume：继续可用', matrixResume.resume, true);
eq('resume：重新开始可用', matrixResume.restart, true);
eq('resume：放弃可用（非 running）', matrixResume.abandon, true);
const matrixRestart = actionMap(I.buildRecoverActions({ status: 'failed' }, { action: 'restart' }));
eq('restart：继续不可用', matrixRestart.resume, false);
eq('restart：重新开始可用', matrixRestart.restart, true);
const matrixAbandon = actionMap(I.buildRecoverActions({ status: 'failed' }, { action: 'abandon' }));
eq('abandon：继续不可用', matrixAbandon.resume, false);
eq('abandon：重新开始不可用', matrixAbandon.restart, false);
eq('abandon：放弃可用', matrixAbandon.abandon, true);
const matrixNone = actionMap(I.buildRecoverActions({ status: 'failed' }, null));
eq('无 recovery：继续不可用', matrixNone.resume, false);
eq('无 recovery：重新开始不可用', matrixNone.restart, false);
eq('无 recovery：放弃可用', matrixNone.abandon, true);
const matrixRunning = actionMap(I.buildRecoverActions({ status: 'running' }, { action: 'resume' }));
eq('running：放弃不可用（先取消）', matrixRunning.abandon, false);
eq('running：继续可用', matrixRunning.resume, true);

// 二次确认文案差异
contains('重新开始确认文案说明先备份', I.recoverConfirmText('restart'), '先备份');
contains('重新开始确认文案给出备份目录', I.recoverConfirmText('restart'), '.jkkb/backup/');
contains('继续确认文案说明不备份', I.recoverConfirmText('resume'), '不会备份');
contains('放弃确认文案说明不改文件', I.recoverConfirmText('abandon'), '不会修改或删除任何文件');
eq('未知动作无确认文案', I.recoverConfirmText('nope'), '');

// 详情底部按钮组
const recoverRunFixture = { id: 'rec-1', title: '中断任务', kind: 'bootstrap', status: 'failed', startedAt: hbIso(-600000) };
const recoverDetail = I.presentRunDetail({ run: recoverRunFixture, steps: [], recovery: { action: 'restart', reason: '心跳过期', conflicts: [] } }, HB);
eq('detail 归一 recovery', recoverDetail.recovery.action, 'restart');
const recoverView = I.RunDetailView({
  phase: 'ready', detail: recoverDetail,
  onBack: () => {}, onCancel: () => {}, onRetry: () => {},
  recoverPending: '', recoverBusy: false, recoverNotice: null, recoverSuggested: '',
  onRecoverRequest: (action) => actionRequests.push(action),
  onRecoverConfirm: () => {}, onRecoverCancel: () => {},
});
const actionRequests = [];
eq('继续按钮禁用', findIn(recoverView, 'data-jk-kb-recover-action', 'resume').props['data-jk-kb-recover-enabled'], 'false');
eq('重新开始按钮可用', findIn(recoverView, 'data-jk-kb-recover-action', 'restart').props['data-jk-kb-recover-enabled'], 'true');
eq('放弃按钮可用', findIn(recoverView, 'data-jk-kb-recover-action', 'abandon').props['data-jk-kb-recover-enabled'], 'true');
eq('恢复建议渲染', textOf(findIn(recoverView, 'data-jk-kb-recovery', 'restart')), '恢复建议：重新开始（原因：心跳过期）');
ok('建议按钮默认高亮', String(findIn(recoverView, 'data-jk-kb-recover-action', 'restart').props.className).indexOf('jk-kb-btn-suggested') >= 0);
findIn(recoverView, 'data-jk-kb-recover-action', 'restart').props.onClick();
eq('点击动作只请求一次', actionRequests.join(','), 'restart');
eq('禁用按钮点击无回调', findIn(recoverView, 'data-jk-kb-recover-action', 'resume').props.disabled, true);

const confirmView = (pending, suggested) => I.RunDetailView({
  phase: 'ready', detail: recoverDetail,
  onBack: () => {}, onCancel: () => {}, onRetry: () => {},
  recoverPending: pending, recoverBusy: false, recoverNotice: null, recoverSuggested: suggested || '',
  onRecoverRequest: () => {}, onRecoverConfirm: () => { confirmCalls += 1; }, onRecoverCancel: () => { cancelCalls += 1; },
});
let confirmCalls = 0;
let cancelCalls = 0;
const restartConfirm = confirmView('restart');
ok('重新开始二次确认出现', !!findIn(restartConfirm, 'data-jk-kb-recover-confirm', 'restart'));
contains('重启确认文案含备份', textOf(findIn(restartConfirm, 'data-jk-kb-recover-confirm', 'restart')), '.jkkb/backup/');
findIn(restartConfirm, 'data-jk-kb-recover-confirm-yes', 'true').props.onClick();
findIn(restartConfirm, 'data-jk-kb-recover-confirm-no', 'true').props.onClick();
eq('确认回调', confirmCalls, 1);
eq('取消回调', cancelCalls, 1);
contains('继续确认文案不备份', textOf(findIn(confirmView('resume'), 'data-jk-kb-recover-confirm', 'resume')), '不会备份');
contains('放弃确认文案不改文件', textOf(findIn(confirmView('abandon'), 'data-jk-kb-recover-confirm', 'abandon')), '不会修改或删除任何文件');
eq('无 pending 时不渲染确认框', findIn(confirmView(''), 'data-jk-kb-recover-confirm', ''), undefined);

// 请求体
const recoverFetch = installFetch(() => ({ body: { ok: true, status: 'abandoned' } }));
const recoverResult = await I.recoverHostRun('run-9', 'abandon');
recoverFetch.restore();
eq('recover POST 路径', recoverFetch.calls[0].url, I.HOST_RUNS_PATH + '/run-9/recover');
eq('recover 方法 POST', recoverFetch.calls[0].init.method, 'POST');
eq('recover body.action', JSON.parse(recoverFetch.calls[0].init.body).action, 'abandon');
eq('recover 成功 ok', recoverResult.ok, true);

// 409 / 422 / 其它错误文案 + suggested 高亮
const conflictOutcome = I.describeRecoverOutcome({
  ok: false, status: 409,
  error: { code: 'action-mismatch', suggested: 'restart', decision: { action: 'restart', reason: '心跳过期', conflicts: [] } },
});
eq('409 识别为冲突', conflictOutcome.kind, 'conflict');
eq('409 带 suggested', conflictOutcome.suggested, 'restart');
eq('409 文案含当前建议', conflictOutcome.message, '当前建议：重新开始（原因：心跳过期）');
const noSuggestOutcome = I.describeRecoverOutcome({ ok: false, status: 409, error: { code: 'action-mismatch', message: '不一致' } });
eq('409 无 suggested 用宿主原文', noSuggestOutcome.message, '不一致');
const rejected = I.describeRecoverOutcome({ ok: false, status: 422, error: { code: 'backup-failed', message: '备份失败：磁盘已满' } });
eq('422 文案取宿主 message', rejected.message, '备份失败：磁盘已满');
const otherErr = I.describeRecoverOutcome({ ok: false, status: 500, error: { code: 'internal', message: '炸了' } });
eq('其它错误保留原文', otherErr.message, 'internal 炸了');
const conflictView = I.RunDetailView({
  phase: 'ready', detail: recoverDetail,
  onBack: () => {}, onCancel: () => {}, onRetry: () => {},
  recoverPending: '', recoverBusy: false,
  recoverNotice: { kind: 'error', text: conflictOutcome.message },
  recoverSuggested: 'restart',
  onRecoverRequest: () => {}, onRecoverConfirm: () => {}, onRecoverCancel: () => {},
});
contains('409 提示渲染', textOf(findIn(conflictView, 'data-jk-kb-recover-notice', 'error')), '当前建议：重新开始');
eq('409 高亮 suggested 按钮', findIn(conflictView, 'data-jk-kb-recover-action', 'restart').props['data-jk-kb-suggested'], 'true');
contains('高亮类落到 suggested 按钮', findIn(conflictView, 'data-jk-kb-recover-action', 'restart').props.className, 'jk-kb-btn-suggested');
eq('非 suggested 按钮无高亮', findIn(conflictView, 'data-jk-kb-recover-action', 'abandon').props['data-jk-kb-suggested'], undefined);
const rejectedView = I.RunDetailView({
  phase: 'ready', detail: recoverDetail,
  onBack: () => {}, onCancel: () => {}, onRetry: () => {},
  recoverPending: '', recoverBusy: false,
  recoverNotice: { kind: 'error', text: rejected.message },
  recoverSuggested: '',
  onRecoverRequest: () => {}, onRecoverConfirm: () => {}, onRecoverCancel: () => {},
});
contains('422 文案渲染', textOf(findIn(rejectedView, 'data-jk-kb-recover-notice', 'error')), '备份失败：磁盘已满');

// 分页：查询串 / 追加去重 / 加载更多 / 轮询条件
eq('无分页参数不拼查询串', I.buildRunsQuery({}), '');
eq('limit=20 查询串', I.buildRunsQuery({ limit: 20 }), '?limit=20');
eq('before 查询串编码', I.buildRunsQuery({ limit: 20, before: '2026-10-17T05:00:00.000Z' }), '?limit=20&before=' + encodeURIComponent('2026-10-17T05:00:00.000Z'));
eq('limit 上限 100', I.buildRunsQuery({ limit: 500 }), '?limit=100');
const pageFetch = installFetch(() => ({ body: { ok: true, runs: [], nextBefore: null } }));
await I.fetchRuns({ limit: 20, before: 'abc' });
pageFetch.restore();
eq('翻页请求 URL', pageFetch.calls[0].url, I.HOST_RUNS_PATH + '?limit=20&before=abc');
const merged = I.mergeRunPages([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
eq('追加去重', merged.map((run) => run.id).join(','), 'a,b,c');
let pageState = I.reduceRunsPage(I.createRunsPageState(), { type: 'loaded', runs: [{ id: 'a' }], nextBefore: 'n1' });
eq('第一页 nextBefore', pageState.nextBefore, 'n1');
eq('第一页 pages=1', pageState.pages, 1);
pageState = I.reduceRunsPage(pageState, { type: 'appendLoaded', runs: [{ id: 'a' }, { id: 'b' }], nextBefore: 'n2' });
eq('追加不替换', pageState.runs.map((run) => run.id).join(','), 'a,b');
eq('追加后 pages=2', pageState.pages, 2);
eq('追加后 nextBefore', pageState.nextBefore, 'n2');
pageState = I.reduceRunsPage(pageState, { type: 'appendLoaded', runs: [{ id: 'c' }], nextBefore: null });
eq('末页 nextBefore=null', pageState.nextBefore, null);
eq('末页 pages=3', pageState.pages, 3);

const moreCalls = [];
const paginatedView = I.RunsBoardView({
  phase: 'ready', runs: I.presentRuns([{ id: 'x', title: 't', kind: 'bootstrap', status: 'completed' }], HB),
  nextBefore: 'n1', loadingMore: false,
  onRunKind: () => {}, onRetry: () => {}, onLoadMore: () => moreCalls.push('load'),
});
ok('有 nextBefore 时显示加载更多', !!findIn(paginatedView, 'data-jk-kb-load-more', 'true'));
findIn(paginatedView, 'data-jk-kb-load-more', 'true').props.onClick();
eq('加载更多回调', moreCalls.join(','), 'load');
const loadingView = I.RunsBoardView({ phase: 'ready', runs: [], nextBefore: 'n1', loadingMore: true, onRunKind: () => {}, onRetry: () => {}, onLoadMore: () => {} });
eq('加载中禁用按钮', findIn(loadingView, 'data-jk-kb-load-more', 'true').props.disabled, true);
eq('加载中文案', textOf(findIn(loadingView, 'data-jk-kb-load-more', 'true')), '加载中…');
const noMoreView = I.RunsBoardView({ phase: 'ready', runs: [], nextBefore: null, loadingMore: false, onRunKind: () => {}, onRetry: () => {}, onLoadMore: () => {} });
eq('无 nextBefore 时隐藏加载更多', findIn(noMoreView, 'data-jk-kb-load-more', 'true'), undefined);

eq('第一页 running 才轮询', I.shouldPollRunsPage({ phase: 'ready', pages: 1, runs: [{ status: 'running' }] }), true);
eq('翻页后不轮询', I.shouldPollRunsPage({ phase: 'ready', pages: 2, runs: [{ status: 'running' }] }), false);
eq('无 running 不轮询', I.shouldPollRunsPage({ phase: 'ready', pages: 1, runs: [{ status: 'completed' }] }), false);
eq('loading 不轮询', I.shouldPollRunsPage({ phase: 'loading', pages: 1, runs: [{ status: 'running' }] }), false);

// 状态配色
ok('cancelled 用灰色', I.PANEL_STYLE.indexOf('.jk-kb-status-cancelled{color:var(--dsw-alias-label-tertiary);}') >= 0);
ok('stalled 加粗 + 脉冲', I.PANEL_STYLE.indexOf('.jk-kb-status-stalled{color:var(--dsw-alias-state-error-primary);font-weight:700;animation:') >= 0);
ok('timed_out 加粗 + 脉冲', I.PANEL_STYLE.indexOf('.jk-kb-status-timed_out{color:var(--dsw-alias-state-error-primary);font-weight:700;animation:') >= 0);
eq('cancelled tone 独立', I.normalizeRunStatus('cancelled'), 'cancelled');
eq('cancelled 文案仍是已中止', I.statusLabel('cancelled'), '已中止');
ok('abandoned 灰色', I.PANEL_STYLE.indexOf('.jk-kb-status-abandoned{color:var(--dsw-alias-label-tertiary);}') >= 0);

// ═════════════════════════ 13. 双视图 / token / 台账 ═════════════════════════
// 视图切换（不改左栏菜单）
const viewChanges = [];
const switchTree = I.TasksViewSwitch({ viewMode: 'list', onChange: (mode) => viewChanges.push(mode) });
eq('默认列表 tab 激活', findIn(switchTree, 'data-jk-kb-view-tab', 'list').props['aria-pressed'], true);
eq('日历 tab 未激活', findIn(switchTree, 'data-jk-kb-view-tab', 'calendar').props['aria-pressed'], false);
findIn(switchTree, 'data-jk-kb-view-tab', 'calendar').props.onClick();
eq('切到日历回调', viewChanges.join(','), 'calendar');
eq('菜单条目未被视图切换影响', I.MENUS.length, 5);

// 列表 token 列三态
const tokenRuns = [
  { id: 'tok-1', title: '有 token', kind: 'bootstrap', status: 'completed', startedAt: hbIso(-1000), endedAt: hbIso(0), usage: { inputTokens: 12345, outputTokens: 3210, cacheReadTokens: 5, cacheWriteTokens: 0 }, usageSource: 'agent' },
  { id: 'tok-2', title: '未采集', kind: 'bootstrap', status: 'completed', usage: null, usageSource: 'unavailable' },
  { id: 'tok-3', title: '降级', kind: 'bootstrap', status: 'completed', usage: null, usageSource: 'degraded' },
];
const tokenView = I.RunsBoardView({ phase: 'ready', runs: I.presentRuns(tokenRuns, HB), onRunKind: () => {}, onRetry: () => {} });
eq('token 数值展示', textOf(findIn(tokenView, 'data-jk-kb-token', 'tok-1')), '12,345 / 3,210');
eq('token 缺失显示 —', textOf(findIn(tokenView, 'data-jk-kb-token', 'tok-2')), '—');
eq('degraded 显示无 agent', textOf(findIn(tokenView, 'data-jk-kb-token', 'tok-3')), '无 agent');
contains('degraded token 灰色类', findIn(tokenView, 'data-jk-kb-token', 'tok-3').props.className, 'jk-kb-token-degraded');
eq('token 来源标记', findIn(tokenView, 'data-jk-kb-token', 'tok-1').props['data-jk-kb-usage-source'], 'agent');
eq('千分位格式化', I.formatTokenCount(1234567), '1,234,567');
eq('token 格式化 null', I.formatTokenCount(null), '—');
eq('usageHasTokens 空对象', I.usageHasTokens({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }), false);
const hasUsageFalseDay = I.presentLedgerDayCell({ date: '2026-10-09', runCount: 1, hasUsage: false, inputTokens: 0, outputTokens: 0 });
eq('hasUsage=false 即使补 0 也不算用量', hasUsageFalseDay.hasUsage, false);
eq('hasUsage=false 无 token 文本', hasUsageFalseDay.tokenText, '');

// 详情用量区块三态
const usageDetail = (run) => I.RunDetailView({
  phase: 'ready',
  detail: I.presentRunDetail({ run: run, steps: [] }, HB),
  onBack: () => {}, onCancel: () => {}, onRetry: () => {},
  onRecoverRequest: () => {}, onRecoverConfirm: () => {}, onRecoverCancel: () => {},
});
const agentUsageView = usageDetail({
  id: 'u1', title: '用量', kind: 'bootstrap', status: 'completed',
  usage: { inputTokens: 12345, outputTokens: 3210, cacheReadTokens: 88, cacheWriteTokens: 0 },
  usageSource: 'agent',
});
eq('用量 agent 态', findIn(agentUsageView, 'data-jk-kb-usage', 'agent').props['data-jk-kb-usage'], 'agent');
eq('用量输入', textOf(findIn(agentUsageView, 'data-jk-kb-usage-input', 'true')), '12,345');
eq('用量输出', textOf(findIn(agentUsageView, 'data-jk-kb-usage-output', 'true')), '3,210');
eq('用量缓存读', textOf(findIn(agentUsageView, 'data-jk-kb-usage-cache-read', 'true')), '88');
eq('用量缓存写', textOf(findIn(agentUsageView, 'data-jk-kb-usage-cache-write', 'true')), '0');
eq('用量来源 agent', textOf(findIn(agentUsageView, 'data-jk-kb-usage-source-label', 'true')), 'agent');
const degradedUsageView = usageDetail({ id: 'u2', title: '降级', status: 'completed', usage: null, usageSource: 'degraded' });
eq('用量 degraded 态', findIn(degradedUsageView, 'data-jk-kb-usage', 'degraded').props['data-jk-kb-usage'], 'degraded');
contains('用量 degraded 文案', textOf(degradedUsageView), '无 agent 降级，未消耗 token');
eq('用量 degraded 无输入行', findIn(degradedUsageView, 'data-jk-kb-usage-input', 'true'), undefined);
const unavailableUsageView = usageDetail({ id: 'u3', title: '未采集', status: 'completed', usage: null, usageSource: 'unavailable' });
eq('用量 unavailable 态', findIn(unavailableUsageView, 'data-jk-kb-usage', 'unavailable').props['data-jk-kb-usage'], 'unavailable');
contains('用量 unavailable 文案', textOf(unavailableUsageView), '未采集到用量');
const missingUsageView = usageDetail({ id: 'u4', title: '旧 run', status: 'completed' });
eq('缺 usage 也显示 unavailable', findIn(missingUsageView, 'data-jk-kb-usage', 'unavailable').props['data-jk-kb-usage'], 'unavailable');

// 台账接口：查询串与 URL
eq('月查询串', I.buildLedgerCalendarQuery({ year: 2026, month: 10 }), '?year=2026&month=10');
eq('年查询串', I.buildLedgerCalendarQuery({ year: 2026 }), '?year=2026');
eq('月补零', I.buildLedgerCalendarQuery({ year: 2026, month: 3 }), '?year=2026&month=03');
const calFetch = installFetch(() => ({ body: { ok: true, view: 'month', year: 2026, month: 10, days: [], totals: {} } }));
await I.fetchLedgerCalendar({ year: 2026, month: 10 });
const dayFetch = installFetch(() => ({ body: { ok: true, date: '2026-10-17', runs: [], totals: {} } }));
await I.fetchLedgerDay('2026-10-17');
calFetch.restore();
dayFetch.restore();
eq('日历请求 URL', calFetch.calls[0].url, I.HOST_LEDGER_CALENDAR_PATH + '?year=2026&month=10');
eq('单日请求 URL', dayFetch.calls[0].url, I.HOST_LEDGER_DAY_PATH + '?date=2026-10-17');
eq('本地日期字符串', I.toLocalDateString(new Date(2026, 9, 17, 23, 30)), '2026-10-17');
eq('本地日期补零', I.toLocalDateString(new Date(2026, 0, 5, 0, 1)), '2026-01-05');

// 月视图渲染
const monthFixture = {
  ok: true, view: 'month', year: 2026, month: 10,
  days: [
    { date: '2026-10-05', runCount: 3, completed: 2, failed: 1, totalMs: 120000, inputTokens: 100, outputTokens: 50, hasUsage: true },
    { date: '2026-10-06', runCount: 1, completed: 1, failed: 0, totalMs: 1000, inputTokens: null, outputTokens: null, hasUsage: false },
  ],
  totals: { runCount: 4, failed: 1, totalMs: 121000, inputTokens: 100, outputTokens: 50 },
};
const monthViewProps = {
  mode: 'month', year: 2026, month: 10, today: '2026-10-06',
  phase: 'ready', calendar: I.presentLedger(monthFixture),
  selectedDate: '', dayPhase: 'idle', day: null,
  onPrev: () => {}, onNext: () => {}, onToggleMode: () => {}, onRefresh: () => {},
  onSelectDay: () => {}, onSelectMonth: () => {}, onRetry: () => {}, onOpenRun: () => {},
};
const monthView = I.LedgerCalendarView(monthViewProps);
eq('月视图标签', textOf(findIn(monthView, 'data-jk-kb-cal-label', 'true')), '2026年10月');
ok('月网格存在', !!findIn(monthView, 'data-jk-kb-cal-grid', 'month'));
const dayCells = flatten(monthView).filter((el) => el.props && el.props['data-jk-kb-cal-day'] !== undefined);
eq('月网格含 31 个日期格', dayCells.length, 31);
eq('有任务标记', findIn(monthView, 'data-jk-kb-cal-day', '2026-10-05').props['data-jk-kb-cal-has-tasks'], 'true');
eq('失败日红点标记', findIn(monthView, 'data-jk-kb-cal-day', '2026-10-05').props['data-jk-kb-cal-has-failed'], 'true');
eq('有 token 标记', findIn(monthView, 'data-jk-kb-cal-day', '2026-10-05').props['data-jk-kb-cal-has-token'], 'true');
eq('日期格 token 文本', textOf(findIn(findIn(monthView, 'data-jk-kb-cal-day', '2026-10-05'), 'data-jk-kb-cal-token', '150')), '150');
eq('今天边框标记', findIn(monthView, 'data-jk-kb-cal-day', '2026-10-06').props['data-jk-kb-cal-today'], 'true');
eq('无任务日无标记', findIn(monthView, 'data-jk-kb-cal-day', '2026-10-07').props['data-jk-kb-cal-has-tasks'], undefined);
let pickedDate = '';
const monthClickView = I.LedgerCalendarView(Object.assign({}, monthViewProps, { onSelectDay: (date) => { pickedDate = date; } }));
findIn(monthClickView, 'data-jk-kb-cal-day', '2026-10-05').props.onClick();
eq('点日期回传 date', pickedDate, '2026-10-05');
const emptyMonthView = I.LedgerCalendarView(Object.assign({}, monthViewProps, {
  calendar: I.presentLedger({ ok: true, view: 'month', year: 2026, month: 9, days: [], totals: {} }),
  month: 9,
}));
contains('空月提示', textOf(findIn(emptyMonthView, 'data-jk-kb-cal-empty', 'true')), '本月暂无任务');
const octGrid = I.buildMonthGrid(2026, 10, []);
eq('周一对齐留白 3 格（2026-10-01 周四）', octGrid[3].date, '2026-10-01');
eq('月网格总格数 3+31', octGrid.length, 34);

// 年视图渲染
const yearFixture = {
  ok: true, view: 'year', year: 2026,
  months: [
    { month: 9, runCount: 1, failed: 0, totalMs: 1000, inputTokens: 0, outputTokens: 0 },
    { month: 10, runCount: 3, failed: 1, totalMs: 120000, inputTokens: 100, outputTokens: 50 },
  ],
  totals: { runCount: 4, failed: 1, totalMs: 121000, inputTokens: 100, outputTokens: 50 },
};
let pickedMonth = 0;
const yearView = I.LedgerCalendarView(Object.assign({}, monthViewProps, {
  mode: 'year', calendar: I.presentLedger(yearFixture),
  onSelectMonth: (month) => { pickedMonth = month; },
}));
eq('年视图标签', textOf(findIn(yearView, 'data-jk-kb-cal-label', 'true')), '2026年');
const monthCells = flatten(yearView).filter((el) => el.props && el.props['data-jk-kb-cal-month'] !== undefined);
eq('年视图 12 个格子', monthCells.length, 12);
contains('10 月 run 数', textOf(findIn(yearView, 'data-jk-kb-cal-month', '10')), '3 次');
contains('10 月失败数', textOf(findIn(yearView, 'data-jk-kb-cal-month', '10')), '1 失败');
contains('10 月 token 合计', textOf(findIn(yearView, 'data-jk-kb-cal-month', '10')), '150');
contains('空月份显示 0 次', textOf(findIn(yearView, 'data-jk-kb-cal-month', '1')), '0 次');
findIn(yearView, 'data-jk-kb-cal-month', '10').props.onClick();
eq('点月份回传 month', pickedMonth, 10);
contains('年/月切换按钮文案', textOf(findIn(yearView, 'data-jk-kb-cal-mode', 'month')), '月');

// 单日任务列表 + 跳详情
let openedRun = '';
const dayFixture = {
  ok: true, date: '2026-10-17',
  runs: [{ id: 'd1', title: '建库任务', kind: 'bootstrap', status: 'completed', startedAt: hbIso(-200000), endedAt: hbIso(-67000), elapsedMs: 133000, usage: { inputTokens: 10, outputTokens: 5 }, usageSource: 'agent' }],
  totals: { runCount: 1, totalMs: 133000, inputTokens: 10, outputTokens: 5 },
};
const dayView = I.LedgerCalendarView(Object.assign({}, monthViewProps, {
  selectedDate: '2026-10-17', dayPhase: 'ready', day: I.presentLedgerDay(dayFixture),
  onOpenRun: (id) => { openedRun = id; },
}));
ok('单日区块存在', !!findIn(dayView, 'data-jk-kb-ledger-day', '2026-10-17'));
contains('单日任务标题', textOf(findIn(dayView, 'data-jk-kb-ledger-run', 'd1')), '建库任务');
contains('单日耗时来自 elapsedMs', textOf(findIn(dayView, 'data-jk-kb-ledger-run', 'd1')), '2m 13s');
contains('单日 token', textOf(findIn(dayView, 'data-jk-kb-ledger-run', 'd1')), '10 / 5');
findIn(dayView, 'data-jk-kb-ledger-run', 'd1').props.onClick();
eq('点任务跳详情', openedRun, 'd1');
contains('单日合计', textOf(findIn(dayView, 'data-jk-kb-ledger-day-totals', 'true')), '共 1 次');
const emptyDayView = I.LedgerCalendarView(Object.assign({}, monthViewProps, {
  selectedDate: '2026-10-18', dayPhase: 'ready',
  day: I.presentLedgerDay({ ok: true, date: '2026-10-18', runs: [], totals: {} }),
}));
contains('空日提示', textOf(findIn(emptyDayView, 'data-jk-kb-ledger-day-empty', 'true')), '当天暂无任务');

// 台账失败降级 + 重试
let retriedLedger = 0;
const ledgerErrorView = I.LedgerCalendarView(Object.assign({}, monthViewProps, {
  phase: 'error', calendar: null, onRetry: () => { retriedLedger += 1; },
}));
contains('台账不可用文案', textOf(ledgerErrorView), '台账不可用');
findIn(ledgerErrorView, 'data-jk-kb-ledger-retry', 'true').props.onClick();
eq('台账重试回调', retriedLedger, 1);
const ledgerDown = installFetch(() => ({ throw: true }));
const ledgerResult = await I.fetchLedgerCalendar({ year: 2026, month: 10 });
ledgerDown.restore();
eq('台账请求失败归一', I.normalizeLedgerResponse(ledgerResult).ok, false);
eq('台账失败错误码', I.normalizeLedgerResponse(ledgerResult).error.code, 'host-unreachable');

// 不新增定时器：定时器只存在于既有轮询控制器
eq('没有直呼 setInterval(', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处（定义 + 列表 + 详情 + 专家对话）', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const calendarSection = source.slice(source.indexOf('function LedgerCalendarPage'), source.indexOf('function LedgerCalendarView'));
eq('日历页不挂轮询', calendarSection.indexOf('usePollingEffect') < 0, true);

// ═════════════════════════ 14. 入柜（curate）入口 ═════════════════════════
// 技能目录：归一 + 按岗位分组
const skillsFixture = {
  ok: true,
  skills: [
    { id: 'mkt-copy', name: '营销文案', role: '市场', stage: 'v1' },
    { id: 'mkt-plan', name: '营销策划', role: '市场', stage: 'v2' },
    { id: 'dev-api', name: '接口设计', role: '研发', stage: 'v1' },
  ],
};
const presentedSkills = I.presentSkills(skillsFixture);
eq('技能岗位分组数', presentedSkills.groups.length, 2);
eq('第一组岗位名', presentedSkills.groups[0].label, '市场');
eq('第一组技能数', presentedSkills.groups[0].skills.length, 2);
eq('技能显示名称+阶段', presentedSkills.groups[0].skills[0].label, '营销文案（v1）');
eq('技能 id', presentedSkills.groups[0].skills[0].id, 'mkt-copy');
eq('技能总数', presentedSkills.count, 3);
eq('技能响应归一', I.normalizeSkillsResponse(skillsFixture).ok, true);
eq('缺 skills 字段按空目录', I.normalizeSkillsResponse({ ok: true }).count, 0);
eq('缺岗位归到未分组', I.presentSkills({ ok: true, skills: [{ id: 'x', name: 'X' }] }).groups[0].label, '未分组');

// 入柜按钮 + 表单字段与禁用规则
let curateOpened = 0;
const boardProps = {
  phase: 'ready',
  runs: [],
  onRunKind: () => {},
  onRetry: () => {},
  onCurateOpen: () => { curateOpened += 1; },
};
const curateBoard = I.RunsBoardView(boardProps);
const curateOpenButton = findIn(curateBoard, 'data-jk-kb-curate-open', 'true');
ok('顶部有入柜按钮', !!curateOpenButton);
eq('入柜按钮文案', textOf(curateOpenButton), '入柜');
curateOpenButton.props.onClick();
eq('点入柜回调', curateOpened, 1);

const emptyFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '', skillId: '', title: '', source: '' },
  skills: { phase: 'ready', groups: presentedSkills.groups },
}));
ok('表单容器渲染', !!findIn(emptyFormView, 'data-jk-kb-curate-form', 'true'));
ok('原始文本 textarea', !!findIn(emptyFormView, 'data-jk-kb-curate-text', 'true'));
ok('技能下拉', !!findIn(emptyFormView, 'data-jk-kb-curate-skill', 'true'));
ok('标题输入', !!findIn(emptyFormView, 'data-jk-kb-curate-title', 'true'));
ok('来源输入', !!findIn(emptyFormView, 'data-jk-kb-curate-source', 'true'));
eq('空文本禁用提交', findIn(emptyFormView, 'data-jk-kb-curate-submit', 'true').props.disabled, true);
contains('空文本提示', textOf(findIn(emptyFormView, 'data-jk-kb-curate-required', 'true')), '请先粘贴原始文本');
eq('默认选中让 agent 自动判定', findIn(emptyFormView, 'data-jk-kb-curate-skill', 'true').props.value, '');

const filledFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈', skillId: 'mkt-copy', title: 'T', source: 'S' },
  skills: { phase: 'ready', groups: presentedSkills.groups },
}));
eq('有文本可提交', findIn(filledFormView, 'data-jk-kb-curate-submit', 'true').props.disabled, false);
eq('有文本时不显示必填提示', findIn(filledFormView, 'data-jk-kb-curate-required', 'true'), undefined);
const busyFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateBusy: true,
  curateForm: { text: '一段访谈' },
  skills: { phase: 'ready', groups: presentedSkills.groups },
}));
eq('提交中禁用提交', findIn(busyFormView, 'data-jk-kb-curate-submit', 'true').props.disabled, true);
eq('提交中文案', textOf(findIn(busyFormView, 'data-jk-kb-curate-submit', 'true')), '提交中…');
eq('canSubmitCurate 空文本', I.canSubmitCurate({ text: '   ' }, false), false);
eq('canSubmitCurate 有文本', I.canSubmitCurate({ text: 'x' }, false), true);
eq('canSubmitCurate busy', I.canSubmitCurate({ text: 'x' }, true), false);

// 技能下拉：按岗位分组渲染
const optgroups = flatten(filledFormView).filter((el) => el.props && el.props['data-jk-kb-curate-group'] !== undefined);
eq('技能按岗位分组渲染', optgroups.length, 2);
eq('分组标签', optgroups[0].props.label, '市场');
const skillOptions = flatten(filledFormView).filter((el) => el.type === 'option' && el.props.value === 'mkt-copy');
eq('技能选项存在', skillOptions.length, 1);
contains('技能选项显示名称+阶段', textOf(skillOptions[0]), '营销文案（v1）');

// 技能目录失败降级：仍可无技能提交
const skillsDownForm = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈' },
  skills: { phase: 'error', groups: [], error: { code: 'host-unreachable' } },
}));
eq('技能目录不可用选项', textOf(findIn(skillsDownForm, 'data-jk-kb-curate-skills-unavailable', 'true')), '技能目录不可用');
eq('目录不可用仍可提交', findIn(skillsDownForm, 'data-jk-kb-curate-submit', 'true').props.disabled, false);
eq('目录不可用时默认仍为空技能', findIn(skillsDownForm, 'data-jk-kb-curate-skill', 'true').props.value, '');

// 字段回调
const edits = [];
const editView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '', skillId: '', title: '', source: '' },
  skills: { phase: 'ready', groups: [] },
  onCurateField: (field, value) => edits.push(field + '=' + value),
}));
findIn(editView, 'data-jk-kb-curate-text', 'true').props.onChange({ target: { value: '正文' } });
findIn(editView, 'data-jk-kb-curate-skill', 'true').props.onChange({ target: { value: 'mkt-copy' } });
findIn(editView, 'data-jk-kb-curate-title', 'true').props.onChange({ target: { value: '标题' } });
findIn(editView, 'data-jk-kb-curate-source', 'true').props.onChange({ target: { value: '来源' } });
eq('四个字段回调', edits.join(','), 'text=正文,skillId=mkt-copy,title=标题,source=来源');

// 提交请求体（kind=curate + input 字段齐全）
const fullPayload = I.buildCuratePayload({ text: ' 访谈正文 ', skillId: ' mkt-copy ', title: ' 标题 ', source: ' 来源 ' });
eq('payload kind', fullPayload.kind, 'curate');
eq('payload text 原样', fullPayload.input.text, ' 访谈正文 ');
eq('payload skillId 去空格', fullPayload.input.skillId, 'mkt-copy');
eq('payload title 去空格', fullPayload.input.title, '标题');
eq('payload source 去空格', fullPayload.input.source, '来源');
const minimalPayload = I.buildCuratePayload({ text: 'x' });
eq('空技能不传 skillId', minimalPayload.input.skillId, undefined);
eq('空标题不传 title', minimalPayload.input.title, undefined);
eq('空来源不传 source', minimalPayload.input.source, undefined);

const curateFetch = installFetch(() => ({ body: { ok: true, runId: 'curate-run' } }));
const curateOutcome = await I.startCurateRequest({ text: '访谈正文', skillId: 'mkt-copy', title: 'T', source: 'S' });
curateFetch.restore();
eq('入柜 POST 到 /run', curateFetch.calls[0].url, I.HOST_RUN_PATH);
eq('入柜请求方法', curateFetch.calls[0].init.method, 'POST');
const sentBody = JSON.parse(curateFetch.calls[0].init.body);
eq('入柜 body.kind', sentBody.kind, 'curate');
eq('入柜 input 完整', JSON.stringify(sentBody.input), JSON.stringify({ text: '访谈正文', skillId: 'mkt-copy', title: 'T', source: 'S' }));
eq('入柜成功 started', curateOutcome.started, true);

const noPostFetch = installFetch(() => ({ body: { ok: true } }));
const emptyTextOutcome = await I.startCurateRequest({ text: '   ' });
noPostFetch.restore();
eq('空文本不发 POST', noPostFetch.calls.length, 0);
eq('空文本返回 text-required', emptyTextOutcome.code, 'text-required');
eq('空文本 started=false', emptyTextOutcome.started, false);

// 提交失败：422 checks 走既有体检卡片
const curate422Fetch = installFetch(() => ({
  status: 422,
  body: { ok: false, error: { code: 'MODE_CONFLICT', message: '入柜需要指定技能', checks: [{ id: 'mode', level: 'error', title: '模式冲突', detail: '缺少技能' }] } },
}));
const curate422 = await I.startCurateRequest({ text: 'x' });
curate422Fetch.restore();
eq('入柜 422 保留状态', curate422.status, 422);
eq('入柜 422 checks 原样带回', curate422.checks.length, 1);
contains('入柜 422 宿主 message 优先', curate422.message, '入柜需要指定技能');
const curate422View = pfUsageView({ phase: 'ready', report: { ok: false, code: curate422.code, checks: curate422.checks }, expanded: true });
contains('入柜失败用既有体检卡片', textOf(findIn(curate422View, 'data-jk-kb-check', 'mode')), '模式冲突');

const okPlan = I.planCurateResult({ started: true });
eq('成功后收起表单', okPlan.closeForm, true);
eq('成功后刷新列表', okPlan.refresh, true);
eq('成功通知文案', okPlan.notice.kind, 'ok');
contains('成功通知内容', okPlan.notice.text, '已提交入柜');
const failPlan = I.planCurateResult({ started: false, message: '提交失败（宿主）', checks: [{ id: 'x' }] });
eq('失败不收起表单', failPlan.closeForm, false);
eq('失败不刷新列表', failPlan.refresh, false);
eq('失败时展开既有体检卡片', failPlan.expandChecks, true);
eq('失败通知用宿主原文', failPlan.notice.text, '提交失败（宿主）');
eq('无 checks 失败不展开卡片', I.planCurateResult({ started: false, message: 'x' }).expandChecks, false);

// 技能目录请求本身：路径正确、失败归一
const skillsDownFetch = installFetch(() => ({ throw: true }));
const skillsDownResult = await I.fetchSkills();
skillsDownFetch.restore();
eq('技能目录 GET 路径', skillsDownFetch.calls[0].url, I.HOST_SKILLS_PATH);
eq('技能请求 GET', skillsDownFetch.calls[0].init.method, 'GET');
eq('技能目录失败归一', I.normalizeSkillsResponse(skillsDownResult).ok, false);
eq('技能目录失败错误码', I.normalizeSkillsResponse(skillsDownResult).error.code, 'host-unreachable');

// ═════════════════════════ 15. 整理（maintain）与整理报告 ═════════════════════════
// 整理按钮 + 二次确认
let maintainOpened = 0;
let maintainConfirmed = 0;
let maintainCancelled = 0;
const maintainBoard = I.RunsBoardView({
  phase: 'ready', runs: [],
  onRunKind: () => {}, onRetry: () => {},
  onMaintainOpen: () => { maintainOpened += 1; },
});
const maintainButton = findIn(maintainBoard, 'data-jk-kb-maintain-open', 'true');
ok('动作区有整理按钮', !!maintainButton);
eq('整理按钮文案', textOf(maintainButton), '整理');
maintainButton.props.onClick();
eq('点整理回调', maintainOpened, 1);
const maintainConfirmView = I.RunsBoardView({
  phase: 'ready', runs: [],
  onRunKind: () => {}, onRetry: () => {},
  confirm: 'maintain',
  onMaintainConfirm: () => { maintainConfirmed += 1; },
  onMaintainCancel: () => { maintainCancelled += 1; },
});
const maintainConfirmBox = findIn(maintainConfirmView, 'data-jk-kb-maintain-confirm', 'true');
ok('整理二次确认出现', !!maintainConfirmBox);
contains('确认文案说明只读', textOf(maintainConfirmBox), '只读扫描，不会移动或删除任何文件');
findIn(maintainConfirmView, 'data-jk-kb-maintain-confirm-yes', 'true').props.onClick();
findIn(maintainConfirmView, 'data-jk-kb-maintain-confirm-no', 'true').props.onClick();
eq('确认整理回调', maintainConfirmed, 1);
eq('取消整理回调', maintainCancelled, 1);

// 整理请求：POST /run {kind:'maintain'}
const maintainFetch = installFetch(() => ({ body: { ok: true, runId: 'maintain-1' } }));
const maintainOutcome = await I.startMaintainRequest();
maintainFetch.restore();
eq('整理 POST 到 /run', maintainFetch.calls[0].url, I.HOST_RUN_PATH);
eq('整理请求方法', maintainFetch.calls[0].init.method, 'POST');
eq('整理 body.kind', JSON.parse(maintainFetch.calls[0].init.body).kind, 'maintain');
eq('整理成功 started', maintainOutcome.started, true);
const maintain422Fetch = installFetch(() => ({
  status: 422,
  body: { ok: false, error: { code: 'MODE_CONFLICT', message: '整理模式冲突', checks: [{ id: 'mode', level: 'error', title: '模式', detail: 'x' }] } },
}));
const maintain422 = await I.startMaintainRequest();
maintain422Fetch.restore();
eq('整理失败 checks 原样带回', maintain422.checks.length, 1);
contains('整理失败宿主 message 优先', maintain422.message, '整理模式冲突');

// 报告归一 + 四规则分组
const reportRaw = {
  id: 'rep-1',
  kind: 'maintain',
  period: '2026-10',
  summary: '共 4 条发现',
  path: '/kb/reports/2026-10.md',
  createdAt: '2026-10-17T06:00:00Z',
  findings: [
    { ruleId: 'M01', path: 'notes/a.md', title: '缺日期前缀', detail: '文件名不符合规范', basis: '命名规范', threshold: '1 项' },
    { ruleId: 'M03', path: 'notes/b.md', detail: '缺标签' },
    { ruleId: 'M04', path: 'notes/c.md' },
    { ruleId: 'M08', path: 'notes/d.md' },
    { ruleId: 'M99', path: 'notes/e.md' },
  ],
};
const reportView = I.presentReport(reportRaw, 0);
eq('报告 period', reportView.period, '2026-10');
eq('报告 summary', reportView.summary, '共 4 条发现');
eq('报告路径', reportView.path, '/kb/reports/2026-10.md');
ok('报告时间非占位', reportView.createdAtText !== '—');
eq('报告 findings 条数', reportView.findings.length, 5);
const grouped = I.groupReportFindings(reportView.findings);
eq('四规则顺序 + 其它', grouped.map((group) => group.ruleId).join(','), 'M01,M03,M04,M08,M99');
eq('M01 组内条数', grouped[0].items.length, 1);
eq('缺失字段降级 —', grouped[1].items[0].basis, '—');
eq('缺失阈值降级 —', grouped[1].items[0].threshold, '—');
eq('缺失说明降级 —', grouped[2].items[0].detail, '—');
const byRuleReport = I.presentReport({ id: 'rep-2', byRule: { M01: [{ path: 'x.md', detail: 'd' }] } }, 1);
eq('byRule 映射也能展开', byRuleReport.findings[0].ruleId, 'M01');

// 报告列表视图
const reportsHandlers = { toggled: '', opened: '', copied: '', refreshed: 0 };
const reportsTree = I.ReportsView({
  phase: 'ready',
  reports: [reportView],
  expandedId: 'rep-1',
  onToggleReport: (id) => { reportsHandlers.toggled = id; },
  onOpenPath: (path) => { reportsHandlers.opened = path; },
  onCopyPath: (path) => { reportsHandlers.copied = path; },
  onRefresh: () => { reportsHandlers.refreshed += 1; },
});
ok('报告列表存在', !!findIn(reportsTree, 'data-jk-kb-reports', 'true'));
eq('报告 period 渲染', textOf(findIn(reportsTree, 'data-jk-kb-report-period', 'rep-1')), '2026-10');
eq('报告 summary 渲染', textOf(findIn(reportsTree, 'data-jk-kb-report-summary', 'rep-1')), '共 4 条发现');
ok('报告时间渲染', textOf(findIn(reportsTree, 'data-jk-kb-report-created', 'rep-1')) !== '—');
const groupsEls = flatten(reportsTree).filter((el) => el.props && el.props['data-jk-kb-report-group'] !== undefined);
eq('展开后按规则分组渲染', groupsEls.map((el) => el.props['data-jk-kb-report-group']).join(','), 'M01,M03,M04,M08,M99');
contains('finding 路径', textOf(findIn(reportsTree, 'data-jk-kb-report-findings', 'rep-1')), 'notes/a.md');
contains('finding 说明', textOf(findIn(reportsTree, 'data-jk-kb-report-findings', 'rep-1')), '文件名不符合规范');
contains('finding 依据', textOf(findIn(reportsTree, 'data-jk-kb-report-basis', 'M01-0')), '命名规范');
contains('finding 阈值', textOf(findIn(reportsTree, 'data-jk-kb-report-threshold', 'M01-0')), '1 项');
contains('finding 标题', textOf(findIn(reportsTree, 'data-jk-kb-report-findings', 'rep-1')), '缺日期前缀');
findIn(reportsTree, 'data-jk-kb-report', 'rep-1').props.onClick();
eq('点报告切换展开', reportsHandlers.toggled, 'rep-1');
findIn(reportsTree, 'data-jk-kb-report-open', 'rep-1').props.onClick();
eq('打开报告回调', reportsHandlers.opened, '/kb/reports/2026-10.md');
findIn(reportsTree, 'data-jk-kb-report-copy', 'rep-1').props.onClick();
eq('复制路径回调', reportsHandlers.copied, '/kb/reports/2026-10.md');
findIn(reportsTree, 'data-jk-kb-reports-refresh', 'true').props.onClick();
eq('刷新报告回调', reportsHandlers.refreshed, 1);
const collapsedTree = I.ReportsView({ phase: 'ready', reports: [reportView], expandedId: '', onToggleReport: () => {} });
eq('收起时不渲染 findings', findIn(collapsedTree, 'data-jk-kb-report-findings', 'rep-1'), undefined);

// 空态 / 失败 / 缺省
const emptyReports = I.ReportsView({ phase: 'ready', reports: [], expandedId: '' });
contains('报告空态显示暂无报告', textOf(findIn(emptyReports, 'data-jk-kb-reports-empty', 'true')), '暂无报告');
ok('报告空态带图标', findIn(emptyReports, 'data-jk-kb-reports-empty', 'true').children.some((child) => child && child.type === 'svg' && child.props.className.indexOf('jk-kb-empty-icon') >= 0));
ok('报告列表为 shadcn 表格', findIn(reportsTree, 'data-jk-kb-reports', 'true').type === 'table');
let reportsRetried = 0;
const reportsError = I.ReportsView({ phase: 'error', reports: [], error: { code: 'host-unreachable' }, onRetry: () => { reportsRetried += 1; } });
contains('报告不可用文案', textOf(reportsError), '报告不可用');
findIn(reportsError, 'data-jk-kb-reports-retry', 'true').props.onClick();
eq('报告重试回调', reportsRetried, 1);
ok('报告加载态', !!findIn(I.ReportsView({ phase: 'loading', reports: [] }), 'data-jk-kb-reports-loading', 'true'));
const noPathReport = I.presentReport({ id: 'rep-3', period: '2026-09' }, 2);
const noPathTree = I.ReportsView({ phase: 'ready', reports: [noPathReport], expandedId: 'rep-3' });
eq('缺路径禁用打开', findIn(noPathTree, 'data-jk-kb-report-open', 'rep-3').props.disabled, true);
eq('缺路径禁用复制', findIn(noPathTree, 'data-jk-kb-report-copy', 'rep-3').props.disabled, true);
contains('无 findings 提示', textOf(findIn(noPathTree, 'data-jk-kb-report-no-findings', 'rep-3')), '该报告未附带明细');
eq('缺字段 summary 降级 —', noPathReport.summary, '—');

// 报告请求：路径与失败归一
eq('报告查询串默认 20', I.buildReportsQuery({}), '?limit=20');
eq('报告查询串自定义', I.buildReportsQuery({ limit: 5 }), '?limit=5');
const reportsFetch = installFetch(() => ({ body: { ok: true, reports: [] } }));
await I.fetchReports({ limit: 20 });
reportsFetch.restore();
eq('报告请求 URL', reportsFetch.calls[0].url, I.HOST_REPORTS_PATH + '?limit=20');
const reportsDownFetch = installFetch(() => ({ throw: true }));
const reportsDown = await I.fetchReports();
reportsDownFetch.restore();
eq('报告请求失败归一', I.normalizeReportsResponse(reportsDown).ok, false);
eq('报告失败错误码', I.normalizeReportsResponse(reportsDown).error.code, 'host-unreachable');

// 不新增定时器：报告面板只用 effect
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const archiveReportsSection = source.slice(source.indexOf('function ReportsPanel'), source.indexOf('function ReportsView'));
eq('报告面板不挂轮询/定时器',
  archiveReportsSection.indexOf('usePollingEffect') < 0 && archiveReportsSection.indexOf('setInterval') < 0 && archiveReportsSection.indexOf('setTimeout') < 0,
  true);

// ═════════════════════════ 16. P2-3 技能视图 ═════════════════════════
// 三视图切换
const skillTabChanges = [];
const threeTabSwitch = I.TasksViewSwitch({ viewMode: 'skills', onChange: (mode) => skillTabChanges.push(mode) });
ok('技能 tab 存在', !!findIn(threeTabSwitch, 'data-jk-kb-view-tab', 'skills'));
eq('技能 tab 激活', findIn(threeTabSwitch, 'data-jk-kb-view-tab', 'skills').props['aria-pressed'], true);
eq('技能 tab 文案', textOf(findIn(threeTabSwitch, 'data-jk-kb-view-tab', 'skills')), '技能');
findIn(threeTabSwitch, 'data-jk-kb-view-tab', 'list').props.onClick();
eq('切回列表回调', skillTabChanges.join(','), 'list');
eq('菜单仍五条不变', I.MENUS.length, 5);

// 相似度与判重（与 host lifecycle 同口径）
eq('normalize 去空白标点虚词', I.normalizeSkillText('  客户 的访谈，记录！ '), '客户访谈记录');
eq('Levenshtein 相同', I.levenshtein('abc', 'abc'), 0);
eq('Levenshtein 距离', I.levenshtein('kitten', 'sitting'), 3);
eq('similarity 相同为 1', I.similarity('abc', 'abc'), 1);
const existingSkill = { id: 'SK001', name: '客户访谈', version: '1.0.0', purpose: '整理客户访谈记录', path: '/kb/11_岗位技能库/通用/SK001-客户访谈.md' };
const dupDecision = I.decideSkillCreate({ name: '客户访谈', purpose: '另一个用途' }, [existingSkill]);
eq('同名 → duplicate', dupDecision.action, 'duplicate');
eq('duplicate 匹配项', dupDecision.matches.length, 1);
eq('duplicate 相似度 1', dupDecision.matches[0].score, 1);
eq('匹配项带 pagePath', dupDecision.matches[0].pagePath, existingSkill.path);
const similarDecision = I.decideSkillCreate({ name: '客户访谈整理', purpose: '整理客户访谈记录' }, [existingSkill]);
eq('用途相近 → similar', similarDecision.action, 'similar');
ok('similar 带相似度', similarDecision.matches[0].score >= 0.55, String(similarDecision.matches[0].score));
const okDecision = I.decideSkillCreate({ name: '财务对账', purpose: '核对发票金额' }, [existingSkill]);
eq('不相似 → ok', okDecision.action, 'ok');
eq('ok 无匹配', okDecision.matches.length, 0);
eq('空名称不判重', I.decideSkillCreate({ name: '' }, [existingSkill]).action, 'ok');

// 表单校验与字段解析
eq('三项必填都缺', I.validateSkillForm({}).missing.join(','), 'name,purpose,scenario');
eq('缺适用场景', I.validateSkillForm({ name: 'a', purpose: 'b' }).missing.join(','), 'scenario');
eq('三项齐全通过', I.validateSkillForm({ name: 'a', purpose: 'b', scenario: 'c' }).ok, true);
eq('关键词解析', I.parseSkillList('客户，访谈、记录; 复盘').join(','), '客户,访谈,记录,复盘');
eq('字段解析', I.parseSkillList('结论, 依据').join(','), '结论,依据');
eq('空列表解析', I.parseSkillList('   ').length, 0);

const fullSkillForm = {
  name: '客户访谈整理',
  purpose: '把客户访谈整理成结构化卡片',
  scenario: '每次客户访谈结束后',
  keywords: '客户，访谈、复盘',
  fields: '结论, 依据',
};
const skillPayload = I.buildSkillPayload(fullSkillForm, { confirmed: true });
eq('技能 payload kind', skillPayload.kind, 'skill');
eq('技能 payload 名称', skillPayload.input.name, '客户访谈整理');
eq('技能 payload 用途', skillPayload.input.purpose, '把客户访谈整理成结构化卡片');
eq('技能 payload 场景', skillPayload.input.scenario, '每次客户访谈结束后');
eq('技能 payload 关键词数组', skillPayload.input.keywords.join(','), '客户,访谈,复盘');
eq('技能 payload 字段数组', skillPayload.input.fields.join(','), '结论,依据');
eq('确认后才带 confirm', skillPayload.input.confirm, true);
eq('未确认不带 confirm', I.buildSkillPayload(fullSkillForm, {}).input.confirm, undefined);

// 新建技能按钮 + 表单 + 重复风险卡
let skillOpened = 0;
const skillBoard = I.RunsBoardView(Object.assign({}, boardProps, {
  onSkillCreateOpen: () => { skillOpened += 1; },
}));
const skillOpenButton = findIn(skillBoard, 'data-jk-kb-skill-create-open', 'true');
ok('动作区有新建技能按钮', !!skillOpenButton);
eq('新建技能按钮文案', textOf(skillOpenButton), '新建技能');
skillOpenButton.props.onClick();
eq('点新建技能回调', skillOpened, 1);

const emptySkillFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  skillFormOpen: true,
  skillForm: { name: '', purpose: '', scenario: '', keywords: '', fields: '' },
  skillRegistry: { phase: 'ready', skills: [existingSkill] },
}));
ok('技能表单容器', !!findIn(emptySkillFormView, 'data-jk-kb-skill-form', 'true'));
ok('名称输入', !!findIn(emptySkillFormView, 'data-jk-kb-skill-name', 'true'));
ok('用途输入', !!findIn(emptySkillFormView, 'data-jk-kb-skill-purpose', 'true'));
ok('场景输入', !!findIn(emptySkillFormView, 'data-jk-kb-skill-scenario', 'true'));
ok('关键词输入', !!findIn(emptySkillFormView, 'data-jk-kb-skill-keywords', 'true'));
ok('字段输入', !!findIn(emptySkillFormView, 'data-jk-kb-skill-fields', 'true'));
eq('空表单禁用提交', findIn(emptySkillFormView, 'data-jk-kb-skill-submit', 'true').props.disabled, true);
contains('必填提示', textOf(findIn(emptySkillFormView, 'data-jk-kb-skill-required', 'true')), '名称、用途、适用场景');

const riskFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  skillFormOpen: true,
  skillAck: false,
  skillForm: { name: '客户访谈', purpose: '整理客户访谈记录', scenario: '访谈后', keywords: '', fields: '' },
  skillRegistry: { phase: 'ready', skills: [existingSkill] },
}));
const riskCard = findIn(riskFormView, 'data-jk-kb-skill-risk', 'duplicate');
ok('重复风险卡出现', !!riskCard);
contains('风险卡列出匹配项', textOf(riskCard), '客户访谈');
contains('风险卡显示相似度', textOf(riskCard), '相似度');
contains('风险卡要求勾选', textOf(riskCard), '我已确认，继续创建');
eq('未勾选时禁用提交', findIn(riskFormView, 'data-jk-kb-skill-submit', 'true').props.disabled, true);
eq('风险卡匹配项标记', !!findIn(riskFormView, 'data-jk-kb-skill-match', 'SK001'), true);
let ackValue = null;
const ackFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  skillFormOpen: true,
  skillAck: true,
  skillForm: { name: '客户访谈', purpose: '整理客户访谈记录', scenario: '访谈后', keywords: '', fields: '' },
  skillRegistry: { phase: 'ready', skills: [existingSkill] },
  onSkillAck: (value) => { ackValue = value; },
}));
eq('勾选后允许提交', findIn(ackFormView, 'data-jk-kb-skill-submit', 'true').props.disabled, false);
findIn(ackFormView, 'data-jk-kb-skill-ack', 'true').props.onChange({ target: { checked: true } });
eq('勾选回调', ackValue, true);
const noRiskFormView = I.RunsBoardView(Object.assign({}, boardProps, {
  skillFormOpen: true,
  skillAck: false,
  skillForm: { name: '财务对账', purpose: '核对发票金额', scenario: '月末', keywords: '', fields: '' },
  skillRegistry: { phase: 'ready', skills: [existingSkill] },
}));
eq('不相似时无风险卡', findIn(noRiskFormView, 'data-jk-kb-skill-risk', 'similar'), undefined);
eq('不相似可直接提交', findIn(noRiskFormView, 'data-jk-kb-skill-submit', 'true').props.disabled, false);

const skillEdits = [];
const editSkillView = I.RunsBoardView(Object.assign({}, boardProps, {
  skillFormOpen: true,
  skillForm: { name: '', purpose: '', scenario: '', keywords: '', fields: '' },
  skillRegistry: { phase: 'ready', skills: [] },
  onSkillField: (field, value) => skillEdits.push(field + '=' + value),
}));
findIn(editSkillView, 'data-jk-kb-skill-name', 'true').props.onChange({ target: { value: 'N' } });
findIn(editSkillView, 'data-jk-kb-skill-purpose', 'true').props.onChange({ target: { value: 'P' } });
findIn(editSkillView, 'data-jk-kb-skill-scenario', 'true').props.onChange({ target: { value: 'S' } });
findIn(editSkillView, 'data-jk-kb-skill-keywords', 'true').props.onChange({ target: { value: 'K' } });
findIn(editSkillView, 'data-jk-kb-skill-fields', 'true').props.onChange({ target: { value: 'F' } });
eq('五个字段回调', skillEdits.join(','), 'name=N,purpose=P,scenario=S,keywords=K,fields=F');

// 提交请求体
const skillFetch = installFetch(() => ({ body: { ok: true, runId: 'skill-run', skillId: 'SK002' } }));
const skillOutcome = await I.startSkillRequest(fullSkillForm, { confirmed: true });
skillFetch.restore();
eq('技能 POST 到 /run', skillFetch.calls[0].url, I.HOST_RUN_PATH);
const skillBody = JSON.parse(skillFetch.calls[0].init.body);
eq('技能 body.kind', skillBody.kind, 'skill');
eq('技能 input.confirm', skillBody.input.confirm, true);
eq('技能 input 名称', skillBody.input.name, '客户访谈整理');
eq('技能 input 关键词', skillBody.input.keywords.join(','), '客户,访谈,复盘');
eq('技能提交成功', skillOutcome.started, true);
const noPostSkill = installFetch(() => ({ body: { ok: true } }));
const invalidOutcome = await I.startSkillRequest({ name: 'a' }, {});
noPostSkill.restore();
eq('表单不完整不发 POST', noPostSkill.calls.length, 0);
eq('表单不完整 code', invalidOutcome.code, 'invalid-form');
const needConfirmFetch = installFetch(() => ({
  status: 422,
  body: { ok: false, error: { code: 'NEED_CONFIRM', message: '需要确认', matches: [{ id: 'SK001', name: '客户访谈', score: 0.9 }] } },
}));
const needConfirm = await I.startSkillRequest(fullSkillForm, {});
needConfirmFetch.restore();
eq('NEED_CONFIRM matches 带回', needConfirm.matches.length, 1);
contains('NEED_CONFIRM 原文', needConfirm.message, '需要确认');

// 技能视图：注册表 + 调用日志
const registrySkills = [
  { id: 'SK001', name: '客户访谈', version: '1.0.0', status: 'active', keywords: ['客户', '访谈'], path: '/kb/11_岗位技能库/通用/SK001-客户访谈.md' },
  { id: 'SK002', name: '会议纪要', version: '1.1.0', status: 'active', keywords: [], path: '' },
];
const registryNorm = I.normalizeRegistryResponse({ ok: true, skills: registrySkills });
eq('注册表归一', registryNorm.ok, true);
eq('注册表条数', registryNorm.skills.length, 2);
eq('注册表关键词', registryNorm.skills[0].keywords.join(','), '客户,访谈');
eq('注册表空路径', registryNorm.skills[1].path, '');
const callsNorm = I.normalizeCallsResponse({
  ok: true,
  calls: [
    { ts: new Date(2026, 9, 5, 10, 30).toISOString(), skill: 'SK001', name: '客户访谈', version: '1.0.0', task: '整理访谈A', result: 'ok', outputs: ['/kb/03_内容'] },
    { ts: new Date(2026, 9, 5, 11, 0).toISOString(), skill: 'SK001', name: '客户访谈', version: '1.0.0', task: '整理访谈B', result: 'fail', reason: '缺字段', outputs: [] },
    { ts: new Date(2026, 9, 6, 9, 0).toISOString(), skill: 'SK002', name: '会议纪要', version: '1.1.0', task: '整理会议', result: 'ok', outputs: [] },
  ],
  nextBefore: null,
});
eq('调用日志归一', callsNorm.ok, true);
eq('调用日志条数', callsNorm.calls.length, 3);
eq('调用结果文案 ok', callsNorm.calls[0].resultLabel, '成功');
eq('调用结果文案 fail', callsNorm.calls[1].resultLabel, '失败');
const callGrid = I.buildSkillCallMonthGrid(2026, 10, callsNorm.calls);
const day5 = callGrid.cells.filter((cell) => cell.date === '2026-10-05')[0];
const day6 = callGrid.cells.filter((cell) => cell.date === '2026-10-06')[0];
eq('10-05 调用数', day5.runCount, 2);
eq('10-05 失败数', day5.failed, 1);
eq('10-06 调用数', day6.runCount, 1);
eq('按日期归组', Object.keys(callGrid.groups).sort().join(','), '2026-10-05,2026-10-06');

const skillViewProps = {
  skills: { phase: 'ready', groups: I.presentSkills({ ok: true, skills: [
    { id: 'sk-interview', name: '客户访谈', profession: '洞察', purpose: '把客户访谈内容整理成结构化要点' },
    { id: 'sk-summary', name: '会议纪要', profession: '洞察', purpose: '把会议录音转成纪要' },
    { id: 'sk-spec', name: '需求整理', profession: '交付', purpose: '把零散需求整理成规格' },
    { id: 'sk-raw', name: '原始整理', profession: '交付', purpose: '' },
  ] }).groups, count: 4, error: null },
  onRetry: () => {},
};
const skillView = I.SkillViewView(skillViewProps);
ok('技能视图容器', !!findIn(skillView, 'data-jk-kb-skill-view', 'true'));
ok('按岗位分组渲染', !!findIn(skillView, 'data-jk-kb-skill-desc-group', '洞察'));
eq('技能总数提示', textOf(findIn(skillView, 'data-jk-kb-skill-count', 'true')), '共 4 项技能，一行一个');
eq('一行一个技能', flatten(skillView).filter((el) => el.props && el.props['data-jk-kb-skill-desc'] !== undefined).length, 4);
contains('技能名称', textOf(findIn(skillView, 'data-jk-kb-skill-desc', 'sk-interview')), '客户访谈');
contains('技能说明', textOf(findIn(skillView, 'data-jk-kb-skill-desc', 'sk-interview')), '结构化要点');
contains('无说明显示占位', textOf(findIn(skillView, 'data-jk-kb-skill-desc', 'sk-raw')), '—');

const skillLoadingView = I.SkillViewView({ skills: { phase: 'loading', groups: [], count: 0, error: null } });
ok('读取中提示', !!findIn(skillLoadingView, 'data-jk-kb-skill-registry-loading', 'true'));
eq('读取中不渲染技能行', flatten(skillLoadingView).filter((el) => el.props && el.props['data-jk-kb-skill-desc'] !== undefined).length, 0);
const skillEmptyView = I.SkillViewView({ skills: { phase: 'ready', groups: [], count: 0, error: null } });
contains('空目录提示', textOf(findIn(skillEmptyView, 'data-jk-kb-skill-registry-empty', 'true')), '暂无技能');
let skillRetried = 0;
const skillErrorView = I.SkillViewView({
  skills: { phase: 'error', groups: [], count: 0, error: { code: 'host-unreachable', message: '宿主服务未连接' } },
  onRetry: () => { skillRetried += 1; },
});
contains('技能目录不可用', textOf(skillErrorView), '技能库不可用');
contains('技能目录错误详情', textOf(skillErrorView), '详情：host-unreachable 宿主服务未连接');
findIn(skillErrorView, 'data-jk-kb-skill-registry-retry', 'true').props.onClick();
eq('技能目录重试回调', skillRetried, 1);
eq('错误态不渲染技能行', flatten(skillErrorView).filter((el) => el.props && el.props['data-jk-kb-skill-desc'] !== undefined).length, 0);

// 接口路径与失败归一
const registryFetch = installFetch(() => ({ body: { ok: true, skills: [] } }));
await I.fetchSkillRegistry({ limit: 50 });
registryFetch.restore();
eq('注册表 URL', registryFetch.calls[0].url, I.HOST_SKILL_REGISTRY_PATH + '?limit=50');
const callsFetch = installFetch(() => ({ body: { ok: true, calls: [], nextBefore: null } }));
await I.fetchSkillCalls({ limit: 100 });
callsFetch.restore();
eq('调用日志 URL', callsFetch.calls[0].url, I.HOST_SKILL_CALLS_PATH + '?limit=100');
const registryDown = installFetch(() => ({ throw: true }));
const registryDownResult = await I.fetchSkillRegistry();
registryDown.restore();
eq('注册表失败归一', I.normalizeRegistryResponse(registryDownResult).ok, false);
eq('调用日志失败归一', I.normalizeCallsResponse({ ok: false, error: { code: 'x' } }).ok, false);

// 不新增定时器
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const skillViewSection = source.slice(source.indexOf('function SkillViewPage'), source.indexOf('function SkillViewView'));
eq('技能视图不挂轮询/定时器',
  skillViewSection.indexOf('usePollingEffect') < 0 && skillViewSection.indexOf('setInterval') < 0 && skillViewSection.indexOf('setTimeout') < 0,
  true);

// ═════════════════════════ 17. 手动回执 + M06/M07 提议 ═════════════════════════
// 回执表单模型
eq('多行产物解析', I.parseOutputs('/kb/03_内容/a.md\n/kb/04_输出/b.md\n\n').join(','), '/kb/03_内容/a.md,/kb/04_输出/b.md');
eq('空产物解析', I.parseOutputs('   ').length, 0);
eq('回执必填校验', I.validateSkillCallForm({}, true).missing.join(','), 'skillId,task');
const failMissingReason = I.validateSkillCallForm({ skillId: 'SK001', task: '做事', result: 'fail', reason: '短' }, true);
eq('fail 原因不足 → reason', failMissingReason.missing.join(','), 'reason');
eq('fail 原因足够 → ok', I.validateSkillCallForm({ skillId: 'SK001', task: '做事', result: 'fail', reason: '字段缺失导致失败' }, true).ok, true);
eq('ok 不需要原因', I.validateSkillCallForm({ skillId: 'SK001', task: '做事', result: 'ok' }, true).ok, true);
eq('任务超长拒绝', I.validateSkillCallForm({ skillId: 'SK001', task: 'x'.repeat(201) }, true).missing.join(','), 'taskTooLong');
eq('空注册表不可提交', I.validateSkillCallForm({ skillId: 'SK001', task: '做事' }, false).ok, false);

const callPayload = I.buildSkillCallPayload({ skillId: ' SK001 ', task: ' 做事 ', result: 'fail', reason: ' 字段缺失 ', outputs: '/kb/03_内容/a.md\n/kb/04_输出/b.md' });
eq('回执 payload skillId', callPayload.skillId, 'SK001');
eq('回执 payload task', callPayload.task, '做事');
eq('回执 payload result', callPayload.result, 'fail');
eq('回执 payload reason', callPayload.reason, '字段缺失');
eq('回执 payload outputs', callPayload.outputs.join(','), '/kb/03_内容/a.md,/kb/04_输出/b.md');
const minimalCallPayload = I.buildSkillCallPayload({ skillId: 'SK001', task: '做事', result: 'ok' });
eq('ok 回执不带 reason', minimalCallPayload.reason, undefined);
eq('无产物不带 outputs', minimalCallPayload.outputs, undefined);

const callSubmitFetch = installFetch(() => ({ body: { ok: true, id: 'call-1', call: { ts: '2026-10-17T06:00:00.000Z' } } }));
const callOutcome = await I.startSkillCallRequest({ skillId: 'SK001', task: '做事', result: 'ok', outputs: '/kb/03_内容/a.md' }, { hasSkills: true });
callSubmitFetch.restore();
eq('回执 POST 路径', callSubmitFetch.calls[0].url, I.HOST_SKILL_CALLS_PATH);
eq('回执方法 POST', callSubmitFetch.calls[0].init.method, 'POST');
const callBody = JSON.parse(callSubmitFetch.calls[0].init.body);
eq('回执 body.skillId', callBody.skillId, 'SK001');
eq('回执 body.task', callBody.task, '做事');
eq('回执 body.result', callBody.result, 'ok');
eq('回执 body.outputs', callBody.outputs.join(','), '/kb/03_内容/a.md');
eq('回执成功 submitted', callOutcome.submitted, true);
eq('回执成功 id', callOutcome.id, 'call-1');

const noCallFetch = installFetch(() => ({ body: { ok: true } }));
const invalidCall = await I.startSkillCallRequest({ task: '做事' }, { hasSkills: true });
noCallFetch.restore();
eq('回执表单不完整不发 POST', noCallFetch.calls.length, 0);
eq('回执表单不完整 code', invalidCall.code, 'invalid-form');

// 三类错误提示
const notFoundFetch = installFetch(() => ({ status: 404, body: { ok: false, error: { code: 'skill-not-found', message: 'skill not found' } } }));
const notFound = await I.startSkillCallRequest({ skillId: 'SK999', task: '做事' }, { hasSkills: true });
notFoundFetch.restore();
eq('skill-not-found 提示', notFound.message, '技能不存在，请重新选择');
const reasonFetch = installFetch(() => ({ status: 400, body: { ok: false, error: { code: 'reason-required', message: 'reason required' } } }));
const reasonError = await I.startSkillCallRequest({ skillId: 'SK001', task: '做事', result: 'fail', reason: '足够长的失败原因' }, { hasSkills: true });
reasonFetch.restore();
eq('reason-required 提示', reasonError.message, '失败必须填写原因（至少 4 个字符）');
const outputFetch = installFetch(() => ({ status: 400, body: { ok: false, error: { code: 'output-forbidden', message: 'forbidden', outputs: ['/etc/passwd'] } } }));
const outputError = await I.startSkillCallRequest({ skillId: 'SK001', task: '做事', outputs: '/etc/passwd' }, { hasSkills: true });
outputFetch.restore();
contains('output-forbidden 提示', outputError.message, '产物路径不合法');
contains('output-forbidden 列出违规项', outputError.message, '/etc/passwd');
const otherCallFetch = installFetch(() => ({ status: 500, body: { ok: false, error: { code: 'internal', message: '炸了' } } }));
const otherCall = await I.startSkillCallRequest({ skillId: 'SK001', task: '做事' }, { hasSkills: true });
otherCallFetch.restore();
eq('其它错误原文', otherCall.message, 'internal 炸了');

const callOkPlan = I.planSkillCallResult({ submitted: true });
eq('回执成功收起表单', callOkPlan.closeForm, true);
eq('回执成功刷新日志', callOkPlan.refresh, true);
eq('回执成功提示已登记', callOkPlan.notice.text, '已登记');
const callFailPlan = I.planSkillCallResult({ submitted: false, message: '技能不存在，请重新选择' });
eq('回执失败不收起', callFailPlan.closeForm, false);
eq('回执失败提示原文', callFailPlan.notice.text, '技能不存在，请重新选择');

// M06/M07 只读提议
const proposalReportTree = I.ReportsView({
  phase: 'ready',
  expandedId: 'rep-m',
  reports: [I.presentReport({
    id: 'rep-m', period: '2026-10', summary: '2 条归档提议', path: '/kb/reports/2026-10.md', createdAt: '2026-10-17T06:00:00Z',
    findings: [
      { ruleId: 'M06', path: '09_项目与运营/项目A/首页.md', proposedTarget: '12_归档与历史/03_归档笔记/09_项目与运营/项目A/首页.md', archiveReason: '项目已结束 45 天未归档', level: 'info', action: 'propose-archive' },
      { ruleId: 'M07', relPath: '05_内容/旧文.md', proposedTarget: '12_归档与历史/03_归档笔记/05_内容/旧文.md', archiveReason: '已废弃 60 天', level: 'info', action: 'propose-archive' },
    ],
  }, 0)],
});
const groupM06 = findIn(proposalReportTree, 'data-jk-kb-report-group', 'M06');
const groupM07 = findIn(proposalReportTree, 'data-jk-kb-report-group', 'M07');
ok('M06 分组存在', !!groupM06);
ok('M07 分组存在', !!groupM07);
contains('M06 建议归档目标', textOf(groupM06), '建议归档到 12_归档与历史/03_归档笔记/09_项目与运营/项目A/首页.md');
contains('M06 归档原因', textOf(groupM06), '项目已结束 45 天未归档');
contains('M07 建议归档目标', textOf(groupM07), '建议归档到 12_归档与历史/03_归档笔记/05_内容/旧文.md');
contains('M07 归档原因', textOf(groupM07), '已废弃 60 天');
eq('后续版本提示已移除', findIn(proposalReportTree, 'data-jk-kb-report-archive-note', 'true'), undefined);
eq('本批不提供执行按钮', flatten(proposalReportTree).filter((el) => el.props && (el.props['data-jk-kb-archive-execute'] !== undefined || el.props['data-jk-kb-report-archive-execute'] !== undefined)).length, 0);
eq('提议标签标记', !!findIn(proposalReportTree, 'data-jk-kb-report-proposed', 'M06-0'), true);
const proposalGroups = I.groupReportFindings(I.presentReport({
  findings: [
    { ruleId: 'M07', proposedTarget: 'x', archiveReason: 'r' },
    { ruleId: 'M06', proposedTarget: 'y', archiveReason: 'r' },
  ],
}, 0).findings);
eq('M06/M07 进入固定分组顺序', proposalGroups.map((group) => group.ruleId).join(','), 'M06,M07');
eq('M06 proposedTarget 归一', proposalGroups[0].items[0].proposedTarget, 'y');
eq('M07 proposedTarget 归一', proposalGroups[1].items[0].proposedTarget, 'x');
eq('archiveReason 归一', proposalGroups[0].items[0].archiveReason, 'r');
eq('relPath 降级为 path', I.presentReport({ findings: [{ ruleId: 'M07', relPath: '05_内容/旧文.md' }] }, 0).findings[0].path, '05_内容/旧文.md');

// ═════════════════════════ 18. 归档执行入口 ═════════════════════════
// 提交体
const archiveFinding = {
  key: 'M06-0',
  ruleId: 'M06',
  path: '09_项目与运营/项目A/首页.md',
  proposedTarget: '12_归档与历史/03_归档笔记/09_项目与运营/项目A/首页.md',
  archiveReason: '项目已结束 45 天未归档',
  successorLink: '09_项目与运营/项目A/新版.md',
};
const archivePayload = I.buildArchivePayload(archiveFinding);
eq('归档 payload kind', archivePayload.kind, 'archive');
eq('归档 confirmed=true', archivePayload.input.confirmed, true);
eq('归档 items 条数', archivePayload.input.items.length, 1);
eq('归档 item relPath', archivePayload.input.items[0].relPath, archiveFinding.path);
eq('归档 item reason', archivePayload.input.items[0].reason, archiveFinding.archiveReason);
eq('归档 item successorLink', archivePayload.input.items[0].successorLink, archiveFinding.successorLink);

const archiveFetch = installFetch(() => ({ body: { ok: true, runId: 'archive-run' } }));
const archiveOutcome = await I.startArchiveRequest(archiveFinding);
archiveFetch.restore();
eq('归档 POST 到 /run', archiveFetch.calls[0].url, I.HOST_RUN_PATH);
eq('归档 method POST', archiveFetch.calls[0].init.method, 'POST');
const archiveBody = JSON.parse(archiveFetch.calls[0].init.body);
eq('归档 body.kind', archiveBody.kind, 'archive');
eq('归档 body.input.confirmed', archiveBody.input.confirmed, true);
eq('归档 body item relPath', archiveBody.input.items[0].relPath, archiveFinding.path);
eq('归档 body item reason', archiveBody.input.items[0].reason, archiveFinding.archiveReason);
eq('归档成功 started', archiveOutcome.started, true);

const noArchiveFetch = installFetch(() => ({ body: { ok: true } }));
const invalidArchive = await I.startArchiveRequest({ path: 'x', archiveReason: '短' });
noArchiveFetch.restore();
eq('归档原因不足不发 POST', noArchiveFetch.calls.length, 0);
eq('归档原因不足 code', invalidArchive.code, 'invalid-item');

// NEED_CONFIRM preview
const needConfirmArchiveFetch = installFetch(() => ({
  status: 400,
  body: { ok: false, error: { code: 'NEED_CONFIRM', message: '需要确认', preview: [{ from: 'a.md', to: '12_归档与历史/03_归档笔记/a.md', reason: '旧文' }] } },
}));
const needConfirmArchive = await I.startArchiveRequest(archiveFinding);
needConfirmArchiveFetch.restore();
eq('归档 NEED_CONFIRM code', needConfirmArchive.code, 'need-confirm');
eq('归档 NEED_CONFIRM preview 条数', needConfirmArchive.preview.length, 1);
eq('归档 NEED_CONFIRM preview from', needConfirmArchive.preview[0].from, 'a.md');

// 422 走既有体检卡
const archive422Fetch = installFetch(() => ({
  status: 422,
  body: { ok: false, error: { code: 'PATH_DENIED', message: '路径不允许', checks: [{ id: 'path', level: 'error', title: '路径', detail: 'x' }] } },
}));
const archive422 = await I.startArchiveRequest(archiveFinding);
archive422Fetch.restore();
eq('归档 422 checks 带回', archive422.checks.length, 1);
eq('归档 422 code', archive422.code, 'PATH_DENIED');

// plan：成功收起 + 刷新 + 通知任务列表
const archiveOkPlan = I.planArchiveResult({ started: true });
eq('归档成功收起弹层', archiveOkPlan.closeDialog, true);
eq('归档成功刷新报告', archiveOkPlan.refreshReports, true);
eq('归档成功通知任务列表刷新', archiveOkPlan.notifyRuns, true);
eq('归档成功提示', archiveOkPlan.notice.text, '已提交归档任务');
const archiveNeedConfirmPlan = I.planArchiveResult({ code: 'need-confirm', preview: [{ from: 'a', to: 'b' }] });
eq('NEED_CONFIRM 保留弹层', archiveNeedConfirmPlan.closeDialog, false);
eq('NEED_CONFIRM preview 透出', archiveNeedConfirmPlan.preview.length, 1);
const archiveFailPlan = I.planArchiveResult({ started: false, message: '路径不允许' });
eq('归档失败不收起', archiveFailPlan.closeDialog, false);
eq('归档失败原文', archiveFailPlan.notice.text, '路径不允许');

// 归档按钮只出现在 M06/M07
const archiveButtonsView = I.ReportsView({
  phase: 'ready',
  expandedId: 'rep-arc',
  reports: [I.presentReport({
    id: 'rep-arc', period: '2026-10', summary: '提议', path: '/kb/report.md', createdAt: '2026-10-17T06:00:00Z',
    findings: [
      { ruleId: 'M01', path: '00_系统与索引/x.md', title: '命名', proposedTarget: '12_归档与历史/03_归档笔记/00_系统与索引/x.md', archiveReason: '不合规命名' },
      { ruleId: 'M06', path: '09_项目与运营/项目A/首页.md', proposedTarget: '12_归档与历史/03_归档笔记/09_项目与运营/项目A/首页.md', archiveReason: '项目已结束 45 天未归档' },
      { ruleId: 'M07', path: '05_内容/旧文.md', proposedTarget: '12_归档与历史/03_归档笔记/05_内容/旧文.md', archiveReason: '已废弃 60 天' },
    ],
  }, 0)],
});
ok('M06 有归档按钮', !!findIn(archiveButtonsView, 'data-jk-kb-archive-button', 'M06-1'));
ok('M07 有归档按钮', !!findIn(archiveButtonsView, 'data-jk-kb-archive-button', 'M07-2'));
eq('M01 没有归档按钮', findIn(archiveButtonsView, 'data-jk-kb-archive-button', 'M01-0'), undefined);

// 二次确认弹层
let archiveRequested = null;
let archiveClosed = 0;
let archiveAckValue = null;
let archiveSubmitted = 0;
const dialogView = I.ReportsView({
  phase: 'ready',
  reports: [I.presentReport({ id: 'rep-arc', period: '2026-10', summary: 'x', findings: [{ ruleId: 'M06', path: archiveFinding.path, proposedTarget: archiveFinding.proposedTarget, archiveReason: archiveFinding.archiveReason }] }, 0)],
  archiveTarget: archiveFinding,
  archiveConfirmed: false,
  archiveBusy: false,
  archiveNotice: null,
  archivePreview: [],
  onArchiveRequest: (finding) => { archiveRequested = finding; },
  onArchiveClose: () => { archiveClosed += 1; },
  onArchiveConfirm: (value) => { archiveAckValue = value; },
  onArchiveSubmit: () => { archiveSubmitted += 1; },
});
ok('确认弹层出现', !!findIn(dialogView, 'data-jk-kb-archive-confirm', 'true'));
contains('目录弹层说明整个目录移动', textOf(findIn(dialogView, 'data-jk-kb-archive-confirm', 'true')), '归档会移动整个目录到 12_归档与历史，目录内文件与结构保持不变；不会删除内容');
eq('目录归档弹层标记', findIn(dialogView, 'data-jk-kb-archive-confirm', 'true').props['data-jk-kb-archive-kind'], 'dir');
const fileArchiveFinding = { key: 'M07-0', ruleId: 'M07', path: '05_内容/旧文.md', proposedTarget: '12_归档与历史/03_归档笔记/05_内容/旧文.md', archiveReason: '已废弃 60 天' };
const fileDialogView = I.ReportsView({
  phase: 'ready', reports: [], archiveTarget: fileArchiveFinding, archiveConfirmed: false, archiveBusy: false, archivePreview: [],
});
contains('文件弹层说明四要素', textOf(findIn(fileDialogView, 'data-jk-kb-archive-confirm', 'true')), '归档会移动文件到 12_归档与历史，四要素会写进文件头；不会删除内容');
eq('文件归档弹层标记', findIn(fileDialogView, 'data-jk-kb-archive-confirm', 'true').props['data-jk-kb-archive-kind'], 'file');
eq('弹层原路径', textOf(findIn(dialogView, 'data-jk-kb-archive-from', 'true')), archiveFinding.path);
eq('弹层目标路径', textOf(findIn(dialogView, 'data-jk-kb-archive-to', 'true')), archiveFinding.proposedTarget);
eq('弹层归档原因', textOf(findIn(dialogView, 'data-jk-kb-archive-reason', 'true')), archiveFinding.archiveReason);
eq('未勾选时禁用提交', findIn(dialogView, 'data-jk-kb-archive-submit', 'true').props.disabled, true);
findIn(dialogView, 'data-jk-kb-archive-ack', 'true').props.onChange({ target: { checked: true } });
eq('勾选回调', archiveAckValue, true);
findIn(dialogView, 'data-jk-kb-archive-cancel', 'true').props.onClick();
eq('取消回调', archiveClosed, 1);
const confirmedDialogView = I.ReportsView(Object.assign({}, {
  phase: 'ready',
  reports: [],
  archiveTarget: archiveFinding,
  archiveConfirmed: true,
  archiveBusy: false,
  archivePreview: [],
  onArchiveSubmit: () => { archiveSubmitted += 1; },
}));
eq('勾选后允许提交', findIn(confirmedDialogView, 'data-jk-kb-archive-submit', 'true').props.disabled, false);
findIn(confirmedDialogView, 'data-jk-kb-archive-submit', 'true').props.onClick();
eq('提交回调', archiveSubmitted, 1);

// NEED_CONFIRM preview 渲染
const previewDialogView = I.ReportsView({
  phase: 'ready', reports: [],
  archiveTarget: archiveFinding,
  archiveConfirmed: false,
  archivePreview: [{ from: 'a.md', to: '12_归档与历史/03_归档笔记/a.md', reason: '旧文' }],
  archiveNotice: { kind: 'error', text: '宿主要求再次确认，请核对 preview 后重试' },
});
contains('preview 列表渲染', textOf(findIn(previewDialogView, 'data-jk-kb-archive-preview', 'true')), 'a.md → 12_归档与历史/03_归档笔记/a.md');
contains('preview 原因', textOf(findIn(previewDialogView, 'data-jk-kb-archive-preview', 'true')), '旧文');
contains('NEED_CONFIRM 提示', textOf(findIn(previewDialogView, 'data-jk-kb-archive-notice', 'error')), '宿主要求再次确认');

// 归档按钮点击回传 finding
let requestedFinding = null;
const clickView = I.ReportsView(Object.assign({}, {
  phase: 'ready',
  reports: [I.presentReport({ id: 'rep-arc', period: '2026-10', summary: 'x', findings: [{ ruleId: 'M06', path: 'a.md', proposedTarget: 'b.md', archiveReason: '旧' }] }, 0)],
  expandedId: 'rep-arc',
  onArchiveRequest: (finding) => { requestedFinding = finding; },
}));
findIn(clickView, 'data-jk-kb-archive-button', 'M06-0').props.onClick();
eq('归档按钮回传 finding', requestedFinding.ruleId, 'M06');
eq('回传 finding 原因', requestedFinding.archiveReason, '旧');

// 不新增定时器
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const archiveReportsSection2 = source.slice(source.indexOf('function ReportsPanel'), source.indexOf('function ReportsView'));
eq('报告面板不挂轮询/定时器',
  archiveReportsSection2.indexOf('usePollingEffect') < 0 && archiveReportsSection2.indexOf('setInterval') < 0 && archiveReportsSection2.indexOf('setTimeout') < 0,
  true);

// ═════════════════════════ 19. 业务专家（角色卡） ═════════════════════════
// 列表与归一
const expertsFixture = [
  { id: 'EXP-001', name: '客户成功专家', domain: '客户成功', responsibility: '把客户访谈整理成可复用的客户成功卡片与复盘记录。', skillIds: ['mkt-copy', 'mkt-plan'], promptFragment: '优先提炼客户原话', status: 'active', createdAt: '2026-10-17T06:00:00Z', updatedAt: '2026-10-17T07:00:00Z' },
  { id: 'EXP-002', name: '研发文档专家', domain: '研发', responsibility: '整理接口设计与故障复盘，形成可检索的技术卡片。', skillIds: [], promptFragment: '', status: 'active' },
];
const expertsNorm = I.normalizeExpertsResponse({ ok: true, experts: expertsFixture });
eq('专家列表归一', expertsNorm.ok, true);
eq('专家条数', expertsNorm.experts.length, 2);
eq('专家名称', expertsNorm.experts[0].name, '客户成功专家');
eq('专家领域', expertsNorm.experts[0].domain, '客户成功');
eq('专家技能 id', expertsNorm.experts[0].skillIds.join(','), 'mkt-copy,mkt-plan');
eq('专家状态', expertsNorm.experts[0].status, 'active');
eq('专家缺字段降级', expertsNorm.experts[1].promptFragment, '');
const expertsFetch = installFetch(() => ({ body: { ok: true, experts: [] } }));
await I.fetchExperts({ status: 'active' });
const expertsArchivedFetch = installFetch(() => ({ body: { ok: true, experts: [] } }));
await I.fetchExperts({ status: 'archived' });
expertsFetch.restore();
expertsArchivedFetch.restore();
eq('专家 active URL', expertsFetch.calls[0].url, I.HOST_EXPERTS_PATH + '?status=active');
eq('专家 archived URL', expertsArchivedFetch.calls[0].url, I.HOST_EXPERTS_PATH + '?status=archived');
const expertsDown = installFetch(() => ({ throw: true }));
const expertsDownResult = await I.fetchExperts();
expertsDown.restore();
eq('专家请求失败归一', I.normalizeExpertsResponse(expertsDownResult).ok, false);

// 卡片字段与空态
let editedExpert = null;
let archivedExpert = null;
const expertsView = I.ExpertsView({
  status: 'active',
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
  skills: { phase: 'ready', groups: I.presentSkills({ ok: true, skills: [
    { id: 'mkt-copy', name: '营销文案', role: '市场', stage: 'v1', purpose: '生成营销文案初稿' },
    { id: 'mkt-plan', name: '营销策划', role: '市场', stage: 'v2', purpose: '制定季度营销策划' },
  ] }).groups, error: null },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
  onEdit: (expert) => { editedExpert = expert; },
  onArchive: (expert) => { archivedExpert = expert; },
});
ok('专家卡片存在', !!findIn(expertsView, 'data-jk-kb-expert', 'EXP-001'));
eq('卡片名称', textOf(findIn(expertsView, 'data-jk-kb-expert-name', 'EXP-001')), '客户成功专家');
eq('卡片领域', textOf(findIn(expertsView, 'data-jk-kb-expert-domain', 'EXP-001')), '客户成功');
contains('卡片职责', textOf(findIn(expertsView, 'data-jk-kb-expert-responsibility', 'EXP-001')), '客户访谈');
contains('卡片技能数', textOf(findIn(expertsView, 'data-jk-kb-expert-skills', 'EXP-001')), '技能：2');
eq('卡片信号触发器', !!findIn(expertsView, 'data-jk-kb-expert-signal', 'EXP-001'), true);
eq('卡片信号浮层 tooltip 角色', findIn(expertsView, 'data-jk-kb-expert-signal-popover', 'EXP-001').props.role, 'tooltip');
contains('信号浮层技能名', textOf(findIn(expertsView, 'data-jk-kb-expert-signal-item', '营销文案')), '营销文案');
contains('信号浮层技能介绍', textOf(findIn(expertsView, 'data-jk-kb-expert-signal-item', '营销文案')), '生成营销文案初稿');
ok('信号浮层未绑定技能兜底', !!findIn(expertsView, 'data-jk-kb-expert-signal-empty', 'true'));
eq('卡片提示词有', textOf(findIn(expertsView, 'data-jk-kb-expert-prompt', 'EXP-001')), '提示词：有');
eq('卡片提示词无', textOf(findIn(expertsView, 'data-jk-kb-expert-prompt', 'EXP-002')), '提示词：无');
findIn(expertsView, 'data-jk-kb-expert-edit', 'EXP-001').props.onClick();
eq('编辑回传专家', editedExpert.id, 'EXP-001');
eq('活跃卡片不再有归档按钮（按需求移除）', findIn(expertsView, 'data-jk-kb-expert-archive', 'EXP-001'), undefined);
eq('top 新建按钮', !!findIn(expertsView, 'data-jk-kb-expert-new', 'true'), true);
eq('状态切换按钮', findIn(expertsView, 'data-jk-kb-experts-status', 'archived').props['data-jk-kb-experts-status'], 'archived');
// 主页面 cardsHidden：全部/其他 标签页 + 卡片（卡片与设置页同款）
const panelTabChanges = [];
const panelExpertsView = I.ExpertsView({
  cardsHidden: true,
  panelTab: 'all',
  onPanelTab: (tab) => panelTabChanges.push(tab),
  status: 'active',
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
  skills: { phase: 'ready', groups: [], error: null },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
});
ok('主页面挂全部标签', !!findIn(panelExpertsView, 'data-jk-kb-expert-tab', 'all'));
ok('主页面挂其他标签', !!findIn(panelExpertsView, 'data-jk-kb-expert-tab', 'other'));
eq('默认全部标签激活', findIn(panelExpertsView, 'data-jk-kb-expert-tab', 'all').props['aria-pressed'], true);
eq('全部标签文案', textOf(findIn(panelExpertsView, 'data-jk-kb-expert-tab', 'all')), '全部');
eq('其他标签文案', textOf(findIn(panelExpertsView, 'data-jk-kb-expert-tab', 'other')), '其他');
ok('全部标签下有专家卡片', !!findIn(panelExpertsView, 'data-jk-kb-expert', 'EXP-001'));
findIn(panelExpertsView, 'data-jk-kb-expert-tab', 'other').props.onClick();
eq('切到其他标签回调', panelTabChanges.join(','), 'other');
// 其他标签：仅显示领域为「其他」或未填的专家（两个 fixture 领域均非「其他」→ 空态）
const otherExpertsView = I.ExpertsView({
  cardsHidden: true,
  panelTab: 'other',
  status: 'active',
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
  skills: { phase: 'ready', groups: [], error: null },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
});
eq('其他标签激活', findIn(otherExpertsView, 'data-jk-kb-expert-tab', 'other').props['aria-pressed'], true);
eq('其他标签过滤非其他领域专家', findIn(otherExpertsView, 'data-jk-kb-expert', 'EXP-001'), undefined);
contains('其他标签空态文案', textOf(findIn(otherExpertsView, 'data-jk-kb-experts-empty', 'true')), '「其他」分类下还没有专家');
// 立即使用：主页面「全部」标签下编辑按钮换成「立即使用」；点击进入对话、收起专家区域
eq('全部标签下是立即使用按钮', textOf(findIn(panelExpertsView, 'data-jk-kb-expert-use', 'EXP-001')), '立即使用');
eq('全部标签下无编辑按钮', findIn(panelExpertsView, 'data-jk-kb-expert-edit', 'EXP-001'), undefined);
const usedExperts = [];
const useModeView = I.ExpertsView({
  cardsHidden: true,
  panelTab: 'all',
  onUseExpert: (expert) => usedExperts.push(expert.id),
  status: 'active',
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
  skills: { phase: 'ready', groups: [], error: null },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
});
findIn(useModeView, 'data-jk-kb-expert-use', 'EXP-001').props.onClick();
eq('立即使用回传专家', usedExperts.join(','), 'EXP-001');
eq('设置页卡片仍是编辑按钮', textOf(findIn(expertsView, 'data-jk-kb-expert-edit', 'EXP-001')), '编辑');
let chatBacked = 0;
const chatModeView = I.ExpertsView({
  chatExpert: expertsNorm.experts[0],
  onChatBack: () => { chatBacked += 1; },
  status: 'active',
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
  skills: {
    phase: 'ready', error: null,
    groups: [{ key: '内容', label: '内容', skills: [
      { id: 'mkt-copy', name: '文案整理', label: '文案整理' },
      { id: 'mkt-plan', name: '投放计划', label: '投放计划' },
      { id: 'other', name: '不相关技能', label: '不相关技能' },
    ] }],
  },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
});
eq('对话模式挂 ExpertChatPage', chatModeView.type, I.ExpertChatPage);
eq('对话模式绑定专家', chatModeView.props.expert.id, 'EXP-001');
eq('对话模式技能分组按专家过滤', chatModeView.props.skillGroups[0].skills.map((skill) => skill.id).join(','), 'mkt-copy,mkt-plan');
chatModeView.props.onBack();
eq('对话返回回调', chatBacked, 1);
eq('对话模式收起专家区域', findIn(chatModeView, 'data-jk-kb-experts-list', 'true'), undefined);
// 专家对话视图：输入框在下方、执行步骤时间线原样呈现
const chatDetail = I.presentRunDetail({
  run: { id: 'run-chat-1', title: '整理入库', kind: 'curate', status: 'done', startedAt: '2026-10-23T08:00:00Z', endedAt: '2026-10-23T08:00:05Z', summary: '入柜 2 张卡片' },
  steps: [{ id: 's1', name: '解析正文', status: 'done', startedAt: '2026-10-23T08:00:00Z', endedAt: '2026-10-23T08:00:02Z' }],
});
const chatView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [
    { key: 'chat-1', text: '请整理这段访谈', runId: 'run-chat-1', phase: 'done', detail: chatDetail, error: null },
    { key: 'chat-2', text: '起跑失败的消息', runId: null, phase: 'failed', detail: null, error: 'run 启动失败' },
  ],
  draft: '下一条',
  busy: false,
  onSend: () => {},
  onBack: () => {},
});
contains('对话头部专家名', textOf(findIn(chatView, 'data-jk-kb-chat-expert', 'EXP-001')), '客户成功专家');
contains('用户消息气泡', textOf(findIn(chatView, 'data-jk-kb-chat-user', 'chat-1')), '请整理这段访谈');
contains('执行块状态', textOf(findIn(chatView, 'data-jk-kb-chat-run', 'run-chat-1')), '完成');
ok('执行块含步骤时间线', !!findIn(chatView, 'data-jk-kb-step', 's1'));
contains('完成摘要', textOf(findIn(chatView, 'data-jk-kb-chat-summary', 'chat-1')), '入柜 2 张卡片');
ok('起跑失败渲染错误提示', !!findIn(chatView, 'data-jk-kb-chat-error', 'chat-2'));
contains('输入框占位文案', findIn(chatView, 'data-jk-kb-chat-draft', 'true').props.placeholder, '回车发送');
eq('输入框是多行 textarea', findIn(chatView, 'data-jk-kb-chat-draft', 'true').type, 'textarea');
contains('输入框支持换行提示', findIn(chatView, 'data-jk-kb-chat-draft', 'true').props.placeholder, 'Shift+回车换行');
eq('发送按钮可点（草稿非空）', findIn(chatView, 'data-jk-kb-chat-send', 'true').props.disabled, false);
eq('发送按钮为圆形图标钮', findIn(chatView, 'data-jk-kb-chat-send', 'true').props['aria-label'], '发送');
contains('composer 绑定专家提示', textOf(findIn(chatView, 'data-jk-kb-chat-binding', 'true')), '绑定专家');
eq('加号钮为技能选择入口', findIn(chatView, 'data-jk-kb-chat-plus', 'true').props['aria-label'], '选择技能');
eq('加号钮可点击', findIn(chatView, 'data-jk-kb-chat-plus', 'true').props.disabled, false);
eq('输入框行数加大', findIn(chatView, 'data-jk-kb-chat-draft', 'true').props.rows, 5);
ok('输入框使用加大样式', (findIn(chatView, 'data-jk-kb-chat-draft', 'true').props.className || '').includes('jk-kb-chat-draft'));
eq('语音不支持时无麦克风', findIn(chatView, 'data-jk-kb-chat-mic', 'true'), undefined);
eq('默认不弹技能浮层', findIn(chatView, 'data-jk-kb-skill-menu', 'true'), undefined);
eq('未选技能无标签', findIn(chatView, 'data-jk-kb-chat-skill-tags', 'true'), undefined);
// 快捷选项：三行单选，点击回传预设并收起
const pickedPresets = [];
const presetsView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [],
  draft: '',
  busy: false,
  showPresets: true,
  presets: [
    { id: 'interview', label: '整理一段访谈记录', text: '请把这段访谈记录整理成知识卡片：\n\n' },
    { id: 'note', label: '整理一篇技术笔记', text: '请把这篇技术笔记整理成知识卡片：\n\n' },
    { id: 'minutes', label: '整理一份会议纪要', text: '请把这份会议纪要整理成知识卡片：\n\n' },
  ],
  onPickPreset: (option) => pickedPresets.push(option.id),
  onSend: () => {},
  onBack: () => {},
});
ok('快捷选项容器是 radiogroup', !!findIn(presetsView, 'data-jk-kb-chat-presets', 'true'));
eq('快捷选项共三条', flatten(presetsView).filter((el) => el.props && el.props['data-jk-kb-chat-preset'] !== undefined).length, 3);
eq('快捷选项一标签', textOf(findIn(presetsView, 'data-jk-kb-chat-preset', 'interview')), '整理一段访谈记录');
eq('快捷选项二标签', textOf(findIn(presetsView, 'data-jk-kb-chat-preset', 'note')), '整理一篇技术笔记');
eq('快捷选项三标签', textOf(findIn(presetsView, 'data-jk-kb-chat-preset', 'minutes')), '整理一份会议纪要');
eq('选项为单选角色', findIn(presetsView, 'data-jk-kb-chat-preset', 'interview').props.role, 'radio');
findIn(presetsView, 'data-jk-kb-chat-preset', 'note').props.onClick();
eq('点击选项回传预设', pickedPresets.join(','), 'note');
const presetHiddenView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [],
  draft: '请把这篇技术笔记整理成知识卡片：\n\n',
  busy: false,
  showPresets: false,
  presets: [],
  onPickPreset: () => {},
  onSend: () => {},
  onBack: () => {},
});
eq('选项选后收起隐藏', findIn(presetHiddenView, 'data-jk-kb-chat-presets', 'true'), undefined);
eq('选中内容填入输入框', findIn(presetHiddenView, 'data-jk-kb-chat-draft', 'true').props.value, '请把这篇技术笔记整理成知识卡片：\n\n');
// 加号浮层：列出该专家绑定的技能，选中后以标签形式挂在输入框上
const chatSkillGroups = [
  { key: '内容', label: '内容', skills: [
    { id: 'mkt-copy', name: '文案整理', label: '文案整理' },
    { id: 'mkt-plan', name: '投放计划', label: '投放计划' },
  ] },
  { key: '洞察', label: '洞察', skills: [{ id: 'sk-insight', name: '行业洞察', label: '行业洞察' }] },
];
const pickedSkills = [];
let skillMenuToggled = 0;
let skillRemoved = 0;
const skillMenuView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [],
  draft: '正文',
  busy: false,
  skillGroups: chatSkillGroups,
  skillMenuOpen: true,
  selectedSkillId: '',
  onToggleSkillMenu: () => { skillMenuToggled += 1; },
  onPickSkill: (id) => { pickedSkills.push(id); },
  onRemoveSkill: () => { skillRemoved += 1; },
  onSend: () => {},
  onBack: () => {},
});
eq('浮层角色为 listbox', findIn(skillMenuView, 'data-jk-kb-skill-menu', 'true').props.role, 'listbox');
eq('浮层选项数（自动判定 + 3 技能）', flatten(skillMenuView).filter((el) => el.props && el.props['data-jk-kb-skill-option'] !== undefined).length, 4);
contains('自动判定选项', textOf(findIn(skillMenuView, 'data-jk-kb-skill-option', '')), '自动判定');
contains('技能选项带名称', textOf(findIn(skillMenuView, 'data-jk-kb-skill-option', 'mkt-copy')), '文案整理');
ok('分组标题渲染', !!findIn(skillMenuView, 'data-jk-kb-skill-menu-group', '洞察'));
eq('加号钮展开态回传', findIn(skillMenuView, 'data-jk-kb-chat-plus', 'true').props['aria-expanded'], true);
findIn(skillMenuView, 'data-jk-kb-chat-plus', 'true').props.onClick();
eq('加号触发浮层开关回调', skillMenuToggled, 1);
findIn(skillMenuView, 'data-jk-kb-skill-option', 'mkt-plan').props.onClick();
eq('点选技能回传 id', pickedSkills.join(','), 'mkt-plan');
findIn(skillMenuView, 'data-jk-kb-skill-option', '').props.onClick();
eq('点自动判定回传空 id', pickedSkills.join(','), 'mkt-plan,');
const skillTagView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [],
  draft: '正文',
  busy: false,
  skillGroups: chatSkillGroups,
  skillMenuOpen: false,
  selectedSkillId: 'sk-insight',
  onToggleSkillMenu: () => {},
  onPickSkill: () => {},
  onRemoveSkill: () => { skillRemoved += 1; },
  onSend: () => {},
  onBack: () => {},
});
contains('选中技能以标签展示', textOf(findIn(skillTagView, 'data-jk-kb-chat-skill-tag', 'sk-insight')), '技能：行业洞察');
eq('选中后浮层收起', findIn(skillTagView, 'data-jk-kb-skill-menu', 'true'), undefined);
eq('加号钮收起态回传', findIn(skillTagView, 'data-jk-kb-chat-plus', 'true').props['aria-expanded'], false);
findIn(skillTagView, 'data-jk-kb-chat-skill-remove', 'true').props.onClick();
eq('移除技能标签回调', skillRemoved, 1);
const skillTagRawView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '', busy: false,
  skillGroups: chatSkillGroups, skillMenuOpen: false, selectedSkillId: 'ghost-id',
  onSend: () => {}, onBack: () => {},
});
contains('目录缺失时标签兜底显示 id', textOf(findIn(skillTagRawView, 'data-jk-kb-chat-skill-tag', 'ghost-id')), '技能：ghost-id');
const skillMenuEmptyView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '', busy: false,
  skillGroups: [], skillMenuOpen: true, selectedSkillId: '',
  onSend: () => {}, onBack: () => {},
});
contains('专家未绑技能空提示', textOf(findIn(skillMenuEmptyView, 'data-jk-kb-skill-menu-empty', 'true')), '该专家暂未绑定技能');
// 语音输入麦克风：支持时渲染、点击回传切换、录音中高亮
let micToggled = 0;
const micView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '正文', busy: false,
  speechSupported: true,
  listening: false,
  onToggleListening: () => { micToggled += 1; },
  onSend: () => {}, onBack: () => {},
});
eq('支持语音时渲染麦克风', findIn(micView, 'data-jk-kb-chat-mic', 'true').props['aria-label'], '语音输入');
eq('麦克风未录音态', findIn(micView, 'data-jk-kb-chat-mic', 'true').props['aria-pressed'], false);
ok('未录音无高亮类', !(findIn(micView, 'data-jk-kb-chat-mic', 'true').props.className || '').includes('jk-kb-chat-mic-on'));
findIn(micView, 'data-jk-kb-chat-mic', 'true').props.onClick();
eq('麦克风点击回传', micToggled, 1);
const micOnView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '正文', busy: false,
  speechSupported: true,
  listening: true,
  onToggleListening: () => { micToggled += 1; },
  onSend: () => {}, onBack: () => {},
});
eq('录音中按钮为按下态', findIn(micOnView, 'data-jk-kb-chat-mic', 'true').props['aria-pressed'], true);
ok('录音中高亮类', (findIn(micOnView, 'data-jk-kb-chat-mic', 'true').props.className || '').includes('jk-kb-chat-mic-on'));
findIn(micOnView, 'data-jk-kb-chat-mic', 'true').props.onClick();
eq('录音中点击停止回调', micToggled, 2);
// 语音状态机：录音/转写/错误反馈渲染对应提示；录音中图标换成停止方块
const micPhaseView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '正文', busy: false,
  speechSupported: true, listening: true, speechPhase: 'recording',
  onToggleListening: () => {}, onSend: () => {}, onBack: () => {},
});
contains('录音中状态提示', textOf(findIn(micPhaseView, 'data-jk-kb-chat-speech-status', 'recording')), '正在聆听');
ok('录音中渲染停止方块', !!findIn(micPhaseView, 'data-jk-kb-chat-mic-stop-icon', 'true'));
eq('录音中麦克风标签', findIn(micPhaseView, 'data-jk-kb-chat-mic', 'true').props['aria-label'], '停止语音输入');
const micTranscribeView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '正文', busy: false,
  speechSupported: true, listening: false, speechPhase: 'transcribing',
  onToggleListening: () => {}, onSend: () => {}, onBack: () => {},
});
contains('转写中状态提示', textOf(findIn(micTranscribeView, 'data-jk-kb-chat-speech-status', 'transcribing')), '正在转文字');
const micFeedbackView = I.ExpertChatView({
  expert: expertsNorm.experts[0],
  entries: [], draft: '正文', busy: false,
  speechSupported: true, listening: false, speechPhase: 'feedback',
  speechMessage: '麦克风权限被拒绝，请在系统设置中允许访问麦克风',
  onToggleListening: () => {}, onSend: () => {}, onBack: () => {},
});
contains('错误反馈提示', textOf(findIn(micFeedbackView, 'data-jk-kb-chat-speech-status', 'feedback')), '麦克风权限被拒绝');
ok('idle 时不渲染状态提示', flatten(micView).filter((el) => el.props && el.props['data-jk-kb-chat-speech-status'] !== undefined).length === 0);
// 语音 WAV 编码：16kHz 单声道 PCM16 小端（宿主 speech/transcribe 的规范输入）
const wavBytes = I.speechEncodeWav(new Float32Array([0, 1, -1, 0.5]));
const wavView = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
eq('WAV 头标识', String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]), 'RIFF');
eq('WAV 声道数 1', wavView.getUint16(22, true), 1);
eq('WAV 采样率 16k', wavView.getUint32(24, true), 16000);
eq('WAV 位深 16', wavView.getUint16(34, true), 16);
eq('WAV 数据长度', wavView.getUint32(40, true), 8);
eq('WAV 总长 52', wavBytes.byteLength, 52);
eq('WAV base64 编码', I.speechWavToBase64(new Uint8Array([104, 105])), 'aGk=');
eq('录音权限错误文案', I.describeRecorderError({ name: 'NotAllowedError' }), '麦克风权限被拒绝，请在系统设置中允许访问麦克风');
eq('录音设备缺失文案', I.describeRecorderError({ name: 'NotFoundError' }), '未找到可用的麦克风设备');
eq('录音错误透传消息', I.describeRecorderError({ message: '录音中断' }), '录音中断');
// 语音桥：setupSpeechBridge 动态注入 remote.speech，挂载/卸载同步可用性并通知订阅者
let bridgeInject = null;
I.setupSpeechBridge({
  inject(deps, callback) { eq('语音桥注入依赖', deps.join(','), 'remote.speech'); bridgeInject = callback; return { dispose() {} }; },
});
eq('初始语音 API 不可用', I.getSpeechApi(), null);
const fakeSpeechApi = { catalog: async () => ({ ok: true }), transcribe: async () => ({ ok: true }) };
const speechAvailability = [];
const detachSpeechListener = I.subscribeSpeech((available) => speechAvailability.push(available));
// cordis 命名空间服务的标准访问路径：fiber 激活后通过 ctx['remote.speech'] 取实例
const detachBridge = bridgeInject({ 'remote.speech': fakeSpeechApi });
eq('挂载后语音 API 可用', I.getSpeechApi(), fakeSpeechApi);
detachBridge();
eq('卸载后语音 API 不可用', I.getSpeechApi(), null);
// 兼容路径：链上有 'remote' 注入时 ctx.remote.speech 也能取到
const detachBridgeAlt = bridgeInject({ remote: { speech: fakeSpeechApi } });
ok('兼容路径挂载语音 API', I.getSpeechApi() === fakeSpeechApi);
detachBridgeAlt();
eq('兼容路径卸载后不可用', I.getSpeechApi(), null);
detachSpeechListener();
eq('订阅收到挂载卸载通知', speechAvailability.join(','), 'true,false,true,false');
// 非法注入体（方法缺失）不算可用
bridgeInject({ 'remote.speech': { catalog: async () => ({ ok: true }) } });
eq('方法缺失不挂载', I.getSpeechApi(), null);
I.setupSpeechBridge({ inject: undefined });
ok('旧宿主桥接静默降级', I.getSpeechApi() === null);
const emptyExpertsView = I.ExpertsView(Object.assign({}, {
  status: 'active',
  experts: { phase: 'ready', list: [], error: null },
  skills: { phase: 'ready', groups: [] },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
}));
contains('专家空态文案', textOf(findIn(emptyExpertsView, 'data-jk-kb-experts-empty', 'true')), '还没有业务专家。专家 = 一组技能 + 一段职责说明，入柜时可以指定由谁处理。');
let expertsRetried = 0;
const expertsErrorView = I.ExpertsView(Object.assign({}, {
  status: 'active',
  experts: { phase: 'error', list: [], error: { code: 'host-unreachable', message: '宿主服务未连接' } },
  skills: { phase: 'ready', groups: [] },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
  onRetry: () => { expertsRetried += 1; },
}));
contains('专家列表不可用', textOf(expertsErrorView), '专家列表不可用');
contains('专家错误详情', textOf(expertsErrorView), '详情：host-unreachable 宿主服务未连接');
findIn(expertsErrorView, 'data-jk-kb-experts-retry', 'true').props.onClick();
eq('专家重试回调', expertsRetried, 1);

// 表单校验
eq('名称必填', I.validateExpertForm({}).errors.name, '名称必填');
eq('域名必填', I.validateExpertForm({ name: 'x' }).errors.domain, '领域必填');
eq('职责至少 10 字', I.validateExpertForm({ name: 'x', domain: 'y', responsibility: '短' }).errors.responsibility, '职责至少 10 个字符');
eq('提示词超长', I.validateExpertForm({ name: 'x', domain: 'y', responsibility: '这是十个字符以上的职责说明', promptFragment: 'x'.repeat(2001) }).errors.promptFragment, '提示词片段不能超过 2000 字符');
eq('合法表单通过', I.validateExpertForm({ name: 'x', domain: 'y', responsibility: '这是十个字符以上的职责说明' }).ok, true);
eq('名称超长', I.validateExpertForm({ name: 'x'.repeat(61), domain: 'y', responsibility: '这是十个字符以上的职责说明' }).errors.name, '名称不能超过 60 字符');
eq('领域超长', I.validateExpertForm({ name: 'x', domain: 'y'.repeat(41), responsibility: '这是十个字符以上的职责说明' }).errors.domain, '领域不能超过 40 字符');

const expertPayload = I.buildExpertPayload({ name: ' 专家 ', domain: ' 领域 ', responsibility: ' 这是十个字符以上的职责说明 ', skillIds: ['a', 'b'], promptFragment: '提示' });
eq('专家 payload name', expertPayload.name, '专家');
eq('专家 payload domain', expertPayload.domain, '领域');
eq('专家 payload responsibility', expertPayload.responsibility, '这是十个字符以上的职责说明');
eq('专家 payload skillIds', expertPayload.skillIds.join(','), 'a,b');
eq('专家 payload prompt', expertPayload.promptFragment, '提示');
// 三条写路径
const createExpertFetch = installFetch(() => ({ body: { ok: true, expert: { id: 'EXP-003', name: '新专家', domain: 'D', responsibility: '这是十个字符以上的职责说明', status: 'active' } } }));
const createdExpert = await I.createExpertRequest({ name: '新专家', domain: 'D', responsibility: '这是十个字符以上的职责说明', skillIds: ['mkt-copy'] });
createExpertFetch.restore();
eq('创建专家 POST 路径', createExpertFetch.calls[0].url, I.HOST_EXPERTS_PATH);
eq('创建专家 method', createExpertFetch.calls[0].init.method, 'POST');
const createBody = JSON.parse(createExpertFetch.calls[0].init.body);
eq('创建专家 body.name', createBody.name, '新专家');
eq('创建专家 body.skillIds', createBody.skillIds.join(','), 'mkt-copy');
eq('创建专家成功', createdExpert.ok, true);
eq('创建专家返回 expert', createdExpert.expert.id, 'EXP-003');
const updateExpertFetch = installFetch(() => ({ body: { ok: true, expert: { id: 'EXP-001', name: '客户成功专家', status: 'active' } } }));
const updatedExpert = await I.updateExpertRequest('EXP-001', { name: '客户成功专家', domain: '客户成功', responsibility: '这是十个字符以上的职责说明' });
updateExpertFetch.restore();
eq('更新专家 PATCH 路径', updateExpertFetch.calls[0].url, I.HOST_EXPERTS_PATH + '/EXP-001');
eq('更新专家 method', updateExpertFetch.calls[0].init.method, 'PATCH');
eq('更新专家 body.name', JSON.parse(updateExpertFetch.calls[0].init.body).name, '客户成功专家');
eq('更新专家成功', updatedExpert.ok, true);
const archiveExpertFetch = installFetch(() => ({ body: { ok: true, expert: { id: 'EXP-001', status: 'archived' } } }));
const archivedResult = await I.archiveExpertRequest('EXP-001');
archiveExpertFetch.restore();
eq('归档专家 POST 路径', archiveExpertFetch.calls[0].url, I.HOST_EXPERTS_PATH + '/EXP-001/archive');
eq('归档专家 method', archiveExpertFetch.calls[0].init.method, 'POST');
eq('归档专家成功', archivedResult.ok, true);
eq('归档成功状态', archivedResult.expert.status, 'archived');

// 九类错误提示
eq('name-required 提示', I.describeExpertError({ error: { code: 'name-required' } }), '名称必填');
eq('name-too-long 提示', I.describeExpertError({ error: { code: 'name-too-long' } }), '名称不能超过 60 字符');
eq('domain-required 提示', I.describeExpertError({ error: { code: 'domain-required' } }), '领域必填');
eq('domain-too-long 提示', I.describeExpertError({ error: { code: 'domain-too-long' } }), '领域不能超过 40 字符');
eq('responsibility-too-short 提示', I.describeExpertError({ error: { code: 'responsibility-too-short' } }), '职责至少 10 个字符');
eq('prompt-too-long 提示', I.describeExpertError({ error: { code: 'prompt-too-long' } }), '提示词片段不能超过 2000 字符');
contains('unknown-skill 提示列出 id', I.describeExpertError({ error: { code: 'unknown-skill', skillIds: ['X1', 'X2'] } }), 'X1、X2');
eq('expert-not-found 提示', I.describeExpertError({ error: { code: 'expert-not-found' } }), '专家不存在（可能已被删除）');
eq('already-archived 提示', I.describeExpertError({ error: { code: 'already-archived' } }), '该专家已归档');
eq('其它错误保留原文', I.describeExpertError({ error: { code: 'internal', message: '炸了' } }), 'internal 炸了');
const unknownSkills = I.normalizeExpertWrite({ ok: false, error: { code: 'unknown-skill', skillIds: ['A'] } });
eq('未知技能列表归一', unknownSkills.unknownSkills.join(','), 'A');

// 成功计划：提示 + 刷新 + 归档切视图
const createPlan = I.planExpertWriteResult('create', { ok: true });
eq('创建成功提示', createPlan.notice.text, '已创建');
eq('创建成功关闭表单', createPlan.closeForm, true);
eq('创建成功刷新列表', createPlan.refresh, true);
eq('创建后停留 active', createPlan.nextStatus, 'active');
const updatePlan = I.planExpertWriteResult('update', { ok: true });
eq('保存成功提示', updatePlan.notice.text, '已保存');
const archivePlan = I.planExpertWriteResult('archive', { ok: true });
eq('归档成功提示', archivePlan.notice.text, '已归档');
eq('归档成功关闭弹层', archivePlan.closeArchive, true);
eq('归档后切到 archived', archivePlan.nextStatus, 'archived');
const writeFailPlan = I.planExpertWriteResult('create', { ok: false, message: '未知技能：X1' });
eq('写失败不关闭表单', writeFailPlan.closeForm, false);
eq('写失败提示原文', writeFailPlan.notice.text, '未知技能：X1');

// 新建表单渲染 + 技能多选 + 搜索
let expertFieldEdits = [];
let toggledSkill = null;
const expertFormView = I.ExpertsView(Object.assign({}, {
  status: 'active',
  experts: { phase: 'ready', list: [], error: null },
  skills: { phase: 'ready', groups: I.presentSkills({ ok: true, skills: [
    { id: 'mkt-copy', name: '营销文案', role: '市场', stage: 'v1' },
    { id: 'dev-api', name: '接口设计', role: '研发', stage: 'v1' },
  ] }).groups, error: null },
  form: { open: true, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
  onField: (field, value) => expertFieldEdits.push(field + '=' + value),
  onToggleSkill: (id) => { toggledSkill = id; },
  onSearch: () => {},
}));
ok('专家表单容器', !!findIn(expertFormView, 'data-jk-kb-expert-form', 'true'));
ok('名称输入', !!findIn(expertFormView, 'data-jk-kb-expert-name', 'true'));
ok('领域输入', !!findIn(expertFormView, 'data-jk-kb-expert-domain', 'true'));
ok('职责输入', !!findIn(expertFormView, 'data-jk-kb-expert-responsibility', 'true'));
ok('提示词输入', !!findIn(expertFormView, 'data-jk-kb-expert-prompt-fragment', 'true'));
ok('技能搜索', !!findIn(expertFormView, 'data-jk-kb-expert-skill-search', 'true'));
const expertGroups = flatten(expertFormView).filter((el) => el.props && el.props['data-jk-kb-expert-skill-group'] !== undefined);
eq('技能按岗位分组', expertGroups.map((el) => el.props['data-jk-kb-expert-skill-group']).join(','), '市场,研发');
eq('技能多选存在', !!findIn(expertFormView, 'data-jk-kb-expert-skill', 'mkt-copy'), true);
findIn(expertFormView, 'data-jk-kb-expert-skill', 'mkt-copy').props.onChange();
eq('技能勾选回调', toggledSkill, 'mkt-copy');
findIn(expertFormView, 'data-jk-kb-expert-name', 'true').props.onChange({ target: { value: 'N' } });
findIn(expertFormView, 'data-jk-kb-expert-domain', 'true').props.onChange({ target: { value: 'D' } });
findIn(expertFormView, 'data-jk-kb-expert-responsibility', 'true').props.onChange({ target: { value: '这是十个字符以上的职责说明' } });
findIn(expertFormView, 'data-jk-kb-expert-prompt-fragment', 'true').props.onChange({ target: { value: 'P' } });
eq('专家字段回调', expertFieldEdits.join(','), 'name=N,domain=D,responsibility=这是十个字符以上的职责说明,promptFragment=P');
eq('空表单禁用提交', findIn(expertFormView, 'data-jk-kb-expert-submit', 'true').props.disabled, true);
ok('名称错误提示', !!findIn(expertFormView, 'data-jk-kb-expert-error', 'name'));
ok('职责错误提示', !!findIn(expertFormView, 'data-jk-kb-expert-error', 'responsibility'));
eq('技能搜索过滤', I.filterSkillGroups(I.presentSkills({ ok: true, skills: [{ id: 'a', name: '营销', role: '市场' }, { id: 'b', name: '接口', role: '研发' }] }).groups, '接口').length, 1);

// 编辑回填
const editExpertForm = I.expertToForm(expertsFixture[0]);
eq('编辑回填 name', editExpertForm.name, '客户成功专家');
eq('编辑回填 skillIds', editExpertForm.skillIds.join(','), 'mkt-copy,mkt-plan');
const editFormView = I.ExpertsView(Object.assign({}, {
  status: 'active',
  experts: { phase: 'ready', list: [presentExpertSafe()], error: null },
  skills: { phase: 'ready', groups: [] },
  form: { open: true, mode: 'edit', id: 'EXP-001', fields: editExpertForm, search: '', notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
}));
contains('编辑表单标题', textOf(findIn(editFormView, 'data-jk-kb-expert-form', 'true')), '编辑专家 EXP-001');
eq('编辑回填名称值', findIn(editFormView, 'data-jk-kb-expert-name', 'true').props.value, '客户成功专家');
eq('编辑回填领域值', findIn(editFormView, 'data-jk-kb-expert-domain', 'true').props.value, '客户成功');
eq('合法编辑可提交', findIn(editFormView, 'data-jk-kb-expert-submit', 'true').props.disabled, false);
function presentExpertSafe() { return I.presentExpert(expertsFixture[0], 0); }

// 归档确认
let archiveAck = null;
let archiveYes = 0;
let archiveNo = 0;
const expertArchiveView = I.ExpertsView(Object.assign({}, {
  status: 'active',
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
  skills: { phase: 'ready', groups: [] },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', notice: null },
  archive: { target: expertsNorm.experts[0], confirmed: false, busy: false, notice: null },
  onArchiveConfirm: (value) => { archiveAck = value; },
  onArchiveSubmit: () => { archiveYes += 1; },
  onArchiveClose: () => { archiveNo += 1; },
}));
const archiveConfirmEl = findIn(expertArchiveView, 'data-jk-kb-expert-archive-confirm', 'EXP-001');
ok('归档确认弹层', !!archiveConfirmEl);
contains('归档不删除说明', textOf(archiveConfirmEl), '归档不会删除数据');
contains('归档可查看说明', textOf(archiveConfirmEl), '?status=archived');
eq('未勾选禁用归档', findIn(expertArchiveView, 'data-jk-kb-expert-archive-yes', 'true').props.disabled, true);
findIn(expertArchiveView, 'data-jk-kb-expert-archive-ack', 'true').props.onChange({ target: { checked: true } });
eq('归档勾选回调', archiveAck, true);
findIn(expertArchiveView, 'data-jk-kb-expert-archive-yes', 'true').props.onClick();
eq('归档提交回调', archiveYes, 1);
findIn(expertArchiveView, 'data-jk-kb-expert-archive-no', 'true').props.onClick();
eq('归档取消回调', archiveNo, 1);
const archiveBusyView = I.ExpertsView(Object.assign({}, {
  status: 'active', experts: { phase: 'ready', list: [], error: null }, skills: { phase: 'ready', groups: [] },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', busy: false, notice: null },
  archive: { target: expertsNorm.experts[0], confirmed: true, busy: true, notice: { kind: 'error', text: '该专家已归档' } },
}));
eq('归档中禁用按钮', findIn(archiveBusyView, 'data-jk-kb-expert-archive-yes', 'true').props.disabled, true);
eq('归档中按钮文案', textOf(findIn(archiveBusyView, 'data-jk-kb-expert-archive-yes', 'true')), '归档中…');
contains('归档失败提示', textOf(findIn(archiveBusyView, 'data-jk-kb-expert-archive-notice', 'error')), '该专家已归档');
const expertBusyFormView = I.ExpertsView(Object.assign({}, {
  status: 'active', experts: { phase: 'ready', list: [], error: null }, skills: { phase: 'ready', groups: [] },
  form: { open: true, mode: 'create', id: '', fields: { name: 'N', domain: 'D', responsibility: '这是十个字符以上的职责说明', skillIds: [], promptFragment: '' }, search: '', busy: true, notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
}));
eq('提交中禁用按钮', findIn(expertBusyFormView, 'data-jk-kb-expert-submit', 'true').props.disabled, true);
eq('提交中文案', textOf(findIn(expertBusyFormView, 'data-jk-kb-expert-submit', 'true')), '提交中…');
const successNoticeView = I.ExpertsView(Object.assign({}, {
  status: 'active', experts: { phase: 'ready', list: [], error: null }, skills: { phase: 'ready', groups: [] },
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', busy: false, notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
  writeNotice: { kind: 'ok', text: '已归档' },
}));
contains('成功提示渲染', textOf(findIn(successNoticeView, 'data-jk-kb-experts-notice', 'ok')), '已归档');

// 入柜表单：业务专家下拉
const curateWithExperts = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '正文', skillId: '', expertId: 'EXP-001', title: '', source: '' },
  skills: { phase: 'ready', groups: [] },
  experts: { phase: 'ready', list: expertsNorm.experts, error: null },
}));
const expertSelect = findIn(curateWithExperts, 'data-jk-kb-curate-expert', 'true');
ok('入柜表单有专家下拉', !!expertSelect);
eq('专家下拉当前值', expertSelect.props.value, 'EXP-001');
const expertOptions = flatten(curateWithExperts).filter((el) => el.type === 'option' && el.props.value === 'EXP-001');
eq('专家下拉选项存在', expertOptions.length, 1);
contains('专家下拉选项文案', textOf(expertOptions[0]), '客户成功专家');
const curateNoExperts = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '正文', expertId: '', skillId: '', title: '', source: '' },
  skills: { phase: 'ready', groups: [] },
  experts: { phase: 'ready', list: [], error: null },
}));
ok('无专家时提示', !!findIn(curateNoExperts, 'data-jk-kb-curate-no-experts', 'true'));
eq('无专家时默认为不指定', findIn(curateNoExperts, 'data-jk-kb-curate-expert', 'true').props.value, '');
const curateExpertPayload = I.buildCuratePayload({ text: '正文', expertId: ' EXP-001 ' });
eq('入柜 payload 带 expertId', curateExpertPayload.input.expertId, 'EXP-001');
eq('未指定专家不带 expertId', I.buildCuratePayload({ text: '正文' }).input.expertId, undefined);

// 不新增定时器
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const expertsSection = source.slice(source.indexOf('function ExpertsPage'), source.indexOf('function ExpertsView'));
eq('专家页不挂轮询/定时器',
  expertsSection.indexOf('usePollingEffect') < 0 && expertsSection.indexOf('setInterval') < 0 && expertsSection.indexOf('setTimeout') < 0,
  true);

// 产出 / 悬空技能 / 恢复归档 / 入柜按专家过滤
const enhancedExpertRaw = Object.assign({}, expertsFixture[0], {
  cardCount: 7,
  lastUsedAt: '2026-10-17T08:00:00Z',
  skillStates: { 'mkt-copy': { ok: true }, 'mkt-plan': { ok: false } },
  danglingSkillIds: ['mkt-plan'],
});
const enhancedExpert = I.presentExpert(enhancedExpertRaw, 0);
eq('专家产出卡数', enhancedExpert.cardCount, 7);
ok('专家最近使用时间', enhancedExpert.lastUsedAtText !== '—');
eq('skillStates 对象归一', I.normalizeExpertSkillStates({ a: { ok: true }, b: { ok: false } }).b, false);
eq('skillStates 数组归一', I.normalizeExpertSkillStates([{ id: 'a', ok: false }]).a, false);
eq('悬空技能合并去重', I.expertDanglingSkillIds(enhancedExpert).join(','), 'mkt-plan');

const enhancedSkills = { phase: 'ready', groups: presentedSkills.groups };
let unbindExpertArg = null;
let unbindSkillArg = null;
const enhancedExpertsView = I.ExpertsView({
  status: 'active',
  experts: { phase: 'ready', list: [enhancedExpert], error: null },
  skills: enhancedSkills,
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', busy: false, notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
  onUnbindSkill: (expert, skillId) => { unbindExpertArg = expert; unbindSkillArg = skillId; },
});
contains('专家产出文案', textOf(findIn(enhancedExpertsView, 'data-jk-kb-expert-output', 'EXP-001')), '7 张卡片 · 最近使用');
eq('悬空技能标记', !!findIn(enhancedExpertsView, 'data-jk-kb-expert-dangling', 'EXP-001:mkt-plan'), true);
contains('悬空技能文案', textOf(findIn(enhancedExpertsView, 'data-jk-kb-expert-dangling', 'EXP-001:mkt-plan')), '悬空技能：营销策划');
findIn(enhancedExpertsView, 'data-jk-kb-expert-unbind', 'EXP-001:mkt-plan').props.onClick();
eq('解绑回调 expert', unbindExpertArg && unbindExpertArg.id, 'EXP-001');
eq('解绑回调 skill', unbindSkillArg, 'mkt-plan');
const noOutputView = I.ExpertsView({
  status: 'active',
  experts: { phase: 'ready', list: [I.presentExpert(expertsFixture[1], 1)], error: null },
  skills: enhancedSkills,
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', busy: false, notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
});
contains('无产出空态', textOf(findIn(noOutputView, 'data-jk-kb-expert-output', 'EXP-002')), '还没有入柜记录');

// 解绑 PATCH：只提交剩余 skillIds
const unbindFetch = installFetch(() => ({ body: { ok: true, expert: { id: 'EXP-001', skillIds: ['mkt-copy'] } } }));
const unbindOutcome = await I.unbindExpertSkillRequest('EXP-001', ['mkt-copy']);
unbindFetch.restore();
eq('解绑 PATCH 路径', unbindFetch.calls[0].url, I.HOST_EXPERTS_PATH + '/EXP-001');
eq('解绑 PATCH 方法', unbindFetch.calls[0].init.method, 'PATCH');
const unbindBody = JSON.parse(unbindFetch.calls[0].init.body);
eq('解绑 body 仅 skillIds', Object.keys(unbindBody).join(','), 'skillIds');
eq('解绑保留其余技能', unbindBody.skillIds.join(','), 'mkt-copy');
eq('解绑成功', unbindOutcome.ok, true);

// 恢复归档
const restoreFetch = installFetch(() => ({ body: { ok: true, expert: { id: 'EXP-001', status: 'active' } } }));
const restoreOutcome = await I.restoreExpertRequest('EXP-001');
restoreFetch.restore();
eq('恢复 POST 路径', restoreFetch.calls[0].url, I.HOST_EXPERTS_PATH + '/EXP-001/restore');
eq('恢复 POST 方法', restoreFetch.calls[0].init.method, 'POST');
const restorePlan = I.planExpertWriteResult('restore', restoreOutcome);
eq('恢复成功提示', restorePlan.notice.text, '已恢复');
eq('恢复后回 active', restorePlan.nextStatus, 'active');
eq('恢复后刷新', restorePlan.refresh, true);
let restoredExpertArg = null;
const archivedView = I.ExpertsView({
  status: 'archived',
  experts: { phase: 'ready', list: [I.presentExpert(Object.assign({}, expertsFixture[0], { status: 'archived' }), 0)], error: null },
  skills: enhancedSkills,
  form: { open: false, mode: 'create', id: '', fields: I.expertToForm(null), search: '', busy: false, notice: null },
  archive: { target: null, confirmed: false, busy: false, notice: null },
  onRestore: (expert) => { restoredExpertArg = expert; },
});
eq('归档视图有恢复按钮', !!findIn(archivedView, 'data-jk-kb-expert-restore', 'EXP-001'), true);
eq('活跃视图无恢复按钮', findIn(enhancedExpertsView, 'data-jk-kb-expert-restore', 'EXP-001'), undefined);
findIn(archivedView, 'data-jk-kb-expert-restore', 'EXP-001').props.onClick();
eq('恢复回调 expert', restoredExpertArg && restoredExpertArg.id, 'EXP-001');

// 入柜按专家绑定过滤技能
const filteredGroups = I.filterSkillGroupsByIds(presentedSkills.groups, ['mkt-copy']);
eq('按绑定过滤后组数', filteredGroups.length, 1);
eq('按绑定过滤后技能', filteredGroups[0].skills.map((skill) => skill.id).join(','), 'mkt-copy');
eq('未知绑定不产生空组', I.filterSkillGroupsByIds(presentedSkills.groups, ['nope']).length, 0);
const curateBoundExpert = I.presentExpert(Object.assign({}, enhancedExpertRaw, {
  skillIds: ['mkt-copy'],
  danglingSkillIds: [],
  skillStates: { 'mkt-copy': { ok: true } },
}), 0);
const curateExpertsProp = {
  phase: 'ready',
  list: [curateBoundExpert],
};
const curateOptionValues = (view) => flatten(findIn(view, 'data-jk-kb-curate-skill', 'true'))
  .filter((el) => el.type === 'option')
  .map((el) => el.props.value);
const expertBoundView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈', skillId: '', expertId: 'EXP-001', title: '', source: '', showAllSkills: false },
  skills: enhancedSkills,
  experts: curateExpertsProp,
}));
eq('选专家后仅绑定技能', curateOptionValues(expertBoundView).filter((value) => value !== '').join(','), 'mkt-copy');
eq('选专家后无未绑定技能', curateOptionValues(expertBoundView).indexOf('dev-api'), -1);
const showAllView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈', skillId: '', expertId: 'EXP-001', title: '', source: '', showAllSkills: true },
  skills: enhancedSkills,
  experts: curateExpertsProp,
}));
ok('显示全部技能后含未绑定', curateOptionValues(showAllView).indexOf('dev-api') >= 0);
eq('显示全部技能默认不勾', findIn(expertBoundView, 'data-jk-kb-curate-show-all-skills', 'true').props.checked, false);
eq('显示全部技能勾选状态', findIn(showAllView, 'data-jk-kb-curate-show-all-skills', 'true').props.checked, true);
const noExpertView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈', skillId: '', expertId: '', title: '', source: '', showAllSkills: false },
  skills: enhancedSkills,
  experts: curateExpertsProp,
}));
ok('未选专家时显示全量', curateOptionValues(noExpertView).indexOf('dev-api') >= 0);
const outOfRangeView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈', skillId: 'dev-api', expertId: 'EXP-001', title: '', source: '', showAllSkills: false },
  skills: enhancedSkills,
  experts: curateExpertsProp,
}));
contains('越界技能黄提示', textOf(findIn(outOfRangeView, 'data-jk-kb-curate-skill-warning', 'true')), '该技能不在该专家绑定范围内');
eq('越界技能选择保留', findIn(outOfRangeView, 'data-jk-kb-curate-skill', 'true').props.value, 'dev-api');
eq('越界技能仍可提交', findIn(outOfRangeView, 'data-jk-kb-curate-submit', 'true').props.disabled, false);
eq('越界技能保留选项', !!findIn(outOfRangeView, 'data-jk-kb-curate-skill-out-of-range', 'true'), true);
const noWarningView = I.RunsBoardView(Object.assign({}, boardProps, {
  curateOpen: true,
  curateForm: { text: '一段访谈', skillId: 'mkt-copy', expertId: 'EXP-001', title: '', source: '', showAllSkills: false },
  skills: enhancedSkills,
  experts: curateExpertsProp,
}));
eq('绑定内技能无黄提示', findIn(noWarningView, 'data-jk-kb-curate-skill-warning', 'true'), undefined);

// ═════════════════════════ 20. 仪表盘真实数据 + 目录归档文案 ═════════════════════════
// 仪表盘归一
const dashboardFixture = {
  ok: true,
  generatedAt: '2026-10-17T06:00:00Z',
  counts: {
    notes: 128,
    dirs: 13,
    files: 214,
    topDirs: [{ name: '01_收件箱', notes: 12 }, { name: '03_内容', notes: 80 }],
    truncated: true,
  },
  recent: [
    { relPath: '03_内容/客户访谈.md', title: '客户访谈', updatedAt: '2026-10-17T05:00:00Z', size: 2048 },
    { relPath: '01_收件箱/随手记.md', title: '随手记', updatedAt: '2026-10-16T05:00:00Z', size: 512 },
  ],
  runtime: {
    root: '/data/kb',
    hasVault: true,
    mode: 'asset',
    vaultUpdatedAt: '2026-10-16T00:00:00Z',
    lastRun: { id: 'run-1', title: '建库', status: 'completed', startedAt: '2026-10-17T05:00:00Z', endedAt: '2026-10-17T05:02:13Z', elapsedMs: 133000 },
    running: 1,
  },
  today: { runs: 3, completed: 2, failed: 1, totalMs: 240000, inputTokens: 1200, outputTokens: 800 },
  health: {
    storeGuard: 'ready',
    tools: { registered: 9, failed: 0 },
    subagents: { available: true, providers: ['spawn'] },
  },
  maintain: { lastReport: { period: '2026-10', summary: '共 3 条命中', byRule: { M01: 1, M03: 2, M04: 0, M08: 0 } } },
};
// 固定 now 与 fixture 日期（2026-10-15/16/17）配套，避免"近 7 天估算"随真实时间漂移。
const dashboard = I.presentDashboard(dashboardFixture, Date.parse('2026-10-17T00:00:00Z'));
eq('仪表盘条目数', dashboard.counts.notes, 128);
eq('仪表盘顶层目录数', dashboard.counts.dirs, 13);
eq('仪表盘截断标记', dashboard.counts.truncated, true);
eq('仪表盘 recent 条数', dashboard.recent.length, 2);
eq('recent 标题', dashboard.recent[0].title, '客户访谈');
eq('recent 相对路径', dashboard.recent[0].relPath, '03_内容/客户访谈.md');
ok('recent 更新时间非占位', dashboard.recent[0].updatedAtText !== '—');
eq('runtime 根目录', dashboard.runtime.root, '/data/kb');
eq('runtime mode', dashboard.runtime.mode, 'asset');
eq('runtime 最近 run 状态', dashboard.runtime.lastRun.statusLabel, '完成');
eq('runtime 最近 run 耗时', dashboard.runtime.lastRun.elapsedText, '2m 13s');
eq('runtime running', dashboard.runtime.running, 1);
eq('today runs', dashboard.today.runs, 3);
eq('today 完成失败', dashboard.today.completed + '/' + dashboard.today.failed, '2/1');
eq('today token 合计', dashboard.today.tokenText, '2,000');
eq('health storeGuard', dashboard.health.storeGuard, 'ready');
eq('health 工具注册', dashboard.health.toolsRegistered, 9);
eq('health 子代理可用', dashboard.health.subagentsAvailable, true);
eq('maintain 报告 period', dashboard.maintain.lastReport.period, '2026-10');
eq('maintain byRule', dashboard.maintain.lastReport.byRule.M03, 2);
eq('周新增估算（固定 now）', I.estimateWeekAdded([
  { updatedMs: Date.parse('2026-10-15T00:00:00Z') },
  { updatedMs: Date.parse('2026-10-01T00:00:00Z') },
], Date.parse('2026-10-17T00:00:00Z')), 1);

const dashboardView = I.DashboardView({
  phase: 'ready',
  data: dashboard,
  registryCount: 3,
  onRefresh: () => {},
  onRetry: () => {},
});
ok('仪表盘容器', !!findIn(dashboardView, 'data-jk-kb-dashboard', 'true'));
eq('仪表盘阶段标记', findIn(dashboardView, 'data-jk-kb-dashboard', 'true').props['data-jk-kb-dashboard-phase'], 'ready');
const dashboardCards = flatten(dashboardView).filter((el) => el.props && el.props['data-jk-kb-stat'] !== undefined);
eq('四张卡 id', dashboardCards.map((el) => el.props['data-jk-kb-stat']).join(','), 'entries,weekly,today,skills');
contains('知识条目卡数值', textOf(findIn(dashboardView, 'data-jk-kb-stat', 'entries')), '128');
contains('知识条目副文案', textOf(findIn(dashboardView, 'data-jk-kb-stat', 'entries')), '13 个顶层目录');
contains('本周新增估算', textOf(findIn(dashboardView, 'data-jk-kb-stat', 'weekly')), '2');
contains('今日任务卡', textOf(findIn(dashboardView, 'data-jk-kb-stat', 'today')), '完成 2 · 失败 1');
contains('技能数卡（47+3）', textOf(findIn(dashboardView, 'data-jk-kb-stat', 'skills')), '50');
contains('技能数副文案', textOf(findIn(dashboardView, 'data-jk-kb-stat', 'skills')), '内置 47 · 自定义 3');
eq('截断标记渲染', !!findIn(dashboardView, 'data-jk-kb-truncated', 'true'), true);
const recentItems = flatten(dashboardView).filter((el) => el.props && el.props['data-jk-kb-recent'] !== undefined);
eq('最近入库条数', recentItems.length, 2);
contains('最近入库标题', textOf(recentItems[0]), '客户访谈');
contains('最近入库相对路径', textOf(recentItems[0]), '03_内容/客户访谈.md');
eq('最近入库可复制路径', !!findIn(dashboardView, 'data-jk-kb-recent-copy', '03_内容/客户访谈.md'), true);
eq('仪表盘不再渲染运行状态块（迁至使用信息）', findIn(dashboardView, 'data-jk-kb-runtime', 'root'), undefined);
contains('最近整理 period', textOf(findIn(dashboardView, 'data-jk-kb-maintain-period', 'true')), '2026-10');
contains('最近整理 byRule', textOf(findIn(dashboardView, 'data-jk-kb-maintain-rules', 'true')), 'M01=1');
// 使用信息页：承接仪表盘迁来的运行状态块
const usageView = I.UsageView({ phase: 'ready', data: dashboard, onRefresh: () => {}, onRetry: () => {} });
eq('使用信息根目录', textOf(findIn(usageView, 'data-jk-kb-runtime', 'root')), '根目录/data/kb');
contains('使用信息最近 run', textOf(findIn(usageView, 'data-jk-kb-runtime', 'lastRun')), '建库');
contains('使用信息工具注册', textOf(findIn(usageView, 'data-jk-kb-runtime', 'tools')), '9 个（失败 0）');
contains('使用信息子代理', textOf(findIn(usageView, 'data-jk-kb-runtime', 'subagents')), '可用');
ok('使用信息加载态', !!findIn(I.UsageView({ phase: 'loading', data: null }), 'data-jk-kb-usage-loading', 'true'));
let usageRetried = 0;
const usageErrorView = I.UsageView({ phase: 'error', data: null, error: { code: 'host-unreachable', message: '连接被拒绝' }, onRetry: () => { usageRetried += 1; } });
contains('使用信息不可用文案', textOf(usageErrorView), '使用信息不可用');
findIn(usageErrorView, 'data-jk-kb-usage-retry', 'true').props.onClick();
eq('使用信息重试回调', usageRetried, 1);
const noRegistryView = I.DashboardView({ phase: 'ready', data: dashboard, registryCount: null, onRefresh: () => {}, onRetry: () => {} });
contains('无自定义技能时只显示 47', textOf(findIn(noRegistryView, 'data-jk-kb-stat', 'skills')), '47');
contains('无自定义技能副文案', textOf(findIn(noRegistryView, 'data-jk-kb-stat', 'skills')), '内置 47');
const readyWithoutWeek = I.presentDashboard({ counts: { notes: 0, dirs: 0 }, recent: [], today: {}, health: {}, runtime: {}, maintain: {} });
eq('缺 weekAdded 用估算', readyWithoutWeek.counts.weekAdded, null);
const emptyDashboardView = I.DashboardView({ phase: 'ready', data: readyWithoutWeek, registryCount: null, onRefresh: () => {}, onRetry: () => {} });
contains('仪表盘空态大框文案', textOf(findIn(emptyDashboardView, 'data-jk-kb-dashboard-empty', 'true')), '快来放第一篇文档吧');
eq('仪表盘空态含图标', !!findIn(emptyDashboardView, 'data-jk-kb-dashboard-empty', 'true').children[0], true);
eq('总空态下最近入库区收起', !!findIn(emptyDashboardView, 'data-jk-kb-recent-empty', 'true'), false);
eq('总空态不再显示生成时间行', !!findIn(emptyDashboardView, 'data-jk-kb-dashboard-generated', 'true'), false);
contains('最近整理空态文案', textOf(findIn(emptyDashboardView, 'data-jk-kb-maintain-empty', 'true')), '现在还是空的呢：）');
eq('最近整理空态含图标', !!findIn(emptyDashboardView, 'data-jk-kb-maintain-empty', 'true').children[0], true);
let dashboardRetried = 0;
const dashboardErrorView = I.DashboardView({ phase: 'error', data: null, error: { code: 'host-unreachable', message: '连接被拒绝' }, onRetry: () => { dashboardRetried += 1; } });
contains('仪表盘不可用文案', textOf(dashboardErrorView), '仪表盘数据不可用');
findIn(dashboardErrorView, 'data-jk-kb-dashboard-retry', 'true').props.onClick();
eq('仪表盘重试回调', dashboardRetried, 1);
ok('仪表盘加载态', !!findIn(I.DashboardView({ phase: 'loading', data: null }), 'data-jk-kb-dashboard-loading', 'true'));
const dashboardFetch = installFetch(() => ({ body: { ok: true, counts: { notes: 1 } } }));
await I.fetchDashboard();
dashboardFetch.restore();
eq('仪表盘请求 URL', dashboardFetch.calls[0].url, I.HOST_DASHBOARD_PATH);
eq('仪表盘请求 GET', dashboardFetch.calls[0].init.method, 'GET');
const dashboardDown = installFetch(() => ({ throw: true }));
const dashboardDownResult = await I.fetchDashboard();
dashboardDown.restore();
eq('仪表盘失败归一', I.normalizeDashboardResponse(dashboardDownResult).ok, false);

// ═════════════════════════ 文件管理：数据层 + 三栏视图 ═════════════════════════
// 数据归一：目录列表（folders/files 分组、size/mtime 展示化）
const filesPayload = {
  ok: true, dir: '03_内容',
  folders: [{ name: '子目录B' }, { name: '子目录A' }],
  files: [
    { name: '笔记.md', ext: '.md', size: 2048, mtimeMs: BASE_MS },
    { name: '图表.png', ext: '.png', size: 40960, mtimeMs: BASE_MS },
    { name: '数据.bin', ext: '.bin', size: 512, mtimeMs: BASE_MS },
  ],
};
const filesNorm = I.normalizeFilesResponse(filesPayload);
eq('目录列表归一成功', filesNorm.ok, true);
eq('目录列表 dir 透传', filesNorm.data.dir, '03_内容');
eq('目录条目文件夹数', filesNorm.data.folders.length, 2);
eq('目录条目文件数', filesNorm.data.files.length, 3);
eq('文件 size 展示化', filesNorm.data.files[0].sizeText, '2 KB');
eq('目录列表失败归一', I.normalizeFilesResponse({ ok: false, error: { code: 'dir-out-of-root', message: '越界' } }).error.code, 'dir-out-of-root');
// 预览归一：text / image / binary / too-large 四分支
const textPreview = I.presentFilePreview({ ok: true, kind: 'text', path: '03_内容/笔记.md', name: '笔记.md', ext: '.md', size: 12, mtimeMs: BASE_MS, text: '# 标题' });
eq('text 预览 kind', textPreview.kind, 'text');
eq('text 预览正文', textPreview.text, '# 标题');
const imagePreview = I.presentFilePreview({ ok: true, kind: 'image', name: '图表.png', ext: '.png', dataUrl: 'data:image/png;base64,xxx' });
eq('image 预览 kind', imagePreview.kind, 'image');
contains('image 预览 dataUrl', imagePreview.dataUrl, 'data:image/png');
eq('未知 kind 回落 binary', I.presentFilePreview({ kind: 'weird' }).kind, 'binary');
eq('预览失败归一', I.normalizeFileResponse({ ok: false, error: { code: 'file-not-found', message: '没了' } }).ok, false);
// 请求 URL：dir / path 均需 encode
const filesFetch = installFetch(() => ({ body: { ok: true, folders: [], files: [] } }));
await I.fetchFiles('03_内容/子目录A');
await I.fetchFileEntry('03_内容/笔记.md');
filesFetch.restore();
eq('目录列表请求 URL', filesFetch.calls[0].url, I.HOST_FILES_PATH + '?dir=' + encodeURIComponent('03_内容/子目录A'));
eq('文件预览请求 URL', filesFetch.calls[1].url, I.HOST_FILE_PATH + '?path=' + encodeURIComponent('03_内容/笔记.md'));
eq('文件请求 GET', filesFetch.calls[1].init.method, 'GET');

// 三栏视图：左树 + 中列表 + 右预览（回调驱动）
const filesViewData = I.presentFiles(filesPayload);
let openedDir = '';
let openedFile = '';
let toggledDir = '';
let wentUp = 0;
const filesReadyView = I.FilesView({
  list: { phase: 'ready', data: filesViewData, error: null },
  tree: { '': ['03_内容'], '03_内容': ['子目录A', '子目录B'] },
  expanded: { '': true, '03_内容': true },
  currentDir: '03_内容',
  preview: { phase: 'ready', path: '03_内容/笔记.md', data: textPreview, error: null },
  onOpenDir: (dir) => { openedDir = dir; },
  onToggleDir: (dir) => { toggledDir = dir; },
  onGoUp: () => { wentUp += 1; },
  onOpenFile: (rel) => { openedFile = rel; },
  onRefresh: () => {},
});
ok('文件管理根容器', !!findIn(filesReadyView, 'data-jk-kb-files', 'true'));
eq('文件管理 phase 标记', findIn(filesReadyView, 'data-jk-kb-files', 'true').props['data-jk-kb-files-phase'], 'ready');
ok('左树面板存在', !!findIn(filesReadyView, 'data-jk-kb-file-tree', 'true'));
ok('中栏列表面板存在', !!findIn(filesReadyView, 'data-jk-kb-files-list', 'true'));
ok('右栏预览面板存在', !!findIn(filesReadyView, 'data-jk-kb-file-preview', 'true'));
// 左树：根节点 + 展开的 03_内容 子节点
ok('树根节点', !!findIn(filesReadyView, 'data-jk-kb-file-tree-dir', 'root'));
ok('树子目录节点', !!findIn(filesReadyView, 'data-jk-kb-file-tree-dir', '03_内容'));
ok('树孙节点渲染', !!findIn(filesReadyView, 'data-jk-kb-file-tree-dir', '03_内容/子目录A'));
eq('树节点选中态', findIn(filesReadyView, 'data-jk-kb-file-tree-label', '03_内容').props['aria-current'], 'true');
findIn(filesReadyView, 'data-jk-kb-file-tree-label', '03_内容/子目录B').props.onClick();
eq('树节点点击导航', openedDir, '03_内容/子目录B');
findIn(filesReadyView, 'data-jk-kb-file-tree-caret', '03_内容').props.onClick();
eq('树箭头点击切换', toggledDir, '03_内容');
// 中栏：面包屑 + 文件夹/文件条目 + 回调
eq('面包屑当前目录', textOf(findIn(filesReadyView, 'data-jk-kb-files-crumb', 'true')), '/03_内容');
eq('中栏文件夹条目', findIn(filesReadyView, 'data-jk-kb-file-entry', 'dir').props['data-jk-kb-file-entry-name'], '子目录B');
eq('中栏文件条目存在', !!findIn(filesReadyView, 'data-jk-kb-file-entry', 'file'), true);
eq('中栏文件名标记', findIn(filesReadyView, 'data-jk-kb-file-entry-name', '笔记.md').props['data-jk-kb-file-entry'], 'file');
findIn(filesReadyView, 'data-jk-kb-file-entry-name', '子目录A').props.onClick();
eq('中栏文件夹点击进目录', openedDir, '03_内容/子目录A');
findIn(filesReadyView, 'data-jk-kb-file-entry-name', '数据.bin').props.onClick();
eq('中栏文件点击预览', openedFile, '03_内容/数据.bin');
eq('根目录时上一级禁用', findIn(filesReadyView, 'data-jk-kb-files-up', 'true').props.disabled, false);
findIn(filesReadyView, 'data-jk-kb-files-up', 'true').props.onClick();
eq('上一级回调', wentUp, 1);
// 右栏：text 分支 → pre 原文
contains('text 预览元信息', textOf(findIn(filesReadyView, 'data-jk-kb-file-preview-meta', 'true')), '笔记.md');
eq('text 预览渲染 pre', findIn(filesReadyView, 'data-jk-kb-file-preview-text', 'true').type, 'pre');
eq('text 预览正文', textOf(findIn(filesReadyView, 'data-jk-kb-file-preview-text', 'true')), '# 标题');
// image 分支 → img[dataUrl]
const filesImageView = I.FilesView({
  list: { phase: 'ready', data: filesViewData, error: null },
  tree: { '': [] }, expanded: { '': true }, currentDir: '',
  preview: { phase: 'ready', path: '图表.png', data: imagePreview, error: null },
});
eq('image 预览渲染 img', findIn(filesImageView, 'data-jk-kb-file-preview-image', 'true').type, 'img');
eq('image 预览 src', findIn(filesImageView, 'data-jk-kb-file-preview-image', 'true').props.src, 'data:image/png;base64,xxx');
eq('image 分支不渲染 pre', !!findIn(filesImageView, 'data-jk-kb-file-preview-text', 'true'), false);
// binary / too-large 分支 → 元信息提示
const filesBinaryView = I.FilesView({
  list: { phase: 'ready', data: filesViewData, error: null },
  tree: { '': [] }, expanded: { '': true }, currentDir: '',
  preview: { phase: 'ready', path: '数据.bin', data: I.presentFilePreview({ kind: 'binary', name: '数据.bin', size: 512, mtimeMs: BASE_MS }), error: null },
});
ok('binary 分支提示', !!findIn(filesBinaryView, 'data-jk-kb-file-preview-binary', 'true'));
const filesLargeView = I.FilesView({
  list: { phase: 'ready', data: filesViewData, error: null },
  tree: { '': [] }, expanded: { '': true }, currentDir: '',
  preview: { phase: 'ready', path: '大文件.md', data: I.presentFilePreview({ kind: 'too-large', name: '大文件.md', size: 3 * 1024 * 1024, mtimeMs: BASE_MS }), error: null },
});
ok('too-large 分支提示', !!findIn(filesLargeView, 'data-jk-kb-file-preview-toolarge', 'true'));
// 预览 idle / loading / error 三态
const filesIdleView = I.FilesView({ list: { phase: 'ready', data: filesViewData, error: null }, tree: { '': [] }, expanded: { '': true }, currentDir: '', preview: { phase: 'idle' } });
ok('未选文件占位', !!findIn(filesIdleView, 'data-jk-kb-file-preview-idle', 'true'));
ok('预览加载态', !!I.FilesView({ list: { phase: 'loading' }, preview: { phase: 'loading' } }) && !!findIn(I.FilesView({ list: { phase: 'ready', data: filesViewData, error: null }, tree: { '': [] }, expanded: { '': true }, currentDir: '', preview: { phase: 'loading' } }), 'data-jk-kb-file-preview-loading', 'true'));
const filesPvErrorView = I.FilesView({ list: { phase: 'ready', data: filesViewData, error: null }, tree: { '': [] }, expanded: { '': true }, currentDir: '', preview: { phase: 'error', error: { code: 'file-not-found', message: '文件不存在' } } });
eq('预览错误码标记', findIn(filesPvErrorView, 'data-jk-kb-file-preview-error', 'file-not-found').props['data-jk-kb-file-preview-error'], 'file-not-found');
contains('预览错误文案', textOf(filesPvErrorView), '文件读取失败');
// 目录列表 loading / error / 空态
ok('目录加载态', !!findIn(I.FilesView({ list: { phase: 'loading' }, preview: { phase: 'idle' } }), 'data-jk-kb-files-loading', 'true'));
const filesListErrorView = I.FilesView({ list: { phase: 'error', error: { code: 'dir-out-of-root', message: '越界' } }, preview: { phase: 'idle' } });
eq('目录错误码标记', findIn(filesListErrorView, 'data-jk-kb-files-error', 'dir-out-of-root').props['data-jk-kb-files-error'], 'dir-out-of-root');
contains('目录错误文案', textOf(filesListErrorView), '目录读取失败');
const filesEmptyView = I.FilesView({ list: { phase: 'ready', data: I.presentFiles({ ok: true, folders: [], files: [] }), error: null }, tree: { '': [] }, expanded: { '': true }, currentDir: '空目录', preview: { phase: 'idle' } });
contains('空目录文案', textOf(findIn(filesEmptyView, 'data-jk-kb-files-empty', 'true')), '这个目录是空的');
eq('空目录上一级可用', findIn(filesEmptyView, 'data-jk-kb-files-up', 'true').props.disabled, false);
// 根目录时上一级禁用
const filesRootView = I.FilesView({ list: { phase: 'ready', data: filesViewData, error: null }, tree: { '': [] }, expanded: { '': true }, currentDir: '', preview: { phase: 'idle' } });
eq('根目录禁用上一级', findIn(filesRootView, 'data-jk-kb-files-up', 'true').props.disabled, true);
// 回归防护：FilesPage 直调不抛（初始 loading + idle 预览）
let filesRendered = null;
let filesRenderError = '';
try { filesRendered = I.FilesPage(); } catch (err) { filesRenderError = String(err && err.message); }
ok('FilesPage 可完整渲染（无未定义引用）', !!filesRendered && findIn(filesRendered, 'data-jk-kb-files', 'true') !== undefined, filesRenderError);
eq('FilesPage 初始为目录加载态', findIn(filesRendered, 'data-jk-kb-files', 'true').props['data-jk-kb-files-phase'], 'loading');

// M06 目录归档按钮文案
const dirButtonView = I.ReportsView({
  phase: 'ready', expandedId: 'rep-dir',
  reports: [I.presentReport({
    id: 'rep-dir', period: '2026-10', summary: 'x',
    findings: [
      { ruleId: 'M06', path: '09_项目与运营/项目A', kind: 'dir', proposedTarget: '12_归档与历史/03_归档笔记/09_项目与运营/项目A', archiveReason: '项目已结束 45 天未归档' },
      { ruleId: 'M07', path: '05_内容/旧文.md', proposedTarget: '12_归档与历史/03_归档笔记/05_内容/旧文.md', archiveReason: '已废弃 60 天' },
    ],
  }, 0)],
});
eq('M06 按钮文案为归档目录', textOf(findIn(dirButtonView, 'data-jk-kb-archive-button', 'M06-0')), '归档目录');
eq('M06 按钮标记为 dir', findIn(dirButtonView, 'data-jk-kb-archive-button', 'M06-0').props['data-jk-kb-archive-kind'], 'dir');
eq('M07 按钮文案仍为归档', textOf(findIn(dirButtonView, 'data-jk-kb-archive-button', 'M07-1')), '归档');
eq('M07 按钮标记为 file', findIn(dirButtonView, 'data-jk-kb-archive-button', 'M07-1').props['data-jk-kb-archive-kind'], 'file');

// 不新增定时器
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const dashboardSection = source.slice(source.indexOf('function DashboardPage'), source.indexOf('function DashboardView'));
eq('仪表盘不挂轮询/定时器',
  dashboardSection.indexOf('usePollingEffect') < 0 && dashboardSection.indexOf('setInterval') < 0 && dashboardSection.indexOf('setTimeout') < 0,
  true);

// ═════════════════════════ 21. 未配根目录骨架态 ═════════════════════════
// 菜单按 rootStatus 过滤（数据仍来自 MENUS）
eq('no-root 只显示仪表盘', I.visibleMenus('no-root').map((menu) => menu.id).join(','), 'dashboard');
eq('ready 显示五条', I.visibleMenus('ready').length, 5);
eq('error 保持五条', I.visibleMenus('error').length, 5);
eq('loading 保持五条', I.visibleMenus('loading').length, 5);
eq('no-root 态文件管理被过滤', I.visibleMenus('no-root').some((menu) => menu.id === I.FILES_ID), false);
const noRootNav = I.MenusNav({ rootStatus: 'no-root', activeId: 'dashboard', onSelect: () => {} });
const noRootMenuButtons = flatten(noRootNav).filter((el) => el.props && el.props['data-jk-kb-menu'] !== undefined);
eq('骨架态菜单条数', noRootMenuButtons.length, 1);
eq('骨架态菜单 id', noRootMenuButtons[0].props['data-jk-kb-menu'], 'dashboard');
eq('骨架态菜单文案', textOf(noRootMenuButtons[0]), '仪表盘');
const navSelects = [];
const readyNav = I.MenusNav({ rootStatus: 'ready', activeId: 'tasks', onSelect: (id) => navSelects.push(id) });
eq('已配置菜单五条', flatten(readyNav).filter((el) => el.props && el.props['data-jk-kb-menu'] !== undefined).length, 5);
findIn(readyNav, 'data-jk-kb-menu', 'tasks').props.onClick();
eq('菜单点击回调', navSelects.join(','), 'tasks');
// 回归防护：侧栏菜单纵向排布（shadcn SidebarMenu 为纵向 ul），曾被默认横向 pills 挤成一行。
ok('侧栏菜单纵向排布', flatten(readyNav).some((el) => el.type === 'ul' && String(el.props.className).indexOf('jk-kb-sidebar-menu') >= 0));
const fallbackNav = I.MenusNav({ rootStatus: 'no-root', activeId: 'tasks' });
eq('选中项不可见时回落到仪表盘', findIn(fallbackNav, 'data-jk-kb-menu', 'dashboard').props['aria-current'], 'page');

// ── 侧边栏折叠 / 展开（icon 模式）：collapsed 只渲染图标列，label 转 title/aria-label ──
const collapsedNav = I.MenusNav({ rootStatus: 'ready', activeId: 'dashboard', collapsed: true, onSelect: () => {} });
const collapsedButtons = flatten(collapsedNav).filter((el) => el.props && el.props['data-jk-kb-menu'] !== undefined);
eq('折叠态菜单条数不变', collapsedButtons.length, 5);
eq('折叠态不渲染文字', collapsedButtons.map(textOf).join(''), '');
ok('折叠态保留 title 提示', collapsedButtons.every((btn) => typeof btn.props.title === 'string' && btn.props.title.length > 0));
ok('折叠态保留 aria-label', collapsedButtons.every((btn) => typeof btn.props['aria-label'] === 'string' && btn.props['aria-label'].length > 0));
eq('折叠态图标仍在', flatten(collapsedNav).filter((el) => el.props && el.props['data-jk-kb-menu-icon'] === 'true').length, 5);
eq('菜单组折叠标记', findIn(collapsedNav, 'data-jk-kb-menu-group', 'true').props['data-collapsed'], 'true');
eq('展开态折叠标记为 false', findIn(readyNav, 'data-jk-kb-menu-group', 'true').props['data-collapsed'], 'false');
// PanelLeft 切换图标（shadcn SidebarTrigger 同款）
const toggleIcon = I.PanelLeftIcon({ width: 16, height: 16 });
ok('切换按钮图标是 svg', toggleIcon.type === 'svg');
ok('切换按钮图标线稿', toggleIcon.props.fill === 'none' && toggleIcon.props.stroke === 'currentColor');
// reducer：toggleSidebar 只翻折叠位，不影响选中与任务展开态
const baseState = I.createPanelState();
eq('初始态侧边栏展开', baseState.sidebarCollapsed, false);
const collapsedOnce = I.reducePanel(baseState, { type: 'toggleSidebar' });
eq('toggleSidebar 折叠', collapsedOnce.sidebarCollapsed, true);
eq('折叠不改选中', collapsedOnce.selected, baseState.selected);
eq('折叠不改任务展开', collapsedOnce.expanded, false);
const expandedTasks = I.reducePanel(collapsedOnce, { type: 'toggleTasks' });
eq('折叠下任务区仍可展开', expandedTasks.expanded, true);
eq('展开任务不翻折叠位', expandedTasks.sidebarCollapsed, true);
const collapsedTwice = I.reducePanel(expandedTasks, { type: 'toggleSidebar' });
eq('再 toggle 恢复展开', collapsedTwice.sidebarCollapsed, false);
eq('恢复展开保留任务态', collapsedTwice.expanded, true);
const selectedWhileCollapsed = I.reducePanel(collapsedOnce, { type: 'select', id: 'tasks' });
eq('折叠下切菜单保留折叠', selectedWhileCollapsed.sidebarCollapsed, true);
eq('折叠下切菜单复位任务展开', selectedWhileCollapsed.expanded, false);

// ── shadcn/ui Sidebar 结构：品牌头 / 菜单 icon / 分组标题 / footer 时钟 ──
const readyMenuButtons = flatten(readyNav).filter((el) => el.props && el.props['data-jk-kb-menu'] !== undefined);
eq('菜单按钮数与菜单数一致', readyMenuButtons.length, I.MENUS.length);
// 每个菜单按钮内都有线稿图标（data-jk-kb-menu-icon）
const menuIcons = flatten(readyNav).filter((el) => el.props && el.props['data-jk-kb-menu-icon'] === 'true');
eq('每个菜单都有 icon', menuIcons.length, 5);
ok('菜单 icon 是 svg 线稿', menuIcons.every((icon) => icon.type === 'svg'));
eq('no-root 态只留仪表盘 icon', flatten(noRootNav).filter((el) => el.props && el.props['data-jk-kb-menu-icon'] === 'true').length, 1);
// active 态标记：data-active + active 类（shadcn SidebarMenuButton 同款）
eq('选中菜单 data-active', findIn(readyNav, 'data-jk-kb-menu', 'tasks').props['data-active'], 'true');
contains('选中菜单 active 类', findIn(readyNav, 'data-jk-kb-menu', 'tasks').props.className, 'jk-kb-sidebar-menu-button-active');
eq('未选中菜单 data-active=false', findIn(readyNav, 'data-jk-kb-menu', 'dashboard').props['data-active'], 'false');
// 菜单组：SidebarGroup 结构 + 分组标签
ok('菜单组是 SidebarGroup', findIn(readyNav, 'data-jk-kb-sidebar-group', 'true') !== undefined);
ok('菜单组带菜单组标记', findIn(readyNav, 'data-jk-kb-menu-group', 'true') !== undefined);
// 品牌 Logo 图标渲染（星球填充图标：1024 画布、fill=currentColor）
const logoEl = I.BrandLogoMark({ width: 18, height: 18 });
ok('品牌 Logo 是 svg', logoEl.type === 'svg');
ok('品牌 Logo 带图标标记', logoEl.props['data-jk-kb-menu-icon'] === 'true');
eq('品牌 Logo 1024 画布', logoEl.props.viewBox, '0 0 1024 1024');
eq('品牌 Logo 填充色跟随 currentColor', logoEl.props.fill, 'currentColor');
ok('品牌 Logo path 数据非空', Array.isArray(logoEl.children) && logoEl.children.length === 1 && logoEl.children[0].type === 'path' && typeof logoEl.children[0].props.d === 'string' && logoEl.children[0].props.d.length > 1000);
// Sidebar 结构薄壳
ok('SidebarHeader 薄壳', I.SidebarHeader().props['data-jk-kb-sidebar-header'] === 'true');
// shadcn/ui Table 结构薄壳：语义化标签 + 标记 + className 合并
ok('Table 薄壳是 table', I.Table().type === 'table');
ok('TableHeader 薄壳是 thead', I.TableHeader().type === 'thead');
ok('TableBody 薄壳是 tbody', I.TableBody().type === 'tbody');
ok('TableRow 薄壳是 tr', I.TableRow().type === 'tr');
ok('TableHead 薄壳是 th', I.TableHead().type === 'th');
ok('TableCell 薄壳是 td', I.TableCell().type === 'td');
eq('TableRow 默认类名', I.TableRow().props.className, 'jk-kb-table-row');
eq('TableRow 附加类名合并', I.TableRow({ className: 'extra' }).props.className, 'jk-kb-table-row extra');
ok('SidebarContent 薄壳', I.SidebarContent().props['data-jk-kb-sidebar-content'] === 'true');
ok('SidebarFooter 薄壳', I.SidebarFooter().props['data-jk-kb-sidebar-footer'] === 'true');
ok('SidebarGroupLabel 薄壳', I.SidebarGroupLabel(null, '执行任务').props['data-jk-kb-sidebar-group-label'] === 'true');
eq('SidebarMenuButton 默认非选中', I.SidebarMenuButton({}).props['data-active'], 'false');
eq('SidebarMenuButton 选中', I.SidebarMenuButton({ active: true }).props['data-active'], 'true');
// footer 数字时钟：纯函数格式 + 渲染标记
eq('时钟格式补零', I.formatClockText(new Date(2026, 9, 24, 15, 4, 7)), '15:04:07');
eq('时钟格式零点', I.formatClockText(new Date(2026, 9, 24, 0, 0, 0)), '00:00:00');
const clockEl = I.SidebarClock();
ok('时钟渲染标记', clockEl.props['data-jk-kb-sidebar-clock'] === 'true');
ok('时钟文本 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(textOf(clockEl)));
eq('时钟 role=timer', clockEl.props.role, 'timer');
// 执行任务分组：SidebarGroupLabel 替代原 h2 标题（内联两条 runs，避免依赖后文夹具）
const sidebarGroupView = I.SidebarTasks({ feed: { phase: 'ready', runs: [{ id: 'r1', kind: 'curate', status: 'running', startedAt: '2026-10-24T10:00:00+08:00' }], error: null } });
contains('任务分组标题', textOf(findIn(sidebarGroupView, 'data-jk-kb-sidebar-group-label', 'true')), '执行任务');

// 执行任务骨架
const taskSkeleton = I.TaskListSkeleton();
eq('任务骨架容器标记', findIn(taskSkeleton, 'data-jk-kb-skeleton', 'tasks').props['data-jk-kb-skeleton'], 'tasks');
const skelRows = flatten(taskSkeleton).filter((el) => el.props && el.props['data-jk-kb-skeleton-row'] !== undefined);
eq('任务骨架固定 3 行', skelRows.length, 3);
eq('任务骨架无更多按钮', findIn(taskSkeleton, 'data-jk-kb-more', 'more'), undefined);
eq('任务骨架无收起按钮', findIn(taskSkeleton, 'data-jk-kb-more', 'less'), undefined);
ok('骨架行有圆点与灰条', flatten(skelRows[0]).some((el) => el.props && el.props.className === 'jk-kb-skel-dot')
  && flatten(skelRows[0]).some((el) => el.props && String(el.props.className || '').indexOf('jk-kb-skel-bar') >= 0));

// 仪表盘骨架 + 引导条
let skeletonSettingsOpened = 0;
const dashboardSkeleton = I.DashboardSkeleton({ onOpenSettings: () => { skeletonSettingsOpened += 1; } });
eq('仪表盘骨架容器标记', findIn(dashboardSkeleton, 'data-jk-kb-skeleton', 'dashboard').props['data-jk-kb-skeleton'], 'dashboard');
eq('保留 guidance no-root 标记', findIn(dashboardSkeleton, 'data-jk-kb-guidance', 'no-root').props['data-jk-kb-guidance'], 'no-root');
const guideBar = findIn(dashboardSkeleton, 'data-jk-kb-guide-bar', 'no-root');
ok('引导条存在', !!guideBar);
contains('引导条文案', textOf(guideBar), '还没有配置知识库根目录');
eq('引导条去设置按钮', textOf(findIn(dashboardSkeleton, 'data-jk-kb-guide-bar-open-settings', 'true')), '去设置');
findIn(dashboardSkeleton, 'data-jk-kb-guide-bar-open-settings', 'true').props.onClick();
eq('引导条按钮回调', skeletonSettingsOpened, 1);
const skelCards = flatten(dashboardSkeleton).filter((el) => el.props && el.props['data-jk-kb-skeleton-card'] !== undefined);
eq('四张统计卡骨架', skelCards.map((el) => el.props['data-jk-kb-skeleton-card']).join(','), 'entries,weekly,today,skills');
eq('最近入库骨架 3 行', flatten(dashboardSkeleton).filter((el) => el.props && el.props['data-jk-kb-skeleton-recent-row'] !== undefined).length, 3);
eq('运行状态骨架 3 行', flatten(dashboardSkeleton).filter((el) => el.props && el.props['data-jk-kb-skeleton-runtime-row'] !== undefined).length, 3);
eq('骨架不渲染真实数据块', findIn(dashboardSkeleton, 'data-jk-kb-dashboard', 'ready'), undefined);

// PanelContent：no-root 走骨架且不挂数据组件
const noRootFetch = installFetch(() => ({ body: { ok: true } }));
const noRootPanel = I.PanelContent({
  rootStatus: 'ready',
  root: null,
  activeMenu: I.MENUS[0],
  onOpenSettings: () => {},
});
eq('no-root 骨架标记', findIn(noRootPanel, 'data-jk-kb-skeleton', 'dashboard').props['data-jk-kb-skeleton'], 'dashboard');
ok('no-root 引导条', !!findIn(noRootPanel, 'data-jk-kb-guide-bar', 'no-root'));
eq('渲染 no-root 树不发起任何请求', noRootFetch.calls.length, 0);
noRootFetch.restore();
const mountedTypes = flatten(noRootPanel).map((el) => el.type).filter((type) => typeof type === 'function');
eq('no-root 不挂 Dashboard/Tasks/Experts/Files 组件',
  mountedTypes.filter((type) => type === I.DashboardPage || type === I.TasksPage || type === I.ExpertsPage
    || type === I.RunsBoardPage || type === I.SkillViewPage || type === I.LedgerCalendarPage || type === I.FilesPage).length, 0);
eq('no-root 不渲染真实仪表盘标记', findIn(noRootPanel, 'data-jk-kb-dashboard', 'true'), undefined);

// 已配根目录：正常数据组件，无骨架
const readyPanel = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[0] });
eq('已配置渲染 DashboardPage', readyPanel.type, I.DashboardPage);
eq('已配置无骨架', findIn(readyPanel, 'data-jk-kb-skeleton', 'dashboard'), undefined);
const readyTasksPanel = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[3] });
eq('已配置任务页仍是 TasksPage', readyTasksPanel.type, I.TasksPage);
const readyUsagePanel = I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[4] });
eq('已配置使用信息页是 UsagePage', readyUsagePanel.type, I.UsagePage);

// 宿主不可用：整块错误卡 + 重试，不用骨架
let hostRetried = 0;
const hostErrorPanel = I.PanelContent({
  rootStatus: 'error',
  root: null,
  activeMenu: I.MENUS[0],
  error: { code: 'host-unreachable', message: '连接被拒绝' },
  onRetryHost: () => { hostRetried += 1; },
});
eq('宿主不可用仍用旧标记', findIn(hostErrorPanel, 'data-jk-kb-guidance', 'host-unreachable').props['data-jk-kb-guidance'], 'host-unreachable');
contains('宿主不可用错误卡', textOf(hostErrorPanel), '宿主服务未连接');
eq('宿主不可用无骨架', findIn(hostErrorPanel, 'data-jk-kb-skeleton', 'dashboard'), undefined);
eq('宿主不可用有重试按钮', !!findIn(hostErrorPanel, 'data-jk-kb-host-retry', 'true'), true);
findIn(hostErrorPanel, 'data-jk-kb-host-retry', 'true').props.onClick();
eq('宿主重试回调', hostRetried, 1);

// 源级：骨架无 JS 定时器，CSS 尊重 reduced motion
eq('骨架无 setInterval 驱动', (source.match(/setInterval\s*\(/g) || []).length, 0);
ok('CSS 含 prefers-reduced-motion', I.PANEL_STYLE.indexOf('prefers-reduced-motion') >= 0);
const skeletonSource = source.slice(source.indexOf('function DashboardSkeleton'), source.indexOf('function PanelContent'));
eq('骨架组件无 setTimeout/setInterval',
  skeletonSource.indexOf('setTimeout') < 0 && skeletonSource.indexOf('setInterval') < 0 && skeletonSource.indexOf('usePollingEffect') < 0,
  true);

// ═════════════════════════ 21.5 侧栏执行任务接真实数据 ═════════════════════════
const sidebarBaseMs = Date.parse('2026-10-17T06:00:00Z');
eq('相对时间-刚刚', I.formatRelativeTime('2026-10-17T05:59:40Z', sidebarBaseMs), '刚刚');
eq('相对时间-分钟', I.formatRelativeTime('2026-10-17T05:30:00Z', sidebarBaseMs), '30 分钟前');
eq('相对时间-小时', I.formatRelativeTime('2026-10-17T03:00:00Z', sidebarBaseMs), '3 小时前');
eq('相对时间-天', I.formatRelativeTime('2026-10-14T06:00:00Z', sidebarBaseMs), '3 天前');
const sidebarRuns = [
  { id: 'run-a', title: '整理本周新增笔记', kind: 'maintain', status: 'running', startedAt: '2026-10-17T05:58:00Z' },
  { id: 'run-b', title: '建库', kind: 'bootstrap', status: 'failed', startedAt: '2026-10-17T05:00:00Z' },
  { id: 'run-c', title: '重建索引', kind: 'reindex', status: 'done', startedAt: '2026-10-16T05:00:00Z' },
  { id: 'run-d', title: '入柜', kind: 'curate', status: 'done', startedAt: '2026-10-15T05:00:00Z' },
  { id: 'run-e', title: '归档', kind: 'archive', status: 'done', startedAt: '2026-10-14T05:00:00Z' },
];
const sidebarLoading = I.SidebarTasks({ feed: { phase: 'loading', runs: [], error: null } });
eq('侧栏加载显示骨架', !!findIn(sidebarLoading, 'data-jk-kb-skeleton', 'tasks'), true);
eq('侧栏加载不渲染任务行', findIn(sidebarLoading, 'data-jk-kb-sidebar-task', 'run-a'), undefined);
const sidebarReady = I.SidebarTasks({ feed: { phase: 'ready', runs: sidebarRuns, error: null } });
const sidebarRows = flatten(sidebarReady).filter((el) => el.props && el.props['data-jk-kb-sidebar-task'] !== undefined);
eq('侧栏只显示最近 3 条', sidebarRows.length, 3);
eq('侧栏第一条来自 /runs', sidebarRows[0].props['data-jk-kb-sidebar-task'], 'run-a');
contains('侧栏任务标题', textOf(sidebarRows[0]), '整理本周新增笔记');
contains('侧栏运行中状态', textOf(findIn(sidebarReady, 'data-jk-kb-sidebar-task-status', 'running')), '运行中');
contains('侧栏失败状态', textOf(sidebarReady), '失败');
eq('运行中带心跳点', !!findIn(sidebarReady, 'data-jk-kb-sidebar-task', 'run-a'), true);
ok('侧栏有相对时间', textOf(findIn(sidebarRows[0], 'data-jk-kb-sidebar-task-time', 'true')).length > 0);
ok('总数 >3 出现更多', !!findIn(sidebarReady, 'data-jk-kb-more', 'more'));
const sidebarThree = I.SidebarTasks({ feed: { phase: 'ready', runs: sidebarRuns.slice(0, 3), error: null } });
eq('总数 =3 不出更多', findIn(sidebarThree, 'data-jk-kb-more', 'more'), undefined);
const sidebarExpanded = I.SidebarTasks({ feed: { phase: 'ready', runs: sidebarRuns, error: null }, expanded: true });
eq('展开显示全部', flatten(sidebarExpanded).filter((el) => el.props && el.props['data-jk-kb-sidebar-task'] !== undefined).length, 5);
eq('展开后按钮为收起', textOf(findIn(sidebarExpanded, 'data-jk-kb-more', 'less')), '收起');
let sidebarRunClicks = 0;
const sidebarClickable = I.SidebarTasks({
  feed: { phase: 'ready', runs: sidebarRuns, error: null },
  onSelectRun: () => { sidebarRunClicks += 1; },
});
findIn(sidebarClickable, 'data-jk-kb-sidebar-task', 'run-b').props.onClick();
eq('点行触发选中', sidebarRunClicks, 1);
let sidebarRetried = 0;
const sidebarError = I.SidebarTasks({
  feed: { phase: 'error', runs: [], error: { code: 'host-unreachable', message: '连接被拒绝' } },
  onRetry: () => { sidebarRetried += 1; },
});
contains('侧栏失败文案', textOf(findIn(sidebarError, 'data-jk-kb-sidebar-tasks-error', 'true')), '任务列表暂不可用');
findIn(sidebarError, 'data-jk-kb-sidebar-tasks-retry', 'true').props.onClick();
eq('侧栏重试回调', sidebarRetried, 1);
eq('失败态不渲染示例任务', textOf(sidebarError).indexOf('整理本周新增笔记'), -1);
const sidebarEmpty = I.SidebarTasks({ feed: { phase: 'ready', runs: [], error: null } });
contains('侧栏空态', textOf(findIn(sidebarEmpty, 'data-jk-kb-sidebar-tasks-empty', 'true')), '暂无任务');
eq('侧栏空态含图标', !!findIn(sidebarEmpty, 'data-jk-kb-sidebar-tasks-empty', 'true').children[0], true);
eq('示例常量已移除 STATS', I.STATS, undefined);
eq('示例常量已移除 RECENT', I.RECENT, undefined);
eq('示例常量已移除 RUNTIME', I.RUNTIME, undefined);
eq('MENUS 专家描述无暂未实现', I.MENUS[1].description.indexOf('暂未实现'), -1);
const seededRunsState = I.seedRunsPageState({ phase: 'ready', runs: sidebarRuns.slice(0, 2) });
eq('任务页可用侧栏种子数据', seededRunsState.phase, 'ready');
eq('种子数据条数', seededRunsState.runs.length, 2);
eq('失败态样式存在', source.indexOf('data-jk-kb-sidebar-task-status="failed"') >= 0, true);
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);

// ═════════════════════════ 22. doctor 体检修复入口 ═════════════════════════
// 模型归一
const doctorFixture = {
  ok: true,
  generatedAt: '2026-10-17T06:00:00Z',
  root: '/data/kb',
  checks: [
    { id: 'CFG-01', level: 'blocked', title: '未配置根目录', detail: '没有可用的根目录' },
    { id: 'DIR-01', level: 'error', title: '顶层目录缺失', detail: '缺 3 个目录', repairId: 'R-DIR-01', repairable: true },
    { id: 'STORE-01', level: 'error', title: 'store 损坏', detail: 'bad json', repairId: 'R-STORE-01', repairable: true },
    { id: 'DUP-01', level: 'warn', title: '编号重复', detail: 'SK001 x2' },
    { id: 'ROOT-01', level: 'ok', title: '根目录正常', detail: 'ok' },
  ],
  summary: { total: 5, ok: 1, warn: 1, error: 2, blocked: 1, repairable: 2 },
};
const doctor = I.presentDoctor(doctorFixture);
eq('doctor 检查条数', doctor.checks.length, 5);
eq('doctor 摘要 ok', doctor.summary.ok, 1);
eq('doctor 摘要 warn', doctor.summary.warn, 1);
eq('doctor 摘要 error', doctor.summary.error, 2);
eq('doctor 摘要 blocked', doctor.summary.blocked, 1);
eq('doctor 摘要 repairable', doctor.summary.repairable, 2);
eq('doctor 分组 blocked', doctor.groups.blocked.length, 1);
eq('doctor 分组 error', doctor.groups.error.length, 2);
eq('doctor 分组 ok', doctor.groups.ok.length, 1);
eq('doctor 可修 id', I.selectableRepairIds(doctor.checks).join(','), 'R-DIR-01,R-STORE-01');
eq('doctor 缺字段降级', I.presentDoctor({ checks: [{ id: 'X', level: 'unknown' }] }).checks[0].level, 'warn');
const doctorFetch = installFetch(() => ({ body: { ok: true, checks: [], summary: {} } }));
await I.fetchDoctor();
doctorFetch.restore();
eq('doctor GET 路径', doctorFetch.calls[0].url, I.HOST_DOCTOR_PATH);
eq('doctor GET 方法', doctorFetch.calls[0].init.method, 'GET');
const doctorDown = installFetch(() => ({ throw: true }));
const doctorDownResult = await I.fetchDoctor();
doctorDown.restore();
eq('doctor 失败归一', I.normalizeDoctorResponse(doctorDownResult).ok, false);

// 面板视图：摘要 / 分组 / 勾选 / 折叠
let doctorToggled = null;
let doctorSettingsOpened = 0;
let doctorSelectAll = 0;
let doctorPreview = 0;
const doctorViewProps = {
  open: true,
  phase: 'ready',
  data: doctor,
  error: null,
  selected: [],
  showOk: false,
  view: 'checks',
  plan: null,
  result: null,
  conflict: [],
  notice: null,
  busy: false,
  onToggleCheck: (id) => { doctorToggled = id; },
  onSelectAll: () => { doctorSelectAll += 1; },
  onPreview: () => { doctorPreview += 1; },
  onConfirm: () => {},
  onRefresh: () => {},
  onRetry: () => {},
  onToggleOk: () => {},
  onClose: () => {},
  onGoTasks: () => {},
  onGoSettings: () => { doctorSettingsOpened += 1; },
};
const doctorView = I.DoctorView(doctorViewProps);
contains('doctor 摘要文案', textOf(findIn(doctorView, 'data-jk-kb-doctor-summary', 'true')), '正常 1 · 建议 1 · 可修 2 · 阻塞 1');
ok('blocked 分组', !!findIn(doctorView, 'data-jk-kb-doctor-group', 'blocked'));
ok('error 分组', !!findIn(doctorView, 'data-jk-kb-doctor-group', 'error'));
ok('warn 分组', !!findIn(doctorView, 'data-jk-kb-doctor-group', 'warn'));
eq('ok 默认折叠', findIn(doctorView, 'data-jk-kb-doctor-group', 'ok'), undefined);
ok('ok 折叠切换按钮', !!findIn(doctorView, 'data-jk-kb-doctor-toggle-ok', 'true'));
ok('error 项有勾选框', !!findIn(doctorView, 'data-jk-kb-doctor-checkbox', 'R-DIR-01'));
eq('blocked 项无勾选框', findIn(doctorView, 'data-jk-kb-doctor-checkbox', 'CFG-01'), undefined);
findIn(doctorView, 'data-jk-kb-doctor-checkbox', 'R-DIR-01').props.onChange();
eq('勾选回调', doctorToggled, 'R-DIR-01');
eq('CFG-01 有去设置按钮', !!findIn(doctorView, 'data-jk-kb-doctor-settings', 'true'), true);
findIn(doctorView, 'data-jk-kb-doctor-settings', 'true').props.onClick();
eq('去设置回调', doctorSettingsOpened, 1);
findIn(doctorView, 'data-jk-kb-doctor-select-all', 'true').props.onClick();
eq('全选可修回调', doctorSelectAll, 1);
eq('未选中时预览禁用', findIn(doctorView, 'data-jk-kb-doctor-preview', 'true').props.disabled, true);
const selectedDoctorView = I.DoctorView(Object.assign({}, doctorViewProps, { selected: ['R-DIR-01'] }));
eq('选中后可预览', findIn(selectedDoctorView, 'data-jk-kb-doctor-preview', 'true').props.disabled, false);
findIn(selectedDoctorView, 'data-jk-kb-doctor-preview', 'true').props.onClick();
eq('预览回调', doctorPreview, 1);
const expandedOkView = I.DoctorView(Object.assign({}, doctorViewProps, { showOk: true }));
ok('展开后显示 ok 分组', !!findIn(expandedOkView, 'data-jk-kb-doctor-group', 'ok'));

// 预览请求（dryRun:true）与 plan 渲染
const planFetch = installFetch(() => ({
  body: {
    ok: true,
    dryRun: true,
    planned: [
      { repairId: 'R-DIR-01', checkId: 'DIR-01', action: '创建缺失目录', targets: ['03_内容'], risk: 'low' },
      { repairId: 'R-STORE-01', checkId: 'STORE-01', action: '隔离损坏文件', targets: ['.jkkb/store/cards.json'], risk: 'medium' },
    ],
    applied: [],
  },
}));
const planOutcome = await I.requestDoctorRepair(['R-DIR-01', 'R-STORE-01'], { dryRun: true });
planFetch.restore();
eq('预览修复 URL', planFetch.calls[0].url, I.HOST_DOCTOR_REPAIR_PATH);
eq('预览修复方法', planFetch.calls[0].init.method, 'POST');
const planBody = JSON.parse(planFetch.calls[0].init.body);
eq('预览 repairIds', planBody.repairIds.join(','), 'R-DIR-01,R-STORE-01');
eq('预览 dryRun=true', planBody.dryRun, true);
eq('预览成功 ok', planOutcome.ok, true);
eq('预览 planned 条数', planOutcome.planned.length, 2);
eq('预览 applied 必为空', planOutcome.applied.length, 0);
eq('plan risk 归一', planOutcome.planned[1].risk, 'medium');
const planView = I.DoctorView(Object.assign({}, doctorViewProps, { view: 'plan', plan: planOutcome }));
contains('plan 警告语', textOf(findIn(planView, 'data-jk-kb-doctor-plan-warning', 'true')), '不会删除文件，损坏产物会移入 .jkkb/quarantine');
eq('plan 行渲染', flatten(planView).filter((el) => el.props && el.props['data-jk-kb-doctor-plan-row'] !== undefined).length, 2);
contains('plan action 渲染', textOf(findIn(planView, 'data-jk-kb-doctor-plan-row', 'R-DIR-01')), '创建缺失目录');
contains('plan targets 渲染', textOf(findIn(planView, 'data-jk-kb-doctor-plan-row', 'R-STORE-01')), '.jkkb/store/cards.json');
eq('plan risk 标记', findIn(planView, 'data-jk-kb-doctor-plan-row', 'R-STORE-01').props['data-jk-kb-doctor-plan-risk'], 'medium');
eq('plan 有确认修复按钮', !!findIn(planView, 'data-jk-kb-doctor-confirm', 'true'), true);

// 确认修复（dryRun:false + confirm:true）与结果三态
const applyFetch = installFetch(() => ({
  body: {
    ok: true,
    dryRun: false,
    planned: [],
    applied: [
      { repairId: 'R-DIR-01', status: 'applied', detail: '创建 3 个目录' },
      { repairId: 'R-STORE-01', status: 'skipped', detail: '无需处理' },
      { repairId: 'R-RUN-01', status: 'failed', detail: '权限不足', movedTo: ['.jkkb/quarantine/20261017-120000/x.json'] },
    ],
    auditError: 'audit write failed',
  },
}));
const applyOutcome = await I.requestDoctorRepair(['R-DIR-01', 'R-STORE-01', 'R-RUN-01'], { dryRun: false, confirm: true });
applyFetch.restore();
const applyBody = JSON.parse(applyFetch.calls[0].init.body);
eq('确认 dryRun=false', applyBody.dryRun, false);
eq('确认 confirm=true', applyBody.confirm, true);
eq('确认 repairIds', applyBody.repairIds.length, 3);
eq('结果 applied 条数', applyOutcome.applied.length, 3);
eq('结果 auditError', applyOutcome.auditError, 'audit write failed');
const resultView = I.DoctorView(Object.assign({}, doctorViewProps, { view: 'result', result: applyOutcome }));
eq('结果三态渲染', flatten(resultView).filter((el) => el.props && el.props['data-jk-kb-doctor-result-row'] !== undefined).length, 3);
eq('成功行状态', findIn(resultView, 'data-jk-kb-doctor-result-row', 'R-DIR-01').props['data-jk-kb-doctor-result-status'], 'applied');
eq('跳过行状态', findIn(resultView, 'data-jk-kb-doctor-result-row', 'R-STORE-01').props['data-jk-kb-doctor-result-status'], 'skipped');
eq('失败行状态', findIn(resultView, 'data-jk-kb-doctor-result-row', 'R-RUN-01').props['data-jk-kb-doctor-result-status'], 'failed');
contains('失败行高亮', findIn(resultView, 'data-jk-kb-doctor-result-row', 'R-RUN-01').props.className, 'jk-kb-doctor-result-failed');
contains('movedTo 渲染', textOf(findIn(resultView, 'data-jk-kb-doctor-moved', 'R-RUN-01')), '.jkkb/quarantine/');
contains('audit 黄条', textOf(findIn(resultView, 'data-jk-kb-doctor-audit', 'true')), '修复已生效，但审计记录写入失败');

// 409 RUN_IN_PROGRESS
const doctorConflictFetch = installFetch(() => ({
  status: 409,
  body: { ok: false, error: { code: 'RUN_IN_PROGRESS', message: '有任务正在执行', runs: ['run-1', 'run-2'] } },
}));
const doctorConflictOutcome = await I.requestDoctorRepair(['R-DIR-01'], { dryRun: false, confirm: true });
doctorConflictFetch.restore();
eq('409 识别为 run-in-progress', doctorConflictOutcome.kind, 'run-in-progress');
eq('409 runs 透传', doctorConflictOutcome.runs.join(','), 'run-1,run-2');
let goTasksClicks = 0;
const doctorConflictView = I.DoctorView(Object.assign({}, doctorViewProps, {
  conflict: ['run-1', 'run-2'],
  notice: { kind: 'error', text: doctorConflictOutcome.message },
  onGoTasks: () => { goTasksClicks += 1; },
}));
contains('409 红条文案', textOf(findIn(doctorConflictView, 'data-jk-kb-doctor-conflict', 'true')), '有任务正在执行（run-1、run-2）');
findIn(doctorConflictView, 'data-jk-kb-doctor-go-tasks', 'true').props.onClick();
eq('去任务列表回调', goTasksClicks, 1);

// GET 失败错误态 + 重试
let doctorRetried = 0;
const doctorErrorView = I.DoctorView(Object.assign({}, doctorViewProps, {
  phase: 'error', data: null, error: { code: 'host-unreachable', message: '连接被拒绝' },
  onRetry: () => { doctorRetried += 1; },
}));
contains('doctor 错误态文案', textOf(doctorErrorView), '体检接口不可用');
findIn(doctorErrorView, 'data-jk-kb-doctor-retry', 'true').props.onClick();
eq('doctor 重试回调', doctorRetried, 1);

// 打开面板取一次数据（真实 hook + 假 fetch）
const panelFetch = installFetch(() => ({ body: { ok: true, checks: [], summary: {} } }));
const prevDoctorRunEffects = runEffects;
runEffects = true;
try {
  I.DoctorPanel({ open: true });
} finally {
  runEffects = prevDoctorRunEffects;
  panelFetch.restore();
}
eq('面板打开发起一次 GET /doctor', panelFetch.calls.length >= 1, true);
eq('面板打开请求路径', panelFetch.calls[0].url, I.HOST_DOCTOR_PATH);

// 任务管理页头：体检修复按钮
let doctorOpened = 0;
const tasksHeader = I.TasksPageHeader({ viewMode: 'list', onChange: () => {}, onDoctorOpen: () => { doctorOpened += 1; } });
ok('任务页头有体检修复按钮', !!findIn(tasksHeader, 'data-jk-kb-doctor-open', 'true'));
eq('体检修复按钮文案', textOf(findIn(tasksHeader, 'data-jk-kb-doctor-open', 'true')), '体检修复');
findIn(tasksHeader, 'data-jk-kb-doctor-open', 'true').props.onClick();
eq('体检修复按钮回调', doctorOpened, 1);
ok('任务页头仍有视图切换', !!findIn(tasksHeader, 'data-jk-kb-view-tab', 'skills'));

// 不新增定时器
eq('仍无 setInterval( 直呼', (source.match(/setInterval\s*\(/g) || []).length, 0);
eq('轮询调用点四处', (source.match(/usePollingEffect\s*\(/g) || []).length, 4);
const doctorSection = source.slice(source.indexOf('function DoctorPanel'), source.indexOf('function DoctorView'));
eq('doctor 面板不挂轮询/定时器',
  doctorSection.indexOf('usePollingEffect') < 0 && doctorSection.indexOf('setInterval') < 0 && doctorSection.indexOf('setTimeout') < 0,
  true);

// ═════════════════════════ 23. 既有验收标记未被破坏 ═════════════════════════
const settingsTree = I.SettingsSection({});
ok('设置页仍有 data-jk-kb-save', !!findIn(settingsTree, 'data-jk-kb-save', 'true'));
ok('设置页仍有 data-jk-kb-root(s)', !!findIn(settingsTree, 'data-jk-kb-root', 'saved'));
ok('设置页仍有开关标记', !!findIn(settingsTree, 'data-jk-kb-switch', 'off'));
const rootSection = I.RootSection({ host: { status: 'ready' }, settings: {}, draftRoot: '', needsAck: true, acknowledged: false });
ok('根目录区仍有 data-jk-kb-ack', !!findIn(rootSection, 'data-jk-kb-ack', 'true'));
const taskList = I.TaskList({ tasks: I.TASKS, limit: 3, expanded: false });
ok('任务区仍有 data-jk-kb-more', !!findIn(taskList, 'data-jk-kb-more', 'more'));
ok('样式常量仍是字符串', typeof I.SETTINGS_STYLE === 'string' && typeof I.PANEL_STYLE === 'string');
ok('面板样式新增 jk-kb- 前缀类', I.PANEL_STYLE.indexOf('.jk-kb-table-row') >= 0);
ok('样式只用 var(--dsw-alias-*) 颜色', I.PANEL_STYLE.indexOf('--dsw-alias-') >= 0);
ok('样式未写死十六进制颜色', !/#[0-9a-fA-F]{3,6}/.test(I.PANEL_STYLE));

// ───────────────────────────── 结果 ─────────────────────────────
const total = passed + failures.length;
if (failures.length) {
  console.error('UI TEST FAIL: ' + passed + '/' + total);
  failures.forEach((name) => console.error('  ✗ ' + name));
  process.exit(1);
}
console.log('UI TEST OK: ' + passed + '/' + total);
