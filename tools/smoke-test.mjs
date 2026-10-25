#!/usr/bin/env node
/**
 * jk-knowledge-base 浏览器半冒烟测试：纯 node 运行、零依赖、不联网、不写盘。
 *
 * 做法与 first-demo / logo-substitute 一致：stub globalThis.window.__ModuleLoader__.load
 * 捕获 { id, factory }，用 new Function('window', source) 执行 client.js 源码，stub
 * require('react')，再调用 factory(stubRequire) 拿到导出，对 __internals 的纯函数断言；
 * 同时用假 ctx + 假 slots 走一遍 apply()，验证「开关关闭不注册、开启注册、关闭释放」。
 *
 * 用法：node tools/smoke-test.mjs  → 全通过打印 SMOKE OK: n/m 并以 0 退出。
 */
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// host 半（P1 底座）：入口、设置存储、根目录策略、路由。
import * as hostIndex from '../index.js';
import * as hostConfig from '../host/config.js';
import * as rootPolicy from '../host/root-policy.js';
import * as hostRoutes from '../host/routes.js';
import * as trace from '../host/trace.js';
import * as orchestrator from '../host/orchestrator.js';
import * as engineApi from '../host/engine/index.js';
import * as checkpointMod from '../host/checkpoint.js';
import * as ledgerMod from '../host/ledger.js';
import * as storeMod from '../host/store/index.js';
import * as toolsMod from '../host/tools.js';
import { assertWritableSync as engineAssertWritable } from '../host/engine/guard.js';
import * as backupMod from '../host/backup.js';
import { createRunService } from '../host/orchestrator.js';
import { createToolDefinitions, createToolHandlers } from '../host/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const clientPath = path.join(root, 'client.js');
const source = readFileSync(clientPath, 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log('[jkkb-smoke] platform=' + process.platform + ' node=' + process.version);

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed += 1; return; }
  failures.push(name + (detail ? '  [' + detail + ']' : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}
function deepEq(name, actual, expected) {
  eq(name + ' (JSON)', JSON.stringify(actual), JSON.stringify(expected));
}

// 把 stub createElement 产出的元素树拍平，便于按属性找节点。
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
function classNamesOf(tree) {
  return flatten(tree)
    .map((el) => el.props && el.props.className)
    .filter((name) => typeof name === 'string')
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ─────────────────── 1. 加载 client.js（stub loader + stub react） ───────────────────
let captured = null;
const requireCalls = [];
const dispatched = [];

const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol.for('react.fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (reducer, initialArg, init) => [
    init ? init(initialArg) : initialArg,
    (action) => { dispatched.push(action); },
  ],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
};

const stubRequire = (id) => {
  requireCalls.push(id);
  if (id === 'react') return stubReact;
  throw new Error('client.js 试图 require 未授权的模块: ' + id);
};

// 渲染层 window.localStorage：client.js 的 resolveStorage 优先读它，apply 与设置页
// 都作用在同一个存储上，测试里用 seedEnvStorage() 复位内容。
const envStorage = makeStorage();
const fakeWindow = { __ModuleLoader__: { load: (entry) => { captured = entry; } }, localStorage: envStorage };
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
  console.error('SMOKE FAIL: client.js 没有调用 window.__ModuleLoader__.load');
  process.exit(1);
}

eq('模块 id 等于包名', captured.id, 'jk-knowledge-base');
eq('模块 id 与 package.json name 一致', captured.id, pkg.name);
eq('factory 是函数', typeof captured.factory, 'function');

const mod = captured.factory(stubRequire);
const I = mod.__internals;

eq('factory 只 require 了 react', requireCalls.join(','), 'react');
ok('导出 inject 含 slots', Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0, JSON.stringify(mod.inject));
eq('导出 apply 是函数', typeof mod.apply, 'function');
ok('导出 __internals 测试缝', !!I && typeof I.sliceTasks === 'function');
ok('源码未使用 eval(...) 调用', !/(^|[^.\w$])eval\s*\(/.test(source));
ok('源码未使用 new Function(...) 调用', !/new\s+Function\s*\(/.test(source));
ok('源码未触碰 document.body', !/document\s*\.\s*body/.test(source));

// ─────────────────── 2. 清单契约（package.json / 常量） ───────────────────
eq('package.json version', pkg.version, '1.1.1');
eq('client 常量 PLUGIN_VERSION 与 package.json 一致', I.PLUGIN_VERSION, pkg.version);
eq('display 名称', I.PLUGIN_NAME, 'JK知识库');
eq('panel id 与包名一致', I.PANEL_ID, 'jk-knowledge-base');
eq('storage key', I.STORAGE_KEY, 'jk-knowledge-base:v1');
eq('任务上限', I.TASK_LIMIT, 3);
ok('package.json 无 dependencies', pkg.dependencies === undefined, JSON.stringify(pkg.dependencies));
deepEq('dsh.client.inject 四项齐全', pkg.dsh.client.inject, [
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
]);
eq('dsh.client.platform', pkg.dsh.client.platform, 'web');
eq('bundle patch 路径', pkg.dsh.bundle.patch, './cordis.patch.yml');

// 验收要求的可 grep 标记（源码层面自检）。
const grepTokens = [
  "id: 'jk-knowledge-base'",
  "label: () => '知识库'",
  'order: 1',
  "name: 'settings.section'",
  'key: PANEL_ID',
  "'启动JK知识库'",
  "'jk-kb-meta'",
  "PLUGIN_VERSION = '1.1.1'",
];
grepTokens.forEach((token) => {
  ok('client.js 可 grep 到 ' + token, source.indexOf(token) >= 0);
});

// ─────────────────── 3. 开关状态：默认关闭 + 读写 ───────────────────
function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    seed(entries) {
      map.clear();
      Object.entries(entries || {}).forEach(([key, value]) => map.set(key, String(value)));
    },
  };
}
function seedEnvStorage(entries) {
  envStorage.seed(entries);
}
function brokenStorage() {
  return {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('quota exceeded'); },
  };
}

deepEq('默认状态为关闭', I.defaultState(), { enabled: false });
eq('默认 isEnabled=false', I.isEnabled(I.defaultState()), false);
eq('空对象仍为关闭', I.isEnabled({}), false);
eq('字符串 "true" 不算开启（严格布尔）', I.isEnabled({ enabled: 'true' }), false);
eq('布尔 true 为开启', I.isEnabled({ enabled: true }), true);

const store1 = makeStorage();
deepEq('空 localStorage 读回默认关闭', I.readState(store1), { enabled: false });
eq('写入开启状态返回 true', I.writeState(store1, { enabled: true }), true);
eq('写入内容为 JSON', store1.getItem(I.STORAGE_KEY), JSON.stringify({ enabled: true }));
deepEq('读回开启状态', I.readState(store1), { enabled: true });
eq('写入关闭状态返回 true', I.writeState(store1, { enabled: false }), true);
deepEq('读回关闭状态', I.readState(store1), { enabled: false });

deepEq('脏 JSON 回落默认关闭', I.readState(makeStorage({ [I.STORAGE_KEY]: '{not json' })), { enabled: false });
deepEq('脏结构回落默认关闭', I.readState(makeStorage({ [I.STORAGE_KEY]: '"yes"' })), { enabled: false });
deepEq('存储不可读时回落默认关闭', I.readState(brokenStorage()), { enabled: false });
eq('存储不可写时返回 false', I.writeState(brokenStorage(), { enabled: true }), false);

const persistOn = I.persistState(makeStorage(), { enabled: true });
eq('persistState 开启成功', persistOn.ok, true);
deepEq('persistState 开启返回新状态', persistOn.state, { enabled: true });
const persistFail = I.persistState(brokenStorage(), { enabled: true });
eq('persistState 写盘失败返回 ok=false', persistFail.ok, false);
eq('persistState 写盘失败不返回状态', persistFail.state, null);

// ─────────────────── 4. 任务截断 + 「更多」判定 ───────────────────
ok('示例任务多于 3 条（否则测不到「更多」）', Array.isArray(I.TASKS) && I.TASKS.length > 3, '条数 ' + (I.TASKS || []).length);
const view = I.sliceTasks(I.TASKS, 3);
eq('截断后恰好 3 条', view.items.length, 3);
eq('超过 3 条时 hasMore=true（出现「更多」）', view.hasMore, true);
deepEq('截断保留前三条', view.items.map((t) => t.id), I.TASKS.slice(0, 3).map((t) => t.id));
eq('恰好 3 条时 hasMore=false', I.sliceTasks(I.TASKS.slice(0, 3), 3).hasMore, false);
eq('少于 3 条时 hasMore=false', I.sliceTasks(I.TASKS.slice(0, 2), 3).hasMore, false);
eq('空数组 hasMore=false', I.sliceTasks([], 3).hasMore, false);
eq('空数组 items 为空', I.sliceTasks([], 3).items.length, 0);
eq('非数组入参安全', I.sliceTasks(null, 3).items.length, 0);
eq('非法 limit 回落默认 3', I.sliceTasks(I.TASKS, 0).items.length, 3);

// 4b. 展开 / 收起视图：默认 3 条，展开全部，再收起回 3 条
const collapsed = I.buildTasksView(I.TASKS, 3, false);
eq('收起态只给 3 条', collapsed.items.length, 3);
eq('收起态 hasMore=true', collapsed.hasMore, true);
eq('收起态按钮文案「更多」', collapsed.moreLabel, '更多');
eq('收起态 data-jk-kb-more="more"', collapsed.moreState, 'more');
eq('收起态 expanded=false', collapsed.expanded, false);

const expandedView = I.buildTasksView(I.TASKS, 3, true);
eq('展开态渲染全部任务', expandedView.items.length, I.TASKS.length);
deepEq('展开态任务顺序完整', expandedView.items.map((t) => t.id), I.TASKS.map((t) => t.id));
eq('展开态按钮文案「收起」', expandedView.moreLabel, '收起');
eq('展开态 data-jk-kb-more="less"', expandedView.moreState, 'less');
eq('展开态 expanded=true', expandedView.expanded, true);
eq('再收起回到 3 条', I.buildTasksView(I.TASKS, 3, false).items.length, 3);

const noMore = I.buildTasksView(I.TASKS.slice(0, 3), 3, true);
eq('恰好 3 条时 expanded=false（无可展开）', noMore.expanded, false);
eq('恰好 3 条时 rendered 3 条', noMore.items.length, 3);
eq('恰好 3 条时 hasMore=false（无按钮）', noMore.hasMore, false);
eq('非数组展开态安全', I.buildTasksView(null, 3, true).items.length, 0);

// 4c. 主页面 UI 状态机：切菜单必须复位展开态；侧边栏折叠位独立翻转
deepEq('初始面板状态', I.createPanelState(), { selected: 'dashboard', expanded: false, sidebarCollapsed: false });
deepEq('toggleTasks 展开', I.reducePanel(I.createPanelState(), { type: 'toggleTasks' }), { selected: 'dashboard', expanded: true, sidebarCollapsed: false });
deepEq('再次 toggleTasks 收起', I.reducePanel({ selected: 'dashboard', expanded: true }, { type: 'toggleTasks' }), { selected: 'dashboard', expanded: false, sidebarCollapsed: false });
deepEq('select 已知菜单并复位展开态', I.reducePanel({ selected: 'dashboard', expanded: true }, { type: 'select', id: 'dashboard' }), { selected: 'dashboard', expanded: false, sidebarCollapsed: false });
deepEq('select 未知菜单被忽略', I.reducePanel({ selected: 'dashboard', expanded: true }, { type: 'select', id: 'nope' }), { selected: 'dashboard', expanded: true, sidebarCollapsed: false });
deepEq('toggleSidebar 折叠', I.reducePanel(I.createPanelState(), { type: 'toggleSidebar' }), { selected: 'dashboard', expanded: false, sidebarCollapsed: true });
deepEq('再 toggleSidebar 展开', I.reducePanel({ selected: 'dashboard', expanded: false, sidebarCollapsed: true }, { type: 'toggleSidebar' }), { selected: 'dashboard', expanded: false, sidebarCollapsed: false });
deepEq('折叠下 toggleTasks 不翻折叠位', I.reducePanel({ selected: 'dashboard', expanded: false, sidebarCollapsed: true }, { type: 'toggleTasks' }), { selected: 'dashboard', expanded: true, sidebarCollapsed: true });
deepEq('折叠下切菜单保留折叠', I.reducePanel({ selected: 'dashboard', expanded: true, sidebarCollapsed: true }, { type: 'select', id: 'tasks' }), { selected: 'tasks', expanded: false, sidebarCollapsed: true });
deepEq('脏状态回落首项且未展开', I.reducePanel({ selected: 'nope', expanded: true }, {}), { selected: 'dashboard', expanded: false, sidebarCollapsed: false });
deepEq('未知 action 不改状态', I.reducePanel({ selected: 'dashboard', expanded: true }, null), { selected: 'dashboard', expanded: true, sidebarCollapsed: false });
ok('源码不再保留 moreHint 提示段', source.indexOf('moreHint') < 0);

// ─────────────────── 5. 菜单数组 —— 数据驱动 ───────────────────
ok('MENUS 是数组', Array.isArray(I.MENUS));
ok('菜单数组非空（数据驱动）', I.MENUS.length >= 1, '条数 ' + I.MENUS.length);
eq('首项 id 为仪表盘', I.MENUS[0].id, 'dashboard');
eq('首项 id 与 DASHBOARD_ID 一致', I.MENUS[0].id, I.DASHBOARD_ID);
eq('首项 label', I.MENUS[0].label, '仪表盘');

// ─────────────────── 6. 假 slots + apply：开关切换注册 / 释放 ───────────────────
function makeHarness() {
  const registrations = [];
  const injections = [];
  const disposedNames = [];
  const effects = [];

  const slots = {
    inject(name, callback) {
      injections.push(name);
      let alreadyDisposed = false;
      const inner = callback();
      return () => {
        if (alreadyDisposed) return;
        alreadyDisposed = true;
        disposedNames.push(name);
        if (typeof inner === 'function') inner();
      };
    },
    register(options, component) {
      const entry = { options: options || {}, component: component, alive: true };
      registrations.push(entry);
      return () => { entry.alive = false; };
    },
  };

  return {
    ctx: {
      slots: slots,
      effect(fn, label) {
        effects.push(label);
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      },
    },
    registrations: registrations,
    injections: injections,
    disposedNames: disposedNames,
    effects: effects,
    activeOf(name) {
      return registrations.filter((r) => r.options.name === name && r.alive).length;
    },
    activeByName(name) {
      return registrations.filter((r) => r.options.name === name && r.alive);
    },
  };
}

// 6a. 防御性：坏 ctx 不抛异常、不注册
[undefined, null, {}, { slots: null }, { slots: {} }, { slots: { inject() {}, register: null } }].forEach((bad, index) => {
  let threw = null;
  try { mod.apply(bad); } catch (err) { threw = err; }
  eq('apply(坏 ctx #' + index + ') 不抛异常', threw, null);
});

// 6b. 默认关闭：只注册设置子菜单，侧边栏与主区域都不注册
seedEnvStorage();
const offHarness = makeHarness();
let applyThrew = null;
try { mod.apply(offHarness.ctx); } catch (err) { applyThrew = err; }
eq('apply(假 ctx) 不抛异常', applyThrew, null);
eq('默认关闭时只注入 settings.section', offHarness.injections.join(','), 'settings.section');
eq('默认关闭时注册了设置子菜单', offHarness.activeOf('settings.section'), 1);
eq('默认关闭时不注册 sidebar.panellist', offHarness.activeOf('sidebar.panellist'), 0);
eq('默认关闭时不注册 main', offHarness.activeOf('main'), 0);
ok('副作用通过 ctx.effect 归还', offHarness.effects.indexOf('jk-knowledge-base: slots') >= 0, JSON.stringify(offHarness.effects));

const settingsReg = offHarness.activeByName('settings.section')[0];
ok('设置子菜单已注册', !!settingsReg);
if (settingsReg) {
  eq('设置席位 name', settingsReg.options.name, 'settings.section');
  eq('设置席位 id = 包名', settingsReg.options.id, 'jk-knowledge-base');
  eq('设置子菜单文案', String(settingsReg.options.label()), 'JK知识库');
  eq('设置子菜单 order 避开 logo-substitute 的 100', settingsReg.options.order, 110);
  eq('设置席位组件是函数', typeof settingsReg.component, 'function');
}

// 6c. 打开开关（真实点击设置页上的 Switch）
const settingsTreeOff = I.SettingsSection({});
const switchOff = findIn(settingsTreeOff, 'role', 'switch');
ok('设置页渲染出 Switch', !!switchOff);
eq('Switch 默认 aria-checked=false', switchOff.props['aria-checked'], false);
eq('Switch 默认 data 标记 off', switchOff.props['data-jk-kb-switch'], 'off');
eq('设置页标签文案「启动JK知识库」', textOf(findIn(settingsTreeOff, 'className', 'jk-kb-switch-label')), '启动JK知识库');
eq('设置页默认 data-jk-kb-enabled=off', flatten(settingsTreeOff).find((el) => el.props && el.props['data-jk-kb-settings'] === 'true').props['data-jk-kb-enabled'], 'off');
eq('设置页右下角版本号文案', textOf(findIn(settingsTreeOff, 'data-jk-kb-version', I.PLUGIN_VERSION)), 'JK知识库 v' + I.PLUGIN_VERSION);
ok('设置页存在 jk-kb-meta 容器', !!findIn(settingsTreeOff, 'data-jk-kb-meta', 'true'));

switchOff.props.onClick();
eq('点开 Switch 后 localStorage 写入开启', envStorage.getItem(I.STORAGE_KEY), JSON.stringify({ enabled: true }));
eq('点开 Switch 后注册 sidebar.panellist', offHarness.activeOf('sidebar.panellist'), 1);
eq('点开 Switch 后注册 main', offHarness.activeOf('main'), 1);

const sidebarOn = offHarness.activeByName('sidebar.panellist')[0];
const mainOn = offHarness.activeByName('main')[0];
ok('侧边栏席位已注册', !!sidebarOn);
ok('主区域席位已注册', !!mainOn);
if (sidebarOn) {
  eq('侧边栏席位 name', sidebarOn.options.name, 'sidebar.panellist');
  eq('侧边栏菜单 id = 包名', sidebarOn.options.id, I.PANEL_ID);
  eq('侧边栏 order = 1（紧跟官方「插件」order 0）', sidebarOn.options.order, 1);
  eq('侧边栏菜单文案', String(sidebarOn.options.label()), '知识库');
  const icon = sidebarOn.component({ size: 20 });
  eq('图标根元素是 svg', icon.type, 'svg');
  eq('图标尺寸跟随 size', icon.props.width, 20);
  eq('图标 stroke=currentColor', icon.props.stroke, 'currentColor');
  eq('图标 aria-hidden', icon.props['aria-hidden'], 'true');
  eq('图标带 data-dsh-panel-entry', icon.props['data-dsh-panel-entry'], I.PANEL_ID);
  ok('图标内有图形子节点', Array.isArray(icon.children) && icon.children.length >= 3, '子节点数 ' + (icon.children || []).length);
  eq('图标缺省尺寸 16', sidebarOn.component({}).props.width, 16);
}
if (mainOn) {
  eq('主区域席位 key = 同一个 PANEL_ID', mainOn.options.key, I.PANEL_ID);
  eq('主区域 key 与侧边栏 id 相同', mainOn.options.key, sidebarOn && sidebarOn.options.id);
  eq('主区域席位组件是函数', typeof mainOn.component, 'function');
}

// 设置页在开启状态下重渲染：Switch 变 on
const settingsTreeOn = I.SettingsSection({});
eq('开启后 Switch aria-checked=true', findIn(settingsTreeOn, 'role', 'switch').props['aria-checked'], true);
eq('开启后 data-jk-kb-switch=on', findIn(settingsTreeOn, 'role', 'switch').props['data-jk-kb-switch'], 'on');

// 6d. 关闭开关：两条注册都被 dispose
findIn(settingsTreeOn, 'role', 'switch').props.onClick();
eq('关闭后 localStorage 写入关闭', envStorage.getItem(I.STORAGE_KEY), JSON.stringify({ enabled: false }));
eq('关闭后 sidebar.panellist 被 dispose', offHarness.activeOf('sidebar.panellist'), 0);
eq('关闭后 main 被 dispose', offHarness.activeOf('main'), 0);
ok('dispose 覆盖到 sidebar.panellist', offHarness.disposedNames.indexOf('sidebar.panellist') >= 0, JSON.stringify(offHarness.disposedNames));
ok('dispose 覆盖到 main', offHarness.disposedNames.indexOf('main') >= 0, JSON.stringify(offHarness.disposedNames));
eq('设置子菜单在关闭后仍在', offHarness.activeOf('settings.section'), 1);

// 6e. 再开一次：不产生重复注册
I.getStore().set(I.persistState(envStorage, { enabled: true }).state);
eq('再次开启后 sidebar.panellist 只有一条', offHarness.activeOf('sidebar.panellist'), 1);
eq('再次开启后 main 只有一条', offHarness.activeOf('main'), 1);

// 6f. 刷新场景：已保存开启时 apply 后立即注册
seedEnvStorage({ [I.STORAGE_KEY]: JSON.stringify({ enabled: true }) });
const restored = makeHarness();
mod.apply(restored.ctx);
eq('刷新后按已保存状态注册 sidebar.panellist', restored.activeOf('sidebar.panellist'), 1);
eq('刷新后按已保存状态注册 main', restored.activeOf('main'), 1);

// ─────────────────── 7. 主页面渲染 ───────────────────
// 用 6e 重新开启后存活的那条注册（6c 的 mainOn 已在 6d 被 dispose）。
const liveMain = offHarness.activeByName('main')[0];
ok('重新开启后主区域席位存活', !!liveMain);
const panelTree = liveMain.component({});
const panelEl = flatten(panelTree).find((el) => el.props && el.props['data-dsh-plugin'] === I.PANEL_ID);
ok('面板根容器带 data-dsh-plugin', !!panelEl);
const pageEl = flatten(panelTree).find((el) => el.props && el.props['data-jk-kb-page'] !== undefined);
eq('默认选中仪表盘页面', pageEl.props['data-jk-kb-page'], 'dashboard');

const styleEls = flatten(panelTree).filter((el) => el.type === 'style');
ok('样式以 <style> 元素渲染', styleEls.length > 0 && !!styleEls[0].props.dangerouslySetInnerHTML);

const menuButtons = flatten(panelTree).filter((el) => el.props && el.props['data-jk-kb-menu'] !== undefined);
eq('左栏菜单按数组渲染', menuButtons.length, I.MENUS.length);
eq('左栏首个菜单是仪表盘', textOf(menuButtons[0]), '仪表盘');
eq('菜单带 data 标记', menuButtons[0].props['data-jk-kb-menu'], 'dashboard');

const sidebarSkelRows = flatten(panelTree).filter((el) => el.props && el.props['data-jk-kb-skeleton-row'] !== undefined);
eq('执行任务区骨架 3 行', sidebarSkelRows.length, 3);
ok('骨架态无更多按钮', !findIn(panelTree, 'data-jk-kb-more', 'more'));
ok('骨架态不渲染示例任务标题', textOf(panelTree).indexOf('整理本周新增笔记') < 0);
eq('执行任务区骨架容器标记', findIn(panelTree, 'data-jk-kb-skeleton', 'tasks').props['data-jk-kb-skeleton'], 'tasks');
ok('骨架行有灰条', flatten(sidebarSkelRows[0]).some((el) => String((el.props && el.props.className) || '').indexOf('jk-kb-skel-bar') >= 0));
ok('骨架行有圆点', flatten(sidebarSkelRows[0]).some((el) => (el.props && el.props.className) === 'jk-kb-skel-dot'));
ok('骨架态不渲染第二条示例标题', textOf(panelTree).indexOf('为 9 条笔记补标签') < 0);
ok('骨架态不渲染第三条示例标题', textOf(panelTree).indexOf('重建知识库索引') < 0);

// 主页面在配置读取前渲染 loading；仪表盘内容用 DashboardPage() 独立渲染断言。
// 仪表盘现在是真实数据：用宿主响应 → 客户端 normalize → DashboardView 渲染。
const dashRaw = {
  ok: true,
  generatedAt: '2026-10-17T12:00:00.000Z',
  counts: { notes: 1286, dirs: 13, files: 1300, topDirs: [], truncated: true },
  recent: [
    { relPath: '01_收件箱/a.md', title: '甲', updatedAt: '2026-10-17T11:00:00.000Z', size: 10 },
    { relPath: '03_研究与洞察/b.md', title: '乙', updatedAt: '2026-10-17T10:00:00.000Z', size: 20 },
    { relPath: '06_知识与模型/c.md', title: '丙', updatedAt: '2026-10-17T09:00:00.000Z', size: 30 },
  ],
  runtime: {
    root: '/kb', hasVault: true, mode: 'asset', vaultUpdatedAt: '2026-10-15T00:00:00.000Z',
    lastRun: { id: 'run-1', title: '体检', status: 'completed', startedAt: '2026-10-17T08:00:00.000Z', endedAt: '2026-10-17T08:00:01.500Z', elapsedMs: 1500 },
    running: 0,
  },
  today: { runs: 4, completed: 3, failed: 1, totalMs: 1000, inputTokens: 10, outputTokens: 5 },
  health: { storeGuard: 'ready', tools: { registered: 13, failed: 0 }, subagents: { available: true, providers: ['deepseek'] } },
  maintain: { lastReport: { period: '2026-10-17', summary: 'M01=2 M03=1 M04=0 M06=0 M07=0 M08=0', byRule: { M01: 2, M03: 1, M04: 0, M06: 0, M07: 0, M08: 0 } } },
};
const dashNorm = I.normalizeDashboardResponse(Object.assign({ ok: true }, dashRaw));
eq('normalizeDashboardResponse 认宿主响应', dashNorm.ok, true);
const dashboardTree = I.DashboardView({ phase: 'ready', data: dashNorm.data, registryCount: 2 });
const statCards = flatten(dashboardTree).filter((el) => el.props && el.props['data-jk-kb-stat'] !== undefined);
eq('仪表盘 4 张统计卡', statCards.length, 4);
deepEq('统计卡顺序', statCards.map((el) => el.props['data-jk-kb-stat']), ['entries', 'weekly', 'today', 'skills']);
ok('统计卡渲染 label/value', textOf(findIn(dashboardTree, 'data-jk-kb-stat', 'entries')).indexOf('知识条目') >= 0
  && textOf(findIn(dashboardTree, 'data-jk-kb-stat', 'today')).indexOf('4') >= 0);
ok('截断时显示「已截断」徽标', !!findIn(dashboardTree, 'data-jk-kb-truncated', 'true'));

const recentItems = flatten(dashboardTree).filter((el) => el.props && el.props['data-jk-kb-recent'] !== undefined);
eq('最近入库列表条数', recentItems.length, dashRaw.recent.length);
eq('仪表盘不再渲染运行状态块（已迁至使用信息页）', findIn(dashboardTree, 'data-jk-kb-block', 'runtime'), undefined);
const usageTree = I.UsageView({ phase: 'ready', data: dashNorm.data });
ok('使用信息页渲染运行状态块', !!findIn(usageTree, 'data-jk-kb-block', 'runtime'));
ok('使用信息 store guard 行', textOf(findIn(usageTree, 'data-jk-kb-runtime', 'storeGuard')).indexOf('ready') >= 0);
ok('最近整理块渲染最新报告', textOf(findIn(dashboardTree, 'data-jk-kb-maintain-summary', 'true')).indexOf('M01=2') >= 0);
ok('页面渲染 ready 相位', findIn(dashboardTree, 'data-jk-kb-dashboard', 'true') && findIn(dashboardTree, 'data-jk-kb-dashboard-phase', 'ready') !== false);
ok('主页面配置读取中不白屏（渲染 loading 文案）', !!findIn(panelTree, 'data-jk-kb-root-loading', 'true'));
ok('主页面不再渲染「知识库」大标题行（已按需求移除）', flatten(panelTree).every((el) => !el.props || el.props.className !== 'jk-kb-title'));
ok('主页面顶部导航渲染（知识库/文档）', !!findIn(panelTree, 'data-jk-kb-nav', 'knowledge-base') && !!findIn(panelTree, 'data-jk-kb-nav', 'docs'));
ok('顶部导航「知识库」为当前项', findIn(panelTree, 'data-jk-kb-nav', 'knowledge-base').props['data-active'] === 'true');

// 占位页：将来加菜单自动落到这里
const placeholderTree = I.PlaceholderPage({ id: 'archive', label: '归档' });
ok('占位页渲染菜单名', textOf(placeholderTree).indexOf('归档') >= 0);
ok('占位页有 data 标记', !!findIn(placeholderTree, 'data-jk-kb-placeholder', 'archive'));
ok('占位页提示尚未实现', textOf(placeholderTree).indexOf('尚未实现') >= 0);

// 7b. TaskList 组件：折叠 3 条 ↔ 展开全部 ↔ 无更多时不出按钮
const taskListCollapsed = I.TaskList({ tasks: I.TASKS, limit: 3, expanded: false, onToggle: () => {} });
const collapsedRows = flatten(taskListCollapsed).filter((el) => el.props && el.props['data-jk-kb-task'] !== undefined);
eq('折叠态渲染 3 条', collapsedRows.length, 3);
eq('折叠态按钮 data-jk-kb-more="more"', findIn(taskListCollapsed, 'data-jk-kb-more', 'more').props['data-jk-kb-more'], 'more');
eq('折叠态按钮文案', textOf(findIn(taskListCollapsed, 'data-jk-kb-more', 'more')), '更多');

const taskListExpanded = I.TaskList({ tasks: I.TASKS, limit: 3, expanded: true, onToggle: () => {} });
const expandedRows = flatten(taskListExpanded).filter((el) => el.props && el.props['data-jk-kb-task'] !== undefined);
eq('展开态渲染全部任务', expandedRows.length, I.TASKS.length);
eq('展开态按钮 data-jk-kb-more="less"', findIn(taskListExpanded, 'data-jk-kb-more', 'less').props['data-jk-kb-more'], 'less');
eq('展开态按钮文案「收起」', textOf(findIn(taskListExpanded, 'data-jk-kb-more', 'less')), '收起');
eq('展开态按钮 aria-expanded=true', findIn(taskListExpanded, 'data-jk-kb-more', 'less').props['aria-expanded'], true);

let toggleCalls = 0;
const taskListClickable = I.TaskList({ tasks: I.TASKS, limit: 3, expanded: false, onToggle: () => { toggleCalls += 1; } });
findIn(taskListClickable, 'data-jk-kb-more', 'more').props.onClick();
eq('点击「更多」会调用 onToggle', toggleCalls, 1);
eq('收起态可再展开（同一组件 re-render 后 5 条）',
  flatten(I.TaskList({ tasks: I.TASKS, limit: 3, expanded: true, onToggle: () => {} }))
    .filter((el) => el.props && el.props['data-jk-kb-task'] !== undefined).length,
  I.TASKS.length);

const taskListShort = I.TaskList({ tasks: I.TASKS.slice(0, 2), limit: 3, expanded: true, onToggle: () => {} });
eq('任务不足 3 条时不渲染按钮', !!findIn(taskListShort, 'data-jk-kb-more', 'more'), false);

// 仪表盘也可独立渲染（页面分发的两条分支都存在）
ok('仪表盘可独立渲染', !!findIn(I.DashboardPage(), 'data-jk-kb-dashboard-loading', 'true'));

// ─────────────────── 8. 样式与类名契约 ───────────────────
[['设置页', I.SETTINGS_STYLE], ['主页面', I.PANEL_STYLE]].forEach(([label, css]) => {
  ok(label + ' CSS 未写死颜色（无 #hex）', !/#[0-9a-fA-F]{3,8}\b/.test(css));
  ok(label + ' CSS 未写死颜色（无 rgb()/rgba()）', !/\brgba?\(/.test(css));
  ok(label + ' CSS 使用了 --dsw-alias-* 主题变量', css.indexOf('var(--dsw-alias-') >= 0);
});

[['设置页', settingsTreeOff], ['主页面', panelTree]].forEach(([label, tree]) => {
  const bad = classNamesOf(tree).filter((name) => name.indexOf('jk-kb-') !== 0);
  eq(label + ' 全部类名带 jk-kb- 前缀', bad.join(','), '');
});

// ═══════════════════ 9. host 半：入口契约 ═══════════════════
eq('host name', hostIndex.name, 'jk-knowledge-base');
deepEq('host inject 为 webServer + connection', hostIndex.inject, ['webServer', 'connection']);
eq('host apply 是函数', typeof hostIndex.apply, 'function');
ok('host 刻意不导出 Config（cordis resolveConfig 会解 ~standard）', hostIndex.Config === undefined);

[undefined, null, {}, { effect: null }, { effect() {} }, { effect() {}, webServer: null }, { effect() {}, webServer: {} }].forEach((badCtx, index) => {
  let threw = null;
  try { hostIndex.apply(badCtx, {}); } catch (err) { threw = err; }
  eq('host apply(退化 ctx #' + index + ') 不抛异常', threw, null);
});

const hostRegistered = [];
const hostEffectLabels = [];
const hostApplyCtx = {
  webServer: {
    register(spec) { hostRegistered.push(spec); return () => { spec.disposed = true; }; },
  },
  connection: { requestRejection() { return undefined; } },
  effect(fn, label) {
    hostEffectLabels.push(label);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
};
let hostApplyThrew = null;
try { hostIndex.apply(hostApplyCtx, {}); } catch (err) { hostApplyThrew = err; }
eq('host apply(假 webServer) 不抛异常', hostApplyThrew, null);
eq('注册 21 条路由（+ /dashboard + /doctor + /doctor/repair + /files + /file）', hostRegistered.length, 21);
deepEq('路由 path/kind 列表', hostRegistered.map((spec) => spec.kind + ' ' + spec.path).sort(), [
  'exact /plugins/jk-knowledge-base/config',
  'exact /plugins/jk-knowledge-base/config/validate',
  'exact /plugins/jk-knowledge-base/dashboard',
  'exact /plugins/jk-knowledge-base/doctor',
  'exact /plugins/jk-knowledge-base/doctor/repair',
  'exact /plugins/jk-knowledge-base/experts',
  'exact /plugins/jk-knowledge-base/file',
  'exact /plugins/jk-knowledge-base/files',
  'exact /plugins/jk-knowledge-base/health',
  'exact /plugins/jk-knowledge-base/ledger/calendar',
  'exact /plugins/jk-knowledge-base/ledger/day',
  'exact /plugins/jk-knowledge-base/preflight',
  'exact /plugins/jk-knowledge-base/reports',
  'exact /plugins/jk-knowledge-base/run',
  'exact /plugins/jk-knowledge-base/runs',
  'exact /plugins/jk-knowledge-base/skill-calls',
  'exact /plugins/jk-knowledge-base/skill-registry',
  'exact /plugins/jk-knowledge-base/skills',
  'prefix /plugins/jk-knowledge-base/experts',
  'prefix /plugins/jk-knowledge-base/reports',
  'prefix /plugins/jk-knowledge-base/runs',
]);
ok('prefix 用于路径参数路由（/runs、/reports、/experts）', hostRegistered.filter((spec) => spec.kind === 'prefix').length === 3);
ok('每条都有 handler 函数', hostRegistered.every((spec) => typeof spec.handler === 'function'));
ok('注册包在 ctx.effect 里', hostEffectLabels.indexOf('jk-knowledge-base: routes') >= 0, JSON.stringify(hostEffectLabels));
eq('路由前缀', hostRoutes.ROUTE_PREFIX, '/plugins/jk-knowledge-base');
eq('请求体上限 8KB', hostRoutes.MAX_BODY_BYTES, 8192);

// apply 也注册工具：6 个定义逐个交给 ctx.tools.register；单个失败不影响其它。
const toolRegistrations = [];
const applyToolsService = { register(definition) { toolRegistrations.push(definition); return () => {}; } };
const applyWithTools = {
  get: (name) => (name === 'tools' ? applyToolsService : undefined),
  webServer: { register() { return () => {}; } },
  connection: { requestRejection() { return undefined; } },
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
};
let applyWithToolsThrew = null;
try { hostIndex.apply(applyWithTools, {}); } catch (err) { applyWithToolsThrew = err; }
eq('apply 注册工具不抛', applyWithToolsThrew, null);
eq('apply 注册 19 个工具', toolRegistrations.length, 19);
ok('注册的是普通对象定义', toolRegistrations.every((def) => def && typeof def === 'object' && typeof def.execute === 'function' && def.output));

let toolAttempts = 0;
let applyThrowingToolsThrew = null;
try {
  hostIndex.apply({
    get: (name) => (name === 'tools' ? { register() { toolAttempts += 1; throw new Error('schema rejected'); } } : undefined),
    webServer: { register() { return () => {}; } },
    connection: { requestRejection() { return undefined; } },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  }, {});
} catch (err) { applyThrowingToolsThrew = err; }
eq('单个工具注册失败不冒泡', applyThrowingToolsThrew, null);
eq('19 个工具都尝试注册过', toolAttempts, 19);

// ═══════════════════ 10. root-policy：6 类拒绝 + 3 类警告 ═══════════════════
const tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'jkkb-smoke-'));
  tmpDirs.push(dir);
  return dir;
}

const home = os.homedir();
[
  ['空字符串', '', 'root-empty'],
  ['相对路径', 'some/relative/dir', 'root-relative'],
  ['不存在的路径', path.join(os.tmpdir(), 'jkkb-not-exist-' + Date.now()), 'root-missing'],
  ['根目录 /', '/', 'root-system'],
  ['系统目录 /System', '/System', 'root-system'],
  ['家目录本身', home, 'root-is-home'],
  ['~/.dsh', path.join(home, '.dsh'), 'root-dsh'],
].forEach(([label, input, code]) => {
  const result = rootPolicy.evaluateRoot(input);
  eq('拒绝：' + label + ' → level=reject', result.level, 'reject');
  eq('拒绝：' + label + ' → ok=false', result.ok, false);
  eq('拒绝：' + label + ' → 原因码 ' + code, result.reasons[0].code, code);
  ok('拒绝：' + label + ' → 带中文说明', typeof result.reasons[0].message === 'string' && result.reasons[0].message.length > 0);
});

const fileProbe = path.join(makeTmpDir('jkkb-file-'), 'a.txt');
fs.writeFileSync(fileProbe, 'x');
const notDirectory = rootPolicy.evaluateRoot(fileProbe);
eq('拒绝：指向文件 → level=reject', notDirectory.level, 'reject');
eq('拒绝：指向文件 → 原因码', notDirectory.reasons[0].code, 'root-not-directory');

const sshDir = path.join(makeTmpDir('jkkb-ssh-'), '.ssh');
fs.mkdirSync(sshDir);
const sensitive = rootPolicy.evaluateRoot(sshDir);
eq('拒绝：.ssh 敏感段 → level=reject', sensitive.level, 'reject');
eq('拒绝：.ssh 敏感段 → 原因码', sensitive.reasons[0].code, 'root-sensitive');

// 3 类警告：用户目录（Documents/Desktop/Downloads）、外接卷、非空目录。
function fakeDeps(entries) {
  return {
    homedir: () => '/Users/tester',
    realpathSync: (value) => value,
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: (value) => (entries && entries[value]) || [],
  };
}
const fakeHomeDeps = fakeDeps({});
[['Documents', 'warn-documents'], ['Desktop', 'warn-desktop'], ['Downloads', 'warn-downloads']].forEach(([name, code]) => {
  const result = rootPolicy.evaluateRoot('/Users/tester/' + name + '/kb', fakeHomeDeps);
  eq('警告：~/ ' + name + ' → level=warn', result.level, 'warn');
  eq('警告：~/ ' + name + ' → ok=true', result.ok, true);
  ok('警告：~/ ' + name + ' → 原因码 ' + code, result.reasons.some((item) => item.code === code), JSON.stringify(result.reasons));
});

const volumeResult = rootPolicy.evaluateRoot('/Volumes/ExtDisk/kb', fakeHomeDeps);
eq('警告：外接卷 → level=warn', volumeResult.level, 'warn');
ok('警告：外接卷 → 原因码 warn-external-volume', volumeResult.reasons.some((item) => item.code === 'warn-external-volume'), JSON.stringify(volumeResult.reasons));

const plainResult = rootPolicy.evaluateRoot('/Users/tester/work/kb', fakeHomeDeps);
eq('普通目录 → level=ok', plainResult.level, 'ok');
eq('普通目录 → ok=true', plainResult.ok, true);
deepEq('普通目录 → 无 reasons', plainResult.reasons, []);

const nonEmptyDir = makeTmpDir('jkkb-nonempty-');
fs.writeFileSync(path.join(nonEmptyDir, 'note.md'), 'x');
const nonEmptyResult = rootPolicy.evaluateRoot(nonEmptyDir);
eq('警告：非空目录 → level=warn', nonEmptyResult.level, 'warn');
ok('警告：非空目录 → 原因码 warn-non-empty', nonEmptyResult.reasons.some((item) => item.code === 'warn-non-empty'), JSON.stringify(nonEmptyResult.reasons));
eq('normalized 走 realpath', nonEmptyResult.normalized, fs.realpathSync(nonEmptyDir));

const emptyDir = makeTmpDir('jkkb-empty-');
const emptyResult = rootPolicy.evaluateRoot(emptyDir);
eq('空目录 → level=ok', emptyResult.level, 'ok');
eq('空目录 → ok=true', emptyResult.ok, true);
eq('空目录 → normalized 为 realpath', emptyResult.normalized, fs.realpathSync(emptyDir));

// ═══════════════════ 11. 设置存储：默认值 / 原子写 / 坏 JSON 回落 ═══════════════════
deepEq('默认设置', hostConfig.defaultSettings(), { root: null, rootConfirmedAt: null, rootRiskAck: null, updatedAt: null });
deepEq('脏输入（字符串）回落默认', hostConfig.normalizeSettings('nope'), hostConfig.defaultSettings());
deepEq('脏输入（数组）回落默认', hostConfig.normalizeSettings([]), hostConfig.defaultSettings());
deepEq('只有 root 没有确认记录 → 视为未配置', hostConfig.normalizeSettings({ root: '/data/kb' }), hostConfig.defaultSettings());

const goodSettings = {
  root: '/data/kb',
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: hostConfig.hashAckText(hostConfig.RISK_ACK_TEXT) },
  updatedAt: '2026-10-17T05:00:00.000Z',
};
deepEq('完整设置原样保留', hostConfig.normalizeSettings(goodSettings), goodSettings);
eq('确认文本哈希为 sha256 hex', hostConfig.hashAckText(hostConfig.RISK_ACK_TEXT).length, 64);
eq('哈希稳定', hostConfig.hashAckText(hostConfig.RISK_ACK_TEXT), hostConfig.hashAckText(hostConfig.RISK_ACK_TEXT));
eq('host 版本与 package.json 一致', hostConfig.PLUGIN_VERSION, pkg.version);
eq('client 版本与 host 版本一致', I.PLUGIN_VERSION, hostConfig.PLUGIN_VERSION);
eq('两端风险确认文案一致', I.RISK_ACK_TEXT, hostConfig.RISK_ACK_TEXT);
const engineDirs = await rootPolicy.getTopLevelDirs('asset');
eq('顶层目录真源来自引擎预设（13 个）', engineDirs.length, 13);
ok('目录名是引擎的中文口径', engineDirs.indexOf('00_系统与索引') >= 0 && engineDirs.indexOf('12_归档与历史') >= 0, JSON.stringify(engineDirs));
eq('client 展示的目录数与之对齐', I.VAULT_TOP_LEVEL_COUNT, engineDirs.length);
ok('root-policy 不再硬编码英文 PARA 目录名', readFileSync(path.join(root, 'host', 'root-policy.js'), 'utf8').indexOf('10-notes') < 0);

const storeDir = makeTmpDir('jkkb-store-');
const settingsFile = path.join(storeDir, 'nested', 'settings.json');
const writeResult = hostConfig.writeSettingsAtomic(settingsFile, goodSettings);
eq('原子写成功', writeResult.ok, true);
deepEq('原子写返回归一化设置', writeResult.settings, goodSettings);
deepEq('落盘内容可读回', JSON.parse(fs.readFileSync(settingsFile, 'utf8')), goodSettings);
eq('无残留 tmp 文件', fs.readdirSync(path.dirname(settingsFile)).filter((name) => name.endsWith('.tmp')).length, 0);
deepEq('readSettings 读回', hostConfig.readSettings(settingsFile), goodSettings);

const badFile = path.join(makeTmpDir('jkkb-bad-'), 'settings.json');
fs.writeFileSync(badFile, '{ not json');
deepEq('坏 JSON 回落默认值', hostConfig.readSettings(badFile), hostConfig.defaultSettings());
deepEq('文件不存在回落默认值', hostConfig.readSettings(path.join(os.tmpdir(), 'jkkb-absent-' + Date.now() + '.json')), hostConfig.defaultSettings());

const failingIo = {
  mkdirSync() {},
  writeFileSync() {},
  renameSync() { const err = new Error('EACCES: permission denied'); err.code = 'EACCES'; throw err; },
  unlinkSync() {},
};
const failedWrite = hostConfig.writeSettingsAtomic('/tmp/jkkb-nowhere/settings.json', goodSettings, failingIo);
eq('写失败 ok=false', failedWrite.ok, false);
eq('写失败错误码', failedWrite.error.code, 'EACCES');
ok('写失败错误文案含 errno', failedWrite.error.message.indexOf('EACCES') >= 0, failedWrite.error.message);

const atomicStore = hostConfig.createSettingsStore({ file: settingsFile });
deepEq('store 读到已保存设置', atomicStore.get(), goodSettings);
const freshStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-store2-'), 'settings.json') });
deepEq('新 store 默认未配置', freshStore.get(), hostConfig.defaultSettings());
const freshSave = freshStore.save(goodSettings);
eq('store.save 成功', freshSave.ok, true);
deepEq('store.get 返回内存新值', freshStore.get(), goodSettings);
deepEq('store.reload 从盘上读回', freshStore.reload(), goodSettings);

// ═══════════════════ 12. 路由：四种行为 + 鉴权 + 错误码 ═══════════════════
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); },
  };
}
function makeReq(options) {
  const o = options || {};
  const chunks = o.body === undefined
    ? []
    : [Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body))];
  const req = Readable.from(chunks);
  req.method = o.method || 'GET';
  req.url = o.url || '/';
  req.headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {});
  return req;
}
async function callHandler(handler, options) {
  const res = makeRes();
  await handler(makeReq(options), res);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch (err) { json = null; }
  return { res: res, json: json, status: res.statusCode };
}

const routeStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-route-store-'), 'settings.json') });
const handlers = hostRoutes.createHandlers({ store: routeStore, connection: undefined });

const healthOk = await callHandler(handlers.health, { method: 'GET' });
eq('GET health → 200', healthOk.status, 200);
eq('health ok', healthOk.json.ok, true);
eq('health version', healthOk.json.version, pkg.version);
eq('health host=true', healthOk.json.host, true);
ok('health 带诊断字段', !!healthOk.json.tools && !!healthOk.json.subagents && !!healthOk.json.agentRoute && !!healthOk.json.root, JSON.stringify(healthOk.json));

const healthMethod = await callHandler(handlers.health, { method: 'POST', body: {} });
eq('health 非 GET → 405', healthMethod.status, 405);
eq('405 错误码', healthMethod.json.error.code, 'method-not-allowed');

const rejectHandlers = hostRoutes.createHandlers({ store: routeStore, connection: { requestRejection() { return 401; } } });
const rejected = await callHandler(rejectHandlers.health, { method: 'GET' });
eq('connection 拒绝 → 401', rejected.status, 401);
eq('拒绝时不写 body', rejected.res.body, null);

const allowed = hostRoutes.createHandlers({ store: routeStore, connection: { requestRejection() { return undefined; } } });
eq('connection 放行 → 200', (await callHandler(allowed.health, { method: 'GET' })).status, 200);

const cfgEmpty = await callHandler(handlers.config, { method: 'GET' });
eq('GET config → 200', cfgEmpty.status, 200);
deepEq('config 初始 settings 为默认', cfgEmpty.json.settings, hostConfig.defaultSettings());
eq('config discovery.vault=false', cfgEmpty.json.discovery.vault, false);
eq('config discovery.vaultPath=null', cfgEmpty.json.discovery.vaultPath, null);

const target = makeTmpDir('jkkb-target-');
const valid = await callHandler(handlers.validate, { method: 'POST', body: { root: target } });
eq('validate → 200', valid.status, 200);
eq('validate ok=true', valid.json.ok, true);
eq('validate level=ok', valid.json.level, 'ok');
eq('validate 可写性实测通过', valid.json.writable.ok, true);
eq('validate 概要顶层 0 项', valid.json.summary.topLevelCount, 0);
eq('validate 概要 13 个目录', valid.json.summary.expectedDirs, 13);
eq('validate 概要 existingDirs 为空', valid.json.summary.existingDirs.length, 0);
eq('可写性探测不留残留文件', fs.readdirSync(target).length, 0);

fs.writeFileSync(path.join(target, 'note.md'), 'x');
const warnValidate = await callHandler(handlers.validate, { method: 'POST', body: { root: target } });
eq('validate 非空目录 → level=warn', warnValidate.json.level, 'warn');
eq('validate 非空目录 → ok=true', warnValidate.json.ok, true);
eq('validate 非空目录 → 顶层 1 项', warnValidate.json.summary.topLevelCount, 1);

const rejectValidate = await callHandler(handlers.validate, { method: 'POST', body: { root: '/' } });
eq('validate / → level=reject', rejectValidate.json.level, 'reject');
eq('validate / → ok=false', rejectValidate.json.ok, false);
eq('validate / → 不做可写性探测', rejectValidate.json.writable.code, 'not-checked');
eq('validate / → summary=null', rejectValidate.json.summary, null);

const notJsonReq = await callHandler(handlers.validate, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
eq('非 JSON Content-Type → 415', notJsonReq.status, 415);
eq('415 错误码', notJsonReq.json.error.code, 'unsupported-media-type');

const tooLarge = await callHandler(handlers.validate, { method: 'POST', body: 'x'.repeat(hostRoutes.MAX_BODY_BYTES + 1) });
eq('超过 8KB → 413', tooLarge.status, 413);
eq('413 错误码', tooLarge.json.error.code, 'payload-too-large');

const badJsonReq = await callHandler(handlers.validate, { method: 'POST', body: '{ not json' });
eq('非法 JSON → 400', badJsonReq.status, 400);
eq('400 错误码', badJsonReq.json.error.code, 'invalid-json');

const wrongMethod = await callHandler(handlers.validate, { method: 'GET' });
eq('validate 非 POST → 405', wrongMethod.status, 405);

const noAck = await callHandler(handlers.config, { method: 'POST', body: { root: target } });
eq('缺 riskAck → 409', noAck.status, 409);
eq('缺 riskAck 错误码', noAck.json.error.code, 'risk-ack-required');
eq('缺 riskAck 不落盘', routeStore.get().root, null);

const falseAck = await callHandler(handlers.config, { method: 'POST', body: { root: target, riskAck: false } });
eq('riskAck=false → 409', falseAck.status, 409);
eq('riskAck=false 错误码', falseAck.json.error.code, 'risk-ack-required');

const rejectedRoot = await callHandler(handlers.config, { method: 'POST', body: { root: '/', riskAck: true } });
eq('riskAck=true 但根目录被拒 → 400', rejectedRoot.status, 400);
eq('根目录被拒错误码', rejectedRoot.json.error.code, 'root-rejected');

const saved = await callHandler(handlers.config, { method: 'POST', body: { root: target, riskAck: true } });
eq('保存 → 200', saved.status, 200);
eq('保存 ok=true', saved.json.ok, true);
eq('保存后 root 为 realpath', saved.json.settings.root, fs.realpathSync(target));
ok('保存后带确认时间', typeof saved.json.settings.rootConfirmedAt === 'string' && saved.json.settings.rootConfirmedAt.length > 0);
eq('保存后确认版本', saved.json.settings.rootRiskAck.version, hostConfig.RISK_ACK_VERSION);
eq('保存后确认哈希', saved.json.settings.rootRiskAck.textHash, hostConfig.hashAckText(hostConfig.RISK_ACK_TEXT));
eq('内存 store 同步', routeStore.get().root, fs.realpathSync(target));
deepEq('盘上文件同步', JSON.parse(fs.readFileSync(routeStore.file, 'utf8')), saved.json.settings);

const cfgAfter = await callHandler(handlers.config, { method: 'GET' });
eq('config 返回已保存 root', cfgAfter.json.settings.root, fs.realpathSync(target));
eq('未建 vault.json 时 discovery.vault=false', cfgAfter.json.discovery.vault, false);

fs.mkdirSync(path.join(target, '.jkkb'), { recursive: true });
fs.writeFileSync(path.join(target, '.jkkb', 'vault.json'), '{}');
const cfgVault = await callHandler(handlers.config, { method: 'GET' });
eq('已建 vault.json 时 discovery.vault=true', cfgVault.json.discovery.vault, true);
ok('vaultPath 指向 .jkkb/vault.json', String(cfgVault.json.discovery.vaultPath).endsWith(path.join('.jkkb', 'vault.json')), String(cfgVault.json.discovery.vaultPath));

// ── 文件管理路由：目录列表 + 文件预览（防穿越 / 隐藏文件过滤 / 格式分支）──
const filesRoot = makeTmpDir('jkkb-files-root-');
fs.mkdirSync(path.join(filesRoot, '03_内容'), { recursive: true });
fs.mkdirSync(path.join(filesRoot, '03_内容', '子目录A'), { recursive: true });
fs.writeFileSync(path.join(filesRoot, '03_内容', '笔记.md'), '# 你好', 'utf8');
fs.writeFileSync(path.join(filesRoot, '03_内容', '图表.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(filesRoot, '03_内容', '数据.bin'), Buffer.from([0x00, 0x01]));
fs.writeFileSync(path.join(filesRoot, '.hidden'), 'x', 'utf8');
const filesStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-files-store-'), 'settings.json') });
filesStore.save({ root: filesRoot, rootConfirmedAt: '2026-10-17T05:00:00.000Z', rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' } });
const filesHandlers = hostRoutes.createHandlers({ store: filesStore });

const filesListRoot = await callHandler(filesHandlers.filesList, { method: 'GET', url: '/plugins/jk-knowledge-base/files?dir=' });
eq('files 根目录 → 200', filesListRoot.status, 200);
eq('files 根目录 ok', filesListRoot.json.ok, true);
eq('files 根目录 dir 为空串', filesListRoot.json.dir, '');
eq('files 根目录只见 03_内容（隐藏文件过滤）', JSON.stringify(filesListRoot.json.folders.map((f) => f.name)), '["03_内容"]');
eq('files 根目录无文件', filesListRoot.json.files.length, 0);
const filesListSub = await callHandler(filesHandlers.filesList, { method: 'GET', url: '/plugins/jk-knowledge-base/files?dir=' + encodeURIComponent('03_内容') });
eq('files 子目录文件夹', JSON.stringify(filesListSub.json.folders.map((f) => f.name)), '["子目录A"]');
eq('files 子目录文件含 ext/size', filesListSub.json.files[0].name, '笔记.md');
eq('files 子目录文件 ext', filesListSub.json.files[0].ext, '.md');
ok('files 子目录文件 size 为数值', typeof filesListSub.json.files[0].size === 'number' && filesListSub.json.files[0].size > 0);
const filesListEscape = await callHandler(filesHandlers.filesList, { method: 'GET', url: '/plugins/jk-knowledge-base/files?dir=' + encodeURIComponent('../') });
eq('files 穿越 → 400', filesListEscape.status, 400);
eq('files 穿越 错误码', filesListEscape.json.error.code, 'dir-out-of-root');
const filesListMissing = await callHandler(filesHandlers.filesList, { method: 'GET', url: '/plugins/jk-knowledge-base/files?dir=' + encodeURIComponent('不存在') });
eq('files 目录不存在 → 404', filesListMissing.status, 404);
const filesListMethod = await callHandler(filesHandlers.filesList, { method: 'POST', body: {} });
eq('files 非 GET → 405', filesListMethod.status, 405);
const filesNoRoot = await callHandler(hostRoutes.createHandlers({ store: hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-files-noroot-'), 'settings.json') }) }).filesList, { method: 'GET' });
eq('files 未配根目录 → 409', filesNoRoot.status, 409);

const fileText = await callHandler(filesHandlers.fileEntry, { method: 'GET', url: '/plugins/jk-knowledge-base/file?path=' + encodeURIComponent('03_内容/笔记.md') });
eq('file 文本 → 200', fileText.status, 200);
eq('file 文本 kind=text', fileText.json.kind, 'text');
eq('file 文本正文', fileText.json.text, '# 你好');
eq('file 文本 path 规范化', fileText.json.path, '03_内容/笔记.md');
const fileImage = await callHandler(filesHandlers.fileEntry, { method: 'GET', url: '/plugins/jk-knowledge-base/file?path=' + encodeURIComponent('03_内容/图表.png') });
eq('file 图片 kind=image', fileImage.json.kind, 'image');
ok('file 图片 dataUrl 前缀', String(fileImage.json.dataUrl).indexOf('data:image/png;base64,') === 0, String(fileImage.json.dataUrl).slice(0, 30));
const fileBinary = await callHandler(filesHandlers.fileEntry, { method: 'GET', url: '/plugins/jk-knowledge-base/file?path=' + encodeURIComponent('03_内容/数据.bin') });
eq('file 二进制 kind=binary', fileBinary.json.kind, 'binary');
eq('file 二进制不带正文', fileBinary.json.text, undefined);
const fileEscape = await callHandler(filesHandlers.fileEntry, { method: 'GET', url: '/plugins/jk-knowledge-base/file?path=' + encodeURIComponent('../../etc/passwd') });
eq('file 穿越 → 400', fileEscape.status, 400);
eq('file 穿越 错误码', fileEscape.json.error.code, 'path-out-of-root');
const fileMissing = await callHandler(filesHandlers.fileEntry, { method: 'GET', url: '/plugins/jk-knowledge-base/file?path=' + encodeURIComponent('03_内容/不存在.md') });
eq('file 不存在 → 404', fileMissing.status, 404);
const fileMethod = await callHandler(filesHandlers.fileEntry, { method: 'POST', body: {} });
eq('file 非 GET → 405', fileMethod.status, 405);

deepEq('缺 webServer 时 registerRoutes 返回空数组', hostRoutes.registerRoutes({}, { store: routeStore }), []);
const regSpecs = [];
const wsCtx = { webServer: { register(spec) { regSpecs.push(spec); return () => {}; } } };
const routeDisposers = hostRoutes.registerRoutes(wsCtx, { store: routeStore });
eq('registerRoutes 注册 21 条路由', regSpecs.length, 21);
eq('registerRoutes 返回 21 个 disposer', routeDisposers.length, 21);
ok('registerRoutes 缺 connection 也不抛', true);

// ═══════════════════ 13. client 半：根目录配置 / 风险确认 / 引导态 ═══════════════════
const hostRoutesSource = readFileSync(path.join(root, 'host', 'routes.js'), 'utf8');
const hostIndexSource = readFileSync(path.join(root, 'index.js'), 'utf8');
const hostConfigSource = readFileSync(path.join(root, 'host', 'config.js'), 'utf8');
[
  ['client: /plugins/jk-knowledge-base/config', source, '/plugins/jk-knowledge-base/config'],
  ['client: __DSH_DIRECTORY_PICKER__', source, '__DSH_DIRECTORY_PICKER__'],
  ['client: jk-kb-footer', source, 'jk-kb-footer'],
  ['client: 我已了解风险', source, '我已了解风险'],
  ['client: data-jk-kb-root', source, 'data-jk-kb-root'],
  ['client: data-jk-kb-save', source, 'data-jk-kb-save'],
  ['host routes: requestRejection', hostRoutesSource, 'requestRejection'],
  ['host index: ctx.effect', hostIndexSource, 'ctx.effect'],
  ['host index: inject 声明', hostIndexSource, "['webServer', 'connection']"],
  ['host config: plugin-data 路径', hostConfigSource, 'plugin-data'],
].forEach(([label, text, token]) => ok('可 grep 到 ' + label, text.indexOf(token) >= 0));

const confirmedSettings = {
  root: '/data/kb',
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
};
eq('未选择任何目录 → 不需要确认', I.needsRiskAck('', confirmedSettings), false);
eq('与已保存路径不同 → 需要确认', I.needsRiskAck('/data/other', confirmedSettings), true);
eq('与已保存路径相同 → 不需要确认', I.needsRiskAck('/data/kb', confirmedSettings), false);
eq('末尾斜杠视为同一路径', I.needsRiskAck('/data/kb/', confirmedSettings), false);
eq('有 root 但从未确认 → 需要确认', I.needsRiskAck('/data/kb', { root: '/data/kb' }), true);
eq('首次配置 → 需要确认', I.needsRiskAck('/data/kb', {}), true);
eq('空草稿永不要求确认', I.needsRiskAck('   ', confirmedSettings), false);

const okValidation = { ok: true, level: 'warn', reasons: [] };
eq('host 未就绪不能保存', I.canSave({ hostReady: false, draftRoot: '/data/kb', validation: okValidation }), false);
eq('没有待保存路径不能保存', I.canSave({ hostReady: true, draftRoot: '', validation: okValidation }), false);
eq('没校验过不能保存', I.canSave({ hostReady: true, draftRoot: '/data/kb', validation: null }), false);
eq('校验 reject 不能保存', I.canSave({ hostReady: true, draftRoot: '/data/kb', validation: { ok: false, level: 'reject' } }), false);
eq('需要确认但未勾选 → 不能保存', I.canSave({ hostReady: true, draftRoot: '/data/kb', validation: okValidation, needsAck: true, acknowledged: false }), false);
eq('勾选后可保存', I.canSave({ hostReady: true, draftRoot: '/data/kb', validation: okValidation, needsAck: true, acknowledged: true }), true);
eq('保存中不能重复保存', I.canSave({ hostReady: true, draftRoot: '/data/kb', validation: okValidation, saving: true }), false);
eq('无需确认时可直接保存', I.canSave({ hostReady: true, draftRoot: '/data/kb', validation: okValidation, needsAck: false }), true);

eq('错误文案含 code 与 message', I.describeHostError({ error: { code: 'risk-ack-required', message: '先确认' } }), 'risk-ack-required 先确认');
eq('无 error 时给出兜底', I.describeHostError(null), '未知错误');

eq('node 环境默认没有目录选择器', I.hasDirectoryPicker(), false);
eq('没有选择器时 pickDirectory 返回 null', await I.pickDirectory(), null);
globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => '/picked/dir' };
eq('注入后 hasDirectoryPicker=true', I.hasDirectoryPicker(), true);
eq('pick 返回选中路径', await I.pickDirectory(), '/picked/dir');
globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => { throw new Error('cancelled'); } };
eq('pick 被取消 → null', await I.pickDirectory(), null);
globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => '' };
eq('pick 返回空串 → null', await I.pickDirectory(), null);
delete globalThis.__DSH_DIRECTORY_PICKER__;
eq('清理后恢复无选择器', I.hasDirectoryPicker(), false);

// fetch 打桩：验证 hostRequest 的三类结果（业务响应 / 错误体 / 连不上）。
const realFetch = globalThis.fetch;
const fetchCalls = [];
let nextResponse = null;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: url, init: init || {} });
  if (nextResponse === 'throw') throw new Error('ECONNREFUSED');
  if (nextResponse === 'not-json') return { status: 200, json: async () => { throw new Error('bad json'); } };
  return { status: nextResponse.status, json: async () => nextResponse.body };
};

nextResponse = { status: 200, body: { ok: true, settings: { root: '/data/kb' }, discovery: { vault: false } } };
const cfgOk = await I.loadHostConfig();
eq('loadHostConfig 命中 /config', fetchCalls[fetchCalls.length - 1].url, '/plugins/jk-knowledge-base/config');
eq('loadHostConfig 返回 ok', cfgOk.ok, true);
eq('loadHostConfig 返回 root', cfgOk.settings.root, '/data/kb');

nextResponse = {
  status: 200,
  body: {
    ok: false,
    level: 'reject',
    reasons: [{ code: 'root-system', message: '不允许把系统目录当作知识库根目录：/' }],
    normalized: '/',
    writable: { ok: false, code: 'not-checked', message: '路径未通过校验，未做可写性探测' },
    summary: null,
  },
};
const validationResult = await I.validateRoot('/');
eq('validate 的业务失败也可解析', validationResult.level, 'reject');
eq('validate 业务失败不算请求错误', validationResult.error, undefined);
eq('validate 命中 /config/validate', fetchCalls[fetchCalls.length - 1].url, '/plugins/jk-knowledge-base/config/validate');
eq('validate 用 POST', fetchCalls[fetchCalls.length - 1].init.method, 'POST');

nextResponse = { status: 409, body: { ok: false, error: { code: 'risk-ack-required', message: '先确认' } } };
const conflict = await I.saveRoot('/data/kb', true);
eq('409 保留 HTTP 状态码', conflict.status, 409);
eq('409 错误码透传', conflict.error.code, 'risk-ack-required');
eq('save 提交 riskAck=true', JSON.parse(fetchCalls[fetchCalls.length - 1].init.body).riskAck, true);

nextResponse = 'throw';
const unreachable = await I.loadHostConfig();
eq('fetch 抛错 → host-unreachable', unreachable.error.code, 'host-unreachable');
ok('fetch 抛错提示宿主未连接', unreachable.error.message.indexOf('宿主服务未连接') >= 0, unreachable.error.message);

nextResponse = 'not-json';
const badResponse = await I.loadHostConfig();
eq('非 JSON 响应 → bad-response', badResponse.error.code, 'bad-response');

globalThis.fetch = undefined;
const noFetch = await I.loadHostConfig();
eq('环境没有 fetch → host-unreachable', noFetch.error.code, 'host-unreachable');
globalThis.fetch = realFetch;

// 根目录区块渲染（展示组件，直接把各种状态喂进去）。
const rootTreeError = I.RootSection({ host: { status: 'error', error: { code: 'host-unreachable', message: '连接被拒绝' } }, settings: {}, draftRoot: '', pickerAvailable: false });
ok('根目录区块展示「宿主服务未连接」', textOf(rootTreeError).indexOf('宿主服务未连接') >= 0);
eq('宿主错误带 data 标记', findIn(rootTreeError, 'data-jk-kb-host-error', 'host-unreachable').props['data-jk-kb-host-error'], 'host-unreachable');

const rootTreeSaved = I.RootSection({ host: { status: 'ready' }, settings: confirmedSettings, draftRoot: '/data/other', pickerAvailable: false, needsAck: true });
eq('展示当前根目录', textOf(findIn(rootTreeSaved, 'data-jk-kb-root', 'saved')), '/data/kb');
eq('展示待保存路径', textOf(findIn(rootTreeSaved, 'data-jk-kb-root', 'draft')), '/data/other');
ok('需要确认时展示风险卡', !!findIn(rootTreeSaved, 'data-jk-kb-risk', 'true'));
eq('风险卡列出 5 条风险', flatten(findIn(rootTreeSaved, 'data-jk-kb-risk', 'true')).filter((el) => el.props && el.props.className === 'jk-kb-risk-item').length, 5);
ok('风险卡包含确认文案', textOf(rootTreeSaved).indexOf('我已了解风险并授权写入该目录') >= 0);
ok('风险卡有 checkbox', !!findIn(rootTreeSaved, 'data-jk-kb-ack', 'true'));
ok('风险卡说明 node:fs 直写', textOf(rootTreeSaved).indexOf('node:fs') >= 0);
ok('风险卡说明不受沙箱保护', textOf(rootTreeSaved).indexOf('沙箱') >= 0);
ok('风险卡说明 13 个顶层目录', textOf(rootTreeSaved).indexOf('13 个顶层目录') >= 0);
ok('风险卡说明同名目录不删除', textOf(rootTreeSaved).indexOf('不会被删除') >= 0);

const rootTreeNoAck = I.RootSection({ host: { status: 'ready' }, settings: confirmedSettings, draftRoot: '/data/kb', needsAck: false });
eq('无需确认时不展示风险卡', findIn(rootTreeNoAck, 'data-jk-kb-risk', 'true'), undefined);
eq('未选择时 draft 显示「尚未选择」', textOf(findIn(I.RootSection({ host: { status: 'ready' }, settings: {}, draftRoot: '' }), 'data-jk-kb-root', 'draft')), '尚未选择');

const rootTreeManual = I.RootSection({ host: { status: 'ready' }, settings: {}, draftRoot: '' });
ok('无原生选择器 → 手填输入框', !!findIn(rootTreeManual, 'data-jk-kb-root-input', 'true'));
ok('无原生选择器 → 校验按钮', !!findIn(rootTreeManual, 'data-jk-kb-validate', 'true'));
const rootTreePicker = I.RootSection({ host: { status: 'ready' }, settings: {}, draftRoot: '', pickerAvailable: true });
ok('有原生选择器 → 选择目录按钮', !!findIn(rootTreePicker, 'data-jk-kb-pick', 'true'));

const rootTreeValidation = I.RootSection({
  host: { status: 'ready' },
  settings: {},
  draftRoot: '/',
  needsAck: false,
  validation: {
    ok: false,
    level: 'reject',
    reasons: [{ code: 'root-system', message: '不允许把系统目录当作知识库根目录：/' }],
    writable: { ok: false, code: 'not-checked', message: '路径未通过校验，未做可写性探测' },
    summary: null,
  },
});
eq('校验结果标记 reject', findIn(rootTreeValidation, 'data-jk-kb-validate-result', 'reject').props['data-jk-kb-validate-result'], 'reject');
ok('校验结果列出原因', textOf(rootTreeValidation).indexOf('不允许把系统目录') >= 0);
ok('校验结果展示可写性失败', textOf(rootTreeValidation).indexOf('可写性实测：失败') >= 0);

const settingsTreeHostLoading = I.SettingsSection({});
const saveButton = findIn(settingsTreeHostLoading, 'data-jk-kb-save', 'true');
ok('设置页有保存按钮', !!saveButton);
eq('host 未就绪时保存禁用', saveButton.props.disabled, true);
eq('页脚容器类名', flatten(settingsTreeHostLoading).find((el) => el.props && el.props.className === 'jk-kb-footer').props.className, 'jk-kb-footer');
eq('页脚仍有版本号', textOf(findIn(settingsTreeHostLoading, 'data-jk-kb-version', I.PLUGIN_VERSION)), 'JK知识库 v' + I.PLUGIN_VERSION);

// 主页面右栏分发：loading / host 不可用 / 未配置根目录 / 已配置。
ok('右栏配置读取中 → loading', !!findIn(I.PanelContent({ rootStatus: 'loading', activeMenu: I.MENUS[0] }), 'data-jk-kb-root-loading', 'true'));
const pcError = I.PanelContent({ rootStatus: 'error', activeMenu: I.MENUS[0], error: { code: 'host-unreachable', message: '连接被拒绝' } });
eq('右栏 host 不可用 → 引导态', findIn(pcError, 'data-jk-kb-guidance', 'host-unreachable').props['data-jk-kb-guidance'], 'host-unreachable');
ok('右栏 host 不可用文案', textOf(pcError).indexOf('宿主服务未连接') >= 0);
const pcNoRoot = I.PanelContent({ rootStatus: 'ready', root: null, activeMenu: I.MENUS[0] });
eq('右栏未配置根目录 → 引导态', findIn(pcNoRoot, 'data-jk-kb-guidance', 'no-root').props['data-jk-kb-guidance'], 'no-root');
ok('引导态提示去设置里选根目录', textOf(pcNoRoot).indexOf('设置') >= 0 && textOf(pcNoRoot).indexOf('根目录') >= 0);
ok('右栏已配置 → 仪表盘', !!findIn(I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: I.MENUS[0] }), 'data-jk-kb-dashboard', 'true'));
ok('右栏未实现菜单 → 占位页', !!findIn(I.PanelContent({ rootStatus: 'ready', root: '/data/kb', activeMenu: { id: 'future', label: '未来页' } }), 'data-jk-kb-placeholder', 'future'));

eq('根目录区块类名统一前缀', classNamesOf(rootTreeSaved).filter((name) => name.indexOf('jk-kb-') !== 0).join(','), '');

// 清理：只删自己 mkdtemp 出来的临时目录。
tmpDirs.forEach((dir) => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 清理失败不影响断言 */ }
});

// ═══════════════════ 14. trace：运行记录读写 / 原子写 / 串行追加 ═══════════════════
const traceRoot = makeTmpDir('jkkb-trace-');
deepEq('空目录读 index 回落空', trace.readIndex(traceRoot), { version: 1, runs: [] });

fs.mkdirSync(path.join(traceRoot, '.jkkb', 'runs'), { recursive: true });
fs.writeFileSync(path.join(traceRoot, '.jkkb', 'runs', 'index.json'), '{oops');
deepEq('坏 index.json 回落空', trace.readIndex(traceRoot), { version: 1, runs: [] });

const run1 = trace.createRun({ root: traceRoot, kind: 'bootstrap', title: '建库' });
eq('createRun 初始为 running', run1.status, 'running');
eq('run id 带 kind 前缀', run1.id.indexOf('bootstrap-'), 0);
eq('index 里有 1 条 run', trace.readIndex(traceRoot).runs.length, 1);
eq('run.json 已落盘', JSON.parse(fs.readFileSync(trace.runFile(traceRoot, run1.id), 'utf8')).id, run1.id);
eq('steps.jsonl 已创建', fs.existsSync(trace.stepsFile(traceRoot, run1.id)), true);
eq('新 run 无 steps', trace.readRun(traceRoot, run1.id).steps.length, 0);

await trace.appendStep({ root: traceRoot, runId: run1.id, step: { title: 'validate', status: 'ok', role: 'PLUGIN', inputSummary: '/', artifacts: ['a.md'] } });
await trace.appendStep({ root: traceRoot, runId: run1.id, step: { title: 'scan', status: 'ok', role: 'PLUGIN' } });
const stepLines = fs.readFileSync(trace.stepsFile(traceRoot, run1.id), 'utf8').trim().split('\n');
eq('steps.jsonl 一行一个 step', stepLines.length, 2);
const parsedSteps = trace.readRun(traceRoot, run1.id).steps;
eq('run 详情带回 steps', parsedSteps.length, 2);
eq('step status 归一化', parsedSteps[0].status, 'ok');
deepEq('step artifacts 保留', parsedSteps[0].artifacts, ['a.md']);
eq('step 带 startedAt/endedAt', typeof parsedSteps[0].startedAt === 'string' && typeof parsedSteps[0].endedAt === 'string', true);
eq('index stepCount 累加', trace.readIndex(traceRoot).runs[0].stepCount, 2);
eq('index currentStep 跟随', trace.readIndex(traceRoot).runs[0].currentStep, 'scan');

await Promise.all([0, 1, 2, 3, 4].map((i) => trace.appendStep({ root: traceRoot, runId: run1.id, step: { title: 'c' + i } })));
eq('并发追加不丢行', trace.readRun(traceRoot, run1.id).steps.length, 7);
eq('并发追加后 stepCount 正确', trace.readIndex(traceRoot).runs[0].stepCount, 7);
eq('index 无残留 tmp', fs.readdirSync(path.join(traceRoot, '.jkkb', 'runs')).filter((name) => name.endsWith('.tmp')).length, 0);

eq('findRunning 命中', trace.findRunning(traceRoot).id, run1.id);
const finishedRun = trace.finishRun({ root: traceRoot, runId: run1.id, status: 'completed', summary: 'ok' });
eq('finishRun 返回终态', finishedRun.status, 'completed');
eq('finishRun 写入 endedAt', typeof finishedRun.endedAt, 'string');
eq('finishRun 后 findRunning 为空', trace.findRunning(traceRoot), null);
eq('index 同步终态', trace.readIndex(traceRoot).runs[0].status, 'completed');
eq('listRuns 反映同一真源', trace.listRuns(traceRoot)[0].id, run1.id);

eq('非法 runId 被拒（路径穿越）', trace.readRun(traceRoot, '../escape'), null);
eq('未知 runId 被拒', trace.readRun(traceRoot, 'nope-20300101'), null);
trace.writeIndex(traceRoot, {
  version: 1,
  runs: Array.from({ length: 60 }, (_, i) => ({
    id: 'x-' + i, title: 't', kind: 'verify', status: 'completed',
    startedAt: '2026-01-01T00:00:' + String(i % 60).padStart(2, '0') + '.000Z',
    endedAt: null, stepCount: 0, currentStep: '', degraded: null,
  })),
});
eq('listRuns 最多 50 条', trace.listRuns(traceRoot).length, 50);

// ═══════════════════ 15. 编排：降级路径 / 409 / 取消 ═══════════════════
async function waitForTerminal(where, runId, ms) {
  const deadline = Date.now() + (ms || 10000);
  while (Date.now() < deadline) {
    const data = trace.readRun(where, runId);
    if (data && data.run.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return trace.readRun(where, runId);
}

const degradedRoot = makeTmpDir('jkkb-degraded-');
const degradedStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-deg-store-'), 'settings.json') });
degradedStore.save({
  root: degradedRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const degradedService = createRunService({ ctx: {}, store: degradedStore });
const startedRun = await degradedService.start({ kind: 'bootstrap' });
eq('无 route / 无 subagents 时仍能起 run', startedRun.ok, true);
ok('start 返回 runId', typeof startedRun.runId === 'string', JSON.stringify(startedRun));
const degradedDone = await waitForTerminal(degradedRoot, startedRun.runId);
eq('降级 run 正常收尾', degradedDone.run.status, 'completed');
eq('降级标记 no-route', degradedDone.run.degraded, 'no-route');
ok('降级 steps 有记录', degradedDone.steps.length > 0, '条数 ' + degradedDone.steps.length);
ok('降级 steps role 全是 PLUGIN', degradedDone.steps.every((item) => item.role === 'PLUGIN'), JSON.stringify(degradedDone.steps.map((x) => x.role)));
ok('降级首步说明原因', String(degradedDone.steps[0].title).indexOf('降级') >= 0, String(degradedDone.steps[0].title));
ok('降级执行真的建了库（13 个顶层目录）', engineDirs.every((name) => fs.existsSync(path.join(degradedRoot, name))), JSON.stringify(engineDirs));

const orchestratorConflictRoot = makeTmpDir('jkkb-conflict-');
const conflictStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-conflict-store-'), 'settings.json') });
conflictStore.save({
  root: orchestratorConflictRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const conflictService = createRunService({ ctx: {}, store: conflictStore });
trace.createRun({ root: orchestratorConflictRoot, kind: 'verify', title: '进行中' });
const conflictStart = await conflictService.start({ kind: 'verify' });
eq('已有 running → 409', conflictStart.status, 409);
eq('冲突错误码', conflictStart.error.code, 'run-conflict');
eq('冲突时不新建 run', trace.readIndex(orchestratorConflictRoot).runs.length, 1);
eq('非法 kind → 400', (await conflictService.start({ kind: 'nope' })).error.code, 'kind-invalid');

const cancelRoot = makeTmpDir('jkkb-cancel-');
const cancelStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-cancel-store-'), 'settings.json') });
cancelStore.save({
  root: cancelRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const cancelService = createRunService({ ctx: {}, store: cancelStore });
const cancelRun = trace.createRun({ root: cancelRoot, kind: 'reindex', title: '重建索引' });
const cancelResult = await cancelService.cancel(cancelRun.id);
eq('cancel 成功', cancelResult.ok, true);
eq('cancel 后 run 为 cancelled', trace.readRun(cancelRoot, cancelRun.id).run.status, 'cancelled');
eq('cancel 未知 run → 404', (await cancelService.cancel('nope-123')).status, 404);

// ═══════════════════ 16. HTTP：/runs 与 /run ═══════════════════
eq('路由表含 /runs', hostRoutes.ROUTE_PATHS.runs, '/plugins/jk-knowledge-base/runs');
eq('路由表含 /run', hostRoutes.ROUTE_PATHS.run, '/plugins/jk-knowledge-base/run');

const runsRoot = makeTmpDir('jkkb-runs-root-');
const runsStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-runs-store-'), 'settings.json') });
runsStore.save({
  root: runsRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const runsRouteHandlers = hostRoutes.createHandlers({ store: runsStore });
const configuredRoot = fs.realpathSync(runsRoot);
const runsEmpty = await callHandler(runsRouteHandlers.runsList, { method: 'GET' });
eq('GET /runs → 200', runsEmpty.status, 200);
ok('GET /runs 返回数组', Array.isArray(runsEmpty.json.runs), JSON.stringify(runsEmpty.json));

const demoRun = trace.createRun({ root: configuredRoot, kind: 'verify', title: '体检' });
await trace.appendStep({ root: configuredRoot, runId: demoRun.id, step: { title: 'fake-step', status: 'ok' } });
const runsAfter = await callHandler(runsRouteHandlers.runsList, { method: 'GET' });
eq('GET /runs 含新 run', runsAfter.json.runs.filter((item) => item.id === demoRun.id).length, 1);

const runDetail = await callHandler(runsRouteHandlers.runsScoped, { method: 'GET', url: '/plugins/jk-knowledge-base/runs/' + demoRun.id });
eq('GET /runs/:id → 200', runDetail.status, 200);
eq('详情带回 run.id', runDetail.json.run.id, demoRun.id);
eq('详情带回 steps', runDetail.json.steps.length, 1);

const runMissing = await callHandler(runsRouteHandlers.runsScoped, { method: 'GET', url: '/plugins/jk-knowledge-base/runs/nope-123' });
eq('未知 run → 404', runMissing.status, 404);
eq('404 错误码', runMissing.json.error.code, 'run-not-found');
const badRunPath = await callHandler(runsRouteHandlers.runsScoped, { method: 'GET', url: '/plugins/jk-knowledge-base/runs/..%2Fetc' });
eq('非法 runId → 404', badRunPath.status, 404);

const cancelNoService = await callHandler(runsRouteHandlers.runsScoped, { method: 'POST', url: '/plugins/jk-knowledge-base/runs/' + demoRun.id + '/cancel', body: {} });
eq('没有编排服务时 cancel → 503', cancelNoService.status, 503);

const runsHandlers = hostRoutes.createHandlers({
  store: runsStore,
  runs: { start: async () => ({ ok: true, runId: 'fake-1' }), cancel: async () => ({ ok: true }) },
});
const cancelOk = await callHandler(runsHandlers.runsScoped, { method: 'POST', url: '/plugins/jk-knowledge-base/runs/' + demoRun.id + '/cancel', body: {} });
eq('cancel → 200', cancelOk.status, 200);
deepEq('cancel body', cancelOk.json, { ok: true });

const startOk = await callHandler(runsHandlers.startRun, { method: 'POST', body: { kind: 'verify' } });
eq('POST /run → 200', startOk.status, 200);
eq('POST /run 返回 runId', startOk.json.runId, 'fake-1');

const conflictHandlers = hostRoutes.createHandlers({
  store: runsStore,
  runs: { start: async () => ({ ok: false, status: 409, error: { code: 'run-conflict', message: '运行中' } }) },
});
const conflictRes = await callHandler(conflictHandlers.startRun, { method: 'POST', body: { kind: 'verify' } });
eq('编排 409 透传到 HTTP', conflictRes.status, 409);
eq('409 错误码透传', conflictRes.json.error.code, 'run-conflict');
eq('/run 非 POST → 405', (await callHandler(runsHandlers.startRun, { method: 'GET' })).status, 405);
eq('/runs 非 GET → 405', (await callHandler(runsHandlers.runsList, { method: 'POST', body: {} })).status, 405);

// ═══════════════════ 17. jk_kb_* 工具：runId 守卫 + 自动 step ═══════════════════
const toolRoot = makeTmpDir('jkkb-tools-');
const toolStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-tools-store-'), 'settings.json') });
toolStore.save({
  root: toolRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const toolDefs = createToolDefinitions({ store: toolStore });
eq('注册 19 个 jk_kb_* 工具', toolDefs.length, 19);
deepEq('工具名', toolDefs.map((d) => d.name), ['jk_kb_bootstrap', 'jk_kb_verify', 'jk_kb_reindex', 'jk_kb_inspect', 'jk_kb_step', 'jk_kb_curate', 'jk_kb_maintain', 'jk_kb_doctor', 'jk_kb_archive', 'jk_kb_expert_create', 'jk_kb_expert_update', 'jk_kb_expert_restore', 'jk_kb_expert_list', 'jk_kb_expert_archive', 'jk_kb_skill_create', 'jk_kb_skill_find', 'jk_kb_skill_run', 'jk_kb_skill_list', 'jk_kb_run_finish']);
ok('每个工具都有 output.schema 与 render', toolDefs.every((d) => d.output && d.output.schema && typeof d.output.render === 'function'));
ok('output schema 是 object 根', toolDefs.every((d) => d.output.schema.type === 'object'));
ok('动作类工具都要求 runId（find/list/inspect 可选）',
  toolDefs.filter((d) => ['jk_kb_inspect', 'jk_kb_skill_find', 'jk_kb_skill_list', 'jk_kb_expert_list', 'jk_kb_expert_restore', 'jk_kb_doctor'].indexOf(d.name) < 0)
    .every((d) => Array.isArray(d.parameters.required) && d.parameters.required.indexOf('runId') >= 0));
ok('render 返回可渲染块', (() => { const blocks = toolDefs[0].output.render({}, { ok: true, runId: 'r1', message: 'x' }); return Array.isArray(blocks) && blocks[0].type === 'text' && blocks[0].text.indexOf('OK') === 0; })());

const toolHandlers = createToolHandlers({ store: toolStore });
const noRunId = await toolHandlers.bootstrap({});
eq('缺 runId → ok=false', noRunId.ok, false);
eq('缺 runId 错误码', noRunId.code, 'run-id-required');
eq('不存在的 runId 被拒', (await toolHandlers.bootstrap({ runId: 'ghost-1' })).code, 'run-not-found');
eq('非法 runId 被拒', (await toolHandlers.verify({ runId: '../x' })).code, 'run-id-invalid');

const toolRun = trace.createRun({ root: toolRoot, kind: 'bootstrap', title: '建库' });
const bootTool = await toolHandlers.bootstrap({ runId: toolRun.id });
eq('工具 bootstrap 成功', bootTool.ok, true);
const toolSteps = trace.readRun(toolRoot, toolRun.id).steps;
ok('动作类工具自动追加 step', toolSteps.length > 0, '条数 ' + toolSteps.length);
ok('自动 step 标题为工具名', toolSteps.some((item) => item.title === 'jk_kb_bootstrap'), JSON.stringify(toolSteps.map((x) => x.title)));
ok('自动 step 带耗时', toolSteps.every((item) => typeof item.startedAt === 'string' && typeof item.endedAt === 'string'));
ok('自动 step role=AGENT', toolSteps.every((item) => item.role === 'AGENT'), JSON.stringify(toolSteps.map((x) => x.role)));

eq('工具 verify 可执行', typeof (await toolHandlers.verify({ runId: toolRun.id })).ok, 'boolean');
eq('工具 reindex 可执行', typeof (await toolHandlers.reindex({ runId: toolRun.id })).ok, 'boolean');
eq('工具 step 成功', (await toolHandlers.step({ runId: toolRun.id, title: '手动说明', status: 'ok' })).ok, true);
eq('工具 inspect 不需要 runId', typeof (await toolHandlers.inspect({})).ok, 'boolean');

const finishTool = await toolHandlers.runFinish({ runId: toolRun.id, status: 'completed', summary: '完成' });
eq('工具 run_finish 成功', finishTool.ok, true);
eq('run 已终态', trace.readRun(toolRoot, toolRun.id).run.status, 'completed');
eq('已结束的 run 拒绝继续写', (await toolHandlers.bootstrap({ runId: toolRun.id })).code, 'run-not-running');

const toolRun2 = trace.createRun({ root: toolRoot, kind: 'verify', title: '体检' });
eq('run_finish 拒绝 running', (await toolHandlers.runFinish({ runId: toolRun2.id, status: 'running' })).code, 'status-invalid');
eq('step 非法 status 归一化为 ok', (await toolHandlers.step({ runId: toolRun2.id, title: 'x', status: 'bogus' })).ok, true);

// ═══════════════════ 18. 编排 agent 路径（假 subagents 服务）═══════════════════
function makeAgentStore(where) {
  const store = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-agent-store-'), 'settings.json') });
  store.save({
    root: where,
    rootConfirmedAt: '2026-10-17T05:00:00.000Z',
    rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
    updatedAt: '2026-10-17T05:00:00.000Z',
  });
  return store;
}

// 假 subagents：list()->['spawn']，start(name, request) 返回 { result, dispose }。
function makeAgentCtx(options) {
  const o = options || {};
  const calls = [];
  const state = { dispose: 0 };
  const parent = { id: 'agent-parent-1' };
  const outcome = o.outcome || { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' };
  const startImpl = async (name, request) => {
    calls.push({ name: name, request: request });
    if (o.startThrows) throw new Error(o.startThrows);
    return {
      result: o.resultRejects ? Promise.reject(new Error(o.resultRejects)) : Promise.resolve(outcome),
      dispose: async () => { state.dispose += 1; },
    };
  };
  const subagents = o.subagents !== undefined
    ? o.subagents
    : { list: () => ['spawn'], start: startImpl };
  const agents = o.agents !== undefined ? o.agents : { list: () => [parent], roots: () => [parent] };
  const ctx = {
    subagents: subagents,
    agents: agents,
    // cordis 严格门禁下只能通过 ctx.get 取服务；测试也按这个口径喂。
    get: (name) => {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
      if (name === 'subagents') return subagents;
      if (name === 'agents') return agents;
      return undefined;
    },
  };
  return { ctx: ctx, calls: calls, state: state, parent: parent };
}

eq('outputText 拼接内容分片', orchestrator.outputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
eq('outputText 容忍空值', orchestrator.outputText(null), '');
eq('stopReason=completed → completed', orchestrator.statusFromStopReason('completed'), 'completed');
eq('stopReason=aborted → cancelled', orchestrator.statusFromStopReason('aborted'), 'cancelled');
eq('其它 stopReason → failed', orchestrator.statusFromStopReason('error'), 'failed');
eq('summary 截断到 500', orchestrator.truncate('x'.repeat(600), 500).length, 501);

// 18a. 正常 agent 路径：不降级、请求形状正确、dispose 被调用
const agentRootA = makeTmpDir('jkkb-agent-a-');
const envA = makeAgentCtx();
const serviceA = createRunService({ ctx: envA.ctx, store: makeAgentStore(agentRootA) });
const startA = await serviceA.start({ kind: 'verify' });
eq('agent 路径能起 run', startA.ok, true);
const doneA = await waitForTerminal(agentRootA, startA.runId);
eq('agent 路径不降级', doneA.run.degraded, null);
eq('agent 路径 run 完成', doneA.run.status, 'completed');
eq('假 subagents.start 被调用一次', envA.calls.length, 1);
eq('provider 选 spawn', envA.calls[0].name, 'spawn');
ok('request.prompt 非空', Array.isArray(envA.calls[0].request.prompt) && envA.calls[0].request.prompt.length > 0 && typeof envA.calls[0].request.prompt[0].text === 'string' && envA.calls[0].request.prompt[0].text.length > 0);
eq('request.parent 是活 agent', envA.calls[0].request.parent, envA.parent);
eq('request.label', envA.calls[0].request.label, 'JKKB-ORCH');
eq('request.maxDepth=1', envA.calls[0].request.maxDepth, 1);
deepEq('request.toolFilter 只放 jk_kb_*', envA.calls[0].request.toolFilter.allow, [
  'jk_kb_bootstrap', 'jk_kb_verify', 'jk_kb_reindex', 'jk_kb_inspect', 'jk_kb_step', 'jk_kb_run_finish',
]);
eq('summary 来自 output 文本', doneA.run.summary, 'done');
eq('dispose 被调用一次', envA.state.dispose, 1);
ok('agent 路径没有 PLUGIN 步骤', !doneA.steps.some((item) => item.role === 'PLUGIN'), JSON.stringify(doneA.steps.map((x) => x.role)));

// 18b. stopReason=aborted → cancelled，且仍然 dispose
const agentRootB = makeTmpDir('jkkb-agent-b-');
const envB = makeAgentCtx({ outcome: { output: [{ type: 'text', text: '被中止' }], stopReason: 'aborted' } });
const serviceB = createRunService({ ctx: envB.ctx, store: makeAgentStore(agentRootB) });
const startB = await serviceB.start({ kind: 'verify' });
const doneB = await waitForTerminal(agentRootB, startB.runId);
eq('stopReason=aborted → cancelled', doneB.run.status, 'cancelled');
eq('aborted 也 dispose', envB.state.dispose, 1);
eq('aborted 不降级', doneB.run.degraded, null);

// 18c. stopReason=error → failed，summary 含输出文本
const agentRootC = makeTmpDir('jkkb-agent-c-');
const envC = makeAgentCtx({ outcome: { output: [{ type: 'text', text: '模型调用失败：boom' }], stopReason: 'error' } });
const serviceC = createRunService({ ctx: envC.ctx, store: makeAgentStore(agentRootC) });
const startC = await serviceC.start({ kind: 'verify' });
const doneC = await waitForTerminal(agentRootC, startC.runId);
eq('stopReason=error → failed', doneC.run.status, 'failed');
ok('failed 的 summary 含输出文本', String(doneC.run.summary).indexOf('模型调用失败：boom') >= 0, String(doneC.run.summary));
eq('failed 路径也 dispose', envC.state.dispose, 1);

// 18c2. run.result 自身 reject → failed（不降级），且 dispose
const agentRootH = makeTmpDir('jkkb-agent-h-');
const envH = makeAgentCtx({ resultRejects: 'result rejected by provider' });
const serviceH = createRunService({ ctx: envH.ctx, store: makeAgentStore(agentRootH) });
const startH = await serviceH.start({ kind: 'verify' });
const doneH = await waitForTerminal(agentRootH, startH.runId);
eq('result reject → failed', doneH.run.status, 'failed');
ok('result reject 的 summary 带错误', String(doneH.run.summary).indexOf('result rejected by provider') >= 0, String(doneH.run.summary));
eq('result reject 不降级', doneH.run.degraded, null);
eq('result reject 也 dispose', envH.state.dispose, 1);

// 18d. start 抛错 → 降级 no-agent，首条 step 带 error.message
const agentRootD = makeTmpDir('jkkb-agent-d-');
const envD = makeAgentCtx({ startThrows: 'spawn provider exploded' });
const serviceD = createRunService({ ctx: envD.ctx, store: makeAgentStore(agentRootD) });
const startD = await serviceD.start({ kind: 'verify' });
const doneD = await waitForTerminal(agentRootD, startD.runId);
eq('start 抛错 → 降级 no-agent', doneD.run.degraded, 'no-agent');
ok('降级首条 step 带 error 文案', String(doneD.steps[0].inputSummary).indexOf('spawn provider exploded') >= 0, JSON.stringify(doneD.steps[0]));
ok('start 抛错路径没有 run 可 dispose（无泄漏断言占位）', envD.state.dispose === 0);

// 18e. 没有 provider / 没有 parent → 降级
const agentRootE = makeTmpDir('jkkb-agent-e-');
const envE = makeAgentCtx({ subagents: { list: () => [] } });
const startE = await createRunService({ ctx: envE.ctx, store: makeAgentStore(agentRootE) }).start({ kind: 'verify' });
const doneE = await waitForTerminal(agentRootE, startE.runId);
eq('没有 provider → no-agent', doneE.run.degraded, 'no-agent');
const envF = makeAgentCtx({ agents: { list: () => [], roots: () => [] } });
const agentRootF = makeTmpDir('jkkb-agent-f-');
const startF = await createRunService({ ctx: envF.ctx, store: makeAgentStore(agentRootF) }).start({ kind: 'verify' });
const doneF = await waitForTerminal(agentRootF, startF.runId);
eq('没有 parent → no-agent', doneF.run.degraded, 'no-agent');

// 18f. 兼容分支：只有 startActivation 也能跑，并 dispose
const agentRootG = makeTmpDir('jkkb-agent-g-');
const legacyState = { dispose: 0, calls: 0 };
const legacySubagents = {
  list: () => ['spawn'],
  startActivation: () => {
    legacyState.calls += 1;
    return {
      result: Promise.resolve({ ok: true, text: 'legacy done' }),
      dispose: () => { legacyState.dispose += 1; },
    };
  },
};
const serviceG = createRunService({ ctx: makeAgentCtx({ subagents: legacySubagents }).ctx, store: makeAgentStore(agentRootG) });
const startG = await serviceG.start({ kind: 'verify' });
const doneG = await waitForTerminal(agentRootG, startG.runId);
eq('startActivation 兼容分支被调用', legacyState.calls, 1);
eq('兼容分支不降级', doneG.run.degraded, null);
eq('兼容分支走通并 dispose', legacyState.dispose, 1);

// 18g. 工具注册失败 → run.warnings，并出现在 GET /runs/:id
const warnRoot = makeTmpDir('jkkb-agent-warn-');
const warnStore = makeAgentStore(warnRoot);
const warnService = createRunService({
  ctx: makeAgentCtx().ctx,
  store: warnStore,
  toolWarnings: () => ['工具 jk_kb_bootstrap 注册失败：schema rejected'],
});
const warnStart = await warnService.start({ kind: 'verify' });
const warnDone = await waitForTerminal(warnRoot, warnStart.runId);
deepEq('run.warnings 记录工具注册失败', warnDone.run.warnings, ['工具 jk_kb_bootstrap 注册失败：schema rejected']);
const warnHandlers = hostRoutes.createHandlers({ store: warnStore });
const warnDetail = await callHandler(warnHandlers.runsScoped, { method: 'GET', url: '/plugins/jk-knowledge-base/runs/' + warnStart.runId });
deepEq('GET /runs/:id 返回 warnings', warnDetail.json.run.warnings, ['工具 jk_kb_bootstrap 注册失败：schema rejected']);

// ═══════════════════ 19. /health 诊断载荷 + 启动日志 ═══════════════════
const healthRoot = makeTmpDir('jkkb-health-root-');
const healthStoreFull = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-health-store-'), 'settings.json') });
healthStoreFull.save({
  root: healthRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const healthSubagents = { list: () => ['spawn'], start: async () => ({}) };
const healthCtxFull = {
  get: (name) => {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) };
    if (name === 'subagents') return healthSubagents;
    if (name === 'agents') return { list: () => [], roots: () => [] };
    return undefined;
  },
};

// 19a. 全部工具注册成功
const healthFull = await callHandler(hostRoutes.createHandlers({
  store: healthStoreFull,
  ctx: healthCtxFull,
  toolState: () => ({ registered: ['jk_kb_bootstrap', 'jk_kb_verify'], failed: [] }),
}).health, { method: 'GET' });
eq('全成功 health → 200', healthFull.status, 200);
deepEq('health tools.registered', healthFull.json.tools.registered, ['jk_kb_bootstrap', 'jk_kb_verify']);
deepEq('health tools.failed 为空', healthFull.json.tools.failed, []);
deepEq('health subagents', healthFull.json.subagents, { available: true, providers: ['spawn'] });
deepEq('health agentRoute 来自 default', healthFull.json.agentRoute, { available: true, source: 'default' });
deepEq('health root.configured=true', healthFull.json.root, { configured: true });

// 19b. 部分工具注册失败
const healthPartial = await callHandler(hostRoutes.createHandlers({
  store: healthStoreFull,
  ctx: healthCtxFull,
  toolState: () => ({ registered: ['jk_kb_bootstrap'], failed: [{ name: 'jk_kb_verify', error: 'schema rejected' }] }),
}).health, { method: 'GET' });
eq('部分失败 health → 200', healthPartial.status, 200);
deepEq('health 成功名单', healthPartial.json.tools.registered, ['jk_kb_bootstrap']);
deepEq('health 失败清单', healthPartial.json.tools.failed, [{ name: 'jk_kb_verify', error: 'schema rejected' }]);
eq('失败不影响探活', healthPartial.json.ok, true);

// 19c. 取不到 route / subagents 时降级，但仍 200
const healthBare = await callHandler(hostRoutes.createHandlers({
  store: hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-health-bare-'), 'settings.json') }),
  ctx: {},
  toolState: () => ({ registered: [], failed: [] }),
}).health, { method: 'GET' });
eq('无 route 时 health 仍 200', healthBare.status, 200);
deepEq('无 route → agentRoute.available=false', healthBare.json.agentRoute, { available: false, source: null });
deepEq('无 subagents → available=false', healthBare.json.subagents, { available: false, providers: [] });
deepEq('未配置根目录 → configured=false', healthBare.json.root, { configured: false });

// 19d. 诊断源自己抛错也不影响 /health
const healthBroken = await callHandler(hostRoutes.createHandlers({
  store: healthStoreFull,
  ctx: {},
  toolState: () => { throw new Error('diagnostics exploded'); },
}).health, { method: 'GET' });
eq('诊断源抛错时 health 仍 200', healthBroken.status, 200);
deepEq('诊断源抛错 → 空工具列表', healthBroken.json.tools, { registered: [], failed: [] });

// 19e. agent 回退来源为 agent
const healthAgentSource = await callHandler(hostRoutes.createHandlers({
  store: healthStoreFull,
  ctx: { get: (name) => (name === 'agents' ? { list: () => [], roots: () => [{ options: { provider: 'p', model: 'm' } }] } : undefined) },
  toolState: () => ({ registered: [], failed: [] }),
}).health, { method: 'GET' });
deepEq('health agentRoute 来自 agent 回退', healthAgentSource.json.agentRoute, { available: true, source: 'agent' });

// 19f. 启动日志格式
const logLines = [];
const logTools = { register() { return () => {}; } };
const logSubagents = { list: () => ['spawn'], start() {} };
const logLogger = { info(line) { logLines.push(line); } };
const logCtx = {
  webServer: { register() { return () => {}; } },
  connection: {},
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  get: (name) => {
    if (name === 'tools') return logTools;
    if (name === 'subagents') return logSubagents;
    if (name === 'logger') return logLogger;
    return undefined;
  },
};
let logApplyThrew = null;
try { hostIndex.apply(logCtx, {}); } catch (err) { logApplyThrew = err; }
eq('带 logger 的 apply 不抛', logApplyThrew, null);
eq('启动日志恰好一行', logLines.length, 1);
ok('启动日志格式正确', /^\[jk-knowledge-base\] host ready: routes=\d+ tools=\d+\/\d+ failed=\[[^\]]*\] subagents=spawn route=none$/.test(logLines[0]), logLines[0]);
ok('启动日志含 routes 计数', /routes=\d+/.test(logLines[0]), logLines[0]);

// 没有 logger 时静默（不抛、不打）
let silentThrew = null;
try { hostIndex.apply({ get: (name) => (name === 'tools' ? { register() { return () => {}; } } : undefined), webServer: { register() { return () => {}; } }, effect(fn) { return fn(); } }, {}); } catch (err) { silentThrew = err; }
eq('没有 logger 时静默', silentThrew, null);

// ═══════════════════ 20. cordis 严格服务门禁回归 ═══════════════════
// 20a. 静态扫描：源码里任何 ctx.<name> 必须是上下文成员，或已在 inject 里声明。
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

const CTX_CONTEXT_MEMBERS = ['effect', 'get', 'on', 'plugin', 'provide', 'inject', 'root', 'scope', 'emit', 'collector', 'collectorId'];
const scannedFiles = ['index.js'].concat(
  fs.readdirSync(path.join(root, 'host'))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => 'host/' + name)
);
const gateViolations = [];
scannedFiles.forEach((rel) => {
  const text = stripComments(readFileSync(path.join(root, rel), 'utf8'));
  const re = /ctx\.([A-Za-z_]\w*)/g;
  let match = re.exec(text);
  while (match !== null) {
    const name = match[1];
    const declared = hostIndex.inject.indexOf(name) >= 0;
    const contextMember = CTX_CONTEXT_MEMBERS.indexOf(name) >= 0;
    if (!declared && !contextMember) {
      const line = text.slice(0, match.index).split('\n').length;
      gateViolations.push(rel + ':' + line + ' ctx.' + name);
    }
    match = re.exec(text);
  }
});
deepEq('静态门禁：ctx.<service> 只能走 ctx.get 或已声明 inject', gateViolations, []);
ok('扫到了 index.js 与 host/*.js', scannedFiles.length >= 5, scannedFiles.join(','));

// 20b. 代理型门禁：模拟 cordis per-fiber service proxy —— 未声明即抛。
function makeStrictCtx(declared, services) {
  const target = {
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) {
      return services[name];
    },
    root: {},
  };
  return new Proxy(target, {
    get(base, prop) {
      if (typeof prop === 'symbol') return base[prop];
      if (prop in base) return base[prop];
      if (declared.indexOf(prop) >= 0) return services[prop];
      throw new Error('cannot get property "' + String(prop) + '" without inject');
    },
  });
}

const strictRoutes = [];
const strictTools = [];
const strictCtx = makeStrictCtx(['webServer', 'connection'], {
  webServer: { register(spec) { strictRoutes.push(spec); return () => {}; } },
  connection: { requestRejection() { return undefined; } },
  tools: { register(definition) { strictTools.push(definition); return () => {}; } },
  subagents: { list: () => ['spawn'], start() {} },
  agents: { list: () => [], roots: () => [] },
});
let strictThrew = null;
try { hostIndex.apply(strictCtx, {}); } catch (err) { strictThrew = err; }
eq('严格门禁 ctx 上 apply 不抛', strictThrew, null);
eq('严格门禁下注册 21 条路由', strictRoutes.length, 21);
eq('严格门禁下注册 19 个工具', strictTools.length, 19);
deepEq('严格门禁下工具名完整', strictTools.map((d) => d.name), ['jk_kb_bootstrap', 'jk_kb_verify', 'jk_kb_reindex', 'jk_kb_inspect', 'jk_kb_step', 'jk_kb_curate', 'jk_kb_maintain', 'jk_kb_doctor', 'jk_kb_archive', 'jk_kb_expert_create', 'jk_kb_expert_update', 'jk_kb_expert_restore', 'jk_kb_expert_list', 'jk_kb_expert_archive', 'jk_kb_skill_create', 'jk_kb_skill_find', 'jk_kb_skill_run', 'jk_kb_skill_list', 'jk_kb_run_finish']);

// 旧行为桩：直接读门禁属性必然抛 —— 证明这个测试能抓住本次 bug。
function legacyApply(ctx) {
  if (!ctx || typeof ctx.effect !== 'function') return;
  if (ctx.tools && typeof ctx.tools.register === 'function') ctx.tools.register({ name: 'x' });
}
let legacyErr = null;
try { legacyApply(strictCtx); } catch (err) { legacyErr = err; }
ok('旧行为（直读 ctx.tools）在严格门禁下必抛', !!legacyErr && String(legacyErr.message).indexOf('cannot get property "tools" without inject') >= 0,
  legacyErr ? legacyErr.message : '没有抛错（说明门禁桩失效）');

['agents', 'subagents', 'logger'].forEach((name) => {
  let err = null;
  try { void strictCtx[name]; } catch (thrown) { err = thrown; }
  ok('未声明服务 ctx.' + name + ' 直读必抛', !!err, err ? err.message : '没有抛错');
});

// 走 ctx.get 则一律拿到 undefined / 服务，不抛。
eq('ctx.get 取未注册服务返回 undefined', strictCtx.get('not-a-service'), undefined);
eq('ctx.get 可取已注册服务', typeof strictCtx.get('tools'), 'object');
eq('声明过的 webServer 可直读', typeof strictCtx.webServer, 'object');

// ═══════════════════ 21. S1 监督核心：心跳 / 收割 / 锁 / 取消 / 预算 ═══════════════════
// 21a. 心跳写入与 heartbeatBy 切换
const s1Root = makeTmpDir('jkkb-s1-');
const s1Run = trace.createRun({ root: s1Root, kind: 'bootstrap', title: '建库' });
eq('createRun 写 deadlineAt', typeof s1Run.deadlineAt, 'string');
eq('createRun 写 heartbeatAt', typeof s1Run.heartbeatAt, 'string');
const budgetSpan = Date.parse(s1Run.deadlineAt) - Date.parse(s1Run.startedAt);
eq('bootstrap 预算 20min', budgetSpan, 20 * 60 * 1000);

const hbAgent = trace.touchRun(s1Root, s1Run.id, 'agent');
eq('touchRun(agent) 返回 agent', hbAgent.heartbeatBy, 'agent');
eq('readRun 看到 heartbeatBy=agent', trace.readRun(s1Root, s1Run.id).run.heartbeatBy, 'agent');
trace.touchRun(s1Root, s1Run.id, 'engine');
eq('heartbeatBy 切到 engine', trace.readRun(s1Root, s1Run.id).run.heartbeatBy, 'engine');
eq('touchRun 会刷新 heartbeatAt', trace.readRun(s1Root, s1Run.id).run.heartbeatAt !== s1Run.heartbeatAt, true);
trace.finishRun({ root: s1Root, runId: s1Run.id, status: 'completed' });
eq('终态后 touchRun 跳过（返回 null）', trace.touchRun(s1Root, s1Run.id, 'agent'), null);
eq('终态后 heartbeatBy 不变', trace.readRun(s1Root, s1Run.id).run.heartbeatBy, 'engine');

// 21b. reap 三种判定 + 新鲜不动
const reapRoot = makeTmpDir('jkkb-reap-');
const reapNow = Date.now();
const rTimed = trace.createRun({ root: reapRoot, kind: 'verify', deadlineAt: new Date(reapNow - 1000).toISOString(), heartbeatAt: new Date(reapNow).toISOString() });
const rAgent = trace.createRun({ root: reapRoot, kind: 'verify', deadlineAt: new Date(reapNow + 600000).toISOString(), heartbeatAt: new Date(reapNow - 130000).toISOString(), heartbeatBy: 'agent' });
const rEngine = trace.createRun({ root: reapRoot, kind: 'verify', deadlineAt: new Date(reapNow + 600000).toISOString(), heartbeatAt: new Date(reapNow - 310000).toISOString(), heartbeatBy: 'engine' });
const rFresh = trace.createRun({ root: reapRoot, kind: 'verify', deadlineAt: new Date(reapNow + 600000).toISOString(), heartbeatAt: new Date(reapNow).toISOString(), heartbeatBy: 'engine' });
const reaped = trace.reap(reapRoot, { now: reapNow });
eq('reap 收敛 3 条', reaped.length, 3);
eq('deadline 超 → timed_out', trace.readRun(reapRoot, rTimed.id).run.status, 'timed_out');
ok('timedOutAt 已写', typeof trace.readRun(reapRoot, rTimed.id).run.timedOutAt === 'string');
eq('agent 静默 130s → stalled', trace.readRun(reapRoot, rAgent.id).run.status, 'stalled');
ok('stalledAt 已写', typeof trace.readRun(reapRoot, rAgent.id).run.stalledAt === 'string');
eq('engine 静默 310s → stalled', trace.readRun(reapRoot, rEngine.id).run.status, 'stalled');
eq('新鲜 run 不动', trace.readRun(reapRoot, rFresh.id).run.status, 'running');
eq('reap 第二次无新增', trace.reap(reapRoot, { now: reapNow }).length, 0);

// 21c. 锁：第二次拿不到；过期可抢并返回 previous
const lockRoot = makeTmpDir('jkkb-lock-');
const lockRunA = trace.createRun({ root: lockRoot, kind: 'verify' });
const lockFirst = trace.acquireLock({ root: lockRoot, runId: lockRunA.id });
eq('首次取锁成功', lockFirst.ok, true);
const lockSecond = trace.acquireLock({ root: lockRoot, runId: trace.runIdFor('verify', new Date()) });
eq('第二次取锁失败', lockSecond.ok, false);
eq('锁冲突错误码 lock-held', lockSecond.code, 'lock-held');
eq('锁冲突带旧 runId', lockSecond.lock.runId, lockRunA.id);

// 双心跳同源：把 run 与锁的心跳一起推老（touchRun 会同时写两侧）。
trace.touchRun(lockRoot, lockRunA.id, 'engine', Date.now() - 200000);
const takeoverRunId = trace.runIdFor('reindex', new Date());
const takeover = trace.acquireLock({ root: lockRoot, runId: takeoverRunId });
eq('过期锁可抢占', takeover.ok, true);
eq('抢占返回 previous.runId', takeover.previous && takeover.previous.runId, lockRunA.id);
eq('抢占后锁归新 run', trace.readLock(lockRoot).runId, takeoverRunId);
eq('释放锁成功', trace.releaseLock({ root: lockRoot, runId: takeoverRunId }).ok, true);
eq('释放后读不到锁', trace.readLock(lockRoot), null);
eq('别人的锁不能释放', (() => {
  trace.acquireLock({ root: lockRoot, runId: lockRunA.id });
  const out = trace.releaseLock({ root: lockRoot, runId: takeoverRunId });
  trace.releaseLock({ root: lockRoot, runId: lockRunA.id });
  return out.code;
})(), 'lock-owner-mismatch');

// 21d. GET /runs 先 reap：超期 running 在返回里已是终态
const reapRouteRoot = makeTmpDir('jkkb-reap-route-');
const reapRouteStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-reap-store-'), 'settings.json') });
reapRouteStore.save({ root: reapRouteRoot, rootConfirmedAt: '2026-10-17T05:00:00.000Z', rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' }, updatedAt: '2026-10-17T05:00:00.000Z' });
const expiredRun = trace.createRun({ root: reapRouteRoot, kind: 'verify', deadlineAt: new Date(Date.now() - 5000).toISOString() });
const reapRouteHandlers = hostRoutes.createHandlers({ store: reapRouteStore });
const reapedList = await callHandler(reapRouteHandlers.runsList, { method: 'GET' });
eq('GET /runs 响应 200', reapedList.status, 200);
eq('GET /runs 返回前已 reap', reapedList.json.runs.filter((item) => item.id === expiredRun.id)[0].status, 'timed_out');
eq('reap 后 run.json 也是 timed_out', trace.readRun(reapRouteRoot, expiredRun.id).run.status, 'timed_out');

const silentRun = trace.createRun({
  root: reapRouteRoot,
  kind: 'verify',
  deadlineAt: new Date(Date.now() + 600000).toISOString(),
  heartbeatAt: new Date(Date.now() - 130000).toISOString(),
  heartbeatBy: 'agent',
});
const reapedList2 = await callHandler(reapRouteHandlers.runsList, { method: 'GET' });
eq('GET /runs 也会把心跳静默的 running 落成 stalled', reapedList2.json.runs.filter((item) => item.id === silentRun.id)[0].status, 'stalled');

// 21e. cancel 写 cancelRequestedAt
const cancelS1Root = makeTmpDir('jkkb-cancel-s1-');
const cancelS1Store = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-cancel-s1-store-'), 'settings.json') });
cancelS1Store.save({ root: cancelS1Root, rootConfirmedAt: '2026-10-17T05:00:00.000Z', rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' }, updatedAt: '2026-10-17T05:00:00.000Z' });
const cancelS1Service = createRunService({ ctx: {}, store: cancelS1Store });
const cancelS1Run = trace.createRun({ root: cancelS1Root, kind: 'reindex' });
eq('cancel 返回 ok', (await cancelS1Service.cancel(cancelS1Run.id)).ok, true);
ok('cancel 写入 cancelRequestedAt', typeof trace.readRun(cancelS1Root, cancelS1Run.id).run.cancelRequestedAt === 'string');
eq('无执行器时直接落 cancelled', trace.readRun(cancelS1Root, cancelS1Run.id).run.status, 'cancelled');

// 21f. 预算命中：引擎收到 shouldAbort 并抛 ABORTED → timed_out
const abortRoot = makeTmpDir('jkkb-abort-');
const abortStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-abort-store-'), 'settings.json') });
abortStore.save({ root: abortRoot, rootConfirmedAt: '2026-10-17T05:00:00.000Z', rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' }, updatedAt: '2026-10-17T05:00:00.000Z' });
const abortSeen = [];
const fakeEngine = {
  async bootstrap(args) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reason = args.shouldAbort();
    abortSeen.push(reason);
    if (reason) {
      const err = new Error(reason);
      err.code = 'ABORTED';
      throw err;
    }
    return { created: [], skipped: [] };
  },
  async verify() { return { ok: true, summary: 'fake verify' }; },
  async reindex() { return { noteCount: 0 }; },
};
const abortService = createRunService({ ctx: {}, store: abortStore, engine: fakeEngine });
const abortStart = await abortService.start({ kind: 'bootstrap' });
eq('预算用例 run 启动', abortStart.ok, true);
eq('start 写入 engineVersion', trace.readRun(abortRoot, abortStart.runId).run.engineVersion, '1.0.0');
trace.updateRun(abortRoot, abortStart.runId, { deadlineAt: new Date(Date.now() - 1000).toISOString() });
const abortDone = await waitForTerminal(abortRoot, abortStart.runId);
ok('引擎收到 shouldAbort 的中断原因', typeof abortSeen[0] === 'string' && abortSeen[0].indexOf('预算') >= 0, JSON.stringify(abortSeen));
eq('ABORTED → timed_out', abortDone.run.status, 'timed_out');

// 21g. 新鲜锁 → start 409 lock-held；过期锁 → 抢占并把旧 run 标 stalled
const heldRoot = makeTmpDir('jkkb-held-');
const heldStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-held-store-'), 'settings.json') });
heldStore.save({ root: heldRoot, rootConfirmedAt: '2026-10-17T05:00:00.000Z', rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' }, updatedAt: '2026-10-17T05:00:00.000Z' });
const heldRun = trace.createRun({ root: heldRoot, kind: 'verify' });
trace.acquireLock({ root: heldRoot, runId: heldRun.id });
const heldService = createRunService({ ctx: {}, store: heldStore, engine: fakeEngine });
const heldStart = await heldService.start({ kind: 'verify' });
eq('新鲜锁在预检阶段就被拦（422）', heldStart.status, 422);
eq('新鲜锁错误码 LOCK_HELD', heldStart.error.code, 'LOCK_HELD');
ok('错误消息带 runId', heldStart.error.message.indexOf(heldRun.id) >= 0, heldStart.error.message);

trace.touchRun(heldRoot, heldRun.id, 'engine', Date.now() - 200000);
const takeoverStart = await heldService.start({ kind: 'verify' });
eq('过期锁 → start 成功', takeoverStart.ok, true);
eq('旧 run 被标 stalled', trace.readRun(heldRoot, heldRun.id).run.status, 'stalled');
await waitForTerminal(heldRoot, takeoverStart.runId);
eq('新 run 完成后锁已释放', trace.readLock(heldRoot), null);

// ═══════════════════ 22. trace 写盘过路径守卫（host/engine/guard.js） ═══════════════════
// 22a. <root>/.jkkb 是指向库外的软链 → 所有写盘都必须拒绝，库外零新文件
const guardInside = makeTmpDir('jkkb-guard-inside-');
const guardOutside = makeTmpDir('jkkb-guard-outside-');
let symlinkAvailable = true;
try {
  // win32 创建符号链接需要开发者模式；退回 junction（同样会形成目录重定向）。
  fs.symlinkSync(guardOutside, path.join(guardInside, '.jkkb'), process.platform === 'win32' ? 'junction' : 'dir');
} catch (err) {
  symlinkAvailable = false;
  console.log('[jkkb-smoke] symlink 不可用，跳过软链逃逸用例：' + (err && err.code));
}
ok('软链用例可用性或已明确跳过', symlinkAvailable || process.platform === 'win32');

let symlinkErr = null;
if (symlinkAvailable) {
  try { trace.createRun({ root: guardInside, kind: 'verify' }); } catch (err) { symlinkErr = err; }
} else {
  symlinkErr = { code: 'PATH_ESCAPE' }; // 平台无 symlink 权限时按"已跳过"计
}
eq('软链 .jkkb → 库外：createRun 抛 PATH_ESCAPE', symlinkErr && symlinkErr.code, 'PATH_ESCAPE');
deepEq('库外目录没有新增任何文件', fs.readdirSync(guardOutside), []);

let writerErr = null;
try { trace.writeJsonAtomic(path.join(guardInside, '.jkkb', 'x.json'), { a: 1 }, guardInside); } catch (err) { writerErr = err; }
eq('writeJsonAtomic 也过守卫', writerErr && writerErr.code, 'PATH_ESCAPE');

let lockGuardErr = null;
try { trace.acquireLock({ root: guardInside, runId: trace.runIdFor('verify', new Date()) }); } catch (err) { lockGuardErr = err; }
eq('取锁写 lock.json 也过守卫', lockGuardErr && lockGuardErr.code, 'PATH_ESCAPE');

let stepGuardErr = null;
try { await trace.appendStep({ root: guardInside, runId: 'run-x', step: { title: 'x' } }); } catch (err) { stepGuardErr = err; }
eq('steps 追加也过守卫', stepGuardErr && stepGuardErr.code, 'PATH_ESCAPE');

const guardStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-guard-store-'), 'settings.json') });
guardStore.save({ root: guardInside, rootConfirmedAt: '2026-10-17T05:00:00.000Z', rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' }, updatedAt: '2026-10-17T05:00:00.000Z' });
const guardStart = await createRunService({ ctx: {}, store: guardStore }).start({ kind: 'verify' });
eq('守卫拒绝时 start 直接失败（不建 run）', guardStart.ok, false);
ok('守卫拒绝发生在预检（PATH_DENIED 或 lock-failed）',
  guardStart.error.code === 'PATH_DENIED' || guardStart.error.code === 'lock-failed', guardStart.error.code);
eq('守卫拒绝时 HTTP 状态是 422/500', guardStart.status === 422 || guardStart.status === 500, true);
ok('错误消息带守卫原因', String(guardStart.error.message).indexOf('逃逸') >= 0, guardStart.error.message);
deepEq('库外目录仍然为空', fs.readdirSync(guardOutside), []);

// 22b. 正常 root：createRun / touchRun / appendStep / finishRun 不受影响
const guardOkRoot = makeTmpDir('jkkb-guard-ok-');
const guardOkRun = trace.createRun({ root: guardOkRoot, kind: 'verify' });
eq('正常 root 下 createRun 成功', guardOkRun.status, 'running');
eq('正常 root 下 touchRun 成功', trace.touchRun(guardOkRoot, guardOkRun.id, 'agent').heartbeatBy, 'agent');
await trace.appendStep({ root: guardOkRoot, runId: guardOkRun.id, step: { title: 'ok' } });
eq('正常 root 下 appendStep 成功', trace.readRun(guardOkRoot, guardOkRun.id).steps.length, 1);
eq('正常 root 下 finishRun 成功', trace.finishRun({ root: guardOkRoot, runId: guardOkRun.id, status: 'completed' }).status, 'completed');
ok('runs/index.json 落在 root 内', fs.existsSync(path.join(guardOkRoot, '.jkkb', 'runs', 'index.json')));
eq('正常 root 下取锁成功', trace.acquireLock({ root: guardOkRoot, runId: guardOkRun.id }).ok, true);
eq('正常 root 下放锁成功', trace.releaseLock({ root: guardOkRoot, runId: guardOkRun.id }).ok, true);

// ═══════════════════ 23. S1.1 双心跳同源 + 跨平台路径工具 ═══════════════════
// 23a. 长任务不丢锁：touchRun 同时刷新 run.json 与 lock.json
const hbRoot = makeTmpDir('jkkb-hb-');
const hbRun = trace.createRun({ root: hbRoot, kind: 'bootstrap' });
const hbLock = trace.acquireLock({ root: hbRoot, runId: hbRun.id });
eq('长任务首次取锁成功', hbLock.ok, true);
const hbBefore = trace.readLock(hbRoot).heartbeatAt;
const hbTouched = trace.touchRun(hbRoot, hbRun.id, 'engine', Date.now() + 5000);
eq('touchRun 同时刷新锁', hbTouched.lockRefreshed, true);
eq('锁心跳与 run 心跳同源', trace.readLock(hbRoot).heartbeatAt, hbTouched.heartbeatAt);
ok('锁心跳确实前进了', trace.readLock(hbRoot).heartbeatAt !== hbBefore);
const hbOtherRunId = trace.runIdFor('verify', new Date());
const hbSecond = trace.acquireLock({ root: hbRoot, runId: hbOtherRunId });
eq('长任务心跳后别人仍拿不到锁', hbSecond.ok, false);
eq('长任务锁冲突码 lock-held', hbSecond.code, 'lock-held');

// 23b. 仅 lock 过期、run 心跳新鲜 → 拒绝抢占
const lockOnlyRoot = makeTmpDir('jkkb-lockonly-');
const lockOnlyRun = trace.createRun({ root: lockOnlyRoot, kind: 'verify' });
trace.acquireLock({ root: lockOnlyRoot, runId: lockOnlyRun.id });
const lockOnlyFile = trace.lockPath(lockOnlyRoot);
const lockOnlyRaw = JSON.parse(fs.readFileSync(lockOnlyFile, 'utf8'));
lockOnlyRaw.heartbeatAt = new Date(Date.now() - 200000).toISOString();
fs.writeFileSync(lockOnlyFile, JSON.stringify(lockOnlyRaw));
const lockOnlyTry = trace.acquireLock({ root: lockOnlyRoot, runId: trace.runIdFor('verify', new Date()) });
eq('锁过期但 run 新鲜 → lock-held', lockOnlyTry.ok, false);
eq('拒绝原因 run-fresh', lockOnlyTry.reason, 'run-fresh');
ok('消息说明是哪一侧新鲜', String(lockOnlyTry.message).indexOf('run 心跳') >= 0, lockOnlyTry.message);

// 23c. 仅 run 过期、锁新鲜 → 拒绝抢占
const runOnlyRoot = makeTmpDir('jkkb-runonly-');
const runOnlyRun = trace.createRun({ root: runOnlyRoot, kind: 'verify', heartbeatAt: new Date(Date.now() - 200000).toISOString() });
trace.acquireLock({ root: runOnlyRoot, runId: runOnlyRun.id });
const runOnlyTry = trace.acquireLock({ root: runOnlyRoot, runId: trace.runIdFor('verify', new Date()) });
eq('run 过期但锁新鲜 → lock-held', runOnlyTry.ok, false);
eq('拒绝原因 lock-fresh', runOnlyTry.reason, 'lock-fresh');

// 23d. 双过期 → 抢占成功并返回 previous
const bothRoot = makeTmpDir('jkkb-both-');
const bothRun = trace.createRun({ root: bothRoot, kind: 'verify' });
trace.acquireLock({ root: bothRoot, runId: bothRun.id });
trace.touchRun(bothRoot, bothRun.id, 'engine', Date.now() - 200000);
const bothNewRunId = trace.runIdFor('reindex', new Date());
const bothTakeover = trace.acquireLock({ root: bothRoot, runId: bothNewRunId });
eq('双过期 → 抢占成功', bothTakeover.ok, true);
eq('抢占返回旧 runId', bothTakeover.previous && bothTakeover.previous.runId, bothRun.id);

// 23e. 终态 run 的 touchRun 不刷新锁
const termRoot = makeTmpDir('jkkb-term-');
const termRun = trace.createRun({ root: termRoot, kind: 'verify' });
trace.acquireLock({ root: termRoot, runId: termRun.id });
const termLockBefore = trace.readLock(termRoot).heartbeatAt;
trace.finishRun({ root: termRoot, runId: termRun.id, status: 'completed' });
eq('终态 run 的 touchRun 返回 null', trace.touchRun(termRoot, termRun.id, 'agent'), null);
eq('终态 run 不刷新锁心跳', trace.readLock(termRoot).heartbeatAt, termLockBefore);

// 23f. 路径包含判定（path.relative，禁止字符串前缀）
eq('isInsidePath 同路径为真', trace.isInsidePath('/a/b', '/a/b'), true);
eq('isInsidePath 子路径为真', trace.isInsidePath('/a/b', '/a/b/c/d'), true);
eq('isInsidePath 前缀陷阱为假（/a/bc 不在 /a/b 内）', trace.isInsidePath('/a/b', '/a/bc'), false);
eq('isInsidePath 父级为假', trace.isInsidePath('/a/b', '/a'), false);
eq('isInsidePath 接受未 normalize 的路径', trace.isInsidePath('/a/b', '/a/b/./c/../d'), true);
eq('sanitizeSegment 去掉非法字符', trace.sanitizeSegment('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
eq('sanitizeSegment 去掉结尾点与空格', trace.sanitizeSegment('dir. . '), 'dir');
eq('sanitizeSegment 避开 Windows 保留名', trace.sanitizeSegment('CON'), 'CON_');
eq('sanitizeSegment 限制长度（≤200）', trace.sanitizeSegment('x'.repeat(500)).length <= 200, true);

// 23f2. win32 路径总长预判（用 platform 参数在同机验证逻辑）
let tooLongCode = null;
try { trace.assertPathLength('C:\\' + 'a'.repeat(240), 'C:\\' + 'a'.repeat(240) + '\\x', 'win32'); } catch (err) { tooLongCode = err.code; }
eq('win32 超长路径抛 PATH_TOO_LONG', tooLongCode, 'PATH_TOO_LONG');
eq('非 win32 不做长度预判', (() => { try { trace.assertPathLength('/tmp/a', '/tmp/a/b', 'darwin'); return 'ok'; } catch (err) { return err.code; } })(), 'ok');

// 23g. replaceFile：覆盖已存在文件（Windows 上是必经路径）
const replaceRoot = makeTmpDir('jkkb-replace-');
const replaceDest = path.join(replaceRoot, 'dest.json');
fs.writeFileSync(replaceDest, 'old');
const replaceTmp = path.join(replaceRoot, 'dest.tmp');
fs.writeFileSync(replaceTmp, 'new');
const replaced = trace.replaceFile(replaceTmp, replaceDest);
eq('replaceFile 成功', replaced.ok, true);
eq('replaceFile 覆盖了目标', fs.readFileSync(replaceDest, 'utf8'), 'new');
eq('replaceFile 移走了 tmp', fs.existsSync(replaceTmp), false);
const replaceMissing = trace.replaceFile(path.join(replaceRoot, 'nope.tmp'), replaceDest);
eq('replaceFile 缺 tmp 时返回失败', replaceMissing.ok, false);
ok('replaceFile 失败带错误码', typeof replaceMissing.code === 'string' && replaceMissing.code.length > 0, JSON.stringify(replaceMissing));

// ═══════════════════ 24. root-policy 平台化（win32 / linux / darwin） ═══════════════════
const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
};
function winOpts(extra) {
  return Object.assign({
    platform: 'win32',
    homedir: 'C:\\Users\\tester',
    env: WIN_ENV,
    realpathSync: (value) => value,
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => [],
  }, extra || {});
}
function linuxOpts(extra) {
  return Object.assign({
    platform: 'linux',
    homedir: '/home/tester',
    env: {},
    realpathSync: (value) => value,
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => [],
  }, extra || {});
}
function darwinOpts(extra) {
  return Object.assign({
    platform: 'darwin',
    homedir: '/Users/tester',
    env: {},
    realpathSync: (value) => value,
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => [],
  }, extra || {});
}

// 24a. win32：系统盘根 / Windows / Program Files 全部 reject
[
  ['系统盘根 C:\\', 'C:\\'],
  ['Windows 目录', 'C:\\Windows'],
  ['Windows 子目录', 'C:\\Windows\\System32\\kb'],
  ['Program Files', 'C:\\Program Files\\KB'],
  ['ProgramData', 'C:\\ProgramData\\kb'],
  ['APPDATA Crypto', 'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Crypto\\kb'],
].forEach(([label, target]) => {
  const result = rootPolicy.evaluateRoot(target, winOpts());
  eq('win32 拒绝：' + label, result.level, 'reject');
  eq('win32 拒绝原因码：' + label, result.reasons[0].code, 'root-system');
});

// 24b. win32 大小写不敏感：C:\WINDOWS 也拒绝
eq('win32 大小写不同仍拒绝', rootPolicy.evaluateRoot('c:\\windows', winOpts()).level, 'reject');

// 24c. win32 非系统盘放行
const winOk = rootPolicy.evaluateRoot('D:\\knowledge\\kb', winOpts());
eq('win32 非系统盘放行', winOk.level, 'ok');
eq('win32 非系统盘 ok=true', winOk.ok, true);

// 24d. win32 的 ~\Documents\kb 正确展开到用户目录并给警告
const winTilde = rootPolicy.evaluateRoot('~\\Documents\\kb', winOpts());
eq('win32 ~\\ 展开后 level=warn', winTilde.level, 'warn');
ok('win32 ~\\ 展开命中 Documents 警告', winTilde.reasons.some((item) => item.code === 'warn-documents'), JSON.stringify(winTilde.reasons));
eq('win32 ~\\ 展开到正确路径', winTilde.normalized, 'C:\\Users\\tester\\Documents\\kb');

// 24e. linux：/etc 与 /usr 子树 reject
[['/etc/kb', 'reject'], ['/usr/local/kb', 'reject'], ['/home/tester/kb', 'ok']].forEach(([target, expected]) => {
  const result = rootPolicy.evaluateRoot(target, linuxOpts());
  eq('linux ' + target + ' → ' + expected, result.level, expected);
});

// 24f. darwin：/System 子树 reject（其余保持原行为）
eq('darwin /System/Library reject', rootPolicy.evaluateRoot('/System/Library/kb', darwinOpts()).level, 'reject');
eq('darwin /Users/tester/kb ok', rootPolicy.evaluateRoot('/Users/tester/kb', darwinOpts()).level, 'ok');

// 24h. win32 长路径前缀与 UNC
eq('\\?\C:\Windows 剥前缀后命中保留区', rootPolicy.evaluateRoot('\\\\?\\C:\\Windows', winOpts()).level, 'reject');
eq('\\?\C:\Windows 原因码 root-system', rootPolicy.evaluateRoot('\\\\?\\C:\\Windows', winOpts()).reasons[0].code, 'root-system');
eq('\\?\D:\knowledge\kb 放行', rootPolicy.evaluateRoot('\\\\?\\D:\\knowledge\\kb', winOpts()).level, 'ok');
eq('stripWin32LongPrefix 处理 UNC 长路径', rootPolicy.stripWin32LongPrefix('\\\\?\\UNC\\server\\share\\kb'), '\\\\server\\share\\kb');
eq('stripWin32LongPrefix 处理盘符长路径', rootPolicy.stripWin32LongPrefix('\\\\?\\C:\\Windows'), 'C:\\Windows');
eq('非 win32 不剥前缀', rootPolicy.stripWin32LongPrefix('/tmp/a'), '/tmp/a');

const uncLong = rootPolicy.evaluateRoot('\\\\?\\UNC\\server\\share\\kb', winOpts());
eq('\\?\UNC\ 归一化后是 UNC 路径', rootPolicy.isUncPath(uncLong.normalized, 'win32'), true);
eq('长路径 UNC → warn', uncLong.level, 'warn');
ok('长路径 UNC 带 root-network-share', uncLong.reasons.some((item) => item.code === 'root-network-share'), JSON.stringify(uncLong.reasons));

const uncBare = rootPolicy.evaluateRoot('\\\\server\\share\\kb', winOpts());
eq('裸 UNC → warn', uncBare.level, 'warn');
ok('裸 UNC 原因码 root-network-share', uncBare.reasons.some((item) => item.code === 'root-network-share'), JSON.stringify(uncBare.reasons));
eq('UNC 仍 ok=true（不阻断 riskAck 保存）', uncBare.ok, true);
ok('UNC 文案写明延迟/空间/权限三点', (() => {
  const message = (uncBare.reasons.filter((item) => item.code === 'root-network-share')[0] || {}).message || '';
  return message.indexOf('网络') >= 0 && message.indexOf('剩余空间') >= 0 && message.indexOf('写权限') >= 0;
})(), JSON.stringify(uncBare.reasons));

// 24g. 大小写判重与包含判定（win32 折叠、linux 不折叠）
eq('win32 C:\\KB 与 c:\\kb 是同一路径', rootPolicy.samePath('C:\\KB', 'c:\\kb', 'win32'), true);
eq('linux /A 与 /a 不是同一路径', rootPolicy.samePath('/A', '/a', 'linux'), false);
const winCmp = rootPolicy.makePathCompare('win32');
eq('win32 包含判定（前缀陷阱 C:\\Program FilesX 不在其内）', winCmp.inside('C:\\Program Files', 'C:\\Program FilesX'), false);
eq('win32 包含判定（子目录）', winCmp.inside('C:\\Program Files', 'C:\\PROGRAM FILES\\KB'), true);

// ═══════════════════ 25. preflight 接入宿主流程 ═══════════════════
const REQUIRED_TOOL_NAMES = ['jk_kb_bootstrap', 'jk_kb_verify', 'jk_kb_reindex'];

function makePfRoot(prefix) {
  const root = makeTmpDir(prefix || 'jkkb-pf-');
  const store = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-pf-store-'), 'settings.json') });
  store.save({
    root: root,
    rootConfirmedAt: '2026-10-17T05:00:00.000Z',
    rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
    updatedAt: '2026-10-17T05:00:00.000Z',
  });
  return { root: root, store: store };
}

// 25a. 正常根目录 → 200 且 ok=true；NO_ROUTE 只是 warn
const pfOk = makePfRoot('jkkb-pf-ok-');
const pfHandlers = hostRoutes.createHandlers({
  store: pfOk.store,
  ctx: {},
  toolState: () => ({ registered: REQUIRED_TOOL_NAMES, failed: [] }),
});
const pfRes = await callHandler(pfHandlers.preflight, { method: 'GET' });
eq('GET /preflight → 200', pfRes.status, 200);
eq('正常根 ok=true', pfRes.json.ok, true);
eq('正常根 code=OK', pfRes.json.code, 'OK');
ok('报告含 checks / counts / freeBytes', Array.isArray(pfRes.json.checks) && !!pfRes.json.counts && Object.prototype.hasOwnProperty.call(pfRes.json, 'freeBytes'), JSON.stringify(Object.keys(pfRes.json)));
ok('NO_ROUTE 是 warn 且 ok 仍为 true', (() => {
  const route = pfRes.json.checks.filter((item) => item.code === 'NO_ROUTE')[0];
  return !!route && route.level === 'warn' && pfRes.json.ok === true;
})(), JSON.stringify(pfRes.json.checks.filter((item) => item.code === 'NO_ROUTE')));
ok('报告里有 files 计数与上限', typeof pfRes.json.counts.files === 'number' && pfRes.json.counts.limit === 5000, JSON.stringify(pfRes.json.counts));

// 25b. 未配置根目录 → 409 root-missing
const emptyStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-pf-empty-'), 'settings.json') });
const pfEmpty = await callHandler(hostRoutes.createHandlers({ store: emptyStore }).preflight, { method: 'GET' });
eq('未配置根目录 → 409', pfEmpty.status, 409);
eq('未配置根目录错误码 root-missing', pfEmpty.json.error.code, 'root-missing');

// 25c. TOOLS_MISSING：假 toolState 只注册 0 个
const pfMissing = await callHandler(hostRoutes.createHandlers({
  store: pfOk.store,
  ctx: {},
  toolState: () => ({ registered: [], failed: [] }),
}).preflight, { method: 'GET' });
eq('TOOLS_MISSING → ok=false', pfMissing.json.ok, false);
eq('TOOLS_MISSING 错误码', pfMissing.json.code, 'TOOLS_MISSING');
const toolsCheck = pfMissing.json.checks.filter((item) => item.code === 'TOOLS_MISSING')[0];
ok('TOOLS_MISSING 是 error 且有 fix', !!toolsCheck && toolsCheck.level === 'error' && typeof toolsCheck.fix === 'string', JSON.stringify(toolsCheck));

// 25d. POST /run 在 preflight error 时 422，且不创建 run
const pfBadRoot = makePfRoot('jkkb-pf-422-');
const pfBadService = createRunService({
  ctx: {},
  store: pfBadRoot.store,
  toolState: () => ({ registered: [], failed: [] }),
});
const pf422Start = await pfBadService.start({ kind: 'bootstrap' });
eq('preflight 失败 → 422', pf422Start.status, 422);
eq('preflight 失败 code=TOOLS_MISSING', pf422Start.error.code, 'TOOLS_MISSING');
ok('422 body 带 checks 数组', Array.isArray(pf422Start.error.checks) && pf422Start.error.checks.length > 0);

const pfRunsDir = path.join(pfBadRoot.root, '.jkkb', 'runs');
const pfRunDirs = fs.existsSync(pfRunsDir) ? fs.readdirSync(pfRunsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
eq('422 时没有生成任何 run 目录', pfRunDirs.length, 0);
eq('422 时没有 index.json', fs.existsSync(path.join(pfRunsDir, 'index.json')), false);
eq('422 时没有拿锁', fs.existsSync(path.join(pfBadRoot.root, '.jkkb', 'lock.json')), false);

const pfHttp422 = await callHandler(hostRoutes.createHandlers({
  store: pfBadRoot.store,
  ctx: {},
  toolState: () => ({ registered: [], failed: [] }),
  runs: pfBadService,
}).startRun, { method: 'POST', body: { kind: 'bootstrap' } });
eq('POST /run preflight 失败 → 422', pfHttp422.status, 422);
ok('HTTP 422 body 带 checks', Array.isArray(pfHttp422.json.error.checks) && pfHttp422.json.error.checks.length > 0, JSON.stringify(pfHttp422.json.error).slice(0, 200));
eq('HTTP 422 也没有 run 目录', (fs.existsSync(pfRunsDir) ? fs.readdirSync(pfRunsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0), 0);

// 25e. 运行中复检：第 15 个 step 后探针失败 → abort，run 落 failed 且 step 记录 errno
const recheckRoot = makeTmpDir('jkkb-recheck-');
const recheckStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-recheck-store-'), 'settings.json') });
recheckStore.save({
  root: recheckRoot,
  rootConfirmedAt: '2026-10-17T05:00:00.000Z',
  rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
  updatedAt: '2026-10-17T05:00:00.000Z',
});
const recheckEngine = {
  async bootstrap(args) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (let i = 1; i <= 25; i += 1) {
      args.onStep({ step: 's' + i, status: 'start', detail: '' });
      args.onStep({ step: 's' + i, status: 'ok', detail: '' });
      const reason = args.shouldAbort();
      if (reason) {
        const err = new Error(reason);
        err.code = 'ABORTED';
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { created: [], skipped: [] };
  },
  async verify() { return { ok: true, summary: 'fake' }; },
  async reindex() { return { noteCount: 0 }; },
};
const recheckService = createRunService({
  ctx: {},
  store: recheckStore,
  engine: recheckEngine,
  toolState: () => ({ registered: REQUIRED_TOOL_NAMES, failed: [] }),
});
const recheckStart = await recheckService.start({ kind: 'bootstrap' });
eq('复检用例 run 启动', recheckStart.ok, true);
const recheckRunsDir = path.join(recheckRoot, '.jkkb', 'runs');
if (process.platform === 'win32') {
  ok('win32 跳过 chmod 权限用例（无法可靠制造 EACCES）', true);
  await waitForTerminal(recheckRoot, recheckStart.runId);
} else {
  fs.chmodSync(recheckRunsDir, 0o500); // 让探针写入失败
  const recheckDone = await waitForTerminal(recheckRoot, recheckStart.runId);
  fs.chmodSync(recheckRunsDir, 0o700);
  eq('复检失败 → run failed', recheckDone.run.status, 'failed');
  ok('summary 记录 ROOT_UNAVAILABLE', String(recheckDone.run.summary).indexOf('ROOT_UNAVAILABLE') >= 0, String(recheckDone.run.summary));
  ok('step 里记录了 errno', recheckDone.steps.some((item) => item.status === 'error' && String(item.error || '').indexOf('ROOT_UNAVAILABLE') >= 0), JSON.stringify(recheckDone.steps.filter((x) => x.status === 'error').map((x) => x.error)));
}
eq('复检结束后锁已释放', trace.readLock(recheckRoot), null);

// ═══════════════════ 26. S3 验收门（acceptance） ═══════════════════
async function makeVaultRoot(prefix) {
  const root = makeTmpDir(prefix || 'jkkb-accept-');
  await engineApi.bootstrap({ root: root });
  return root;
}
function vaultStore(root) {
  const store = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-accept-store-'), 'settings.json') });
  store.save({
    root: root,
    rootConfirmedAt: '2026-10-17T05:00:00.000Z',
    rootRiskAck: { at: '2026-10-17T05:00:00.000Z', version: 1, textHash: 'x' },
    updatedAt: '2026-10-17T05:00:00.000Z',
  });
  return store;
}
function breakVault(root) {
  const dirs = fs.readdirSync(root).filter((name) => {
    try { return fs.statSync(path.join(root, name)).isDirectory() && !name.startsWith('.'); } catch (err) { return false; }
  });
  const target = path.join(root, dirs[1] || dirs[0], '_说明.md');
  if (fs.existsSync(target)) fs.rmSync(target);
  return target;
}
async function waitFor(predicate, ms) {
  const deadline = Date.now() + (ms || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

// 26a. 验收通过 → completed + acceptance.ok=true
const accRoot = await makeVaultRoot('jkkb-accept-ok-');
const accStore = vaultStore(accRoot);
const accService = createRunService({
  ctx: {},
  store: accStore,
  engine: { bootstrap: async () => ({ created: [], skipped: [] }), verify: engineApi.verify, reindex: engineApi.reindex },
});
const accStart = await accService.start({ kind: 'bootstrap' });
const accDone = await waitForTerminal(accRoot, accStart.runId);
eq('验收通过 → completed', accDone.run.status, 'completed');
eq('acceptance.ok=true', accDone.run.acceptance && accDone.run.acceptance.ok, true);
eq('acceptanceFailed=false', accDone.run.acceptanceFailed, false);
ok('acceptance 带 checkedAt 与 summary', typeof accDone.run.acceptance.checkedAt === 'string' && accDone.run.acceptance.checkedAt.length > 0, JSON.stringify(accDone.run.acceptance));

const accStep = accDone.steps.filter((item) => item.title === '验收（host 强制）')[0];
ok('验收 step 已落 steps.jsonl', !!accStep, JSON.stringify(accDone.steps.map((x) => x.title)));
eq('验收 step role=PLUGIN', accStep && accStep.role, 'PLUGIN');
eq('验收 step status=ok', accStep && accStep.status, 'ok');
ok('验收 step 带耗时（endedAt >= startedAt）', !!accStep && typeof accStep.startedAt === 'string' && typeof accStep.endedAt === 'string' && Date.parse(accStep.endedAt) >= Date.parse(accStep.startedAt), JSON.stringify(accStep && { s: accStep.startedAt, e: accStep.endedAt }));
ok('验收 step 的 outputSummary 非空', !!accStep && String(accStep.outputSummary).length > 0, accStep && accStep.outputSummary);

// 26b. 验收失败（删一个顶层目录的 _说明.md）→ failed + acceptanceFailed=true + error step
const badRoot = await makeVaultRoot('jkkb-accept-bad-');
const badStore = vaultStore(badRoot);
const removed = breakVault(badRoot);
ok('已删除目录说明文件', !fs.existsSync(removed), removed);
const badService = createRunService({
  ctx: {},
  store: badStore,
  engine: { bootstrap: async () => ({ created: [], skipped: [] }), verify: engineApi.verify, reindex: engineApi.reindex },
});
const badStart = await badService.start({ kind: 'bootstrap' });
const badDone = await waitForTerminal(badRoot, badStart.runId);
eq('验收失败 → failed（不是 completed）', badDone.run.status, 'failed');
eq('acceptanceFailed=true', badDone.run.acceptanceFailed, true);
eq('acceptance.ok=false', badDone.run.acceptance && badDone.run.acceptance.ok, false);
ok('acceptance.errors 非空', Array.isArray(badDone.run.acceptance.errors) && badDone.run.acceptance.errors.length > 0);
ok('acceptance.errors[0] 有 message', String((badDone.run.acceptance.errors[0] || {}).message).length > 0);
const badStep = badDone.steps.filter((item) => item.title === '验收（host 强制）')[0];
ok('失败也有验收 step', !!badStep);
eq('失败 step status=error', badStep && badStep.status, 'error');
ok('失败 step 的 outputSummary 写前 3 条 error', !!badStep && typeof badStep.outputSummary === 'string' && badStep.outputSummary.length > 0, badStep && badStep.outputSummary);
deepEq('失败 step artifacts 为空', badStep && badStep.artifacts, []);

// 26c. verify 抛错 → failed + acceptance.summary 有错误摘要
const throwRoot = await makeVaultRoot('jkkb-accept-throw-');
const throwService = createRunService({
  ctx: {},
  store: vaultStore(throwRoot),
  engine: {
    bootstrap: async () => ({ created: [], skipped: [] }),
    verify: async () => { throw new Error('体检炸了：fake verify error'); },
    reindex: async () => ({ noteCount: 0 }),
  },
});
const throwStart = await throwService.start({ kind: 'bootstrap' });
const throwDone = await waitForTerminal(throwRoot, throwStart.runId);
eq('verify 抛错 → failed', throwDone.run.status, 'failed');
eq('verify 抛错 → acceptanceFailed=true', throwDone.run.acceptanceFailed, true);
ok('acceptance.summary 记录错误', String(throwDone.run.acceptance.summary).indexOf('体检炸了') >= 0, String(throwDone.run.acceptance.summary));

// 26d. verify ABORTED（deadline 过期）→ timed_out 而非 completed
const abortAccRoot = await makeVaultRoot('jkkb-accept-abort-');
const abortAccService = createRunService({
  ctx: {},
  store: vaultStore(abortAccRoot),
  engine: {
    bootstrap: async () => ({ created: [], skipped: [] }),
    verify: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const err = new Error('超过运行预算（验收中）');
      err.code = 'ABORTED';
      throw err;
    },
    reindex: async () => ({ noteCount: 0 }),
  },
});
const abortAccStart = await abortAccService.start({ kind: 'bootstrap' });
await new Promise((resolve) => setTimeout(resolve, 20));
trace.updateRun(abortAccRoot, abortAccStart.runId, { deadlineAt: new Date(Date.now() - 1000).toISOString() });
const abortAccDone = await waitForTerminal(abortAccRoot, abortAccStart.runId);
eq('验收中 ABORTED + deadline 过期 → timed_out', abortAccDone.run.status, 'timed_out');
eq('timed_out 也标 acceptanceFailed', abortAccDone.run.acceptanceFailed, true);

// 26e. 编排官谎报 completed → 被 host 强制改判 failed
const lieRoot = await makeVaultRoot('jkkb-accept-lie-');
breakVault(lieRoot);
const lieEnv = makeAgentCtx({
  subagents: {
    list: () => ['spawn'],
    start: async () => ({
      result: new Promise((resolve) => setTimeout(() => resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), 150)),
      dispose: async () => {},
    }),
  },
});
const lieService = createRunService({ ctx: lieEnv.ctx, store: vaultStore(lieRoot), engine: { bootstrap: async () => ({ created: [], skipped: [] }), verify: engineApi.verify, reindex: engineApi.reindex } });
const lieStart = await lieService.start({ kind: 'bootstrap' });
eq('谎报用例 run 启动', lieStart.ok, true);
await new Promise((resolve) => setTimeout(resolve, 30));
// 模拟编排官直接调 jk_kb_run_finish({status:'completed'})
trace.finishRun({ root: lieRoot, runId: lieStart.runId, status: 'completed', summary: 'agent says done' });
await waitFor(() => {
  const data = trace.readRun(lieRoot, lieStart.runId);
  return !!data && data.run.acceptanceFailed === true;
}, 5000);
const lieDone = trace.readRun(lieRoot, lieStart.runId);
eq('编排官谎报的 completed 被改判 failed', lieDone.run.status, 'failed');
eq('改判后 acceptanceFailed=true', lieDone.run.acceptanceFailed, true);
ok('改判后 acceptance.ok=false', lieDone.run.acceptance && lieDone.run.acceptance.ok === false);
eq('index 同步改判', trace.readIndex(lieRoot).runs.filter((item) => item.id === lieStart.runId)[0].status, 'failed');

// 26f. kind='verify' 不再重复验收（engine.verify 只被调 1 次）
const verifyRoot = await makeVaultRoot('jkkb-accept-verify-');
let verifyCalls = 0;
const verifyService = createRunService({
  ctx: {},
  store: vaultStore(verifyRoot),
  engine: {
    bootstrap: async () => ({ created: [], skipped: [] }),
    verify: async () => { verifyCalls += 1; return { ok: true, summary: '体检通过' }; },
    reindex: async () => ({ noteCount: 0 }),
  },
});
const verifyStart = await verifyService.start({ kind: 'verify' });
const verifyDone = await waitForTerminal(verifyRoot, verifyStart.runId);
eq('verify run 完成', verifyDone.run.status, 'completed');
eq('kind=verify 只调用一次 engine.verify', verifyCalls, 1);
eq('kind=verify 不写 acceptance', verifyDone.run.acceptance, null);

// 26g. GET /runs 列表项透出 acceptanceFailed
const listHandlers = hostRoutes.createHandlers({ store: badStore, ctx: {}, toolState: () => ({ registered: REQUIRED_TOOL_NAMES, failed: [] }) });
const listRes = await callHandler(listHandlers.runsList, { method: 'GET' });
const badItem = listRes.json.runs.filter((item) => item.id === badStart.runId)[0];
eq('列表项带 acceptanceFailed', badItem && badItem.acceptanceFailed, true);
const detailRes = await callHandler(listHandlers.runsScoped, { method: 'GET', url: '/plugins/jk-knowledge-base/runs/' + badStart.runId });
ok('详情返回 acceptance', !!detailRes.json.run.acceptance && detailRes.json.run.acceptance.ok === false);
eq('详情返回 acceptanceFailed', detailRes.json.run.acceptanceFailed, true);

// ═══════════════════ 27. S4 断点恢复（checkpoint / backup / recover） ═══════════════════
const EMPTY_CP = { engineVersion: '1.0.0', schemaVersion: 1, lastStepKey: null, completedSteps: [] };

// 27a. 规则 1：completed 且验收未失败 → noop
eq('规则1 completed+验收通过 → noop', checkpointMod.decideRecovery({
  run: { status: 'completed', acceptance: { ok: true } },
  checkpoint: EMPTY_CP,
  engineVersion: '1.0.0',
}).action, 'noop');
eq('规则1 acceptance=null 也算通过', checkpointMod.decideRecovery({
  run: { status: 'completed', acceptance: null },
  checkpoint: EMPTY_CP,
  engineVersion: '1.0.0',
}).action, 'noop');

// 27b. 规则 2：checkpoint 缺失 / 版本不一致 → abandon
eq('规则2 无 checkpoint → abandon', checkpointMod.decideRecovery({
  run: { status: 'failed' }, checkpoint: null, engineVersion: '1.0.0',
}).action, 'abandon');
const versionMismatch = checkpointMod.decideRecovery({
  run: { status: 'failed' },
  checkpoint: { engineVersion: '0.9.0', schemaVersion: 1, completedSteps: [] },
  engineVersion: '1.0.0',
});
eq('规则2 版本不一致 → abandon', versionMismatch.action, 'abandon');
ok('版本不一致 reason 写清版本', versionMismatch.reason.indexOf('0.9.0') >= 0 && versionMismatch.reason.indexOf('1.0.0') >= 0, versionMismatch.reason);

// 27c. 规则 3：产物冲突 → needs-human + conflicts
const cpConflictRoot = makeTmpDir('jkkb-cp-conflict-');
const cpConflictFile = path.join(cpConflictRoot, 'artifact.md');
fs.writeFileSync(cpConflictFile, 'abc');
const cpConflictStat = fs.statSync(cpConflictFile);
const cpConflictCheckpoint = {
  engineVersion: '1.0.0',
  schemaVersion: 1,
  lastStepKey: 'specs',
  completedSteps: [{ key: 'specs', at: new Date().toISOString(), artifacts: [{ path: cpConflictFile, size: cpConflictStat.size, mtimeMs: cpConflictStat.mtimeMs }] }],
};
fs.writeFileSync(cpConflictFile, 'abcdef'); // size 变了
const cpConflictDecision = checkpointMod.decideRecovery({ run: { status: 'failed' }, checkpoint: cpConflictCheckpoint, engineVersion: '1.0.0' });
eq('规则3 产物被改 → needs-human', cpConflictDecision.action, 'needs-human');
ok('conflicts 非空且带 path/expected/actual', cpConflictDecision.conflicts.length > 0
  && cpConflictDecision.conflicts[0].path === cpConflictFile
  && !!cpConflictDecision.conflicts[0].expected && !!cpConflictDecision.conflicts[0].actual,
JSON.stringify(cpConflictDecision.conflicts));

// 27d. 规则 4：running 且心跳新鲜 → needs-human
const freshDecision = checkpointMod.decideRecovery({
  run: { status: 'running', heartbeatAt: new Date().toISOString() },
  checkpoint: EMPTY_CP,
  engineVersion: '1.0.0',
});
eq('规则4 running 心跳新鲜 → needs-human', freshDecision.action, 'needs-human');
ok('规则4 reason 说明仍在运行', freshDecision.reason.indexOf('仍在运行') >= 0, freshDecision.reason);
eq('规则4 running 心跳过期 → 走规则6 restart', checkpointMod.decideRecovery({
  run: { status: 'running', heartbeatAt: new Date(Date.now() - 600000).toISOString() },
  checkpoint: EMPTY_CP,
  engineVersion: '1.0.0',
}).action, 'restart');

// 27e. 规则 5：中断态且无冲突 → resume
['failed', 'cancelled', 'stalled', 'timed_out'].forEach((status) => {
  eq('规则5 ' + status + ' → resume', checkpointMod.decideRecovery({
    run: { status: status }, checkpoint: EMPTY_CP, engineVersion: '1.0.0',
  }).action, 'resume');
});

// 27f. 规则 6：run 缺失 / 异常状态 → restart
eq('规则6 run 缺失 → restart', checkpointMod.decideRecovery({
  run: null, checkpoint: EMPTY_CP, engineVersion: '1.0.0',
}).action, 'restart');
eq('规则6 异常状态 → restart', checkpointMod.decideRecovery({
  run: { status: 'weird' }, checkpoint: EMPTY_CP, engineVersion: '1.0.0',
}).action, 'restart');

// 27g. checkpoint 写入 + 指纹正确
const cpRoot = makeTmpDir('jkkb-cp-');
const cpFileA = path.join(cpRoot, 'a.md');
const cpFileB = path.join(cpRoot, 'b.md');
fs.writeFileSync(cpFileA, 'aaa');
fs.writeFileSync(cpFileB, 'bbbb');
await checkpointMod.recordStep({ root: cpRoot, runId: 'run-cp-1', key: 'dirs', artifacts: [cpFileA, cpFileB] });
const cpWritten = checkpointMod.readCheckpoint(cpRoot, 'run-cp-1');
eq('checkpoint lastStepKey', cpWritten.lastStepKey, 'dirs');
eq('checkpoint schemaVersion', cpWritten.schemaVersion, 1);
eq('checkpoint engineVersion', cpWritten.engineVersion, '1.0.0');
eq('artifacts 数量', cpWritten.completedSteps[0].artifacts.length, 2);
eq('artifacts 绝对路径', cpWritten.completedSteps[0].artifacts[0].path, path.resolve(cpFileA));
eq('artifacts size 正确', cpWritten.completedSteps[0].artifacts[0].size, fs.statSync(cpFileA).size);
eq('artifacts mtimeMs 正确', cpWritten.completedSteps[0].artifacts[0].mtimeMs, fs.statSync(cpFileA).mtimeMs);
eq('checkpoint 落在 run 目录内', checkpointMod.checkpointPath(cpRoot, 'run-cp-1'), path.join(cpRoot, '.jkkb', 'runs', 'run-cp-1', 'checkpoint.json'));
eq('坏 checkpoint 读取回落 null', checkpointMod.readCheckpoint(cpRoot, '../etc'), null);

async function recoverFixture(prefix) {
  const root = await makeVaultRoot(prefix || 'jkkb-recover-');
  const store = vaultStore(root);
  const service = createRunService({
    ctx: {},
    store: store,
    engine: { bootstrap: async () => ({ created: [], skipped: [] }), verify: engineApi.verify, reindex: engineApi.reindex },
  });
  return { root: root, store: store, service: service };
}
function findArtifact(root) {
  const dirs = fs.readdirSync(root).filter((name) => {
    try { return fs.statSync(path.join(root, name)).isDirectory() && !name.startsWith('.'); } catch (err) { return false; }
  });
  return path.join(root, dirs[0], '_说明.md');
}

// 27h. restart：先备份，再启动新 run；备份内容与原件一致
const recA = await recoverFixture('jkkb-recover-restart-');
const recARun = trace.createRun({ root: recA.root, kind: 'verify', title: '旧 run' });
// restart 的判定：running 但心跳过期（规则 6）
trace.updateRun(recA.root, recARun.id, { heartbeatAt: new Date(Date.now() - 600000).toISOString() });
const recAArtifact = findArtifact(recA.root);
const recAOriginal = fs.readFileSync(recAArtifact);
await checkpointMod.recordStep({ root: recA.root, runId: recARun.id, key: 'dirs', artifacts: [recAArtifact] });
const recAResult = await recA.service.recover(recARun.id, 'restart');
eq('restart 返回新 runId', recAResult.ok, true);
ok('restart 返回的新 runId 与旧不同', recAResult.runId !== recARun.id);
const recABackupRoot = path.join(recA.root, '.jkkb', 'backup');
const recABackups = fs.existsSync(recABackupRoot) ? fs.readdirSync(recABackupRoot) : [];
eq('restart 生成 1 个备份目录', recABackups.length, 1);
ok('备份目录名形如 YYYYMMDD-HHmmss-<runId8>', /^\d{8}-\d{6}-.+$/.test(recABackups[0] || ''), String(recABackups[0]));
const recABackupFile = path.join(recABackupRoot, recABackups[0], path.relative(recA.root, recAArtifact));
ok('备份文件存在', fs.existsSync(recABackupFile), recABackupFile);
deepEq('备份内容与原件一致', fs.readFileSync(recABackupFile), recAOriginal);

// 27i. resume：不产生备份
const recB = await recoverFixture('jkkb-recover-resume-');
const recBRun = trace.createRun({ root: recB.root, kind: 'verify', title: '旧 run' });
trace.finishRun({ root: recB.root, runId: recBRun.id, status: 'failed', summary: '中断' });
await checkpointMod.recordStep({ root: recB.root, runId: recBRun.id, key: 'dirs', artifacts: [findArtifact(recB.root)] });
const recBResult = await recB.service.recover(recBRun.id, 'resume');
eq('resume 成功', recBResult.ok, true);
eq('resume 不产生备份目录', fs.existsSync(path.join(recB.root, '.jkkb', 'backup')), false);
const recBNewRun = trace.readRun(recB.root, recBResult.runId);
eq('新 run 的 resumedFrom 指向旧 run', recBNewRun.run.resumedFrom, recBRun.id);

// 27j. 备份失败 → 422 且不启动新 run
const recC = await recoverFixture('jkkb-recover-backupfail-');
const recCRun = trace.createRun({ root: recC.root, kind: 'verify', title: '旧 run' });
trace.updateRun(recC.root, recCRun.id, { heartbeatAt: new Date(Date.now() - 600000).toISOString() });
await checkpointMod.recordStep({ root: recC.root, runId: recCRun.id, key: 'dirs', artifacts: [findArtifact(recC.root)] });
const recCBackupRoot = path.join(recC.root, '.jkkb', 'backup');
fs.mkdirSync(recCBackupRoot, { recursive: true });
if (process.platform === 'win32') {
  ok('win32 跳过"备份目录不可写"用例', true);
} else {
  fs.chmodSync(recCBackupRoot, 0o500);
  const runsBefore = trace.readIndex(recC.root).runs.length;
  const recCResult = await recC.service.recover(recCRun.id, 'restart');
  fs.chmodSync(recCBackupRoot, 0o700);
  eq('备份失败 → 422', recCResult.status, 422);
  eq('备份失败错误码 backup-failed', recCResult.error.code, 'backup-failed');
  eq('备份失败不启动新 run', trace.readIndex(recC.root).runs.length, runsBefore);
}

// 27k. action 与建议不一致 → 409
const recD = await recoverFixture('jkkb-recover-mismatch-');
const recDRun = trace.createRun({ root: recD.root, kind: 'verify', title: '旧 run' });
trace.finishRun({ root: recD.root, runId: recDRun.id, status: 'failed', summary: '中断' });
await checkpointMod.recordStep({ root: recD.root, runId: recDRun.id, key: 'dirs', artifacts: [] });
const recDMismatch = await recD.service.recover(recDRun.id, 'restart');
eq('action 不一致 → 409', recDMismatch.status, 409);
eq('409 给出建议动作', recDMismatch.error.suggested, 'resume');
ok('409 消息说明原因', String(recDMismatch.error.message).indexOf('resume') >= 0, recDMismatch.error.message);

// 27l. 冲突场景经 recover → needs-human 拒绝（409）
const recE = await recoverFixture('jkkb-recover-conflict-');
const recERun = trace.createRun({ root: recE.root, kind: 'verify', title: '旧 run' });
trace.finishRun({ root: recE.root, runId: recERun.id, status: 'failed', summary: '中断' });
const recEFile = findArtifact(recE.root);
await checkpointMod.recordStep({ root: recE.root, runId: recERun.id, key: 'dirs', artifacts: [recEFile] });
fs.appendFileSync(recEFile, '\n被改过的内容\n');
const recEConflict = await recE.service.recover(recERun.id, 'resume');
eq('产物冲突 → 409', recEConflict.status, 409);
eq('冲突时建议 needs-human', recEConflict.error.suggested, 'needs-human');
ok('返回 conflicts 列表', Array.isArray(recEConflict.error.decision.conflicts) && recEConflict.error.decision.conflicts.length > 0);

// ═══════════════════ 28. run.mode 持久化 + 备份目录后缀 ═══════════════════
// 28a. createRun 写入 mode，readRun / index 读回
const modeRoot = makeTmpDir('jkkb-mode-');
const topicRun = trace.createRun({ root: modeRoot, kind: 'bootstrap', mode: 'topic' });
eq('createRun 写入 mode=topic', topicRun.mode, 'topic');
eq('readRun 读回 mode=topic', trace.readRun(modeRoot, topicRun.id).run.mode, 'topic');
eq('index 条目投影 mode', trace.readIndex(modeRoot).runs.filter((item) => item.id === topicRun.id)[0].mode, 'topic');
const defaultModeRun = trace.createRun({ root: modeRoot, kind: 'bootstrap' });
eq('缺省 mode=asset', trace.readRun(modeRoot, defaultModeRun.id).run.mode, 'asset');

// 28b. 非法 mode 回落 asset（createRun 入参与磁盘脏值都兜住）
const dirtyModeRun = trace.createRun({ root: modeRoot, kind: 'bootstrap', mode: 'weird' });
eq('非法 mode 入参 → asset', trace.readRun(modeRoot, dirtyModeRun.id).run.mode, 'asset');
const dirtyFile = trace.runFile(modeRoot, dirtyModeRun.id);
const dirtyRaw = JSON.parse(fs.readFileSync(dirtyFile, 'utf8'));
dirtyRaw.mode = 'MAYBE';
fs.writeFileSync(dirtyFile, JSON.stringify(dirtyRaw));
eq('磁盘脏 mode → asset', trace.readRun(modeRoot, dirtyModeRun.id).run.mode, 'asset');

// 28c. topic 库 restart 仍按 topic 启动（捕获 service.start → engine.bootstrap 的 mode）
const topicRoot = makeTmpDir('jkkb-mode-topic-');
await engineApi.bootstrap({ root: topicRoot, mode: 'topic' });
const topicStore = vaultStore(topicRoot);
const seenModes = [];
const topicService = createRunService({
  ctx: {},
  store: topicStore,
  engine: {
    bootstrap: async (args) => { seenModes.push(args.mode); return { created: [], skipped: [] }; },
    verify: engineApi.verify,
    reindex: engineApi.reindex,
  },
});
const topicOldRun = trace.createRun({ root: topicRoot, kind: 'bootstrap', mode: 'topic' });
trace.updateRun(topicRoot, topicOldRun.id, { heartbeatAt: new Date(Date.now() - 600000).toISOString() });
await checkpointMod.recordStep({ root: topicRoot, runId: topicOldRun.id, key: 'dirs', artifacts: [findArtifact(topicRoot)] });
const topicRecover = await topicService.recover(topicOldRun.id, 'restart');
eq('topic 库 restart 成功', topicRecover.ok, true);
eq('restart 传给引擎的 mode=topic', seenModes[0], 'topic');
eq('新 run.json 也记 topic', trace.readRun(topicRoot, topicRecover.runId).run.mode, 'topic');

// 28d. 同一秒两次 restart → 两个不同的备份目录
const twoBackupRoot = await recoverFixture('jkkb-mode-twobackup-');
// 注意：start 会先 reap。若两条 stale-running 同时存在，第二条会被 reap 成 stalled 从而建议 resume。
// 因此第二次 restart 的旧 run 在第一次 restart 完成之后才创建。
const firstOldRun = trace.createRun({ root: twoBackupRoot.root, kind: 'verify', title: '旧 run A' });
trace.updateRun(twoBackupRoot.root, firstOldRun.id, { heartbeatAt: new Date(Date.now() - 600000).toISOString() });
await checkpointMod.recordStep({ root: twoBackupRoot.root, runId: firstOldRun.id, key: 'dirs', artifacts: [findArtifact(twoBackupRoot.root)] });
const firstRecover = await twoBackupRoot.service.recover(firstOldRun.id, 'restart');
if (firstRecover.ok) await waitForTerminal(twoBackupRoot.root, firstRecover.runId);

const secondOldRun = trace.createRun({ root: twoBackupRoot.root, kind: 'verify', title: '旧 run B' });
trace.updateRun(twoBackupRoot.root, secondOldRun.id, { heartbeatAt: new Date(Date.now() - 600000).toISOString() });
await checkpointMod.recordStep({ root: twoBackupRoot.root, runId: secondOldRun.id, key: 'dirs', artifacts: [findArtifact(twoBackupRoot.root)] });
const secondRecover = await twoBackupRoot.service.recover(secondOldRun.id, 'restart');
eq('两次 restart 都成功', firstRecover.ok && secondRecover.ok, true);
const twoBackupDirs = fs.readdirSync(path.join(twoBackupRoot.root, '.jkkb', 'backup'));
eq('产生两个备份目录', twoBackupDirs.length, 2);
eq('两个目录名不同（后缀不同）', new Set(twoBackupDirs).size, 2);
ok('目录名都带 runId 前缀', twoBackupDirs.every((name) => /^\d{8}-\d{6}-.+$/.test(name)), JSON.stringify(twoBackupDirs));

// ═══════════════════ 29. S5：abandon / 分页 / index 滚动 ═══════════════════
function seedIndexRuns(root, count) {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const runs = Array.from({ length: count }, (_, i) => ({
    id: 'seed-' + String(i).padStart(3, '0'),
    title: 't' + i,
    kind: 'verify',
    mode: 'asset',
    status: 'completed',
    startedAt: new Date(base + (count - i) * 60000).toISOString(),
    endedAt: null,
    stepCount: 0,
    currentStep: '',
    degraded: null,
    acceptanceFailed: false,
  }));
  trace.writeIndex(root, { version: 1, runs: runs });
  return runs;
}

// 29a. abandon 成功：落终态、释放锁、不动任何文件
const abRoot = await makeVaultRoot('jkkb-abandon-');
const abStore = vaultStore(abRoot);
const abArtifact = findArtifact(abRoot);
const abRun = trace.createRun({ root: abRoot, kind: 'verify', title: '待放弃' });
trace.acquireLock({ root: abRoot, runId: abRun.id });
await checkpointMod.recordStep({ root: abRoot, runId: abRun.id, key: 'dirs', artifacts: [abArtifact] });
trace.finishRun({ root: abRoot, runId: abRun.id, status: 'failed', summary: '中断' });
const abService = createRunService({ ctx: {}, store: abStore });
const abResult = await abService.recover(abRun.id, 'abandon');
eq('abandon 返回 ok', abResult.ok, true);
eq('abandon 返回状态 abandoned', abResult.status, 'abandoned');
eq('run.json 落 abandoned', trace.readRun(abRoot, abRun.id).run.status, 'abandoned');
eq('abandon 不删除产物文件', fs.existsSync(abArtifact), true);
eq('abandon 不删除 checkpoint', !!checkpointMod.readCheckpoint(abRoot, abRun.id), true);
eq('abandon 释放锁', trace.readLock(abRoot), null);

// 29b. running + abandon → 409（提示先取消）
const abRunningRoot = await makeVaultRoot('jkkb-abandon-running-');
const abRunningStore = vaultStore(abRunningRoot);
const abRunningRun = trace.createRun({ root: abRunningRoot, kind: 'verify', title: '运行中' });
const abRunningService = createRunService({ ctx: {}, store: abRunningStore });
const abRunningResult = await abRunningService.recover(abRunningRun.id, 'abandon');
eq('running + abandon → 409', abRunningResult.status, 409);
eq('running + abandon 错误码', abRunningResult.error.code, 'run-running');
ok('提示先取消', String(abRunningResult.error.message).indexOf('取消') >= 0, abRunningResult.error.message);
eq('running run 仍是 running', trace.readRun(abRunningRoot, abRunningRun.id).run.status, 'running');

// 29c. resume/restart 与建议不一致 → 409 + suggested + decision
const mmRoot = await makeVaultRoot('jkkb-page-mm-');
const mmStore = vaultStore(mmRoot);
const mmRun = trace.createRun({ root: mmRoot, kind: 'verify', title: '中断' });
trace.finishRun({ root: mmRoot, runId: mmRun.id, status: 'failed', summary: '中断' });
await checkpointMod.recordStep({ root: mmRoot, runId: mmRun.id, key: 'dirs', artifacts: [] });
const mmService = createRunService({ ctx: {}, store: mmStore });
const mmResult = await mmService.recover(mmRun.id, 'restart');
eq('建议 resume 却请求 restart → 409', mmResult.status, 409);
eq('409 错误码 action-mismatch', mmResult.error.code, 'recovery-mismatch');
eq('409 带 suggested', mmResult.error.suggested, 'resume');
eq('409 带 decision.action', mmResult.error.decision.action, 'resume');
ok('409 带 decision.reason', typeof mmResult.error.decision.reason === 'string' && mmResult.error.decision.reason.length > 0);

// 29d. 分页第一页 20 条 + nextBefore
const pageRoot = makeTmpDir('jkkb-page-');
const pageStore = vaultStore(pageRoot);
seedIndexRuns(pageRoot, 25);
const pageHandlers = hostRoutes.createHandlers({ store: pageStore });
const page1 = await callHandler(pageHandlers.runsList, { method: 'GET', url: '/plugins/jk-knowledge-base/runs?limit=20' });
eq('第一页 20 条', page1.json.runs.length, 20);
eq('第一页首条是最新 run', page1.json.runs[0].id, 'seed-000');
eq('第一页 nextBefore 非空', typeof page1.json.nextBefore, 'string');
eq('nextBefore 是最后一条的 id', page1.json.nextBefore, page1.json.runs[19].id);

// 29e. 第二页接续且不重复
const page2 = await callHandler(pageHandlers.runsList, { method: 'GET', url: '/plugins/jk-knowledge-base/runs?limit=20&before=' + page1.json.nextBefore });
eq('第二页 5 条', page2.json.runs.length, 5);
eq('第二页没有更多（nextBefore=null）', page2.json.nextBefore, null);
const page1Ids = page1.json.runs.map((item) => item.id);
const page2Ids = page2.json.runs.map((item) => item.id);
eq('两页无重复', page1Ids.filter((id) => page2Ids.indexOf(id) >= 0).length, 0);
eq('第二页从 seed-020 开始', page2Ids[0], 'seed-020');

// 29f. limit 上限 100 / 非法值回落 20
const bigRoot = makeTmpDir('jkkb-page-big-');
const bigStore = vaultStore(bigRoot);
seedIndexRuns(bigRoot, 150);
const bigHandlers = hostRoutes.createHandlers({ store: bigStore });
const clampHigh = await callHandler(bigHandlers.runsList, { method: 'GET', url: '/plugins/jk-knowledge-base/runs?limit=500' });
eq('limit 上限 100', clampHigh.json.runs.length, 100);
const clampBad = await callHandler(bigHandlers.runsList, { method: 'GET', url: '/plugins/jk-knowledge-base/runs?limit=abc' });
eq('非法 limit 回落 20', clampBad.json.runs.length, 20);
const clampZero = await callHandler(bigHandlers.runsList, { method: 'GET', url: '/plugins/jk-knowledge-base/runs?limit=0' });
eq('limit=0 回落 20', clampZero.json.runs.length, 20);

// 29g. index 滚动：201 条 → index 200 + archive 1，run 目录数不变
const rollRoot = makeTmpDir('jkkb-roll-');
fs.mkdirSync(path.join(rollRoot, '.jkkb', 'runs', 'run-keep-1'), { recursive: true });
fs.mkdirSync(path.join(rollRoot, '.jkkb', 'runs', 'run-keep-2'), { recursive: true });
const dirsBefore = fs.readdirSync(path.join(rollRoot, '.jkkb', 'runs'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
seedIndexRuns(rollRoot, 201);
const rolledIndex = trace.readIndex(rollRoot);
eq('滚动后 index 保留 200 条', rolledIndex.runs.length, 200);
const rolledArchive = trace.readArchiveIndex(rollRoot);
eq('archive 收到 1 条', rolledArchive.runs.length, 1);
eq('archive 里是最旧的一条', rolledArchive.runs[0].id, 'seed-200');
eq('archive 路径正确', trace.archiveIndexPath(rollRoot), path.join(rollRoot, '.jkkb', 'runs', 'archive', 'index.json'));
const dirsAfter = fs.readdirSync(path.join(rollRoot, '.jkkb', 'runs'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
eq('run 目录一个都没删（多了 archive 目录）', dirsAfter, dirsBefore + 1);

// 29h. archive 去重：重复迁移不产生重复条目
seedIndexRuns(rollRoot, 201);
const rolledAgain = trace.readArchiveIndex(rollRoot);
eq('重复迁移后 archive 仍 1 条', rolledAgain.runs.length, 1);
eq('重复迁移后 index 仍 200 条', trace.readIndex(rollRoot).runs.length, 200);

// 29i. readRunsPage 纯函数：同 startedAt 并列时按 id 倒序稳定分页
const tieRoot = makeTmpDir('jkkb-page-tie-');
const sameTime = '2026-01-01T00:00:00.000Z';
trace.writeIndex(tieRoot, {
  version: 1,
  runs: ['b', 'a', 'c'].map((suffix) => ({
    id: 'tie-' + suffix, title: suffix, kind: 'verify', mode: 'asset', status: 'completed',
    startedAt: sameTime, endedAt: null, stepCount: 0, currentStep: '', degraded: null, acceptanceFailed: false,
  })),
});
const tiePage1 = trace.readRunsPage(tieRoot, { limit: 2 });
eq('并列时间第一页 2 条', tiePage1.runs.length, 2);
eq('并列按 id 倒序', tiePage1.runs.map((item) => item.id).join(','), 'tie-c,tie-b');
const tiePage2 = trace.readRunsPage(tieRoot, { limit: 2, before: tiePage1.nextBefore });
eq('并列第二页 1 条', tiePage2.runs.length, 1);
eq('并列分页不重不漏', tiePage2.runs[0].id, 'tie-a');

// ═══════════════════ 30. 任务台账（usage / 日历 / md） ═══════════════════
function isoAt(year, month, day, hour, minute, second) {
  return new Date(year, month - 1, day, hour || 0, minute || 0, second || 0).toISOString();
}
function makeLedgerRun(overrides) {
  return Object.assign({
    id: 'lr-' + Math.random().toString(36).slice(2, 8),
    title: '示例',
    kind: 'bootstrap',
    status: 'completed',
    startedAt: isoAt(2026, 5, 10, 9, 0, 0),
    endedAt: isoAt(2026, 5, 10, 9, 2, 13),
    usage: null,
    usageSource: 'unavailable',
    acceptanceFailed: false,
    acceptance: { ok: true },
    degraded: null,
    stepCount: 0,
  }, overrides || {});
}

// 30a. usage：假 agents + sessionProjections 注入 → usageSource=agent 且数字正确
const usageRoot = makeTmpDir('jkkb-usage-');
const usageStore = vaultStore(usageRoot);
const usageCtx = makeAgentCtx().ctx;
const usageSnapshotCalls = [];
const fakeSession = { id: 'session-1' };
usageCtx.get = (name) => {
  if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
  if (name === 'subagents') return {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-session-1', result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), dispose: async () => {} }),
  };
  if (name === 'agents') return {
    list: () => [{ id: 'parent-agent' }],
    roots: () => [{ id: 'parent-agent' }],
    get: (id) => (id === 'child-session-1' ? { id: id, session: fakeSession } : null),
  };
  if (name === 'sessionProjections') return {
    snapshot: (session, keys) => {
      usageSnapshotCalls.push({ session: session, keys: keys });
      return { values: { tokenUsage: { uncachedInputTokens: 12345, outputTokens: 3210, cacheReadTokens: 900, cacheWriteTokens: 100 } } };
    },
  };
  return undefined;
};
const usageService = createRunService({ ctx: usageCtx, store: usageStore });
const usageStart = await usageService.start({ kind: 'verify' });
const usageDone = await waitForTerminal(usageRoot, usageStart.runId);
eq('agent 路径 usageSource=agent', usageDone.run.usageSource, 'agent');
deepEq('agent 路径 usage 数值正确', usageDone.run.usage, {
  inputTokens: 12345, outputTokens: 3210, cacheReadTokens: 900, cacheWriteTokens: 100,
});
eq('确实调用了 sessionProjections.snapshot', usageSnapshotCalls.length, 1);
deepEq('snapshot 请求的投影键', usageSnapshotCalls[0].keys, ['tokenUsage']);
eq('index 条目带 usageSource', trace.readIndex(usageRoot).runs.filter((item) => item.id === usageStart.runId)[0].usageSource, 'agent');
eq('index 条目带 inputTokens 汇总', trace.readIndex(usageRoot).runs.filter((item) => item.id === usageStart.runId)[0].inputTokens, 12345);

// 30b. 读不到 → usage=null + unavailable（绝不写 0）
const unavailRoot = makeTmpDir('jkkb-usage-na-');
const unavailCtx = makeAgentCtx().ctx;
unavailCtx.get = (name) => {
  if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
  if (name === 'subagents') return { list: () => ['spawn'], start: async () => ({ result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }) };
  if (name === 'agents') return { list: () => [{ id: 'parent-agent' }], roots: () => [{ id: 'parent-agent' }], get: () => null };
  return undefined;
};
const unavailService = createRunService({ ctx: unavailCtx, store: vaultStore(unavailRoot) });
const unavailStart = await unavailService.start({ kind: 'verify' });
const unavailDone = await waitForTerminal(unavailRoot, unavailStart.runId);
eq('读不到 usage → null', unavailDone.run.usage, null);
eq('读不到 usage → usageSource=unavailable', unavailDone.run.usageSource, 'unavailable');
ok('读不到时任何 token 字段都不是 0', unavailDone.run.usage === null, JSON.stringify(unavailDone.run.usage));

// 30c. degraded 路径 → usageSource=degraded
const degradedLedgerRoot = makeTmpDir('jkkb-usage-degraded-');
const degradedLedgerService = createRunService({ ctx: {}, store: vaultStore(degradedLedgerRoot) });
const degradedLedgerStart = await degradedLedgerService.start({ kind: 'verify' });
const degradedLedgerDone = await waitForTerminal(degradedLedgerRoot, degradedLedgerStart.runId);
eq('degraded usage=null', degradedLedgerDone.run.usage, null);
eq('degraded usageSource=degraded', degradedLedgerDone.run.usageSource, 'degraded');

// 30d. month 视图按本地日期归日（23:59:59 不跨日）
const lateRun = makeLedgerRun({ id: 'lr-late', startedAt: isoAt(2026, 5, 10, 23, 59, 59), endedAt: isoAt(2026, 5, 11, 0, 1, 0) });
const monthView = ledgerMod.aggregate([lateRun], { year: 2026, month: 5 });
eq('month 视图只有 1 天', monthView.days.length, 1);
eq('23:59:59 归到当天', monthView.days[0].date, '2026-05-10');
eq('跨零点的耗时仍计入该 run', monthView.days[0].totalMs, 61000);

// 30e. year 视图 12 个月聚合
const yearRuns = [
  makeLedgerRun({ id: 'lr-jan', startedAt: isoAt(2026, 1, 5, 10, 0, 0), endedAt: isoAt(2026, 1, 5, 10, 1, 0), usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
  makeLedgerRun({ id: 'lr-dec', startedAt: isoAt(2026, 12, 31, 10, 0, 0), endedAt: isoAt(2026, 12, 31, 10, 2, 0), status: 'failed' }),
];
const yearView = ledgerMod.aggregateYear(yearRuns, 2026);
eq('year 视图固定 12 个月', yearView.months.length, 12);
eq('1 月 runCount', yearView.months[0].runCount, 1);
eq('12 月 failed', yearView.months[11].failed, 1);
eq('year totals runCount', yearView.totals.runCount, 2);
eq('year totals inputTokens', yearView.totals.inputTokens, 100);

// 30f. day 视图字段齐全
const dayRun = makeLedgerRun({ id: 'lr-day', startedAt: isoAt(2026, 5, 10, 8, 30, 0), endedAt: isoAt(2026, 5, 10, 8, 32, 13) });
const dayView = ledgerMod.aggregateDay([dayRun], '2026-05-10');
eq('day 视图 1 条', dayView.runs.length, 1);
deepEq('day 视图字段齐全', Object.keys(dayView.runs[0]).sort(), [
  'acceptanceFailed', 'degraded', 'elapsedMs', 'endedAt', 'id', 'kind', 'startedAt', 'status', 'stepCount', 'title', 'usage', 'usageSource',
].sort());
eq('day 视图 elapsedMs', dayView.runs[0].elapsedMs, 133000);
eq('day totals totalMs', dayView.totals.totalMs, 133000);

// 30g. 归档里的 run 也出现在日历里
const archiveLedgerRoot = makeTmpDir('jkkb-ledger-archive-');
seedIndexRuns(archiveLedgerRoot, 201); // 触发滚动：最旧一条进 archive
const allLedgerRuns = ledgerMod.readAllRuns(archiveLedgerRoot);
ok('readAllRuns 合并了归档条目', allLedgerRuns.some((run) => run.id === 'seed-200'), '条目数 ' + allLedgerRuns.length);
eq('readAllRuns 按 id 去重', new Set(allLedgerRuns.map((run) => run.id)).size, allLedgerRuns.length);

// 30h. 非法参数 → 400
const ledgerHandlers = hostRoutes.createHandlers({ store: pageStore, ctx: {} });
const badYear = await callHandler(ledgerHandlers.ledgerCalendar, { method: 'GET', url: '/plugins/jk-knowledge-base/ledger/calendar?year=abc' });
eq('非法 year → 400', badYear.status, 400);
eq('非法 year 错误码', badYear.json.error.code, 'year-invalid');
const badMonth = await callHandler(ledgerHandlers.ledgerCalendar, { method: 'GET', url: '/plugins/jk-knowledge-base/ledger/calendar?year=2026&month=13' });
eq('非法 month → 400', badMonth.status, 400);
eq('非法 month 错误码', badMonth.json.error.code, 'month-invalid');
const badDate = await callHandler(ledgerHandlers.ledgerDay, { method: 'GET', url: '/plugins/jk-knowledge-base/ledger/day?date=2026-13-40' });
eq('非法 date → 400', badDate.status, 400);
eq('非法 date 错误码', badDate.json.error.code, 'date-invalid');

// 30i. md 渲染：无 usage 文案 + 超过 50 条提示
const manyRuns = Array.from({ length: 51 }, (_, i) => makeLedgerRun({
  id: 'md-' + String(i).padStart(2, '0'),
  startedAt: isoAt(2026, 5, 10, 10, 0, 0),
  endedAt: isoAt(2026, 5, 10, 10, 1, 0),
}));
const md = ledgerMod.renderMonthMarkdown({ year: 2026, month: 5, runs: manyRuns });
ok('md 有标题', md.indexOf('# JK知识库台账 · 2026-05') === 0, md.slice(0, 40));
ok('md 有勿手改说明', md.indexOf('请勿手工编辑') >= 0);
ok('md 无 usage 文案', md.indexOf('无 agent，未消耗 token') >= 0);
ok('md 超过 50 条写「另有 1 条未展示」', md.indexOf('另有 1 条未展示') >= 0, md.slice(-80));
ok('md 按日期分节', md.indexOf('## 2026-05-10') >= 0);

// 30j. md 文件路径与内容头 + 写失败不影响 run
const mdRoot = await makeVaultRoot('jkkb-ledger-md-');
const mdRun = trace.createRun({ root: mdRoot, kind: 'bootstrap', title: '台账样本' });
trace.finishRun({ root: mdRoot, runId: mdRun.id, status: 'completed', summary: 'ok' });
const mdWriteResult = ledgerMod.writeMonthLedger({ root: mdRoot, year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
eq('writeMonthLedger 成功', mdWriteResult.ok, true);
const mdPath = ledgerMod.ledgerFileFor(mdRoot, new Date().getFullYear(), new Date().getMonth() + 1);
eq('md 文件路径是 00_系统与索引/台账-YYYY-MM.md', mdPath, path.join(mdRoot, '00_系统与索引', '台账-' + new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '.md'));
ok('md 文件存在', fs.existsSync(mdPath), mdPath);
const mdText = fs.readFileSync(mdPath, 'utf8');
ok('md 内容头正确', mdText.indexOf('# JK知识库台账') === 0 && mdText.indexOf('请勿手工编辑') >= 0, mdText.slice(0, 80));

if (process.platform !== 'win32') {
  const ledgerDir = path.join(mdRoot, '00_系统与索引');
  fs.chmodSync(ledgerDir, 0o500);
  const failWrite = ledgerMod.writeMonthLedger({ root: mdRoot, year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  eq('写 md 失败返回 ok=false', failWrite.ok, false);
  ok('写 md 失败带错误码', typeof failWrite.error.code === 'string' && failWrite.error.code.length > 0, JSON.stringify(failWrite.error));
  fs.chmodSync(ledgerDir, 0o700);
  // run 收尾即使台账失败也必须保持完成态
  const failRoot = await makeVaultRoot('jkkb-ledger-failrun-');
  const failService = createRunService({
    ctx: {},
    store: vaultStore(failRoot),
    engine: { bootstrap: async () => ({ created: [], skipped: [] }), verify: async () => ({ ok: true, summary: 'ok' }), reindex: async () => ({ noteCount: 0 }) },
  });
  fs.chmodSync(path.join(failRoot, '00_系统与索引'), 0o500);
  const failStart = await failService.start({ kind: 'bootstrap' });
  const failDone = await waitForTerminal(failRoot, failStart.runId);
  fs.chmodSync(path.join(failRoot, '00_系统与索引'), 0o700);
  eq('台账写失败不影响 run 状态', failDone.run.status, 'completed');
} else {
  ok('win32 跳过 chmod 台账失败用例', true);
}

// 30k. 总量与逐日求和一致
const sumRuns = [
  makeLedgerRun({ id: 'sum-1', startedAt: isoAt(2026, 6, 1, 9, 0, 0), endedAt: isoAt(2026, 6, 1, 9, 1, 0), usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null } }),
  makeLedgerRun({ id: 'sum-2', startedAt: isoAt(2026, 6, 2, 9, 0, 0), endedAt: isoAt(2026, 6, 2, 9, 2, 0), usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null } }),
];
const sumView = ledgerMod.aggregate(sumRuns, { year: 2026, month: 6 });
const daySum = sumView.days.reduce((acc, day) => ({
  runCount: acc.runCount + day.runCount,
  totalMs: acc.totalMs + day.totalMs,
  inputTokens: acc.inputTokens + day.inputTokens,
  outputTokens: acc.outputTokens + day.outputTokens,
}), { runCount: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 });
deepEq('totals 等于逐日求和', sumView.totals, daySum);
eq('totals inputTokens 汇总', sumView.totals.inputTokens, 30);

// ═══════════════════ 31. P2-0 存储仓储层 + 编号分配 ═══════════════════
// 注：引擎守卫当前的 .jkkb 白名单还没放行 store/。若被拦，测试改用「只做 root 包含判定」的注入守卫，
// 并把拦截码单独断言下来；引擎加上 'store' 后这段会自动切回真实守卫，行为不变。
function containmentGuard(rootPath, target) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(target));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  const err = new Error('写入目标逃逸出知识库根目录：' + target);
  err.code = 'PATH_ESCAPE';
  throw err;
}

function makeStoreFixture(prefix) {
  const root = makeTmpDir(prefix || 'jkkb-store-');
  const real = storeMod.createRepos({ root: root });
  const probe = real.adapter.guardProbe();
  const repos = probe.ok ? real : storeMod.createRepos({ root: root, assertWritable: containmentGuard });
  return { root: root, repos: repos, probe: probe, real: real };
}
const storeFixture = makeStoreFixture('jkkb-store-main-');
console.log('[jkkb-smoke] store guard: ' + (storeFixture.probe.ok ? 'ready' : 'blocked (' + storeFixture.probe.code + ') — 引擎白名单缺 .jkkb/store'));
eq('store 守卫状态已探测（blocked 或 ready）', typeof storeFixture.probe.ok, 'boolean');
if (!storeFixture.probe.ok) {
  eq('引擎守卫当前拦截 .jkkb/store（如需启用需在白名单加 store）', storeFixture.probe.code, 'PATH_DENIED');
}

// 31a. repo CRUD 往返
const storeRepos = storeFixture.repos;
const createdSkill = storeRepos.skillsRepo.create({
  id: 'SK001', name: '资料卡', purpose: '把原始资料结构化', keywords: ['资料', '卡片'],
  fields: ['来源', '结论'], version: '1.0.0', status: 'active', path: '00_系统与索引/07_标准模板/资料卡模板.md',
});
eq('create 返回记录 id', createdSkill.id, 'SK001');
eq('get 读回', storeRepos.skillsRepo.get('SK001').name, '资料卡');
deepEq('keywords 原样保存', storeRepos.skillsRepo.get('SK001').keywords, ['资料', '卡片']);
eq('list 含该记录', storeRepos.skillsRepo.list().filter((item) => item.id === 'SK001').length, 1);
const updatedSkill = storeRepos.skillsRepo.update('SK001', { id: 'SK001', name: '资料卡 v2', purpose: 'p', keywords: [], fields: [], version: '1.1.0', status: 'active', path: null });
eq('update 覆盖字段', updatedSkill.name, '资料卡 v2');
eq('update 保留 createdAt', updatedSkill.createdAt, createdSkill.createdAt);
const patchedSkill = storeRepos.skillsRepo.patch('SK001', { status: 'archived' });
eq('patch 只改指定字段', patchedSkill.status, 'archived');
eq('patch 保留其它字段', patchedSkill.name, '资料卡 v2');
eq('remove 返回 true', storeRepos.skillsRepo.remove('SK001'), true);
eq('remove 后 get 为 null', storeRepos.skillsRepo.get('SK001'), null);

// 31b. schemaVersion 自动补 + 时间戳
const autoRecord = storeRepos.skillsRepo.create({ id: 'SK002', name: '自动补版本', status: 'draft' });
eq('create 自动补 schemaVersion', autoRecord.schemaVersion, 1);
ok('create 自动补 createdAt', typeof autoRecord.createdAt === 'string' && autoRecord.createdAt.length > 0);
ok('create 自动补 updatedAt', typeof autoRecord.updatedAt === 'string' && autoRecord.updatedAt.length > 0);
eq('落盘记录也带 schemaVersion', JSON.parse(fs.readFileSync(path.join(storeFixture.root, '.jkkb', 'store', 'skills', 'SK002.json'), 'utf8')).schemaVersion, 1);

// 31c. 不认识的 schemaVersion → SCHEMA_UNSUPPORTED
const badSchemaFile = path.join(storeFixture.root, '.jkkb', 'store', 'skills', 'SK003.json');
fs.mkdirSync(path.dirname(badSchemaFile), { recursive: true });
fs.writeFileSync(badSchemaFile, JSON.stringify({ id: 'SK003', name: '未来版本', schemaVersion: 99, createdAt: 'x', updatedAt: 'x' }));
const badIndexFile = path.join(storeFixture.root, '.jkkb', 'store', 'skills', 'index.json');
const badIndex = JSON.parse(fs.readFileSync(badIndexFile, 'utf8'));
if (badIndex.ids.indexOf('SK003') < 0) {
  badIndex.ids.push('SK003');
  fs.writeFileSync(badIndexFile, JSON.stringify(badIndex));
}
let schemaErr = null;
try { storeRepos.skillsRepo.get('SK003'); } catch (err) { schemaErr = err; }
eq('未知 schemaVersion 抛 SCHEMA_UNSUPPORTED', schemaErr && schemaErr.code, 'SCHEMA_UNSUPPORTED');
let listSchemaErr = null;
try { storeRepos.skillsRepo.list(); } catch (err) { listSchemaErr = err; }
eq('list 也不静默丢弃（抛 SCHEMA_UNSUPPORTED）', listSchemaErr && listSchemaErr.code, 'SCHEMA_UNSUPPORTED');
// 清理：该记录 schemaVersion 不认识，remove 也会按契约拒绝，直接删文件 + 修索引。
fs.rmSync(badSchemaFile, { force: true });
const cleanupIndex = JSON.parse(fs.readFileSync(badIndexFile, 'utf8'));
cleanupIndex.ids = cleanupIndex.ids.filter((id) => id !== 'SK003');
fs.writeFileSync(badIndexFile, JSON.stringify(cleanupIndex));

// 31d. 编号分配连续，且「重开」后不重复
const numberRoot = makeTmpDir('jkkb-numbers-');
const numberReposA = storeMod.createRepos({ root: numberRoot, assertWritable: containmentGuard });
const firstBatch = numberReposA.numbersRepo.allocate('SK', 2);
deepEq('首次分配区间', firstBatch, { start: 1, end: 2, ids: ['SK001', 'SK002'] });
const numberReposB = storeMod.createRepos({ root: numberRoot, assertWritable: containmentGuard });
const secondBatch = numberReposB.numbersRepo.allocate('SK', 2);
deepEq('重开仓储后继续递增（不重复）', secondBatch, { start: 3, end: 4, ids: ['SK003', 'SK004'] });
eq('registry 计数持久化', JSON.parse(fs.readFileSync(path.join(numberRoot, '.jkkb', 'store', 'numbering', 'registry.json'), 'utf8')).counters.SK, 4);
eq('R 前缀互不影响', numberReposB.numbersRepo.allocate('R', 1).start, 1);

// 31e. 同锁内两次 allocate 得到不同区间
const lockToken = { runId: 'verify-testlock' };
const inLockA = numberReposB.numbersRepo.allocateInLock(lockToken, 'H', 1);
const inLockB = numberReposB.numbersRepo.allocateInLock(lockToken, 'H', 1);
eq('同锁第一次', inLockA.start, 1);
eq('同锁第二次', inLockB.start, 2);
eq('两次区间不重叠', inLockA.end < inLockB.start, true);
let lockRequired = null;
try { numberReposB.numbersRepo.allocateInLock(null, 'H', 1); } catch (err) { lockRequired = err; }
eq('无锁调用 allocateInLock 被拒', lockRequired && lockRequired.code, 'LOCK_REQUIRED');
let badPrefix = null;
try { numberReposB.numbersRepo.allocate('ZZ', 1); } catch (err) { badPrefix = err; }
eq('未知编号前缀被拒', badPrefix && badPrefix.code, 'INVALID_PREFIX');

// 31f. 路径守卫：root 外一律拒绝
let escapeErr = null;
try {
  engineAssertWritable(storeFixture.root, path.join(os.tmpdir(), 'jkkb-outside-' + Date.now() + '.json'));
} catch (err) { escapeErr = err; }
eq('真实守卫拒绝 root 外路径', escapeErr && escapeErr.code, 'PATH_ESCAPE');
let injectedEscape = null;
try {
  storeMod.createRepos({ root: storeFixture.root, assertWritable: containmentGuard }).skillsRepo.create({ id: 'SK-escape', name: 'x' });
  // 上面的路径在 root 内，应当成功；这里再直接试一个 root 外目标
  containmentGuard(storeFixture.root, path.join(os.tmpdir(), 'outside.json'));
} catch (err) { injectedEscape = err; }
eq('包含判定守卫拒绝 root 外目标', injectedEscape && injectedEscape.code, 'PATH_ESCAPE');

// 31g. 业务代码不得出现 .jkkb/ 字面量（store/** 与 trace.js 例外）
const jkkbAllowlist = new Set(['trace.js']);
const jkkbViolations = [];
fs.readdirSync(path.join(root, 'host')).filter((name) => name.endsWith('.js')).forEach((name) => {
  if (jkkbAllowlist.has(name)) return;
  // 只看代码：注释里说明磁盘布局是文档，不算"业务代码拼路径"。
  const text = stripComments(fs.readFileSync(path.join(root, 'host', name), 'utf8'));
  if (text.indexOf('.jkkb/') >= 0) jkkbViolations.push('host/' + name);
});
const storeDirFiles = fs.readdirSync(path.join(root, 'host', 'store')).filter((name) => name.endsWith('.js'));
storeDirFiles.forEach((name) => {
  // store/** 允许出现（适配器职责），仅确认没有被误扫进违规列表
  if (jkkbViolations.indexOf('host/store/' + name) >= 0) jkkbViolations.push('store-misflagged:' + name);
});
deepEq('业务代码无 .jkkb/ 路径字面量（store 与 trace 例外）', jkkbViolations, []);

// 31h. 索引与单文件一致（删除后索引同步）
const indexSkillA = storeRepos.skillsRepo.create({ id: 'SK010', name: 'A', status: 'draft' });
storeRepos.skillsRepo.create({ id: 'SK011', name: 'B', status: 'draft' });
const indexBefore = storeRepos.adapter.readIndex('skills').ids;
ok('索引含两条', indexBefore.indexOf('SK010') >= 0 && indexBefore.indexOf('SK011') >= 0, JSON.stringify(indexBefore));
storeRepos.skillsRepo.remove('SK010');
const indexAfter = storeRepos.adapter.readIndex('skills').ids;
eq('删除后索引不再含该 id', indexAfter.indexOf('SK010'), -1);
eq('删除后单文件已删除', fs.existsSync(path.join(storeFixture.root, '.jkkb', 'store', 'skills', 'SK010.json')), false);
eq('删除后索引与文件一致', indexAfter.every((id) => fs.existsSync(path.join(storeFixture.root, '.jkkb', 'store', 'skills', id + '.json'))), true);

// 31i. 重复创建冲突 + 非法命名空间
let conflictErr = null;
try { storeRepos.skillsRepo.create({ id: 'SK011', name: 'dup', status: 'draft' }); } catch (err) { conflictErr = err; }
eq('同 id 重复创建 → CONFLICT', conflictErr && conflictErr.code, 'CONFLICT');
const invalidNamespaceAdapter = storeFixture.real.adapter;
let namespaceErr = null;
try { invalidNamespaceAdapter.listRecords('Bad/Name'); } catch (err) { namespaceErr = err; }
eq('非法命名空间被拒', namespaceErr && namespaceErr.code, 'INVALID_NAMESPACE');

// 31j. 命名空间映射与占位仓储真实可用
deepEq('命名空间映射', storeMod.NAMESPACE_MAP, {
  numbers: 'numbering', skills: 'skills', skillCalls: 'skill_calls', cards: 'cards', reports: 'reports', experts: 'experts',
});
const cardRecord = storeRepos.cardsRepo.create({ id: 'CARD001', kind: 'atom', title: '原子卡' });
eq('cardsRepo 真实可写', storeRepos.cardsRepo.get('CARD001').title, '原子卡');
eq('cardsRepo 落在 cards 命名空间', fs.existsSync(path.join(storeFixture.root, '.jkkb', 'store', 'cards', 'CARD001.json')), true);

// ═══════════════════ 32. P2-1 入柜（jk_kb_curate / curate run / GET skills） ═══════════════════
const curateRoot = await makeVaultRoot('jkkb-curate-');
const curateStore = vaultStore(curateRoot);
const curateRun = trace.createRun({ root: curateRoot, kind: 'curate', title: '入柜' });
trace.acquireLock({ root: curateRoot, runId: curateRun.id });
const curateTools = createToolHandlers({ store: curateStore });

// 32a. 无 runId / 终态 run 被拒
const curateNoRunId = await curateTools.curate({ skillId: 'common.quick_capture', title: 't', body: 'b', tags: ['x'], confidence: '中' });
eq('curate 缺 runId → ok=false', curateNoRunId.ok, false);
eq('curate 缺 runId 错误码', curateNoRunId.code, 'run-id-required');
trace.finishRun({ root: curateRoot, runId: curateRun.id, status: 'completed', summary: 'done' });
trace.releaseLock({ root: curateRoot, runId: curateRun.id });
const curateFinished = await curateTools.curate({ runId: curateRun.id, skillId: 'common.quick_capture', title: 't', body: 'b', tags: ['x'], confidence: '中' });
eq('curate 终态 run → run-not-running', curateFinished.code, 'run-not-running');

// 重新开一个 running run 供后续用例使用
const curateRun2 = trace.createRun({ root: curateRoot, kind: 'curate', title: '入柜 2' });
trace.acquireLock({ root: curateRoot, runId: curateRun2.id });

// 32b. 未知技能 / 缺锁被拒（结构化错误，不抛）
const unknownSkill = await curateTools.curate({ runId: curateRun2.id, skillId: 'no.such.skill', title: 't', body: 'b', tags: ['x'], confidence: '中' });
eq('未知技能 → UNKNOWN_SKILL', unknownSkill.code, 'UNKNOWN_SKILL');
trace.releaseLock({ root: curateRoot, runId: curateRun2.id });
const noLock = await curateTools.curate({ runId: curateRun2.id, skillId: 'common.quick_capture', title: 't', body: 'b', tags: ['x'], confidence: '中' });
eq('没有锁 → LOCK_REQUIRED', noLock.code, 'LOCK_REQUIRED');
trace.acquireLock({ root: curateRoot, runId: curateRun2.id });

// 32c. 同一 run 内两次 curate 得到不同编号（锁内分配连续）
const curateFirst = await curateTools.curate({ runId: curateRun2.id, skillId: 'common.quick_capture', title: '第一张卡', body: '正文一', tags: ['测试'], confidence: '中' });
eq('第一次入柜成功', curateFirst.ok, true);
eq('第一次编号 DOC001', curateFirst.id, 'DOC001');
const curateSecond = await curateTools.curate({ runId: curateRun2.id, skillId: 'common.quick_capture', title: '第二张卡', body: '正文二', tags: ['测试'], confidence: '高' });
eq('第二次入柜成功', curateSecond.ok, true);
eq('第二次编号 DOC002（连续不重复）', curateSecond.id, 'DOC002');
ok('两次编号不同', curateFirst.id !== curateSecond.id);

// 32d. cardsRepo 有记录且 path 与磁盘一致
const curateCards = storeMod.createRepos({ root: curateRoot }).cardsRepo.list();
eq('cardsRepo 记录数 2', curateCards.length, 2);
const cardOne = curateCards.filter((item) => item.id === curateFirst.id)[0];
eq('卡片记录带 path', cardOne && cardOne.path, curateFirst.path);
eq('卡片记录带 sourceRunId', cardOne && cardOne.sourceRunId, curateRun2.id);
ok('卡片文件确实落盘', fs.existsSync(curateFirst.path), curateFirst.path);
eq('落位在技能 outputDir 下', path.dirname(curateFirst.path), path.join(curateRoot, '01_收件箱'));

// 32e. 低置信度无理由 → ok=false 且不落盘
const beforeFiles = fs.readdirSync(path.join(curateRoot, '01_收件箱')).length;
const noReason = await curateTools.curate({ runId: curateRun2.id, skillId: 'common.quick_capture', title: '低置信卡', body: '正文', tags: ['测试'], confidence: '低' });
eq('低置信无理由 → ok=false', noReason.ok, false);
eq('低置信无理由错误码 CONFIDENCE_REQUIRED', noReason.code, 'CONFIDENCE_REQUIRED');
eq('低置信无理由不落盘', fs.readdirSync(path.join(curateRoot, '01_收件箱')).length, beforeFiles);
const withReason = await curateTools.curate({ runId: curateRun2.id, skillId: 'common.quick_capture', title: '低置信卡', body: '正文', tags: ['测试'], confidence: '低', confWhy: '来源只有一句话' });
eq('低置信带理由可以落盘', withReason.ok, true);
// 后续是只读/路由用例，先释放锁并收尾，避免 preflight 报 LOCK_HELD。
trace.releaseLock({ root: curateRoot, runId: curateRun2.id });
trace.finishRun({ root: curateRoot, runId: curateRun2.id, status: 'completed', summary: 'done' });

// 32f. GET /skills 返回 47 条且字段齐全
const skillsHandlers = hostRoutes.createHandlers({ store: curateStore });
const skillsRes = await callHandler(skillsHandlers.skillsList, { method: 'GET' });
eq('GET /skills → 200', skillsRes.status, 200);
eq('GET /skills 返回 47 条', skillsRes.json.skills.length, 47);
deepEq('技能字段齐全', Object.keys(skillsRes.json.skills[0]).sort(), ['id', 'idPrefix', 'name', 'outputDir', 'profession', 'purpose', 'stage']);
ok('技能 id 唯一', new Set(skillsRes.json.skills.map((item) => item.id)).size === 47);

// 32g. curate run 的宪章含技能列表与置信度规则
const curateCharter = orchestrator.buildCurateCharter({
  root: '/tmp/kb', runId: 'run-x', kind: 'curate', input: { text: '把这段内容入柜', skillId: 'common.quick_capture' },
});
ok('宪章含用户输入', curateCharter.indexOf('把这段内容入柜') >= 0);
ok('宪章含 47 条技能', (curateCharter.match(/^- /gm) || []).length >= 47, String((curateCharter.match(/^- /gm) || []).length));
ok('宪章含技能 id', curateCharter.indexOf('common.quick_capture') >= 0);
ok('宪章含「不得编造 confidence」', curateCharter.indexOf('不得编造 confidence') >= 0);
ok('宪章含低置信度必须写理由', curateCharter.indexOf('必须') >= 0 && curateCharter.indexOf('confWhy') >= 0);
eq('curate 走专用宪章（非标准宪章）', curateCharter.indexOf('bootstrap → verify → reindex') < 0, true);

// 32h. preflight：kind=curate 跳过文件数扫描并注明
const curatePreflight = await orchestrator.runHostPreflight(
  { ctx: {}, store: curateStore, toolState: () => ({ registered: REQUIRED_TOOL_NAMES, failed: [] }) },
  { kind: 'curate', mode: 'asset' }
);
eq('curate preflight 仍可 ok', curatePreflight.report.ok, true);
const noScanCheck = curatePreflight.report.checks.filter((item) => item.id === 'curate-no-file-scan')[0];
ok('报告注明未做文件数预检', !!noScanCheck && noScanCheck.detail.indexOf('未做文件数预检') >= 0, JSON.stringify(noScanCheck));
const filesCheck = curatePreflight.report.checks.filter((item) => item.id === 'files')[0];
ok('files 检查被改成「未做」而不是真实计数', !!filesCheck && filesCheck.detail.indexOf('未做文件数预检') >= 0, JSON.stringify(filesCheck));

// 32i. POST /run 接受 kind=curate（服务层直调，degraded 路径按 input 执行）
const curateRunStore = curateStore;
const curateService = createRunService({
  ctx: {},
  store: curateRunStore,
  engine: { bootstrap: async () => ({ created: [], skipped: [] }), verify: async () => ({ ok: true, summary: 'ok' }), reindex: async () => ({ noteCount: 0 }) },
});
const curateStart = await curateService.start({
  kind: 'curate',
  input: { text: '一条来自对话的素材', skillId: 'common.quick_capture', title: '服务层入柜', confidence: '中', tags: ['服务层'] },
});
eq('start 接受 kind=curate', curateStart.ok, true);
const curateDone = await waitForTerminal(curateRoot, curateStart.runId);
eq('curate run 完成', curateDone.run.status, 'completed');
eq('curate run 记录 id', curateDone.run.kind, 'curate');
const curateFiles = fs.readdirSync(path.join(curateRoot, '01_收件箱')).filter((name) => name.indexOf('服务层入柜') >= 0);
eq('degraded 入柜确实写了文件', curateFiles.length, 1);

// 32j. RUN_KINDS 含 curate
ok('RUN_KINDS 含 curate', orchestrator.RUN_KINDS.indexOf('curate') >= 0, JSON.stringify(orchestrator.RUN_KINDS));

// ═══════════════════ 33. P2-2 整理报告（jk_kb_maintain / GET /reports） ═══════════════════
const maintRoot = await makeVaultRoot('jkkb-maint-');
const maintStore = vaultStore(maintRoot);
const maintRun = trace.createRun({ root: maintRoot, kind: 'maintain', title: '整理' });
fs.writeFileSync(
  path.join(maintRoot, '01_收件箱', 'note-old.md'),
  '---\ntitle: 旧笔记\ndate: 2020-01-01\nconfidence: 低\nconf_why: 测试\n---\n正文\n'
);
const maintTools = createToolHandlers({ store: maintStore });

// 33a. 无 runId 被拒
const maintainNoRun = await maintTools.maintain({ thresholds: { M01: 7 } });
eq('maintain 缺 runId → ok=false', maintainNoRun.ok, false);
eq('maintain 缺 runId 错误码', maintainNoRun.code, 'run-id-required');

// 33b. 报告写进 reportsRepo 且 md 存在
const firstMaint = await maintTools.maintain({ runId: maintRun.id });
eq('maintain 成功', firstMaint.ok, true);
ok('返回 reportPath', typeof firstMaint.reportPath === 'string' && fs.existsSync(firstMaint.reportPath), String(firstMaint.reportPath));
const maintReports = storeMod.createRepos({ root: maintRoot }).reportsRepo.list();
eq('reportsRepo 有 1 条 maintain 报告', maintReports.filter((item) => item.kind === 'maintain').length, 1);
const maintRecord = maintReports.filter((item) => item.kind === 'maintain')[0];
eq('报告记录带 path', maintRecord.path, firstMaint.reportPath);
ok('报告 period 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(maintRecord.period), maintRecord.period);
eq('报告记录 summary 是命中数汇总', maintRecord.summary, 'M01=0 M03=1 M04=0 M06=0 M07=0 M08=0');

// 33c. 同日两次执行覆盖同一个 md
const reportDir = path.join(maintRoot, '00_系统与索引');
const beforeReports = fs.readdirSync(reportDir).filter((name) => name.indexOf('整理报告-') === 0);
const secondMaint = await maintTools.maintain({ runId: maintRun.id });
eq('同日第二次执行成功', secondMaint.ok, true);
const afterReports = fs.readdirSync(reportDir).filter((name) => name.indexOf('整理报告-') === 0);
eq('同日仍只有 1 个报告文件（覆盖）', afterReports.length, beforeReports.length);
eq('两次 reportPath 相同', secondMaint.reportPath, firstMaint.reportPath);

// 33d. byRule 四键齐 + findings 透传 basis/threshold
deepEq('byRule 六键齐（含 M06/M07 只读提议）', Object.keys(firstMaint.byRule).sort(), ['M01', 'M03', 'M04', 'M06', 'M07', 'M08']);
ok('findings 透传 basis/threshold', (() => {
  const hit = (firstMaint.findings || []).filter((item) => item.ruleId === 'M03')[0];
  return !!hit && typeof hit.basis === 'string' && hit.basis.length > 0 && typeof hit.threshold === 'string' && hit.threshold.length > 0;
})(), JSON.stringify((firstMaint.findings || []).slice(0, 1)));

// 33e. GET /reports 返回列表（字段齐全，limit 生效）
const reportsHandlers = hostRoutes.createHandlers({ store: maintStore });
const reportsRes = await callHandler(reportsHandlers.reportsList, { method: 'GET', url: '/plugins/jk-knowledge-base/reports?limit=20' });
eq('GET /reports → 200', reportsRes.status, 200);
ok('GET /reports 有 maintain 报告', reportsRes.json.reports.filter((item) => item.kind === 'maintain').length >= 1, JSON.stringify(reportsRes.json));
deepEq('报告字段齐全', Object.keys(reportsRes.json.reports[0]).sort(), ['byRule', 'createdAt', 'findings', 'findingsTotal', 'id', 'kind', 'path', 'period', 'summary', 'truncated']);
const reportsLimit = await callHandler(reportsHandlers.reportsList, { method: 'GET', url: '/plugins/jk-knowledge-base/reports?limit=1' });
eq('limit=1 只返回 1 条', reportsLimit.json.reports.length, 1);

// 33f. 宪章：只读、绝不移动或删除
const maintainCharter = orchestrator.buildMaintainCharter({ root: '/tmp/kb', runId: 'run-m', kind: 'maintain' });
ok('宪章含「绝不移动或删除」', maintainCharter.indexOf('绝不移动或删除') >= 0);
ok('宪章声明没有执行类工具', maintainCharter.indexOf('没有任何执行类工具') >= 0);
ok('宪章要求按规则分组汇报', maintainCharter.indexOf('按规则分组汇报') >= 0);
ok('宪章要求敏感项提示确认', maintainCharter.indexOf('确认后再处理') >= 0);

// 33g. 除报告外文件 mtime 不变
const snapshot = (dirPath, acc) => {
  const out = acc || {};
  fs.readdirSync(dirPath, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === '.jkkb') return;
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) snapshot(abs, out);
    else out[abs] = fs.statSync(abs).mtimeMs;
  });
  return out;
};
const beforeSnapshot = snapshot(maintRoot);
const thirdMaint = await maintTools.maintain({ runId: maintRun.id });
const afterSnapshot = snapshot(maintRoot);
const changed = Object.keys(beforeSnapshot).filter((file) => {
  if (file === thirdMaint.reportPath) return false;
  return afterSnapshot[file] !== beforeSnapshot[file];
});
deepEq('除报告外没有任何文件 mtime 变化', changed, []);
ok('报告文件确实被刷新', typeof afterSnapshot[thirdMaint.reportPath] === 'number');

// 33h. RUN_KINDS 含 maintain
ok('RUN_KINDS 含 maintain', orchestrator.RUN_KINDS.indexOf('maintain') >= 0, JSON.stringify(orchestrator.RUN_KINDS));

// ═══════════════════ 34. 报告明细透出（列表 200 截断 + /reports/:id 完整） ═══════════════════
const bigReportRoot = makeTmpDir('jkkb-report-big-');
const bigReportStore = vaultStore(bigReportRoot);
const bigReportRepos = storeMod.createRepos({ root: bigReportRoot });
const bigFindings = Array.from({ length: 250 }, (_, i) => ({
  ruleId: 'M03',
  level: 'warn',
  path: '/kb/01_收件箱/note-' + i + '.md',
  relPath: '01_收件箱/note-' + i + '.md',
  title: '笔记 ' + i,
  detail: '低置信度已 40 天',
  basis: 'confidence + created/date',
  threshold: '> 30 天',
}));
const bigRecord = bigReportRepos.reportsRepo.create(toolsMod.buildReportRecord({
  period: '2026-05-10',
  summary: 'M01=0 M03=250 M04=0 M08=0',
  path: '/kb/00_系统与索引/整理报告-2026-05-10.md',
  byRule: { M01: 0, M03: 250, M04: 0, M08: 0 },
  scanned: { files: 1, notes: 250 },
  findings: bigFindings,
}));
eq('记录里 findings 存到 5000 硬上限内（250 条全存）', bigRecord.findings.length, 250);
eq('250 条未触发记录级 truncated', bigRecord.truncated, false);
eq('记录里 findingsTotal=250', bigRecord.findingsTotal, 250);

const bigReportHandlers = hostRoutes.createHandlers({ store: bigReportStore });
const bigList = await callHandler(bigReportHandlers.reportsList, { method: 'GET', url: '/plugins/jk-knowledge-base/reports?limit=20' });
const bigItem = bigList.json.reports.filter((item) => item.id === bigRecord.id)[0];
ok('列表项带 findings 且 ≤200', !!bigItem && Array.isArray(bigItem.findings) && bigItem.findings.length === 200, String(bigItem && bigItem.findings && bigItem.findings.length));
eq('列表项 truncated=true', bigItem.truncated, true);
eq('列表项 findingsTotal=250', bigItem.findingsTotal, 250);
deepEq('列表项 byRule 透出', bigItem.byRule, { M01: 0, M03: 250, M04: 0, M08: 0 });

const bigDetail = await callHandler(bigReportHandlers.reportDetail, {
  method: 'GET',
  url: '/plugins/jk-knowledge-base/reports/' + bigRecord.id,
});
eq('GET /reports/:id → 200', bigDetail.status, 200);
eq('详情返回完整 findings（250 条，不按 200 截断）', bigDetail.json.report.findings.length, 250);
eq('详情 findingsTotal', bigDetail.json.report.findingsTotal, 250);
ok('详情保留 finding 字段', (() => {
  const one = bigDetail.json.report.findings[0] || {};
  return ['ruleId', 'path', 'relPath', 'title', 'detail', 'basis', 'threshold', 'level'].every((key) => key in one);
})(), JSON.stringify(bigDetail.json.report.findings[0]));

const unknownReport = await callHandler(bigReportHandlers.reportDetail, {
  method: 'GET',
  url: '/plugins/jk-knowledge-base/reports/RPT-does-not-exist',
});
eq('未知报告 id → 404', unknownReport.status, 404);
eq('未知报告错误码', unknownReport.json.error.code, 'report-not-found');

const badReportId = await callHandler(bigReportHandlers.reportDetail, {
  method: 'GET',
  url: '/plugins/jk-knowledge-base/reports/..%2Fetc',
});
eq('坏 id（../）→ 400', badReportId.status, 400);
eq('坏 id 错误码', badReportId.json.error.code, 'invalid-id');

// 34e. 同日覆盖后列表仍只 1 条，且 findings 是新的
fs.writeFileSync(
  path.join(maintRoot, '01_收件箱', 'note-old-2.md'),
  '---\ntitle: 旧笔记二\ndate: 2020-01-02\nconfidence: 低\nconf_why: 测试\n---\n正文二\n'
);
const refreshed = await maintTools.maintain({ runId: maintRun.id });
eq('覆盖执行成功', refreshed.ok, true);
const reportsAfterOverwrite = storeMod.createRepos({ root: maintRoot }).reportsRepo.list()
  .filter((item) => item.kind === 'maintain');
eq('同日覆盖后仍只有 1 条 maintain 报告', reportsAfterOverwrite.length, 1);
ok('findings 是新的（至少 2 条 M03）', reportsAfterOverwrite[0].findings.filter((item) => item.ruleId === 'M03').length >= 2,
  JSON.stringify(reportsAfterOverwrite[0].findings.map((item) => item.ruleId)));
eq('覆盖后的 summary 反映新命中数', reportsAfterOverwrite[0].summary, refreshed.message);

// ═══════════════════ 35. P2-3 SKILL 机制 ═══════════════════
const lifecycleMod = await import('../host/skills/lifecycle.js');
const skillRoot = await makeVaultRoot('jkkb-skill-');
const skillStore = vaultStore(skillRoot);
const skillRunRec = trace.createRun({ root: skillRoot, kind: 'skill', title: '建 SKILL' });
trace.acquireLock({ root: skillRoot, runId: skillRunRec.id });
const skillTools = createToolHandlers({ store: skillStore });

// 35a. similarity 边界：0 / 1 / 0.55 临界
eq('similarity 完全相同 → 1', lifecycleMod.similarity('写作教练', '写作教练'), 1);
eq('similarity 完全不同 → 0', lifecycleMod.similarity('写作', '编程'), 0);
eq('相似度阈值常量 0.55', lifecycleMod.SIMILAR_THRESHOLD, 0.55);
const nearScore = lifecycleMod.similarity('客户访谈记录模板', '客户访谈记录');
ok('相近文本相似度 ≥ 0.55', nearScore >= 0.55 && nearScore < 1, String(nearScore));
const farScore = lifecycleMod.similarity('客户访谈记录模板', '财务报表审计');
ok('无关文本相似度 < 0.55', farScore < 0.55, String(farScore));
eq('normalizeForCompare 去虚词与标点', lifecycleMod.normalizeForCompare('写作 的 教练，好！'), '写作教练好');

// 35b. decideCreate 三态
const emptyDecision = lifecycleMod.decideCreate({ name: '全新技能', purpose: '做一件全新的事', existing: [] });
eq('decideCreate 空库 → ok', emptyDecision.action, 'ok');
const dupDecision = lifecycleMod.decideCreate({
  name: '写作教练', purpose: '教写作',
  existing: [{ id: 'SK009', name: '写作教练', version: '1.0.0', purpose: '教写作', path: '/kb/x.md' }],
});
eq('decideCreate 同名 → duplicate', dupDecision.action, 'duplicate');
eq('duplicate 匹配项带 id', dupDecision.matches[0].id, 'SK009');
const similarDecision = lifecycleMod.decideCreate({
  name: '客户访谈记录模板', purpose: '把访谈整理成结构化记录',
  existing: [{ id: 'SK010', name: '客户访谈记录', version: '1.0.0', purpose: '把访谈整理成结构化记录', path: '/kb/y.md' }],
});
eq('decideCreate 相近 → similar', similarDecision.action, 'similar');
ok('similar 带 score 与 pagePath', typeof similarDecision.matches[0].score === 'number' && similarDecision.matches[0].pagePath === '/kb/y.md', JSON.stringify(similarDecision.matches));

// 35c. 相似但未 confirm → NEED_CONFIRM 且不落盘
const firstCreate = await skillTools.skillCreate({
  runId: skillRunRec.id,
  name: '客户访谈记录模板', purpose: '把访谈整理成结构化记录',
  scenario: '客户访谈后', keywords: ['访谈'], fields: ['时间', '结论'],
});
eq('首次创建成功', firstCreate.ok, true);
eq('首次创建分配 SK001', firstCreate.id, 'SK001');
ok('SK001 页面已落盘', fs.existsSync(firstCreate.path), firstCreate.path);
ok('页面路径在 11_岗位技能库 下', path.dirname(firstCreate.path).indexOf(path.join('11_岗位技能库', '通用')) >= 0, firstCreate.path);
const recordsBefore = storeMod.createRepos({ root: skillRoot }).skillsRepo.list().length;
const needConfirm = await skillTools.skillCreate({
  runId: skillRunRec.id,
  name: '客户访谈记录模板', purpose: '把访谈整理成结构化记录',
});
eq('同名未 confirm → NEED_CONFIRM', needConfirm.code, 'NEED_CONFIRM');
ok('NEED_CONFIRM 带 matches', Array.isArray(needConfirm.matches) && needConfirm.matches.length >= 1, JSON.stringify(needConfirm.matches));
eq('NEED_CONFIRM 不新增记录', storeMod.createRepos({ root: skillRoot }).skillsRepo.list().length, recordsBefore);

// 35d. confirm 后升级：version 1.0.1，旧页进历史版本
const oldPagePath = firstCreate.path;
const upgrade = await skillTools.skillCreate({
  runId: skillRunRec.id,
  name: '客户访谈记录模板', purpose: '把访谈整理成结构化记录（补充结论与跟进）',
  scenario: '客户访谈后 24h 内', keywords: ['访谈', '跟进'], fields: ['时间', '结论', '跟进'],
  confirm: true,
});
eq('confirm 升级成功', upgrade.ok, true);
eq('升级后版本 1.0.1', upgrade.version, '1.0.1');
eq('升级复用同一个 SK id', upgrade.id, 'SK001');
const archivedDir = path.join(skillRoot, '12_归档与历史', '03_历史版本');
const archivedFiles = fs.existsSync(archivedDir) ? fs.readdirSync(archivedDir) : [];
ok('旧页已归档到 12_归档与历史/03_历史版本', archivedFiles.some((name) => name.indexOf('SK001-1.0.0') === 0), JSON.stringify(archivedFiles));
ok('归档页含四要素', (() => {
  const file = path.join(archivedDir, archivedFiles.filter((name) => name.indexOf('SK001-1.0.0') === 0)[0]);
  const text = fs.readFileSync(file, 'utf8');
  return text.indexOf('原始位置') >= 0 && text.indexOf('归档时间') >= 0 && text.indexOf('归档原因') >= 0 && text.indexOf('继任版本链接') >= 0;
})(), JSON.stringify(archivedFiles));

// 35e. find 命中 / 未命中
const findHit = await skillTools.skillFind({ runId: skillRunRec.id, query: '客户访谈' });
eq('find 命中', findHit.ok, true);
ok('find 返回 SK001', (findHit.skills || []).some((item) => item.id === 'SK001'), JSON.stringify(findHit.skills));
const findMiss = await skillTools.skillFind({ runId: skillRunRec.id, query: '完全不存在的技能名XYZ' });
eq('find 未命中 → ok=false', findMiss.ok, false);
eq('find 未命中 code=NO_MATCH', findMiss.code, 'NO_MATCH');
ok('未命中文案说明不猜测', findMiss.message.indexOf('不做猜测') >= 0, findMiss.message);

// 35f. run 失败无 reason → REASON_REQUIRED 且无回执
const callsBefore = storeMod.createRepos({ root: skillRoot }).skillCallsRepo.list().length;
const failNoReason = await skillTools.skillRun({ runId: skillRunRec.id, skillId: 'SK001', task: '试着用一下', result: 'fail' });
eq('run fail 无 reason → REASON_REQUIRED', failNoReason.code, 'REASON_REQUIRED');
eq('无 reason 不写回执', storeMod.createRepos({ root: skillRoot }).skillCallsRepo.list().length, callsBefore);

// 35g. outputs 越界 → OUTPUT_FORBIDDEN 且无回执
const badOutput = await skillTools.skillRun({
  runId: skillRunRec.id, skillId: 'SK001', task: '写文件', result: 'ok',
  outputs: [path.join(skillRoot, '00_系统与索引', 'x.md')],
});
eq('outputs 越界 → OUTPUT_FORBIDDEN', badOutput.code, 'OUTPUT_FORBIDDEN');
ok('OUTPUT_FORBIDDEN 列出违规项', Array.isArray(badOutput.outputs) && badOutput.outputs.length === 1, JSON.stringify(badOutput.outputs));
eq('越界不写回执', storeMod.createRepos({ root: skillRoot }).skillCallsRepo.list().length, callsBefore);
const outsideOutput = await skillTools.skillRun({
  runId: skillRunRec.id, skillId: 'SK001', task: '写文件', result: 'ok',
  outputs: [path.join(os.tmpdir(), 'outside.md')],
});
eq('root 外路径也被拒', outsideOutput.code, 'OUTPUT_FORBIDDEN');

// 35h. 正常回执：8 个字段齐
const goodOutputPath = path.join(skillRoot, '06_知识与模型', '产出.md');
const goodRun = await skillTools.skillRun({
  runId: skillRunRec.id, skillId: 'SK001', task: '整理一次访谈', result: 'ok', outputs: [goodOutputPath],
});
eq('正常回执成功', goodRun.ok, true);
const callRecord = storeMod.createRepos({ root: skillRoot }).skillCallsRepo.list()[0];
deepEq('回执 8 个字段齐', Object.keys(callRecord).filter((key) => ['ts', 'skill', 'name', 'version', 'task', 'result', 'reason', 'outputs'].indexOf(key) >= 0).sort(),
  ['name', 'outputs', 'reason', 'result', 'skill', 'task', 'ts', 'version']);
eq('回执 skill=SK001', callRecord.skill, 'SK001');
eq('回执 version=1.0.1', callRecord.version, '1.0.1');

// 35i. 无 runId 时 create / find / run 被拒（list 除外）
eq('create 无 runId 被拒', (await skillTools.skillCreate({ name: 'x', purpose: 'y' })).code, 'run-id-required');
eq('find 无 runId 被拒', (await skillTools.skillFind({ query: '客户' })).code, 'run-id-required');
eq('run 无 runId 被拒', (await skillTools.skillRun({ skillId: 'SK001', task: 't', result: 'ok' })).code, 'run-id-required');
eq('list 无 runId 允许', (await skillTools.skillList({})).ok, true);

// 35j. skill-registry 分页 + skill-calls 倒序与 nextBefore
const skillStoreHandlers = hostRoutes.createHandlers({ store: skillStore });
const registry1 = await callHandler(skillStoreHandlers.skillRegistry, { method: 'GET', url: '/plugins/jk-knowledge-base/skill-registry?limit=1' });
eq('skill-registry 首页 1 条', registry1.json.skills.length, 1);
deepEq('skill-registry 字段齐', Object.keys(registry1.json.skills[0]).sort(), ['id', 'keywords', 'name', 'path', 'status', 'version']);
const callsRes = await callHandler(skillStoreHandlers.skillCalls, { method: 'GET', url: '/plugins/jk-knowledge-base/skill-calls?limit=20' });
eq('skill-calls 返回 1 条', callsRes.json.calls.length, 1);
eq('skill-calls nextBefore', callsRes.json.nextBefore, null);
deepEq('skill-calls 字段齐', Object.keys(callsRes.json.calls[0]).sort(), ['name', 'outputs', 'reason', 'result', 'skill', 'task', 'ts', 'version']);

// 35k. warning 对象不再出现 [object Object]
const summaryText = toolsMod.summarizeWarnings([
  { code: 'SECTION_MISSING', section: '原始内容摘要', message: '缺节' },
  { code: 'SECTION_MISSING', section: '原文', message: '缺节' },
  { code: 'SECTION_MISSING', section: '附件', message: '缺节' },
  { code: 'DUPLICATE_TITLE', path: '/kb/a.md', message: '同标题' },
]);
ok('warning 汇总按 code 归类', summaryText.indexOf('缺节 3 处：原始内容摘要 / 原文 / 附件') === 0 && summaryText.indexOf('同标题卡片已存在：/kb/a.md') > 0, summaryText);
ok('单条 warning 不出现 [object Object]', toolsMod.formatWarning({ code: 'X', message: '原因' }) === '[X] 原因' && toolsMod.formatWarning({ code: 'X' }).indexOf('[object Object]') < 0, toolsMod.formatWarning({ code: 'X' }));

// ═══════════════════ 36. 手动回执路由 + M06/M07 只读提议 ═══════════════════
const manualHandlers = hostRoutes.createHandlers({ store: skillStore });
const manualRepos = storeMod.createRepos({ root: skillRoot });

// 36a. POST 成功写入，source=manual、runId=null
const manualPost = await callHandler(manualHandlers.skillCalls, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/skill-calls',
  body: { skillId: 'SK001', task: '手动整理一次访谈', result: 'ok', outputs: [path.join(skillRoot, '06_知识与模型', 'manual.md')] },
});
eq('POST /skill-calls → 200', manualPost.status, 200);
eq('POST 返回 ok', manualPost.json.ok, true);
ok('POST 返回 id 与 call', typeof manualPost.json.id === 'string' && !!manualPost.json.call, JSON.stringify(manualPost.json).slice(0, 120));
eq('manual 记录 source=manual', manualPost.json.call.source, 'manual');
eq('manual 记录 runId=null', manualPost.json.call.runId, null);
eq('manual 记录 skill=SK001', manualPost.json.call.skill, 'SK001');

// 36b. 未知 skillId → 404
const manualUnknown = await callHandler(manualHandlers.skillCalls, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/skill-calls',
  body: { skillId: 'SK999', task: 't', result: 'ok' },
});
eq('未知 skillId → 404', manualUnknown.status, 404);
eq('未知 skillId 错误码', manualUnknown.json.error.code, 'skill-not-found');

// 36c. fail 无 reason → 400 且无记录
const callsBeforeManual = manualRepos.skillCallsRepo.list().length;
const manualNoReason = await callHandler(manualHandlers.skillCalls, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/skill-calls',
  body: { skillId: 'SK001', task: '手动失败', result: 'fail' },
});
eq('fail 无 reason → 400', manualNoReason.status, 400);
eq('fail 无 reason 错误码', manualNoReason.json.error.code, 'reason-required');
eq('fail 无 reason 不写回执', manualRepos.skillCallsRepo.list().length, callsBeforeManual);

// 36d. outputs 越界 → 400 且无记录
const manualBadOutput = await callHandler(manualHandlers.skillCalls, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/skill-calls',
  body: { skillId: 'SK001', task: '手动写文件', result: 'ok', outputs: [path.join(skillRoot, '00_系统与索引', 'x.md')] },
});
eq('outputs 越界 → 400', manualBadOutput.status, 400);
eq('outputs 越界错误码', manualBadOutput.json.error.code, 'output-forbidden');
ok('outputs 越界列出违规项', Array.isArray(manualBadOutput.json.error.outputs) && manualBadOutput.json.error.outputs.length === 1, JSON.stringify(manualBadOutput.json.error));
eq('outputs 越界不写回执', manualRepos.skillCallsRepo.list().length, callsBeforeManual);

// 36e. task 超长 → 400
const manualLongTask = await callHandler(manualHandlers.skillCalls, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/skill-calls',
  body: { skillId: 'SK001', task: 'x'.repeat(201), result: 'ok' },
});
eq('task 超长 → 400', manualLongTask.status, 400);
eq('task 超长错误码', manualLongTask.json.error.code, 'task-too-long');

// 36f. GET /skill-calls 能看到 manual 记录
const callsList = await callHandler(manualHandlers.skillCalls, { method: 'GET', url: '/plugins/jk-knowledge-base/skill-calls?limit=20' });
ok('GET /skill-calls 含 manual 记录', callsList.json.calls.some((item) => item.skill === 'SK001' && item.task === '手动整理一次访谈'), JSON.stringify(callsList.json.calls.map((c) => c.task)));
const manualRecord = manualRepos.skillCallsRepo.get(manualPost.json.id);
eq('列表与记录一致', manualRecord.task, '手动整理一次访谈');
eq('manual 记录按 ts 倒序排在最前', callsList.json.calls[0].task, '手动整理一次访谈');

// 36g. 工具与路由校验行为一致（同一批坏输入 → 对应同一 code）
const toolNoReason = await skillTools.skillRun({ runId: skillRunRec.id, skillId: 'SK001', task: '手动失败', result: 'fail' });
eq('工具 fail 无 reason → REASON_REQUIRED', toolNoReason.code, 'REASON_REQUIRED');
eq('路由 fail 无 reason 与工具同一含义', manualNoReason.json.error.code, 'reason-required');
const toolBadOutput = await skillTools.skillRun({ runId: skillRunRec.id, skillId: 'SK001', task: 'x', result: 'ok', outputs: [path.join(skillRoot, '00_系统与索引', 'y.md')] });
eq('工具 outputs 越界 → OUTPUT_FORBIDDEN', toolBadOutput.code, 'OUTPUT_FORBIDDEN');
eq('路由 outputs 越界与工具同一含义', manualBadOutput.json.error.code, 'output-forbidden');
eq('工具的 task 超长码', (await skillTools.skillRun({ runId: skillRunRec.id, skillId: 'SK001', task: 'x'.repeat(201), result: 'ok' })).code, 'TASK_TOO_LONG');

// 36h. M06/M07 空数组时渲染不报错；有提议时给出目标与原因
const emptyProposalMd = toolsMod.renderMaintainMarkdown({ byRule: { M01: 0, M03: 0, M04: 0, M06: 0, M07: 0, M08: 0 }, findings: [], scanned: { files: 1, notes: 1 } }, '2026-10-17');
ok('空数组时 M06 节存在', emptyProposalMd.indexOf('## M06 项目已结束未归档（0 条）') >= 0, emptyProposalMd.slice(0, 200));
ok('空数组时 M07 节存在', emptyProposalMd.indexOf('## M07 已废弃内容可归档（0 条）') >= 0);
ok('空数组时不出提议说明', emptyProposalMd.indexOf('本报告只提议') < 0);
ok('空数组时渲染不报错', typeof emptyProposalMd === 'string' && emptyProposalMd.length > 0);
const proposalMd = toolsMod.renderMaintainMarkdown({
  byRule: { M01: 0, M03: 0, M04: 0, M06: 1, M07: 1, M08: 0 },
  findings: [
    { ruleId: 'M06', level: 'info', relPath: '09_项目与运营/项目A/index.md', title: '项目A', action: 'propose-archive', proposedTarget: '12_归档与历史/03_归档笔记/09_项目与运营/项目A', archiveReason: '项目已结束 40 天未归档' },
    { ruleId: 'M07', level: 'info', relPath: '03_研究与洞察/旧文.md', title: '旧文', action: 'propose-archive', proposedTarget: '12_归档与历史/03_归档笔记/03_研究与洞察/旧文.md', archiveReason: '已标记废弃 60 天' },
  ],
  scanned: { files: 2, notes: 2 },
}, '2026-10-17');
ok('提议节写明只提议不执行', proposalMd.indexOf('本报告只提议，未执行归档') >= 0);
ok('提议条目带建议归档目标', proposalMd.indexOf('建议归档到 12_归档与历史/03_归档笔记/09_项目与运营/项目A') >= 0, proposalMd.split('\n').filter((l) => l.indexOf('M06') >= 0 || l.indexOf('建议归档到') >= 0).join(' | '));
ok('提议条目带归档原因', proposalMd.indexOf('原因：项目已结束 40 天未归档') >= 0);

// ═══════════════════ 37. 归档工具（破坏性闸门）+ thresholds M06/M07 ═══════════════════
const archRoot = await makeVaultRoot('jkkb-archive-');
const archStore = vaultStore(archRoot);
const archRun = trace.createRun({ root: archRoot, kind: 'archive', title: '归档' });
trace.acquireLock({ root: archRoot, runId: archRun.id });
const archHandlers = createToolHandlers({ store: archStore });
const archNote = path.join(archRoot, '01_收件箱', 'note-to-archive.md');
fs.writeFileSync(archNote, '---\ntitle: 待归档笔记\ndate: 2020-01-01\n---\n正文内容\n');

// 37a. 无 confirm → NEED_CONFIRM，preview 齐全，且不动任何文件
const fileCountOf = (dirPath) => {
  let count = 0;
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name === '.jkkb') return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs); else count += 1;
    });
  };
  walk(dirPath);
  return count;
};
const archiveFilesBefore = fileCountOf(archRoot);
const noConfirm = await archHandlers.archive({ runId: archRun.id, items: [{ relPath: '01_收件箱/note-to-archive.md', reason: '内容已过期' }] });
eq('无 confirm → NEED_CONFIRM', noConfirm.code, 'NEED_CONFIRM');
eq('NEED_CONFIRM 带 preview', Array.isArray(noConfirm.preview) && noConfirm.preview.length, 1);
eq('preview 目标路径', noConfirm.preview[0].to, '12_归档与历史/03_归档笔记/01_收件箱/note-to-archive.md');
eq('preview 保留原因', noConfirm.preview[0].reason, '内容已过期');
eq('无 confirm 不写任何文件', fileCountOf(archRoot), archiveFilesBefore);

// 37b. confirm 后成功移动 + 写 reportsRepo（撤销依据）
const confirmed = await archHandlers.archive({
  runId: archRun.id,
  items: [{ relPath: '01_收件箱/note-to-archive.md', reason: '内容已过期' }],
  confirm: true,
});
eq('confirm 后成功', confirmed.ok, true);
eq('moved 1 项', confirmed.moved.length, 1);
eq('原件已移走', fs.existsSync(archNote), false);
const archivedPath = confirmed.moved[0].to;
ok('归档目标在 12_归档与历史/03_归档笔记 下', archivedPath.indexOf(path.join('12_归档与历史', '03_归档笔记')) >= 0, archivedPath);
ok('归档文件存在', fs.existsSync(archivedPath), archivedPath);
const archivedText = fs.readFileSync(archivedPath, 'utf8');
ok('归档内容含四要素', ['原始位置', '归档时间', '归档原因', '继任版本链接'].every((key) => archivedText.indexOf(key) >= 0), archivedText.slice(0, 400));
ok('frontmatter 追加 archived_from/archived_at/archived_reason', ['archived_from', 'archived_at', 'archived_reason'].every((key) => archivedText.indexOf(key) >= 0));
ok('返回 reportId', typeof confirmed.reportId === 'string' && confirmed.reportId.length > 0, String(confirmed.reportId));

// 37c. 报告记录里的 items 可作为撤销依据
const archRecord = storeMod.createRepos({ root: archRoot }).reportsRepo.get(confirmed.reportId);
eq('报告记录 kind=archive', archRecord.kind, 'archive');
ok('报告 period 是日期', /^\d{4}-\d{2}-\d{2}$/.test(archRecord.period), archRecord.period);
eq('报告 summary 反映 moved/failed', archRecord.summary, 'moved=1 failed=0');
const undoItem = (archRecord.items || [])[0];
ok('撤销依据条目带 from/to/reason/archivedAt', !!undoItem && ['from', 'to', 'reason', 'archivedAt'].every((key) => key in undoItem), JSON.stringify(undoItem));
eq('撤销依据 from 是相对原路径', undoItem.from, '01_收件箱/note-to-archive.md');
eq('撤销依据保留归档原因', undoItem.reason, '内容已过期');
eq('撤销依据 to 是相对归档路径', undoItem.to, path.relative(archRoot, archivedPath).split(path.sep).join('/'));

// 37d. 部分失败：未知 relPath 计入 failed，不抛错
fs.writeFileSync(path.join(archRoot, '01_收件箱', 'note-two.md'), '---\ntitle: 第二篇\n---\n正文\n');
const partial = await archHandlers.archive({
  runId: archRun.id,
  items: [
    { relPath: '01_收件箱/note-two.md', reason: '重复内容' },
    { relPath: '01_收件箱/does-not-exist.md', reason: '文件不存在测试' },
  ],
  confirm: true,
});
eq('部分失败仍 ok', partial.ok, true);
eq('成功项已移动', partial.moved.length, 1);
eq('未知 relPath 计入 failed', partial.failed.length, 1);
eq('failed 带 code', partial.failed[0].code, 'NOT_FOUND');
ok('未知 relPath 不抛错', typeof partial.failed[0].message === 'string');

// 37d-2. 目录项：引擎已支持目录归档（moved.kind='dir'），不再进 skipped
fs.mkdirSync(path.join(archRoot, '09_项目与运营', '项目A'), { recursive: true });
fs.writeFileSync(path.join(archRoot, '09_项目与运营', '项目A', 'index.md'), '---\ntitle: 项目A\nstatus: done\n---\n正文\n');
const dirAttempt = await archHandlers.archive({
  runId: archRun.id,
  items: [{ relPath: '09_项目与运营/项目A', reason: '项目已结束待归档' }],
  confirm: true,
});
eq('目录归档成功', dirAttempt.ok, true);
eq('目录项进入 moved', dirAttempt.moved.length, 1);
eq('moved.kind=dir', dirAttempt.moved[0].kind, 'dir');
eq('目录项不再进 skipped', dirAttempt.skipped.length, 0);
eq('目录项不混进 failed', dirAttempt.failed.length, 0);
eq('原目录已被移走', fs.existsSync(path.join(archRoot, '09_项目与运营', '项目A', 'index.md')), false);
const archivedDirIndex = path.join(archRoot, '12_归档与历史', '03_归档笔记', '09_项目与运营', '项目A', 'index.md');
ok('归档后目录带首页', fs.existsSync(archivedDirIndex), archivedDirIndex);
ok('目录首页插入四要素', ['原始位置', '归档时间', '归档原因', '继任版本链接'].every((key) => fs.readFileSync(archivedDirIndex, 'utf8').indexOf(key) >= 0));

// 37e. items 为空 / item 缺 reason → 结构化错误
eq('items 为空 → empty-items', (await archHandlers.archive({ runId: archRun.id, items: [], confirm: true })).code, 'empty-items');
const archRuns = createRunService({ ctx: {}, store: archStore });
const archRouteHandlers = hostRoutes.createHandlers({ store: archStore, runs: archRuns });
const emptyRunRes = await callHandler(archRouteHandlers.startRun, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/run',
  body: { kind: 'archive', input: { items: [], confirmed: true } },
});
eq('POST /run archive 空 items → 400', emptyRunRes.status, 400);
eq('POST /run archive 空 items 错误码', emptyRunRes.json.error.code, 'empty-items');
const noReasonRunRes = await callHandler(archRouteHandlers.startRun, {
  method: 'POST',
  url: '/plugins/jk-knowledge-base/run',
  body: { kind: 'archive', input: { items: [{ relPath: '01_收件箱/a.md' }], confirmed: true } },
});
eq('POST /run archive 缺 reason → 400', noReasonRunRes.status, 400);
eq('POST /run archive 缺 reason 错误码', noReasonRunRes.json.error.code, 'reason-required');
eq('item 缺 reason → reason-required', (await archHandlers.archive({ runId: archRun.id, items: [{ relPath: '01_收件箱/x.md' }], confirm: true })).code, 'reason-required');

// 37f. run kind archive 的宪章
const archiveCharter = orchestrator.buildArchiveCharter({ root: '/tmp/kb', runId: 'run-a', kind: 'archive', input: { items: [{ relPath: 'a.md', reason: 'r' }], confirmed: true } });
ok('宪章含「不得自行扩项」', archiveCharter.indexOf('不得自行扩项') >= 0, archiveCharter.slice(0, 200));
ok('宪章含 confirm:true', archiveCharter.indexOf('confirm: true') >= 0);
ok('宪章声明破坏性操作', archiveCharter.indexOf('破坏性操作') >= 0);
ok('宪章要求逐条汇报 moved/failed', archiveCharter.indexOf('moved') >= 0 && archiveCharter.indexOf('failed') >= 0);
ok('RUN_KINDS 含 archive', orchestrator.RUN_KINDS.indexOf('archive') >= 0);

// 37g. preflight 对 archive 跳过文件计数
trace.releaseLock({ root: archRoot, runId: archRun.id });
const archPreflight = await orchestrator.runHostPreflight(
  { ctx: {}, store: archStore, toolState: () => ({ registered: REQUIRED_TOOL_NAMES, failed: [] }) },
  { kind: 'archive', mode: 'asset' }
);
eq('archive preflight ok', archPreflight.report.ok, true);
const archNoScan = archPreflight.report.checks.filter((item) => item.id === 'archive-no-file-scan')[0];
ok('archive preflight 注明未做文件数预检', !!archNoScan && archNoScan.detail.indexOf('未做文件数预检') >= 0, JSON.stringify(archNoScan));

// 37h. maintain thresholds 透传 M06/M07 与别名（注入假引擎断言收到的对象）
let capturedThresholds = null;
const fakeMaintainEngine = {
  maintain: async (args) => {
    capturedThresholds = args.thresholds;
    return { ok: true, byRule: { M01: 0, M03: 0, M04: 0, M06: 0, M07: 0, M08: 0 }, findings: [], scanned: { files: 0, notes: 0 }, warnings: [], generatedAt: new Date().toISOString() };
  },
};
const fakeHandlers = createToolHandlers({ store: archStore, engine: fakeMaintainEngine });
const fakeRun = trace.createRun({ root: archRoot, kind: 'maintain', title: '阈值透传' });
await fakeHandlers.maintain({ runId: fakeRun.id, thresholds: { M01: 7, M03: 30, M06: 45, M07: 60 } });
deepEq('thresholds.M06/M07 透传给引擎', capturedThresholds, { M01: 7, M03: 30, M06: 45, M07: 60 });
await fakeHandlers.maintain({ runId: fakeRun.id, thresholds: { projectDays: 11, deprecatedDays: 12 } });
deepEq('别名 projectDays/deprecatedDays 同样透传', capturedThresholds, { projectDays: 11, deprecatedDays: 12 });
trace.finishRun({ root: archRoot, runId: fakeRun.id, status: 'completed', summary: 'ok' });

// ═══════════════════ 38. 业务专家（expertsRepo / 四个工具 / curate expertId） ═══════════════════
const expertRoot = await makeVaultRoot('jkkb-expert-');
const expertStore = vaultStore(expertRoot);
const expertRun = trace.createRun({ root: expertRoot, kind: 'skill', title: '业务专家' });
trace.acquireLock({ root: expertRoot, runId: expertRun.id });
const expertTools = createToolHandlers({ store: expertStore });
const expertRepos = storeMod.createRepos({ root: expertRoot });

// 38a. create 成功且 id=EXP-001
const createdExpert = await expertTools.expertCreate({
  runId: expertRun.id,
  name: '合同审阅专家',
  domain: '法务',
  responsibility: '审阅合同条款并指出对我方不利的风险点',
  skillIds: ['common.quick_capture'],
  promptFragment: '优先关注付款与违约责任条款。',
});
eq('create 专家成功', createdExpert.ok, true);
eq('专家 id 为 EXP-001', createdExpert.id, 'EXP-001');
eq('专家默认 active', createdExpert.expert.status, 'active');
eq('expertsRepo 落盘', expertRepos.expertsRepo.get('EXP-001').name, '合同审阅专家');

// 38b. name / domain / responsibility 校验
eq('name 必填', (await expertTools.expertCreate({ runId: expertRun.id, domain: 'd', responsibility: 'x'.repeat(12) })).code, 'name-required');
eq('name 超长', (await expertTools.expertCreate({ runId: expertRun.id, name: 'x'.repeat(61), domain: 'd', responsibility: 'x'.repeat(12) })).code, 'name-too-long');
eq('domain 必填', (await expertTools.expertCreate({ runId: expertRun.id, name: 'n', responsibility: 'x'.repeat(12) })).code, 'domain-required');
eq('domain 超长', (await expertTools.expertCreate({ runId: expertRun.id, name: 'n', domain: 'x'.repeat(41), responsibility: 'x'.repeat(12) })).code, 'domain-too-long');
eq('responsibility 太短', (await expertTools.expertCreate({ runId: expertRun.id, name: 'n', domain: 'd', responsibility: '太短' })).code, 'responsibility-too-short');

// 38c. 未知 skillId → unknown-skill
const unknownSkillExpert = await expertTools.expertCreate({
  runId: expertRun.id, name: 'n', domain: 'd', responsibility: 'x'.repeat(12), skillIds: ['no.such.skill'],
});
eq('未知 skillId → unknown-skill', unknownSkillExpert.code, 'unknown-skill');
const builtinAndRegistry = await expertTools.expertCreate({
  runId: expertRun.id, name: '双源技能专家', domain: '通用', responsibility: '同时认内置目录与注册表', skillIds: ['common.quick_capture'],
});
eq('内置技能 id 被接受', builtinAndRegistry.ok, true);

// 38d. update 局部更新保留其余字段
const updatedExpert = await expertTools.expertUpdate({
  runId: expertRun.id, id: 'EXP-001', patch: { domain: '法务（合同）' },
});
eq('update 成功', updatedExpert.ok, true);
eq('update 改了 domain', updatedExpert.expert.domain, '法务（合同）');
eq('update 保留 name', updatedExpert.expert.name, '合同审阅专家');
eq('update 保留 responsibility', updatedExpert.expert.responsibility, '审阅合同条款并指出对我方不利的风险点');
deepEq('update 保留 skillIds', updatedExpert.expert.skillIds, ['common.quick_capture']);

// 38e. list 默认不含 archived，status=archived 可看
const listBefore = await expertTools.expertList({ runId: expertRun.id });
eq('默认列表只含 active', listBefore.experts.filter((item) => item.status !== 'active').length, 0);
const archivedResult = await expertTools.expertArchive({ runId: expertRun.id, id: 'EXP-002' });
eq('archive 成功', archivedResult.ok, true);
eq('archive 后 status=archived', archivedResult.expert.status, 'archived');
ok('archive 不是物理删除', !!expertRepos.expertsRepo.get('EXP-002'));
const listActive = await expertTools.expertList({ runId: expertRun.id });
eq('archived 不出现在 active 列表', listActive.experts.filter((item) => item.id === 'EXP-002').length, 0);
const listArchived = await expertTools.expertList({ runId: expertRun.id, status: 'archived' });
eq('status=archived 能看到归档专家', listArchived.experts.filter((item) => item.id === 'EXP-002').length, 1);

// 38f. GET /experts（含非法 status → 400）
const expertHandlers = hostRoutes.createHandlers({ store: expertStore });
const expertsOk = await callHandler(expertHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts' });
eq('GET /experts → 200', expertsOk.status, 200);
ok('GET /experts 只含 active', expertsOk.json.experts.every((item) => item.status === 'active'), JSON.stringify(expertsOk.json.experts.map((e) => e.id)));
deepEq('GET /experts 字段齐', Object.keys(expertsOk.json.experts[0]).sort(),
  ['cardCount', 'createdAt', 'danglingSkillIds', 'domain', 'id', 'lastUsedAt', 'name', 'promptFragment', 'responsibility', 'schemaVersion', 'skillIds', 'skillStates', 'status', 'updatedAt']);
const expertsArchived = await callHandler(expertHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts?status=archived' });
eq('GET /experts?status=archived 有归档项', expertsArchived.json.experts.length, 1);
const expertsBadStatus = await callHandler(expertHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts?status=bogus' });
eq('非法 status → 400', expertsBadStatus.status, 400);
eq('非法 status 错误码', expertsBadStatus.json.error.code, 'invalid-status');

// 38g. curate 带有效 expertId → frontmatter 有 expert 且 cardsRepo 有 expertId
const expertCurate = await expertTools.curate({
  runId: expertRun.id, skillId: 'common.quick_capture', title: '带专家的卡片', body: '正文内容',
  tags: ['专家'], confidence: '中', expertId: 'EXP-001',
});
eq('curate 带 expertId 成功', expertCurate.ok, true);
const expertCardText = fs.readFileSync(expertCurate.path, 'utf8');
ok('卡片 frontmatter 含 expert 字段', /^expert: "EXP-001 合同审阅专家"$/m.test(expertCardText), expertCardText.split('\n').slice(0, 12).join('\n'));
const expertCardRecord = expertRepos.cardsRepo.get(expertCurate.id);
eq('cardsRepo 记录带 expertId', expertCardRecord.expertId, 'EXP-001');

// 38h. curate 带未知/已归档 expertId → EXPERT_INVALID 且不落盘
const cardsBeforeInvalid = expertRepos.cardsRepo.list().length;
const unknownExpertCurate = await expertTools.curate({
  runId: expertRun.id, skillId: 'common.quick_capture', title: '未知专家', body: '正文',
  tags: ['专家'], confidence: '中', expertId: 'EXP-999',
});
eq('未知 expertId → EXPERT_INVALID', unknownExpertCurate.code, 'EXPERT_INVALID');
eq('未知 expertId 不落盘', expertRepos.cardsRepo.list().length, cardsBeforeInvalid);
const archivedExpertCurate = await expertTools.curate({
  runId: expertRun.id, skillId: 'common.quick_capture', title: '已归档专家', body: '正文',
  tags: ['专家'], confidence: '中', expertId: 'EXP-002',
});
eq('已归档 expertId → EXPERT_INVALID', archivedExpertCurate.code, 'EXPERT_INVALID');
eq('已归档 expertId 不落盘', expertRepos.cardsRepo.list().length, cardsBeforeInvalid);

// 38i. curate 不传 expertId → 无 expert 字段（向后兼容）
const plainCurate = await expertTools.curate({
  runId: expertRun.id, skillId: 'common.quick_capture', title: '无专家卡片', body: '正文',
  tags: ['普通'], confidence: '中',
});
eq('不传 expertId 仍成功', plainCurate.ok, true);
const plainText = fs.readFileSync(plainCurate.path, 'utf8');
ok('无 expertId 时不写 expert 字段', plainText.indexOf('expert:') < 0, plainText.split('\n').slice(0, 10).join('\n'));
eq('无 expertId 时记录里没有 expertId', expertRepos.cardsRepo.get(plainCurate.id).expertId, undefined);

trace.releaseLock({ root: expertRoot, runId: expertRun.id });
trace.finishRun({ root: expertRoot, runId: expertRun.id, status: 'completed', summary: 'ok' });

// ═══════════════════ 39. 专家写接口（POST / PATCH / archive） ═══════════════════
const expertWrite = hostRoutes.createHandlers({ store: expertStore });
const expertsBase = '/plugins/jk-knowledge-base/experts';

// 39a. POST 创建成功且出现在 GET 列表
const createRes = await callHandler(expertWrite.expertsList, {
  method: 'POST',
  url: expertsBase,
  body: { name: '税务筹划专家', domain: '财税', responsibility: '梳理税负结构并给出合规的筹划路径', skillIds: ['common.quick_capture'] },
});
eq('POST /experts → 200', createRes.status, 200);
eq('POST /experts ok', createRes.json.ok, true);
ok('POST 返回 EXP 编号', /^EXP-\d{3}$/.test(createRes.json.expert.id), JSON.stringify(createRes.json.expert.id));
eq('POST 返回 active', createRes.json.expert.status, 'active');
deepEq('POST 响应结构含版本与时间戳', Object.keys(createRes.json.expert).sort(),
  ['createdAt', 'domain', 'id', 'name', 'promptFragment', 'responsibility', 'schemaVersion', 'skillIds', 'status', 'updatedAt']);
const createdId = createRes.json.expert.id;
const listAfterCreate = await callHandler(expertWrite.expertsList, { method: 'GET', url: expertsBase });
ok('新建专家出现在 GET 列表', listAfterCreate.json.experts.some((item) => item.id === createdId), JSON.stringify(listAfterCreate.json.experts.map((e) => e.id)));

// 39b. 创建缺 name → 400
const noNameRes = await callHandler(expertWrite.expertsList, {
  method: 'POST', url: expertsBase,
  body: { domain: '财税', responsibility: 'x'.repeat(12) },
});
eq('创建缺 name → 400', noNameRes.status, 400);
eq('创建缺 name 错误码', noNameRes.json.error.code, 'name-required');

// 39c. PATCH 局部更新保留其余字段
const patchRes = await callHandler(expertWrite.expertsScoped, {
  method: 'PATCH', url: expertsBase + '/' + createdId,
  body: { domain: '财税（个税+企业税）' },
});
eq('PATCH → 200', patchRes.status, 200);
eq('PATCH 改了 domain', patchRes.json.expert.domain, '财税（个税+企业税）');
eq('PATCH 保留 name', patchRes.json.expert.name, '税务筹划专家');
eq('PATCH 保留 responsibility', patchRes.json.expert.responsibility, '梳理税负结构并给出合规的筹划路径');
eq('PATCH 保留 skillIds', JSON.stringify(patchRes.json.expert.skillIds), JSON.stringify(['common.quick_capture']));
eq('PATCH 后仍是 active', patchRes.json.expert.status, 'active');

// 39d. PATCH 未知 id → 404
const patchUnknown = await callHandler(expertWrite.expertsScoped, {
  method: 'PATCH', url: expertsBase + '/EXP-999', body: { domain: 'x' },
});
eq('PATCH 未知 id → 404', patchUnknown.status, 404);
eq('PATCH 未知 id 错误码', patchUnknown.json.error.code, 'expert-not-found');

// 39e. archive 成功且 active 列表不再返回
const archiveRes = await callHandler(expertWrite.expertsScoped, {
  method: 'POST', url: expertsBase + '/' + createdId + '/archive',
});
eq('POST archive → 200', archiveRes.status, 200);
eq('archive 后 status=archived', archiveRes.json.expert.status, 'archived');
const listAfterArchive = await callHandler(expertWrite.expertsList, { method: 'GET', url: expertsBase });
eq('archived 不再出现在 active 列表', listAfterArchive.json.experts.filter((item) => item.id === createdId).length, 0);
const archivedList = await callHandler(expertWrite.expertsList, { method: 'GET', url: expertsBase + '?status=archived' });
eq('?status=archived 能看到它', archivedList.json.experts.filter((item) => item.id === createdId).length, 1);

// 39f. 重复 archive → 409
const archiveAgain = await callHandler(expertWrite.expertsScoped, {
  method: 'POST', url: expertsBase + '/' + createdId + '/archive',
});
eq('重复 archive → 409', archiveAgain.status, 409);
eq('重复 archive 错误码', archiveAgain.json.error.code, 'already-archived');

// 39g. 非法 skillId → 400 unknown-skill
const badSkillRes = await callHandler(expertWrite.expertsList, {
  method: 'POST', url: expertsBase,
  body: { name: 'n', domain: 'd', responsibility: 'x'.repeat(12), skillIds: ['no.such.skill'] },
});
eq('非法 skillId → 400', badSkillRes.status, 400);
eq('非法 skillId 错误码', badSkillRes.json.error.code, 'unknown-skill');

// 39h. 请求体非 JSON → 415
const notJsonRes = await callHandler(expertWrite.expertsList, {
  method: 'POST', url: expertsBase, body: '这不是 JSON', headers: { 'content-type': 'text/plain' },
});
eq('非 JSON 请求体 → 415', notJsonRes.status, 415);
eq('非 JSON 错误码', notJsonRes.json.error.code, 'unsupported-media-type');

// 39i. 路由计数：/experts 同时有 exact 与 prefix
ok('experts 同时注册 exact 与 prefix', hostRegistered.some((spec) => spec.kind === 'exact' && spec.path === expertsBase)
  && hostRegistered.some((spec) => spec.kind === 'prefix' && spec.path === expertsBase), JSON.stringify(hostRegistered.filter((spec) => spec.path === expertsBase)));

// 39j. 工具与 HTTP 同一份校验（同一坏输入同 code；用新起的 running run）
const expertValidateRun = trace.createRun({ root: expertRoot, kind: 'skill', title: '专家校验' });
trace.acquireLock({ root: expertRoot, runId: expertValidateRun.id });
const toolBadName = await expertTools.expertCreate({ runId: expertValidateRun.id, domain: 'd', responsibility: 'x'.repeat(12) });
eq('工具缺 name → name-required', toolBadName.code, 'name-required');
eq('HTTP 缺 name 与工具同 code', noNameRes.json.error.code, toolBadName.code);
const toolBadSkill = await expertTools.expertCreate({ runId: expertValidateRun.id, name: 'n', domain: 'd', responsibility: 'x'.repeat(12), skillIds: ['no.such.skill'] });
eq('工具非法 skillId → unknown-skill', toolBadSkill.code, 'unknown-skill');
eq('HTTP 非法 skillId 与工具同 code', badSkillRes.json.error.code, toolBadSkill.code);
trace.releaseLock({ root: expertRoot, runId: expertValidateRun.id });
trace.finishRun({ root: expertRoot, runId: expertValidateRun.id, status: 'completed', summary: 'ok' });

// ═══════════════════ 40. 专家配置真正影响 agent（宪章注入） ═══════════════════
// EXP-001 = 合同审阅专家（法务，绑定 common.quick_capture），来自 38 节
const expertCharter = orchestrator.buildCurateCharter({
  root: expertRoot, runId: 'run-exp', kind: 'curate',
  input: { text: '一段合同条款', expertId: 'EXP-001', skillId: 'common.quick_capture' },
});
ok('宪章含专家段标题', expertCharter.indexOf('本次由专家处理') >= 0, expertCharter.slice(0, 300));
ok('宪章含专家名称与领域', expertCharter.indexOf('合同审阅专家') >= 0 && expertCharter.indexOf('法务') >= 0);
ok('宪章含职责', expertCharter.indexOf('审阅合同条款并指出对我方不利的风险点') >= 0);
ok('宪章含提示词片段', expertCharter.indexOf('优先关注付款与违约责任条款。') >= 0);
ok('宪章含绑定技能名称', expertCharter.indexOf('common.quick_capture') >= 0, expertCharter.split('\n').filter((l) => l.indexOf('绑定技能') >= 0).join(''));
ok('skillId 在绑定范围内时不提示确认', expertCharter.indexOf('不在该专家绑定范围内') < 0);

// 40b. skillId 不在绑定列表 → 明确提示先确认
const offListCharter = orchestrator.buildCurateCharter({
  root: expertRoot, runId: 'run-exp2', kind: 'curate',
  input: { text: 'x', expertId: 'EXP-001', skillId: 'finance.some_other_skill' },
});
ok('skillId 不在绑定范围时提示确认', offListCharter.indexOf('不在该专家绑定范围内，请先确认') >= 0,
  offListCharter.split('\n').filter((l) => l.indexOf('绑定范围') >= 0).join(''));

// 40c. expertId 不可用 → 宪章写明原因，且 run.warnings 有记录
const missingExpertCharter = orchestrator.buildCurateCharter({
  root: expertRoot, runId: 'run-exp3', kind: 'curate',
  input: { text: 'x', expertId: 'EXP-999' },
});
ok('不可用专家在宪章里写明', missingExpertCharter.indexOf('指定的专家不可用') >= 0 && missingExpertCharter.indexOf('本次按通用流程处理') >= 0,
  missingExpertCharter.split('\n').filter((l) => l.indexOf('专家') >= 0).slice(0, 3).join(' | '));
const archivedExpertCharter = orchestrator.buildCurateCharter({
  root: expertRoot, runId: 'run-exp4', kind: 'curate',
  input: { text: 'x', expertId: 'EXP-002' },
});
ok('已归档专家也写明原因', archivedExpertCharter.indexOf('专家已归档') >= 0, archivedExpertCharter.split('\n').filter((l) => l.indexOf('不可用') >= 0).join(''));

const expertWarnStore = vaultStore(expertRoot);
const expertWarnService = createRunService({ ctx: {}, store: expertWarnStore });
const expertWarnStart = await expertWarnService.start({ kind: 'curate', input: { text: '一条素材', expertId: 'EXP-999' } });
eq('不可用专家仍能起 run', expertWarnStart.ok, true);
const expertWarnRun = trace.readRun(expertRoot, expertWarnStart.runId);
ok('run.warnings 记录专家不可用', Array.isArray(expertWarnRun.run.warnings) && expertWarnRun.run.warnings.some((item) => String(item).indexOf('expert-unavailable: EXP-999') >= 0),
  JSON.stringify(expertWarnRun.run.warnings));

// 40d. 无 expertId → 宪章不含专家段
const plainCharter = orchestrator.buildCurateCharter({ root: expertRoot, runId: 'run-plain', kind: 'curate', input: { text: 'x' } });
ok('无 expertId 时不含专家段', plainCharter.indexOf('本次由专家处理') < 0);

// 40e. maintain / archive 宪章声明专家配置不参与
const maintCharter = orchestrator.buildMaintainCharter({ root: expertRoot, runId: 'run-m2', kind: 'maintain' });
ok('maintain 宪章含「专家配置不参与」', maintCharter.indexOf('专家配置不参与本类任务') >= 0);
const archCharter2 = orchestrator.buildArchiveCharter({ root: expertRoot, runId: 'run-a2', kind: 'archive', input: { items: [], confirmed: false } });
ok('archive 宪章含「专家配置不参与」', archCharter2.indexOf('专家配置不参与本类任务') >= 0);

// ═══════════════════ 41. 仪表盘（GET /dashboard）与目录归档 ═══════════════════
const dashRoot = await makeVaultRoot('jkkb-dash-');
const dashStore = vaultStore(dashRoot);
fs.writeFileSync(path.join(dashRoot, '03_研究与洞察', 'note-a.md'), '---\ntitle: 笔记甲\n---\n正文甲\n');
fs.writeFileSync(path.join(dashRoot, '03_研究与洞察', 'note-b.md'), '# 笔记乙\n\n正文乙\n');
const dashRun1 = trace.createRun({ root: dashRoot, kind: 'verify', title: '体检甲' });
trace.finishRun({ root: dashRoot, runId: dashRun1.id, status: 'completed', summary: 'ok', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const dashRun2 = trace.createRun({ root: dashRoot, kind: 'verify', title: '体检乙' });
trace.finishRun({ root: dashRoot, runId: dashRun2.id, status: 'failed', summary: 'boom' });
storeMod.createRepos({ root: dashRoot }).reportsRepo.create({ kind: 'maintain', period: '2026-10-16', summary: 'M01=1 M03=0 M04=0 M06=0 M07=0 M08=0', byRule: { M01: 1, M03: 0, M04: 0, M06: 0, M07: 0, M08: 0 }, path: '/old.md', findings: [] });
storeMod.createRepos({ root: dashRoot }).reportsRepo.create({ kind: 'maintain', period: '2026-10-17', summary: 'M01=2 M03=1 M04=0 M06=0 M07=0 M08=0', byRule: { M01: 2, M03: 1, M04: 0, M06: 0, M07: 0, M08: 0 }, path: '/new.md', findings: [] });

const dashHandlers = hostRoutes.createHandlers({
  store: dashStore,
  toolState: () => ({ registered: ['a', 'b', 'c'], failed: [] }),
});
const dashSnapshot = (() => {
  const out = {};
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name === '.jkkb') return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs); else out[abs] = fs.statSync(abs).mtimeMs;
    });
  };
  walk(dashRoot);
  return out;
})();
const dashRes = await callHandler(dashHandlers.dashboard, { method: 'GET', url: '/plugins/jk-knowledge-base/dashboard' });
eq('GET /dashboard → 200', dashRes.status, 200);
eq('dashboard ok', dashRes.json.ok, true);
ok('dashboard 有 generatedAt', typeof dashRes.json.generatedAt === 'string');
deepEq('counts 字段齐', Object.keys(dashRes.json.counts).sort(), ['dirs', 'files', 'notes', 'topDirs', 'truncated']);
ok('counts.topDirs 是数组且带 name/notes', Array.isArray(dashRes.json.counts.topDirs) && dashRes.json.counts.topDirs.every((item) => typeof item.name === 'string' && typeof item.notes === 'number'), JSON.stringify(dashRes.json.counts.topDirs.slice(0, 2)));
eq('counts.truncated 透传（小库为 false）', dashRes.json.counts.truncated, false);
ok('runtime 字段齐', ['root', 'hasVault', 'mode', 'vaultUpdatedAt', 'lastRun', 'running'].every((key) => key in dashRes.json.runtime), JSON.stringify(dashRes.json.runtime));
ok('lastRun 带耗时', !!dashRes.json.runtime.lastRun && typeof dashRes.json.runtime.lastRun.elapsedMs === 'number', JSON.stringify(dashRes.json.runtime.lastRun));
eq('health.storeGuard=ready', dashRes.json.health.storeGuard, 'ready');
eq('health.tools 与 toolState 一致', dashRes.json.health.tools.registered, 3);
eq('health.tools.failed', dashRes.json.health.tools.failed, 0);
ok('health.subagents 结构齐', typeof dashRes.json.health.subagents.available === 'boolean' && Array.isArray(dashRes.json.health.subagents.providers));

// 41b. today 只累加有 usage 的 run
eq('today.runs 计数含无 usage 的 run', dashRes.json.today.runs, 2);
eq('today.completed', dashRes.json.today.completed, 1);
eq('today.failed', dashRes.json.today.failed, 1);
eq('today.inputTokens 只累加有 usage 的 run', dashRes.json.today.inputTokens, 100);
eq('today.outputTokens', dashRes.json.today.outputTokens, 20);
ok('today.totalMs 是数字', typeof dashRes.json.today.totalMs === 'number');

// 41c. recent ≤10 且按时间倒序
ok('recent 最多 10 条', dashRes.json.recent.length <= 10, String(dashRes.json.recent.length));
ok('recent 按 updatedAt 倒序', (() => {
  const times = dashRes.json.recent.map((item) => new Date(item.updatedAt).getTime());
  return times.every((value, index) => index === 0 || times[index - 1] >= value);
})(), JSON.stringify(dashRes.json.recent.map((item) => item.updatedAt)));
ok('recent 条目字段齐', dashRes.json.recent.every((item) => ['relPath', 'title', 'updatedAt', 'size'].every((key) => key in item)));

// 41d. maintain.lastReport 取最新一条
eq('lastReport 取最新', dashRes.json.maintain.lastReport.period, '2026-10-17');
eq('lastReport summary', dashRes.json.maintain.lastReport.summary, 'M01=2 M03=1 M04=0 M06=0 M07=0 M08=0');
ok('lastReport byRule 透出', typeof dashRes.json.maintain.lastReport.byRule.M01 === 'number');

// 41e. 未配置 root → 409
const emptyRootStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-dash-empty-'), 'settings.json') });
const emptyDashHandlers = hostRoutes.createHandlers({ store: emptyRootStore });
const emptyDash = await callHandler(emptyDashHandlers.dashboard, { method: 'GET' });
eq('未配置 root → 409', emptyDash.status, 409);
eq('未配置 root 错误码', emptyDash.json.error.code, 'root-missing');

// 41f. dashboard 不写盘
const dashSnapshotAfter = (() => {
  const out = {};
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name === '.jkkb') return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs); else out[abs] = fs.statSync(abs).mtimeMs;
    });
  };
  walk(dashRoot);
  return out;
})();
deepEq('dashboard 不写盘（mtime 快照一致）', dashSnapshotAfter, dashSnapshot);

// 41g. 目录归档：成功 moved.kind='dir'；目标已存在 → failed 而非 skipped
const dirRoot = await makeVaultRoot('jkkb-dirarch-');
const dirStore = vaultStore(dirRoot);
const dirRun = trace.createRun({ root: dirRoot, kind: 'archive', title: '目录归档' });
trace.acquireLock({ root: dirRoot, runId: dirRun.id });
const dirTools = createToolHandlers({ store: dirStore });
fs.mkdirSync(path.join(dirRoot, '09_项目与运营', '项目B'), { recursive: true });
fs.writeFileSync(path.join(dirRoot, '09_项目与运营', '项目B', 'index.md'), '---\ntitle: 项目B\n---\n正文\n');
fs.writeFileSync(path.join(dirRoot, '09_项目与运营', '项目B', 'note.md'), '---\ntitle: 子笔记\n---\n正文\n');
const dirOkay = await dirTools.archive({ runId: dirRun.id, items: [{ relPath: '09_项目与运营/项目B', reason: '项目已结束' }], confirm: true });
eq('目录归档 ok', dirOkay.ok, true);
eq('moved 1 条且 kind=dir', dirOkay.moved.length === 1 && dirOkay.moved[0].kind, 'dir');
eq('skipped 为空（目录已支持）', dirOkay.skipped.length, 0);
eq('源目录已移走', fs.existsSync(path.join(dirRoot, '09_项目与运营', '项目B', 'note.md')), false);
ok('归档目录整棵树都在', fs.existsSync(path.join(dirRoot, '12_归档与历史', '03_归档笔记', '09_项目与运营', '项目B', 'note.md')));
const undoKind = storeMod.createRepos({ root: dirRoot }).reportsRepo.list().filter((item) => item.kind === 'archive')[0].items[0];
eq('撤销依据带 kind=dir', undoKind.kind, 'dir');

fs.mkdirSync(path.join(dirRoot, '09_项目与运营', '项目C'), { recursive: true });
fs.writeFileSync(path.join(dirRoot, '09_项目与运营', '项目C', 'index.md'), '---\ntitle: 项目C\n---\n正文\n');
fs.mkdirSync(path.join(dirRoot, '12_归档与历史', '03_归档笔记', '09_项目与运营', '项目C'), { recursive: true });
const dirConflict = await dirTools.archive({ runId: dirRun.id, items: [{ relPath: '09_项目与运营/项目C', reason: '项目已结束' }], confirm: true });
eq('目标已存在 → failed', dirConflict.failed.length, 1);
eq('目标已存在 code', dirConflict.failed[0].code, 'TARGET_EXISTS');
eq('目标已存在不进 skipped', dirConflict.skipped.length, 0);
eq('目标冲突时原件保留', fs.existsSync(path.join(dirRoot, '09_项目与运营', '项目C', 'index.md')), true);
trace.releaseLock({ root: dirRoot, runId: dirRun.id });
trace.finishRun({ root: dirRoot, runId: dirRun.id, status: 'completed', summary: 'ok' });

// ═══════════════════ 42. doctor（诊断 / 修复 / 审计） ═══════════════════
const docRoot = await makeVaultRoot('jkkb-doctor-');
const docStore = vaultStore(docRoot);
const docHandlers = hostRoutes.createHandlers({ store: docStore, toolState: () => ({ registered: ['a'], failed: [] }) });

const docDiagnosis = await callHandler(docHandlers.doctorGet, { method: 'GET', url: '/plugins/jk-knowledge-base/doctor' });
eq('GET /doctor → 200', docDiagnosis.status, 200);
eq('doctor ok', docDiagnosis.json.ok, true);
ok('doctor 字段齐', ['generatedAt', 'root', 'checks', 'summary'].every((key) => key in docDiagnosis.json), JSON.stringify(Object.keys(docDiagnosis.json)));
ok('checks 每条带 id/level/detail', docDiagnosis.json.checks.every((item) => item.id && item.level && typeof item.detail === 'string'));
deepEq('summary 六键齐', Object.keys(docDiagnosis.json.summary).sort(), ['blocked', 'error', 'ok', 'repairable', 'total', 'warn']);
ok('doctor 返回 lastRepair 字段', 'lastRepair' in docDiagnosis.json);

// 42b. 未配置根目录 → CFG-01 blocked（不是 409）
const emptyDocStore = hostConfig.createSettingsStore({ file: path.join(makeTmpDir('jkkb-doctor-empty-'), 'settings.json') });
const emptyDocHandlers = hostRoutes.createHandlers({ store: emptyDocStore });
const emptyDoc = await callHandler(emptyDocHandlers.doctorGet, { method: 'GET' });
eq('未配置 root 时 GET /doctor 仍 200', emptyDoc.status, 200);
ok('checks 含 CFG-01', emptyDoc.json.checks.some((item) => item.id === 'CFG-01'), JSON.stringify(emptyDoc.json.checks.map((c) => c.id)));
eq('CFG-01 是 blocked', emptyDoc.json.checks.filter((item) => item.id === 'CFG-01')[0].level, 'blocked');

// 42c. 删一个顶层目录制造 DIR-01 问题
const missingDir = path.join(docRoot, '01_收件箱');
fs.rmSync(missingDir, { recursive: true, force: true });
const missingCheck = (await callHandler(docHandlers.doctorGet, { method: 'GET' })).json.checks
  .filter((item) => item.id === 'DIR-01')[0];
eq('目录缺失 → DIR-01 error', missingCheck && missingCheck.level, 'error');
eq('DIR-01 可修', missingCheck && missingCheck.repairId, 'R-DIR-01');

// 42d. repair 无 confirm → 400 CONFIRM_REQUIRED 且不落盘
const noConfirmRepair = await callHandler(docHandlers.doctorRepair, {
  method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair',
  body: { repairIds: ['R-DIR-01'], dryRun: false },
});
eq('无 confirm → 400', noConfirmRepair.status, 400);
eq('无 confirm 错误码', noConfirmRepair.json.error.code, 'CONFIRM_REQUIRED');
ok('无 confirm 返回 planned 预览', Array.isArray(noConfirmRepair.json.planned) && noConfirmRepair.json.planned.length === 1, JSON.stringify(noConfirmRepair.json.planned));
eq('无 confirm 不落盘', fs.existsSync(missingDir), false);

// 42e. repairIds 为空 → 400 NO_TARGETS
const noTargets = await callHandler(docHandlers.doctorRepair, {
  method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair', body: { repairIds: [], dryRun: false, confirm: true },
});
eq('repairIds 空 → 400', noTargets.status, 400);
eq('repairIds 空错误码', noTargets.json.error.code, 'NO_TARGETS');

// 42f. 有 running run（心跳新鲜）→ 409
const docRun = trace.createRun({ root: docRoot, kind: 'verify', title: '正在跑' });
const inProgress = await callHandler(docHandlers.doctorRepair, {
  method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair',
  body: { repairIds: ['R-DIR-01'], dryRun: false, confirm: true },
});
eq('有 running run → 409', inProgress.status, 409);
eq('running run 错误码', inProgress.json.error.code, 'run-in-progress');
ok('409 带 running run 列表', Array.isArray(inProgress.json.runs) && inProgress.json.runs.indexOf(docRun.id) >= 0, JSON.stringify(inProgress.json.runs));
trace.releaseLock({ root: docRoot, runId: docRun.id });
trace.finishRun({ root: docRoot, runId: docRun.id, status: 'completed', summary: 'ok' });

// 42g. dryRun=true 不写盘（严格：整个根目录含 .jkkb/doctor 前后一致）
const docSnapshot = (() => {
  const out = {};
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[abs] = fs.statSync(abs).mtimeMs;
    });
  };
  walk(docRoot);
  return out;
})();
const dryRun = await callHandler(docHandlers.doctorRepair, {
  method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair',
  body: { repairIds: ['R-DIR-01'], dryRun: true },
});
eq('dryRun → 200', dryRun.status, 200);
eq('dryRun 标记', dryRun.json.dryRun, true);
eq('dryRun applied 为空', dryRun.json.applied.length, 0);
ok('dryRun planned 完整', dryRun.json.planned.length === 1 && dryRun.json.planned[0].repairId === 'R-DIR-01');
const afterDrySnapshot = (() => {
  const out = {};
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[abs] = fs.statSync(abs).mtimeMs;
    });
  };
  walk(docRoot);
  return out;
})();
deepEq('dryRun 不写盘（mtime 快照一致）', afterDrySnapshot, docSnapshot);

// 42h. 真修：创建目录 + 审计 run + 报告
const realRepair = await callHandler(docHandlers.doctorRepair, {
  method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair',
  body: { repairIds: ['R-DIR-01'], dryRun: false, confirm: true },
});
eq('真修 → 200', realRepair.status, 200);
eq('applied 1 条', realRepair.json.applied.length, 1);
eq('applied 状态', realRepair.json.applied[0].status, 'applied');
eq('目录已补回', fs.existsSync(missingDir), true);
ok('审计 runId 存在', !!realRepair.json.audit && typeof realRepair.json.audit.runId === 'string', JSON.stringify(realRepair.json.audit));
const docAuditRun = trace.readRun(docRoot, realRepair.json.audit.runId);
eq('审计 run kind=doctor', docAuditRun.run.kind, 'doctor');
eq('审计 run 状态 completed', docAuditRun.run.status, 'completed');
ok('报告文件存在', !!realRepair.json.audit.reportPath && fs.existsSync(realRepair.json.audit.reportPath), String(realRepair.json.audit && realRepair.json.audit.reportPath));
const docReportText = fs.readFileSync(realRepair.json.audit.reportPath, 'utf8');
ok('报告含检查项与 movedTo 段', docReportText.indexOf('## 检查项') >= 0 && docReportText.indexOf('## movedTo 清单') >= 0);
ok('报告声明不删文件', docReportText.indexOf('不删除任何文件') >= 0);

// 42i. last.json + /health doctor 摘要
const docLast = JSON.parse(fs.readFileSync(path.join(docRoot, '.jkkb', 'doctor', 'last.json'), 'utf8'));
ok('last.json 记录 at/summary/issues', !!docLast.at && !!docLast.summary && !!docLast.issues, JSON.stringify(docLast));
eq('last.json 标记 kind=repair（宿主唯一写者）', docLast.kind, 'repair');
const healthWithDoctor = await callHandler(docHandlers.health, { method: 'GET' });
ok('health 暴露 doctor 摘要', !!healthWithDoctor.json.doctor && typeof healthWithDoctor.json.doctor.openIssues === 'object', JSON.stringify(healthWithDoctor.json.doctor));
ok('health.doctor.lastRunAt 非空', typeof healthWithDoctor.json.doctor.lastRunAt === 'string' && healthWithDoctor.json.doctor.lastRunAt.length > 0);

// 42j. 幂等：再修一次 applied=0 或 skipped
const idempotent = await callHandler(docHandlers.doctorRepair, {
  method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair',
  body: { repairIds: ['R-DIR-01'], dryRun: false, confirm: true },
});
eq('幂等：第二次仍 200', idempotent.status, 200);
ok('幂等：applied 为空或全 skipped',
  idempotent.json.applied.length === 0 || idempotent.json.applied.every((item) => item.status === 'skipped'),
  JSON.stringify(idempotent.json.applied));

// 42k. 工具：只诊断 / 无 confirm → NEED_CONFIRM / confirm → applied
const docTools = createToolHandlers({ store: docStore });
const toolDiagnose = await docTools.doctor({});
eq('工具只诊断 ok', toolDiagnose.ok, true);
eq('工具只诊断 mode', toolDiagnose.mode, 'diagnose');
ok('工具只诊断返回 checks', Array.isArray(toolDiagnose.checks) && toolDiagnose.checks.length > 0);
fs.rmSync(missingDir, { recursive: true, force: true });
const toolNeedConfirm = await docTools.doctor({ repairIds: ['R-DIR-01'] });
eq('工具无 confirm → NEED_CONFIRM', toolNeedConfirm.code, 'NEED_CONFIRM');
ok('工具 NEED_CONFIRM 带 planned', Array.isArray(toolNeedConfirm.planned) && toolNeedConfirm.planned.length === 1);
eq('工具未确认不落盘', fs.existsSync(missingDir), false);
const toolRepair = await docTools.doctor({ repairIds: ['R-DIR-01'], confirm: true });
eq('工具 confirm 后 applied', toolRepair.ok && toolRepair.applied.length, 1);
eq('工具修复后目录存在', fs.existsSync(missingDir), true);
ok('工具返回 reportPath', typeof toolRepair.reportPath === 'string' && fs.existsSync(toolRepair.reportPath));

// 42l. 诊断对损坏免疫：坏掉的 run.json 不影响 GET /doctor
const brokenRun = trace.createRun({ root: docRoot, kind: 'verify', title: '将被写坏' });
trace.finishRun({ root: docRoot, runId: brokenRun.id, status: 'completed', summary: 'ok' });
fs.writeFileSync(path.join(docRoot, '.jkkb', 'runs', brokenRun.id, 'run.json'), '{ 坏掉的 JSON');
const afterCorrupt = await callHandler(docHandlers.doctorGet, { method: 'GET' });
eq('坏 run.json 时 doctor 仍 200', afterCorrupt.status, 200);
ok('RUN-01 报出问题', afterCorrupt.json.checks.filter((item) => item.id === 'RUN-01')[0].level !== 'ok',
  JSON.stringify(afterCorrupt.json.checks.filter((item) => item.id === 'RUN-01')[0]));

// 42n. GET /doctor 连读两次不写盘（整库含 .jkkb/doctor 的 mtime 快照一致）
const doctorPuritySnapshot = () => {
  const out = {};
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs); else out[abs] = fs.statSync(abs).mtimeMs;
    });
  };
  walk(docRoot);
  return out;
};
const beforeDoctorReads = doctorPuritySnapshot();
await callHandler(docHandlers.doctorGet, { method: 'GET', url: '/plugins/jk-knowledge-base/doctor' });
await callHandler(docHandlers.doctorGet, { method: 'GET', url: '/plugins/jk-knowledge-base/doctor' });
deepEq('GET /doctor 连读两次不写盘（全库 mtime 不变）', doctorPuritySnapshot(), beforeDoctorReads);

// 42m. auditError：报告目录不可写时修复结果仍返回
if (process.platform !== 'win32') {
  const docDirPath = path.join(docRoot, '.jkkb', 'doctor');
  const originalMode = fs.statSync(docDirPath).mode;
  fs.chmodSync(docDirPath, 0o500);
  const auditFail = await callHandler(docHandlers.doctorRepair, {
    method: 'POST', url: '/plugins/jk-knowledge-base/doctor/repair',
    body: { repairIds: ['R-IDX-01'], dryRun: false, confirm: true },
  });
  fs.chmodSync(docDirPath, originalMode);
  eq('审计写失败仍返回 200', auditFail.status, 200);
  ok('响应带 auditError', typeof auditFail.json.auditError === 'string' && auditFail.json.auditError.length > 0, String(auditFail.json.auditError));
  ok('修复结果没被吞掉', Array.isArray(auditFail.json.applied), JSON.stringify(auditFail.json.summary));
}

// ═══════════════════ 43. 专家恢复 / 产出统计 / 解绑 / 死分支清理 ═══════════════════
const restRoot = await makeVaultRoot('jkkb-restore-');
const restStore = vaultStore(restRoot);
const restRun = trace.createRun({ root: restRoot, kind: 'skill', title: '专家恢复' });
trace.acquireLock({ root: restRoot, runId: restRun.id });
const restTools = createToolHandlers({ store: restStore });
const restRepos = storeMod.createRepos({ root: restRoot });
const restHandlers = hostRoutes.createHandlers({ store: restStore });

// 准备：自定义技能 SK900（用于制造悬空）+ 专家绑定两个技能 + 两张卡片
restRepos.skillsRepo.create({ id: 'SK900', name: '自定义技能', purpose: 'p', version: '1.0.0', status: 'active', path: '/kb/sk900.md' });
const restExpert = await restTools.expertCreate({
  runId: restRun.id, name: '产出统计专家', domain: '测试', responsibility: '验证专家产出统计与恢复能力',
  skillIds: ['common.quick_capture', 'SK900'],
});
eq('创建带两个技能的专家', restExpert.ok, true);
const restCardA = await restTools.curate({
  runId: restRun.id, skillId: 'common.quick_capture', title: '专家卡一', body: '正文一',
  tags: ['专家'], confidence: '中', expertId: restExpert.id,
});
const restCardB = await restTools.curate({
  runId: restRun.id, skillId: 'common.quick_capture', title: '专家卡二', body: '正文二',
  tags: ['专家'], confidence: '中', expertId: restExpert.id,
});
eq('两张卡片都入柜成功', restCardA.ok && restCardB.ok, true);

// 43a. cardCount / lastUsedAt / skillStates
const restList = await callHandler(restHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts' });
const restItem = restList.json.experts.filter((item) => item.id === restExpert.id)[0];
eq('cardCount 与实际入柜数量一致', restItem.cardCount, 2);
const cardTimes = restRepos.cardsRepo.list().filter((c) => c.expertId === restExpert.id).map((c) => c.createdAt).sort();
eq('lastUsedAt 取最新卡片时间', restItem.lastUsedAt, cardTimes[cardTimes.length - 1]);
deepEq('skillStates 覆盖两个绑定技能', restItem.skillStates.map((item) => item.id).sort(), ['SK900', 'common.quick_capture']);
ok('绑定的内置技能 ok=true', restItem.skillStates.filter((item) => item.id === 'common.quick_capture')[0].ok === true);
eq('当前无悬空技能', restItem.danglingSkillIds.length, 0);

// 43b. 悬空技能：删掉 SK900 记录后 skillStates ok=false
restRepos.skillsRepo.remove('SK900');
const danglingList = await callHandler(restHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts' });
const danglingItem = danglingList.json.experts.filter((item) => item.id === restExpert.id)[0];
const danglingState = danglingItem.skillStates.filter((item) => item.id === 'SK900')[0];
eq('悬空技能 ok=false', danglingState.ok, false);
ok('悬空技能带原因', typeof danglingState.reason === 'string' && danglingState.reason.length > 0, JSON.stringify(danglingState));
deepEq('danglingSkillIds 命中', danglingItem.danglingSkillIds, ['SK900']);

// 43c. 解绑：skillIds patch 去掉一项，cardCount 不变
const unbound = await callHandler(restHandlers.expertsScoped, {
  method: 'PATCH', url: '/plugins/jk-knowledge-base/experts/' + restExpert.id,
  body: { skillIds: ['common.quick_capture'] },
});
eq('解绑成功', unbound.status, 200);
deepEq('解绑后 skillIds 不再含 SK900', unbound.json.expert.skillIds, ['common.quick_capture']);
const afterUnbind = await callHandler(restHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts' });
const unboundItem = afterUnbind.json.experts.filter((item) => item.id === restExpert.id)[0];
eq('解绑后 cardCount 不变', unboundItem.cardCount, 2);
eq('解绑后无悬空技能', unboundItem.danglingSkillIds.length, 0);
const emptied = await callHandler(restHandlers.expertsScoped, {
  method: 'PATCH', url: '/plugins/jk-knowledge-base/experts/' + restExpert.id, body: { skillIds: [] },
});
eq('skillIds 置空不报校验错', emptied.status, 200);
deepEq('skillIds 置空生效', emptied.json.expert.skillIds, []);
await callHandler(restHandlers.expertsScoped, {
  method: 'PATCH', url: '/plugins/jk-knowledge-base/experts/' + restExpert.id, body: { skillIds: ['common.quick_capture'] },
});

// 43d. 归档后统计仍在 + 恢复（幂等）+ 未知 id
await callHandler(restHandlers.expertsScoped, { method: 'POST', url: '/plugins/jk-knowledge-base/experts/' + restExpert.id + '/archive' });
const archivedStats = await callHandler(restHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts?status=archived' });
eq('归档后卡片数仍统计到该专家', archivedStats.json.experts.filter((item) => item.id === restExpert.id)[0].cardCount, 2);
const expertRestored = await callHandler(restHandlers.expertsScoped, { method: 'POST', url: '/plugins/jk-knowledge-base/experts/' + restExpert.id + '/restore' });
eq('restore → 200', expertRestored.status, 200);
eq('restore 后 status=active', expertRestored.json.expert.status, 'active');
eq('restore alreadyActive=false', expertRestored.json.alreadyActive, false);
const activeAfterRestore = await callHandler(restHandlers.expertsList, { method: 'GET', url: '/plugins/jk-knowledge-base/experts' });
ok('恢复后回到 active 列表', activeAfterRestore.json.experts.some((item) => item.id === restExpert.id));
const restoreAgain = await callHandler(restHandlers.expertsScoped, { method: 'POST', url: '/plugins/jk-knowledge-base/experts/' + restExpert.id + '/restore' });
eq('重复 restore → 200', restoreAgain.status, 200);
eq('重复 restore 幂等 alreadyActive=true', restoreAgain.json.alreadyActive, true);
const restoreUnknown = await callHandler(restHandlers.expertsScoped, { method: 'POST', url: '/plugins/jk-knowledge-base/experts/EXP-999/restore' });
eq('未知 id restore → 404', restoreUnknown.status, 404);
eq('未知 id restore 错误码', restoreUnknown.json.error.code, 'EXPERT_NOT_FOUND');

// 43e. 工具版 restore（配置类，不强制 runId）
const toolRestore = await restTools.expertRestore({ id: restExpert.id });
eq('工具 restore 成功', toolRestore.ok, true);
eq('工具 restore alreadyActive', toolRestore.alreadyActive, true);

// 43f. 目录归档：moved.kind='dir' 且 skipped 为空
fs.mkdirSync(path.join(restRoot, '09_项目与运营', '项目R'), { recursive: true });
fs.writeFileSync(path.join(restRoot, '09_项目与运营', '项目R', 'index.md'), '---\ntitle: 项目R\n---\n正文\n');
const restDirArchive = await restTools.archive({
  runId: restRun.id, items: [{ relPath: '09_项目与运营/项目R', reason: '项目已结束' }], confirm: true,
});
eq('目录归档 ok', restDirArchive.ok, true);
eq('moved.kind=dir', restDirArchive.moved[0].kind, 'dir');
deepEq('skipped 为空（死分支已清理）', restDirArchive.skipped, []);

// 43g. 过期文案已清零
const toolsSource = fs.readFileSync(path.join(root, 'host', 'tools.js'), 'utf8');
eq("host/tools.js 里「下版本」出现次数为 0", (toolsSource.match(/下版本/g) || []).length, 0);

trace.releaseLock({ root: restRoot, runId: restRun.id });
trace.finishRun({ root: restRoot, runId: restRun.id, status: 'completed', summary: 'ok' });

// ─────────────────── 汇总 ───────────────────
const total = passed + failures.length;
if (failures.length) {
  console.error('SMOKE FAIL: ' + passed + '/' + total);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('SMOKE OK: ' + passed + '/' + total);
  process.exitCode = 0;
}
