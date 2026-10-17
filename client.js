/**
 * jk-knowledge-base —— 浏览器半（DSH Web GUI 第三方插件，lazy factory 格式）。
 *
 * 入口契约：window.__ModuleLoader__.load({ id, factory })，其中 id 必须等于包名。
 * 依赖面：只 require('react')。不得 require 任何 @deepseek-ai/* 包。
 *
 * 席位：
 * - settings.section（list）：设置导航新增「JK知识库」子菜单，常驻注册。
 * - sidebar.panellist（list）+ main（list）：受「启动JK知识库」开关控制。
 *   开关打开才注册，关闭时两条注册全部 dispose（参考 logo-substitute 的
 *   releaseBrands：切换时先全部释放，再按当前状态按需重建）。
 *
 * 求值：apply(ctx) 先做 slots 能力防错，缺任何一个直接 return，绝不抛异常。
 * 持久化：渲染层 localStorage（key jk-knowledge-base:v1），刷新 / 重启后仍生效。
 * 数据：全部来自宿主，无前端假数据（仪表盘 GET /dashboard，任务 GET /runs，专家 GET /experts，体检 GET /doctor）；「任务」看板与任务详情全部来自宿主
 *   GET /runs、GET /runs/:id（轮询即全量刷新，前端不维护第二份真源），
 *   发起 / 中止走 POST /run、POST /runs/:id/cancel。
 */
window.__ModuleLoader__.load({
  id: 'jk-knowledge-base',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PLUGIN_ID = 'jk-knowledge-base';
    // 侧边栏菜单行与主区域页面共用同一个 key，两者必须一致才能互相选中。
    const PANEL_ID = 'jk-knowledge-base';
    const PLUGIN_NAME = 'JK知识库';
    // 与 package.json 的 version 保持同一版本。
    const PLUGIN_VERSION = '1.0.0';
    const PLUGIN_AUTHOR = 'JakeKim@XingHaoTech';
    const STORAGE_KEY = 'jk-knowledge-base:v1';
    // 左栏「执行任务」区最多展示的条数；超过它才出现「更多」按钮。
    const TASK_LIMIT = 3;
    const RUNS_PAGE_SIZE = 20;
    const DASHBOARD_ID = 'dashboard';
    const EXPERTS_ID = 'experts';
    const TASKS_ID = 'tasks';
    // 运行中的任务按 1.5s 全量刷新一次；全部结束后立即停止轮询。
    const POLL_INTERVAL_MS = 1500;

    // 设置页：开关说明、引导步骤与「去设置」的 focus 标记。
    const SWITCH_HINT_TEXT = '打开后，主界面侧边栏「插件」行的正下方出现「知识库」菜单；关闭则菜单与对应页面一起移除。'
      + '开关状态保存在浏览器 localStorage（key ' + STORAGE_KEY + '），刷新 / 重启后保持。';
    const FOCUS_KEY = 'jk-knowledge-base:focus';
    const GUIDE_STEP_HINT = '请打开 设置 → JK知识库';
    const GUIDE_STEPS = [
      { id: 'root', index: '1', title: '选择知识库根目录' },
      { id: 'ack', index: '2', title: '勾选风险确认' },
      { id: 'save', index: '3', title: '点击「保存」' },
    ];
    // 设置左栏里属于本插件的那一行：只认这个 label，绝不碰其它 nav 项。
    const NAV_LABEL_TEXT = 'JK知识库';
    const FOCUS_HIGHLIGHT_MS = 2500;

    // host 半路由（见 host/routes.js）：四条行为、三条 path（GET/POST 共用 /config）。
    const HOST_CONFIG_PATH = '/plugins/jk-knowledge-base/config';
    const HOST_VALIDATE_PATH = '/plugins/jk-knowledge-base/config/validate';
    const HOST_HEALTH_PATH = '/plugins/jk-knowledge-base/health';
    // 任务区路由：列表 / 单次详情 / 发起 / 中止。
    const HOST_RUNS_PATH = '/plugins/jk-knowledge-base/runs';
    const HOST_RUN_PATH = '/plugins/jk-knowledge-base/run';
    const HOST_PREFLIGHT_PATH = '/plugins/jk-knowledge-base/preflight';
    const HOST_LEDGER_CALENDAR_PATH = '/plugins/jk-knowledge-base/ledger/calendar';
    const HOST_LEDGER_DAY_PATH = '/plugins/jk-knowledge-base/ledger/day';
    const HOST_SKILLS_PATH = '/plugins/jk-knowledge-base/skills';
    const HOST_REPORTS_PATH = '/plugins/jk-knowledge-base/reports';
    const HOST_SKILL_REGISTRY_PATH = '/plugins/jk-knowledge-base/skill-registry';
    const HOST_SKILL_CALLS_PATH = '/plugins/jk-knowledge-base/skill-calls';
    const HOST_EXPERTS_PATH = '/plugins/jk-knowledge-base/experts';
    const HOST_DASHBOARD_PATH = '/plugins/jk-knowledge-base/dashboard';
    const HOST_DOCTOR_PATH = '/plugins/jk-knowledge-base/doctor';
    const HOST_DOCTOR_REPAIR_PATH = '/plugins/jk-knowledge-base/doctor/repair';
    const BUILTIN_SKILL_COUNT = 47;
    const HOST_TIMEOUT_MS = 10000;
    // 路由 404 = 宿主半没加载（client 半从磁盘热加载，host 半只在进程启动时加载）。
    const HOST_NOT_LOADED_MESSAGE = '宿主半未加载（HTTP 404）：请完全退出并重新打开 DeepSeek Harness（⌘Q 后再打开；只刷新窗口不会重载宿主）。';
    // 与 host/config.js 的 RISK_ACK_TEXT 必须逐字一致（两端各一份常量，smoke 交叉校验）。
    const RISK_ACK_TEXT = '我已了解风险并授权写入该目录';
    // 与 host/root-policy.js 的 VAULT_TOP_LEVEL_DIRS.length 对应，仅用于文案。
    const VAULT_TOP_LEVEL_COUNT = 13;

    // ───────────────────────────── 开关状态模型（纯函数） ─────────────────────────────
    // 默认关闭；只有 JSON 里严格为 true 才算开启，脏数据一律回落 false。
    function defaultState() {
      return { enabled: false };
    }

    function normalizeState(raw) {
      if (!raw || typeof raw !== 'object') return defaultState();
      return { enabled: raw.enabled === true };
    }

    function isEnabled(state) {
      return normalizeState(state).enabled;
    }

    function resolveStorage() {
      try {
        if (typeof window !== 'undefined' && window && window.localStorage) return window.localStorage;
      } catch (err) { /* 隐私模式等场景下取 localStorage 会抛，忽略 */ }
      try {
        if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
      } catch (err) { /* 同上 */ }
      return null;
    }

    function readState(storage) {
      try {
        const store = storage || resolveStorage();
        if (!store || typeof store.getItem !== 'function') return defaultState();
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return defaultState();
        return normalizeState(JSON.parse(raw));
      } catch (err) {
        return defaultState();
      }
    }

    function writeState(storage, state) {
      const next = normalizeState(state);
      try {
        const store = storage || resolveStorage();
        if (!store || typeof store.setItem !== 'function') return false;
        store.setItem(STORAGE_KEY, JSON.stringify(next));
        return true;
      } catch (err) {
        return false;
      }
    }

    // 切换开关：写盘成功才返回新状态，失败时由调用方保持原状态并给中文提示。
    function persistState(storage, next) {
      const target = normalizeState(next);
      const ok = writeState(storage, target);
      return { ok: ok, state: ok ? target : null };
    }

    // ───────────────────────────── 共享状态 ─────────────────────────────
    // 设置页切换开关后，apply() 必须立刻加 / 撤两个席位，故用极小的订阅式 store。
    function createStore(initial) {
      let state = normalizeState(initial);
      const listeners = [];
      return {
        get: () => state,
        set(next) {
          state = normalizeState(next);
          listeners.slice().forEach((fn) => {
            try { fn(state); } catch (err) { /* 单个订阅者出错不影响其它订阅者 */ }
          });
        },
        subscribe(fn) {
          listeners.push(fn);
          return () => {
            const at = listeners.indexOf(fn);
            if (at >= 0) listeners.splice(at, 1);
          };
        },
      };
    }

    const store = createStore(defaultState());

    // apply(ctx) 注入的模块级引用：引导卡的「去设置」按钮取不到 props 里的 ctx。
    let pluginCtx = null;

    // 未配置根目录时只保留仪表盘；其它状态（loading/error/ready）保持完整菜单。
    function visibleMenus(rootStatus) {
      if (rootStatus === 'no-root') return MENUS.filter((menu) => menu.id === DASHBOARD_ID);
      return MENUS.slice();
    }

    // 左栏菜单：数据驱动；顺序即展示顺序。
    const MENUS = [
      { id: DASHBOARD_ID, label: '仪表盘', description: '知识库总览：统计、最近入库与运行状态。' },
      { id: EXPERTS_ID, label: '业务专家', description: '按业务领域维护专家角色、绑定技能与提示词' },
      { id: TASKS_ID, label: '任务管理', description: '执行任务、整理报告与技能台账。' },
    ];

    // 可发起的 run 类型：id / 展示名 / 按钮文案。
    const RUN_KINDS = [
      { id: 'bootstrap', label: '建库', action: '开始建库' },
      { id: 'verify', label: '体检', action: '体检' },
      { id: 'reindex', label: '重建索引', action: '重建索引' },
    ];

    const RECOVER_ACTIONS = [
      { id: 'resume', label: '继续', confirm: '继续会从上次进度接着跑，不会备份当前产物。' },
      { id: 'restart', label: '重新开始', confirm: '重新开始会先备份旧产物到 .jkkb/backup/，再从头执行。' },
      { id: 'abandon', label: '放弃', confirm: '放弃只会结束这次任务，不会修改或删除任何文件。' },
    ];
    const RECOVER_ACTION_IDS = RECOVER_ACTIONS.map((action) => action.id);

    // 仅测试夹具：生产渲染不得引用（侧栏执行任务区改接 GET /runs）。
    const TASKS = [
      { id: 't1', name: '整理本周新增笔记', meta: '进行中 · 12 条' },
      { id: 't2', name: '为 9 条笔记补标签', meta: '排队中' },
      { id: 't3', name: '重建知识库索引', meta: '已完成 · 耗时 2m' },
      { id: 't4', name: '归档过期草稿', meta: '排队中' },
      { id: 't5', name: '导出本周知识摘要', meta: '已完成' },
    ];

    // 截断逻辑与「更多」判定是同一处，纯函数便于单测。
    function sliceTasks(tasks, limit) {
      const list = Array.isArray(tasks) ? tasks : [];
      const max = typeof limit === 'number' && limit > 0 ? limit : TASK_LIMIT;
      return { items: list.slice(0, max), hasMore: list.length > max };
    }

    // 展开 / 收起：默认按 TASK_LIMIT 截断，展开后展示全部；没有更多时永远不出现按钮。
    function buildTasksView(tasks, limit, expanded) {
      const base = sliceTasks(tasks, limit);
      const isExpanded = base.hasMore && expanded === true;
      return {
        items: isExpanded ? (Array.isArray(tasks) ? tasks.slice() : []) : base.items,
        hasMore: base.hasMore,
        expanded: isExpanded,
        moreState: isExpanded ? 'less' : 'more',
        moreLabel: isExpanded ? '收起' : '更多',
      };
    }

    // 主页面 UI 状态：选中菜单 + 任务区是否展开。切换菜单一律收起任务区。
    function createPanelState() {
      return { selected: (MENUS[0] && MENUS[0].id) || DASHBOARD_ID, expanded: false };
    }

    function reducePanel(state, action) {
      const fallback = createPanelState();
      const base = state && typeof state === 'object' ? state : fallback;
      // 选中项不认识（脏状态 / 菜单被删）就整体回落到初始态。
      const match = MENUS.filter((menu) => menu.id === base.selected)[0];
      if (!match) return fallback;
      const act = action || {};
      if (act.type === 'select' && MENUS.filter((menu) => menu.id === act.id)[0]) {
        // 切菜单时复位展开态：切走再回来不该还是展开的。
        return { selected: act.id, expanded: false };
      }
      if (act.type === 'toggleTasks') return { selected: match.id, expanded: base.expanded !== true };
      return { selected: match.id, expanded: base.expanded === true };
    }

    // ───────────────────────────── 宿主服务（HTTP）─────────────────────────────
    async function hostRequest(routePath, options) {
      const impl = typeof fetch === 'function' ? fetch : null;
      if (!impl) return { ok: false, error: { code: 'host-unreachable', message: '宿主服务未连接：当前环境没有 fetch' } };
      const init = Object.assign(
        { credentials: 'same-origin', headers: { 'content-type': 'application/json' } },
        options || {}
      );
      let response = null;
      try {
        response = await impl(routePath, init);
      } catch (err) {
        // fetch 直接失败 = host 半没起来 / 路由没注册，不能静默。
        return { ok: false, error: { code: 'host-unreachable', message: '宿主服务未连接（无法访问插件后端）' } };
      }
      let data = null;
      try {
        data = await response.json();
      } catch (err) {
        // 非 JSON 的 404 = 路由根本没注册（宿主半未加载），不是「响应坏了」。
        if (response && response.status === 404) {
          return { ok: false, status: 404, error: { code: 'host-half-not-loaded', message: HOST_NOT_LOADED_MESSAGE } };
        }
        return {
          ok: false,
          status: response && response.status,
          error: { code: 'bad-response', message: '宿主服务返回了非 JSON 响应（HTTP ' + (response && response.status) + '）' },
        };
      }
      // JSON 的 404 若带 error（run-not-found 等）说明宿主在线，按原错误透传。
      if (data && data.error) return { ok: false, status: response && response.status, error: data.error };
      if (data && typeof data.ok === 'boolean') return data;
      if (response && response.status === 404) {
        return { ok: false, status: 404, error: { code: 'host-half-not-loaded', message: HOST_NOT_LOADED_MESSAGE } };
      }
      return { ok: false, status: response && response.status, error: { code: 'bad-response', message: '宿主服务响应缺少 ok 字段' } };
    }

    function loadHostConfig() {
      return hostRequest(HOST_CONFIG_PATH, { method: 'GET' });
    }

    // 入口探活：区分「宿主半未加载 / 版本不一致 / 网络不通」三种状态，供设置页唯一一处诊断使用。
    async function probeHost() {
      const result = await hostRequest(HOST_HEALTH_PATH, { method: 'GET' });
      if (result && result.ok === true) {
        const version = typeof result.version === 'string' ? result.version : '';
        if (version !== PLUGIN_VERSION) {
          return {
            status: 'mismatch',
            version: version,
            error: { code: 'host-version-mismatch', message: describeHealth({ status: 'mismatch', version: version }).text },
          };
        }
        return { status: 'ready', version: version, error: null };
      }
      const error = (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' };
      if (error.code === 'host-half-not-loaded') return { status: 'not-loaded', version: '', error: error };
      return { status: 'error', version: '', error: error };
    }

    // 把探活结果翻成徽标 + 单行诊断文案；ready 时 text 为空（不刷屏）。
    function describeHealth(probe, expectedVersion) {
      const p = probe && typeof probe === 'object' ? probe : { status: 'loading' };
      const expected = expectedVersion || PLUGIN_VERSION;
      if (p.status === 'ready') return { status: 'ready', label: '宿主已连接', level: '', text: '' };
      if (p.status === 'mismatch') {
        return {
          status: 'mismatch',
          label: '宿主版本不一致',
          level: 'error',
          text: '宿主半版本 ' + (p.version || '未知') + ' 与界面 ' + expected + ' 不一致，请重启应用',
        };
      }
      if (p.status === 'not-loaded') {
        return { status: 'not-loaded', label: '宿主半未加载', level: 'error', text: HOST_NOT_LOADED_MESSAGE };
      }
      if (p.status === 'error') {
        return {
          status: 'error',
          label: '宿主服务未连接',
          level: 'error',
          text: '宿主服务未连接：' + ((p.error && p.error.message) || '无法访问插件后端'),
        };
      }
      return { status: 'loading', label: '连接中…', level: '', text: '' };
    }

    function validateRoot(root) {
      return hostRequest(HOST_VALIDATE_PATH, { method: 'POST', body: JSON.stringify({ root: root }) });
    }

    function saveRoot(root, riskAck) {
      return hostRequest(HOST_CONFIG_PATH, { method: 'POST', body: JSON.stringify({ root: root, riskAck: riskAck === true }) });
    }

    function describeHostError(result) {
      const error = result && result.error ? result.error : null;
      if (!error) return '未知错误';
      return (error.code ? error.code + ' ' : '') + (error.message || '');
    }

    // ───────────────────────────── 运行任务：HTTP 封装 ─────────────────────────────
    // 全部沿用 hostRequest：同一前缀、同一错误处理。前端不累积、不写回，轮询即全量刷新。
    // 无参数时保持原 URL（测试与旧调用兼容）；组件传 limit/before 才拼查询串。
    function buildRunsQuery(options) {
      const o = options || {};
      const parts = [];
      if (typeof o.limit === 'number' && isFinite(o.limit) && o.limit > 0) {
        parts.push('limit=' + Math.min(100, Math.floor(o.limit)));
      }
      if (typeof o.before === 'string' && o.before) parts.push('before=' + encodeURIComponent(o.before));
      return parts.length > 0 ? '?' + parts.join('&') : '';
    }

    function fetchRuns(options) {
      return hostRequest(HOST_RUNS_PATH + buildRunsQuery(options), { method: 'GET' });
    }

    // 追加去重：同一个 run 不会因为翻页边界重复出现。
    function mergeRunPages(existing, incoming) {
      const seen = {};
      const out = [];
      const push = (run) => {
        if (!run || typeof run !== 'object' || run.id == null) return;
        const key = String(run.id);
        if (seen[key]) return;
        seen[key] = true;
        out.push(run);
      };
      (Array.isArray(existing) ? existing : []).forEach(push);
      (Array.isArray(incoming) ? incoming : []).forEach(push);
      return out;
    }

    // 轮询只允许在第一页且有 running 时开启（翻页后停，避免列表跳动）。
    function shouldPollRunsPage(state) {
      const value = state && typeof state === 'object' ? state : {};
      if (value.phase !== 'ready') return false;
      if (typeof value.pages === 'number' && value.pages > 1) return false;
      return hasRunningRuns(value.runs);
    }

    function fetchRunDetail(runId) {
      const id = String(runId == null ? '' : runId);
      return hostRequest(HOST_RUNS_PATH + '/' + encodeURIComponent(id), { method: 'GET' });
    }

    // host 契约只声明 kind；force 默认不传（避免覆盖已有 _说明.md）。
    function startHostRun(kind) {
      return hostRequest(HOST_RUN_PATH, { method: 'POST', body: JSON.stringify({ kind: kind }) });
    }

    function recoverHostRun(runId, action) {
      const id = String(runId == null ? '' : runId);
      return hostRequest(HOST_RUNS_PATH + '/' + encodeURIComponent(id) + '/recover', {
        method: 'POST',
        body: JSON.stringify({ action: action }),
      });
    }

    function cancelHostRun(runId) {
      const id = String(runId == null ? '' : runId);
      return hostRequest(HOST_RUNS_PATH + '/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: JSON.stringify({}) });
    }

    // ───────────────────────────── 运行任务：纯函数数据模型 ─────────────────────────────
    function runKindLabel(kind) {
      const value = String(kind == null ? '' : kind);
      const hit = RUN_KINDS.filter((item) => item.id === value)[0];
      return hit ? hit.label : (value || '未知');
    }

    function normalizeRunKind(kind) {
      const value = String(kind == null ? '' : kind).trim().toLowerCase();
      return RUN_KINDS.filter((item) => item.id === value)[0] ? value : '';
    }

    // host 契约只认 running / done / failed；其余值兜底成 unknown，不猜语义。
    function normalizeRunStatus(raw) {
      const value = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!value) return 'unknown';
      if (value === 'running' || value === 'pending' || value === 'queued' || value === 'started' || value === 'start') return 'running';
      if (value === 'done' || value === 'ok' || value === 'success' || value === 'succeeded' || value === 'completed' || value === 'complete') return 'done';
      if (value === 'failed' || value === 'failure' || value === 'error') return 'failed';
      if (value === 'cancelled' || value === 'canceled' || value === 'aborted') return 'cancelled';
      if (value === 'timed_out') return 'timed_out';
      if (value === 'stalled') return 'stalled';
      if (value === 'abandoned') return 'abandoned';
      return 'unknown';
    }

    function statusLabel(rawStatus) {
      const raw = String(rawStatus == null ? '' : rawStatus).trim().toLowerCase();
      if (raw === 'cancelled' || raw === 'canceled' || raw === 'aborted') return '已中止';
      const tone = normalizeRunStatus(rawStatus);
      if (tone === 'running') return '运行中';
      if (tone === 'done') return '完成';
      if (tone === 'failed') return '失败';
      if (tone === 'timed_out') return '已超时';
      if (tone === 'stalled') return '已卡住';
      if (tone === 'abandoned') return '已放弃';
      return rawStatus ? String(rawStatus) : '未知';
    }

    // host/trace.js 的 STEP_STATUSES = ['start','ok','skip','error']，与 run 状态分开命名。
    function normalizeStepStatus(raw) {
      const value = String(raw == null ? '' : raw).trim().toLowerCase();
      if (value === 'start') return 'running';
      if (value === 'ok') return 'done';
      if (value === 'skip') return 'skipped';
      if (value === 'error') return 'failed';
      return normalizeRunStatus(value);
    }

    function stepStatusLabel(rawStatus) {
      const value = String(rawStatus == null ? '' : rawStatus).trim().toLowerCase();
      if (value === 'start') return '进行中';
      if (value === 'ok') return '完成';
      if (value === 'skip') return '已跳过';
      if (value === 'error') return '失败';
      return statusLabel(rawStatus);
    }

    function runKindActionLabel(kind) {
      const value = String(kind == null ? '' : kind);
      const hit = RUN_KINDS.filter((item) => item.id === value)[0];
      return hit ? hit.action : '任务';
    }

    // ───────────────────────────── 恢复动作（recover） ─────────────────────────────
    function recoverActionLabel(action) {
      const value = String(action == null ? '' : action).trim().toLowerCase();
      const hit = RECOVER_ACTIONS.filter((item) => item.id === value)[0];
      return hit ? hit.label : (value || '未知');
    }

    function recoverConfirmText(action) {
      const value = String(action == null ? '' : action).trim().toLowerCase();
      const hit = RECOVER_ACTIONS.filter((item) => item.id === value)[0];
      return hit ? hit.confirm : '';
    }

    function normalizeRecovery(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const action = String(raw.action == null ? '' : raw.action).trim().toLowerCase();
      return {
        action: RECOVER_ACTION_IDS.indexOf(action) >= 0 ? action : '',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.slice() : [],
      };
    }

    // 可用条件矩阵：resume 仅 decision=resume；restart 允许 resume/restart；abandon 任何非 running。
    function buildRecoverActions(run, recovery) {
      const source = run && typeof run === 'object' ? run : {};
      const decision = recovery && typeof recovery === 'object' && typeof recovery.action === 'string'
        ? recovery.action
        : '';
      const running = normalizeRunStatus(source.status) === 'running';
      return RECOVER_ACTIONS.map((action) => ({
        id: action.id,
        label: action.label,
        confirm: action.confirm,
        enabled: action.id === 'resume'
          ? decision === 'resume'
          : (action.id === 'restart' ? (decision === 'resume' || decision === 'restart') : !running),
      }));
    }

    // 409 → 当前建议 + 原因；422 → 宿主 message；其它 → 原始 code + message。
    function describeRecoverOutcome(result) {
      if (result && result.ok === true) {
        return { ok: true, kind: 'ok', status: typeof result.status === 'string' ? result.status : '', suggested: '', message: '' };
      }
      const status = result && result.status;
      const error = result && result.error && typeof result.error === 'object' ? result.error : {};
      if (status === 409) {
        const suggested = typeof error.suggested === 'string' ? error.suggested : '';
        const decision = error.decision && typeof error.decision === 'object' ? error.decision : {};
        const reason = typeof decision.reason === 'string' ? decision.reason : '';
        return {
          ok: false,
          kind: 'conflict',
          suggested: suggested,
          message: suggested
            ? '当前建议：' + recoverActionLabel(suggested) + (reason ? '（原因：' + reason + '）' : '')
            : (error.message || '操作与当前恢复建议不一致'),
        };
      }
      if (status === 422) {
        return { ok: false, kind: 'rejected', suggested: '', message: error.message || '宿主拒绝了该操作' };
      }
      return {
        ok: false,
        kind: 'error',
        suggested: '',
        message: (error.code ? error.code + ' ' : '') + (error.message || '请求失败'),
      };
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    // startedAt / endedAt 既可能是 ISO 字符串，也可能是毫秒数；无法解析一律 null。
    function toMillis(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') return isFinite(value) ? value : null;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (/^\d+$/.test(trimmed)) {
          const num = Number(trimmed);
          return isFinite(num) ? num : null;
        }
        const parsed = Date.parse(trimmed);
        return isNaN(parsed) ? null : parsed;
      }
      return null;
    }

    function formatRelativeTime(value, nowValue) {
      const ms = toMillis(value);
      if (ms === null) return '—';
      const now = resolveNow(nowValue);
      const diff = Math.max(0, now - ms);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diff < minute) return '刚刚';
      if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
      if (diff < day) return Math.floor(diff / hour) + ' 小时前';
      if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
      return formatTimestamp(value);
    }

    function formatTimestamp(value) {
      const ms = toMillis(value);
      if (ms === null) return '—';
      const date = new Date(ms);
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function formatSpan(ms) {
      const totalSeconds = Math.max(0, Math.round(ms / 1000));
      if (totalSeconds < 60) return totalSeconds + 's';
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes < 60) return minutes + 'm ' + pad2(seconds) + 's';
      return Math.floor(minutes / 60) + 'h ' + pad2(minutes % 60) + 'm';
    }

    // 未结束的任务按 now 计时并加「+」后缀；起止都缺失时给「—」，不假装有耗时。
    function formatDuration(startValue, endValue, nowValue) {
      const start = toMillis(startValue);
      if (start === null) return '—';
      const end = toMillis(endValue);
      if (end !== null) return formatSpan(end - start);
      const now = toMillis(nowValue);
      if (now === null) return '—';
      return formatSpan(now - start) + '+';
    }

    // now 未传入时用当前时间；测试可传固定值保证可断言。
    function resolveNow(nowValue) {
      const ms = toMillis(nowValue);
      return ms === null ? Date.now() : ms;
    }

    // 心跳年龄：秒 / 分 / 时三档；heartbeatAt 缺失给「—」，不编造。
    function formatHeartbeatAge(heartbeatAt, nowValue) {
      const beat = toMillis(heartbeatAt);
      if (beat === null) return '—';
      const now = resolveNow(nowValue);
      const seconds = Math.floor(Math.max(0, now - beat) / 1000);
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm';
      return Math.floor(minutes / 60) + 'h';
    }

    // 心跳阈值：agent 120s / engine 300s；heartbeatBy 缺失按 agent 处理。
    function heartbeatThresholdMs(by) {
      return String(by == null ? '' : by).trim().toLowerCase() === 'engine' ? 300000 : 120000;
    }

    // 仅前端提示「疑似卡住」：running 且心跳年龄严格超过阈值；不改状态。
    function isSuspectedStall(run, nowValue) {
      const source = run && typeof run === 'object' ? run : {};
      if (normalizeRunStatus(source.status) !== 'running') return false;
      const beat = toMillis(source.heartbeatAt);
      if (beat === null) return false;
      const age = resolveNow(nowValue) - beat;
      return age > heartbeatThresholdMs(source.heartbeatBy);
    }

    function firstFiniteNumber() {
      for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i];
        if (typeof value === 'number' && isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) return Number(value);
      }
      return null;
    }

    // 预算由 startedAt / deadlineAt 推导（宿主契约没有 budgetUsed/budgetTotal）：
    // total = deadlineAt - startedAt，used = now - startedAt，按耗时格式展示。
    // 仅当两者缺失时才回退到宿主可能带的显式字段；全缺显示 —。
    function readBudget(run, nowValue) {
      const source = run && typeof run === 'object' ? run : {};
      const start = toMillis(source.startedAt);
      const deadline = toMillis(source.deadlineAt);
      if (start !== null && deadline !== null) {
        const total = deadline - start;
        if (total > 0) {
          const used = Math.max(0, resolveNow(nowValue) - start);
          return {
            used: used,
            total: total,
            text: formatSpan(used) + '/' + formatSpan(total),
            over: used > total,
            source: 'deadline',
          };
        }
      }
      const nested = source.budget && typeof source.budget === 'object' ? source.budget : {};
      const used = firstFiniteNumber(source.budgetUsed, source.stepsUsed, nested.used, nested.usedSteps);
      const total = firstFiniteNumber(source.budgetTotal, source.stepBudget, nested.total, nested.maxSteps);
      const hasUsed = used !== null;
      const hasTotal = total !== null;
      const text = !hasUsed && !hasTotal
        ? '—'
        : (hasUsed ? String(used) : '—') + '/' + (hasTotal ? String(total) : '—');
      return { used: used, total: total, text: text, over: hasUsed && hasTotal && used > total, source: 'fields' };
    }

    // stalled / timed_out 的顶部说明；其它状态不给说明（S5 才加动作按钮）。
    function describeStallNotice(status) {
      const tone = normalizeRunStatus(status);
      if (tone === 'stalled') return '该任务已卡住。默认动作是重新开始，并先备份旧产物到 .jkkb/backup/。';
      if (tone === 'timed_out') return '该任务已超时。默认动作是重新开始，并先备份旧产物到 .jkkb/backup/。';
      return '';
    }

    // ───────────────────────────── 用量（usage）与台账（ledger） ─────────────────────────────
    const USAGE_SOURCES = ['agent', 'degraded', 'unavailable'];
    const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

    function normalizeUsage(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const num = (value) => (typeof value === 'number' && isFinite(value) && value >= 0 ? Math.round(value) : null);
      return {
        inputTokens: num(raw.inputTokens),
        outputTokens: num(raw.outputTokens),
        cacheReadTokens: num(raw.cacheReadTokens),
        cacheWriteTokens: num(raw.cacheWriteTokens),
      };
    }

    function usageHasTokens(usage) {
      if (!usage || typeof usage !== 'object') return false;
      return usage.inputTokens !== null || usage.outputTokens !== null
        || usage.cacheReadTokens !== null || usage.cacheWriteTokens !== null;
    }

    function formatTokenCount(value) {
      const num = typeof value === 'number' && isFinite(value) ? Math.round(value) : null;
      if (num === null) return '—';
      const text = String(Math.abs(num));
      const groups = [];
      for (let i = text.length; i > 0; i -= 3) groups.unshift(text.slice(Math.max(0, i - 3), i));
      return (num < 0 ? '-' : '') + groups.join(',');
    }

    function normalizeUsageSource(value) {
      const raw = String(value == null ? '' : value).trim().toLowerCase();
      return USAGE_SOURCES.indexOf(raw) >= 0 ? raw : '';
    }

    // 列表 token 列：degraded 显示「无 agent」，无用量显示「—」，否则 in / out。
    function usageListText(run) {
      const source = run && typeof run === 'object' ? run.usageSource : '';
      if (normalizeUsageSource(source) === 'degraded') return '无 agent';
      const usage = normalizeUsage(run && typeof run === 'object' ? run.usage : null);
      if (!usageHasTokens(usage)) return '—';
      return formatTokenCount(usage.inputTokens) + ' / ' + formatTokenCount(usage.outputTokens);
    }

    function buildLedgerCalendarQuery(options) {
      const o = options || {};
      const parts = [];
      if (typeof o.year === 'number' && isFinite(o.year)) parts.push('year=' + Math.floor(o.year));
      if (typeof o.month === 'number' && isFinite(o.month) && o.month >= 1 && o.month <= 12) {
        parts.push('month=' + pad2(Math.floor(o.month)));
      }
      return parts.length > 0 ? '?' + parts.join('&') : '';
    }

    function fetchLedgerCalendar(options) {
      return hostRequest(HOST_LEDGER_CALENDAR_PATH + buildLedgerCalendarQuery(options), { method: 'GET' });
    }

    function fetchLedgerDay(date) {
      return hostRequest(HOST_LEDGER_DAY_PATH + '?date=' + encodeURIComponent(String(date == null ? '' : date)), { method: 'GET' });
    }

    function normalizeLedgerResponse(result) {
      if (result && result.ok === true) return { ok: true, data: result };
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function numberOrZero(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    function numberOrNull(value) {
      return typeof value === 'number' && isFinite(value) ? value : null;
    }

    function tokenTotalText(inputTokens, outputTokens) {
      const input = numberOrNull(inputTokens);
      const output = numberOrNull(outputTokens);
      if (input === null && output === null) return '';
      return formatTokenCount((input || 0) + (output || 0));
    }

    function presentLedgerTotals(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const input = numberOrNull(source.inputTokens);
      const output = numberOrNull(source.outputTokens);
      const totalMs = numberOrZero(source.totalMs);
      return {
        runCount: numberOrZero(source.runCount),
        failed: numberOrZero(source.failed),
        totalMs: totalMs,
        durationText: totalMs > 0 ? formatSpan(totalMs) : '—',
        inputTokens: input,
        outputTokens: output,
        tokenText: tokenTotalText(input, output) || '—',
      };
    }

    function presentLedgerDayCell(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const date = typeof raw.date === 'string' ? raw.date : '';
      if (!date) return null;
      const input = numberOrNull(raw.inputTokens);
      const output = numberOrNull(raw.outputTokens);
      // 显式 hasUsage 优先（false 时即使宿主补了 0 也不算有用量）。
      const hasUsage = typeof raw.hasUsage === 'boolean'
        ? raw.hasUsage
        : (input !== null || output !== null);
      return {
        date: date,
        day: Number(date.slice(8, 10)) || '',
        runCount: numberOrZero(raw.runCount),
        failed: numberOrZero(raw.failed),
        totalMs: numberOrZero(raw.totalMs),
        inputTokens: input,
        outputTokens: output,
        hasUsage: hasUsage,
        tokenText: hasUsage ? tokenTotalText(input, output) : '',
      };
    }

    function presentLedgerMonth(data) {
      const source = data && typeof data === 'object' ? data : {};
      const year = typeof source.year === 'number' && isFinite(source.year) ? Math.floor(source.year) : null;
      const month = typeof source.month === 'number' && isFinite(source.month) ? Math.floor(source.month) : null;
      const days = (Array.isArray(source.days) ? source.days : []).map(presentLedgerDayCell).filter(Boolean);
      return {
        view: 'month',
        year: year,
        month: month,
        monthLabel: year === null || month === null ? '—' : year + '年' + month + '月',
        days: days,
        totals: presentLedgerTotals(source.totals),
      };
    }

    function presentLedgerYear(data) {
      const source = data && typeof data === 'object' ? data : {};
      const year = typeof source.year === 'number' && isFinite(source.year) ? Math.floor(source.year) : null;
      const byMonth = {};
      (Array.isArray(source.months) ? source.months : []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const month = numberOrZero(item.month);
        if (month >= 1 && month <= 12) byMonth[month] = item;
      });
      const months = [];
      for (let m = 1; m <= 12; m += 1) {
        const entry = byMonth[m] || {};
        const input = numberOrNull(entry.inputTokens);
        const output = numberOrNull(entry.outputTokens);
        months.push({
          month: m,
          runCount: numberOrZero(entry.runCount),
          failed: numberOrZero(entry.failed),
          totalMs: numberOrZero(entry.totalMs),
          inputTokens: input,
          outputTokens: output,
          tokenText: tokenTotalText(input, output),
        });
      }
      return {
        view: 'year',
        year: year,
        yearLabel: year === null ? '—' : year + '年',
        months: months,
        totals: presentLedgerTotals(source.totals),
      };
    }

    function presentLedger(data) {
      const source = data && typeof data === 'object' ? data : {};
      if (source.view === 'year' || Array.isArray(source.months)) return presentLedgerYear(source);
      return presentLedgerMonth(source);
    }

    function presentLedgerRun(raw) {
      const run = presentRun(raw, null);
      const elapsed = raw && typeof raw.elapsedMs === 'number' && isFinite(raw.elapsedMs)
        ? formatSpan(raw.elapsedMs)
        : run.durationText;
      return Object.assign({}, run, { durationText: elapsed });
    }

    function presentLedgerDay(data) {
      const source = data && typeof data === 'object' ? data : {};
      return {
        date: typeof source.date === 'string' ? source.date : '',
        runs: (Array.isArray(source.runs) ? source.runs : []).map(presentLedgerRun),
        totals: presentLedgerTotals(source.totals),
      };
    }

    // 本地时区字符串（Asia/Shanghai 等由浏览器本地时区决定），不经过 UTC。
    function toLocalDateString(dateValue) {
      const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
      if (!date || isNaN(date.getTime())) return '';
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 月视图网格（周一起始）；pad 格用于对齐星期。
    function buildMonthGrid(year, month, days) {
      const cells = [];
      const yearNum = typeof year === 'number' && isFinite(year) ? Math.floor(year) : null;
      const monthNum = typeof month === 'number' && isFinite(month) ? Math.floor(month) : null;
      if (yearNum === null || monthNum === null || monthNum < 1 || monthNum > 12) return cells;
      const byDate = {};
      (Array.isArray(days) ? days : []).forEach((entry) => {
        if (entry && typeof entry.date === 'string') byDate[entry.date] = entry;
      });
      const lead = (new Date(yearNum, monthNum - 1, 1).getDay() + 6) % 7;
      for (let i = 0; i < lead; i += 1) cells.push({ key: 'pad-' + i, blank: true });
      const total = new Date(yearNum, monthNum, 0).getDate();
      for (let day = 1; day <= total; day += 1) {
        const date = yearNum + '-' + pad2(monthNum) + '-' + pad2(day);
        const entry = byDate[date] || null;
        cells.push({
          key: date,
          blank: false,
          day: day,
          date: date,
          runCount: entry ? entry.runCount : 0,
          failed: entry ? entry.failed : 0,
          tokenText: entry ? entry.tokenText : '',
          hasTasks: !!entry && entry.runCount > 0,
          hasFailed: !!entry && entry.failed > 0,
          hasToken: !!entry && entry.hasUsage === true && entry.tokenText !== '',
        });
      }
      return cells;
    }

    // ───────────────────────────── 验收（acceptance） ─────────────────────────────
    function normalizeAcceptanceIssue(item, index, fallbackLevel) {
      const issue = item && typeof item === 'object' ? item : {};
      const rawLevel = String(issue.level == null ? fallbackLevel : issue.level).trim().toLowerCase();
      return {
        key: typeof issue.id === 'string' && issue.id ? issue.id : 'issue-' + index,
        id: typeof issue.id === 'string' ? issue.id : '',
        level: rawLevel === 'error' ? 'error' : (rawLevel === 'warn' ? 'warn' : 'ok'),
        message: typeof issue.message === 'string' && issue.message ? issue.message : '—',
        fix: typeof issue.fix === 'string' && issue.fix ? issue.fix : '',
      };
    }

    function normalizeAcceptance(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const errors = (Array.isArray(raw.errors) ? raw.errors : []).map((item, index) => normalizeAcceptanceIssue(item, index, 'error'));
      const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).map((item, index) => normalizeAcceptanceIssue(item, index, 'warn'));
      return {
        ok: raw.ok === true,
        checkedAtText: formatTimestamp(raw.checkedAt),
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        errors: errors,
        warnings: warnings,
      };
    }

    // 列表徽标：acceptanceFailed 优先（红）；completed + acceptance.ok 才是「验收通过」。
    function describeAcceptanceBadge(run) {
      const source = run && typeof run === 'object' ? run : {};
      if (source.acceptanceFailed === true) {
        return { state: 'failed', label: '验收未过', tooltip: '步骤可能全绿，但库结构体检未通过' };
      }
      const acceptance = source.acceptance;
      if (normalizeRunStatus(source.status) === 'done' && acceptance && acceptance.ok === true) {
        return { state: 'passed', label: '验收通过', tooltip: '验收已通过' };
      }
      return null;
    }

    // 所有步骤成功（ok / skip 都算绿）——用来识别「步骤全绿但验收红」。
    function stepsAllGreen(steps) {
      const list = Array.isArray(steps) ? steps : [];
      if (list.length === 0) return false;
      return list.every((step) => {
        // 同时接受原始宿主状态（ok/skip）和 presentSteps 归一后的状态（done/skipped）。
        const raw = String(step && step.status == null ? '' : step.status).trim().toLowerCase();
        return raw === 'ok' || raw === 'done' || raw === 'skip' || raw === 'skipped';
      });
    }

    function describeAcceptanceNotice(acceptanceFailed) {
      return acceptanceFailed === true
        ? '该任务因验收未通过被判定失败，修复后可用「重新开始」重跑（S5 才有按钮，这里只说明）。'
        : '';
    }

    // 顶部说明条：stalled/timed_out 与验收失败可同时存在（拼接，不互相覆盖）。
    function describeTopNotice(status, acceptanceFailed) {
      const parts = [];
      const stall = describeStallNotice(status);
      if (stall) parts.push(stall);
      const acceptance = describeAcceptanceNotice(acceptanceFailed);
      if (acceptance) parts.push(acceptance);
      return parts.join('');
    }

    // ───────────────────────────── 环境体检（preflight） ─────────────────────────────
    // ───────────────────────────── 入柜（curate）与技能目录 ─────────────────────────────
    function fetchSkills() {
      return hostRequest(HOST_SKILLS_PATH, { method: 'GET' });
    }

    function normalizeSkill(raw, index) {
      const skill = raw && typeof raw === 'object' ? raw : {};
      const id = typeof skill.id === 'string' && skill.id
        ? skill.id
        : (typeof skill.skillId === 'string' && skill.skillId ? skill.skillId : 'skill-' + index);
      const name = typeof skill.name === 'string' && skill.name
        ? skill.name
        : (typeof skill.title === 'string' && skill.title ? skill.title : id);
      const role = typeof skill.role === 'string' && skill.role
        ? skill.role
        : (typeof skill.group === 'string' && skill.group
            ? skill.group
            : (typeof skill.profession === 'string' && skill.profession ? skill.profession : '未分组'));
      const stage = typeof skill.stage === 'string'
        ? skill.stage
        : (typeof skill.phase === 'string' ? skill.phase : '');
      return {
        id: id,
        name: name,
        role: role,
        stage: stage,
        label: name + (stage ? '（' + stage + '）' : ''),
      };
    }

    // 按岗位分组；组顺序按首次出现，组内保持宿主顺序。
    function presentSkills(data) {
      const list = Array.isArray(data)
        ? data
        : (data && typeof data === 'object'
            ? (Array.isArray(data.skills) ? data.skills : (Array.isArray(data.briefs) ? data.briefs : (Array.isArray(data.items) ? data.items : [])))
            : []);
      const byRole = {};
      const order = [];
      list.map(normalizeSkill).forEach((skill) => {
        if (!byRole[skill.role]) {
          byRole[skill.role] = [];
          order.push(skill.role);
        }
        byRole[skill.role].push(skill);
      });
      return {
        groups: order.map((role) => ({ key: role, label: role, skills: byRole[role] })),
        count: list.length,
      };
    }

    function normalizeSkillsResponse(result) {
      if (result && result.ok === true) {
        const presented = presentSkills(result);
        return { ok: true, groups: presented.groups, count: presented.count };
      }
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function buildCuratePayload(input) {
      const source = input && typeof input === 'object' ? input : {};
      const payload = {
        kind: 'curate',
        input: { text: typeof source.text === 'string' ? source.text : '' },
      };
      if (typeof source.skillId === 'string' && source.skillId.trim()) payload.input.skillId = source.skillId.trim();
      if (typeof source.expertId === 'string' && source.expertId.trim()) payload.input.expertId = source.expertId.trim();
      if (typeof source.title === 'string' && source.title.trim()) payload.input.title = source.title.trim();
      if (typeof source.source === 'string' && source.source.trim()) payload.input.source = source.source.trim();
      return payload;
    }

    function canSubmitCurate(form, busy) {
      const text = form && typeof form.text === 'string' ? form.text : '';
      return busy !== true && text.trim().length > 0;
    }

    async function startCurateRequest(input) {
      const payload = buildCuratePayload(input);
      if (!payload.input.text.trim()) {
        return { started: false, code: 'text-required', message: '请先粘贴原始文本', checks: [] };
      }
      const result = await hostRequest(HOST_RUN_PATH, { method: 'POST', body: JSON.stringify(payload) });
      if (result && result.ok === true) return { started: true, result: result };
      return {
        started: false,
        status: result && result.status,
        code: (result && result.error && result.error.code) || 'request-failed',
        checks: result && result.error && Array.isArray(result.error.checks) ? result.error.checks : [],
        message: describeRunError(result),
      };
    }

    // 提交结果 → UI 动作（成功即收起表单 + 刷新列表；失败时 422 checks 走既有体检卡片）。
    function planCurateResult(outcome) {
      if (outcome && outcome.started === true) {
        return {
          closeForm: true,
          refresh: true,
          expandChecks: false,
          notice: { kind: 'ok', text: '已提交入柜，正在刷新任务列表…' },
        };
      }
      const checks = outcome && Array.isArray(outcome.checks) ? outcome.checks : [];
      return {
        closeForm: false,
        refresh: false,
        expandChecks: checks.length > 0,
        notice: { kind: 'error', text: (outcome && outcome.message) || '提交失败' },
      };
    }

    // ───────────────────────────── 整理（maintain）与整理报告 ─────────────────────────────
    const REPORT_RULE_ORDER = ['M01', 'M03', 'M04', 'M08', 'M06', 'M07'];
    const REPORTS_PAGE_LIMIT = 20;

    async function startMaintainRequest() {
      const result = await hostRequest(HOST_RUN_PATH, { method: 'POST', body: JSON.stringify({ kind: 'maintain' }) });
      if (result && result.ok === true) return { started: true, result: result };
      return {
        started: false,
        status: result && result.status,
        code: (result && result.error && result.error.code) || 'request-failed',
        checks: result && result.error && Array.isArray(result.error.checks) ? result.error.checks : [],
        message: describeRunError(result),
      };
    }

    function buildReportsQuery(options) {
      const o = options || {};
      const limit = typeof o.limit === 'number' && isFinite(o.limit) && o.limit > 0
        ? Math.min(100, Math.floor(o.limit))
        : REPORTS_PAGE_LIMIT;
      return '?limit=' + limit;
    }

    function fetchReports(options) {
      return hostRequest(HOST_REPORTS_PATH + buildReportsQuery(options), { method: 'GET' });
    }

    function normalizeReportFinding(raw, index, fallbackRule) {
      const finding = raw && typeof raw === 'object' ? raw : {};
      const ruleId = typeof finding.ruleId === 'string' && finding.ruleId
        ? finding.ruleId
        : (typeof fallbackRule === 'string' ? fallbackRule : '');
      const relPath = typeof finding.relPath === 'string' && finding.relPath ? finding.relPath : '';
      return {
        key: (ruleId || 'rule') + '-' + index,
        ruleId: ruleId,
        path: typeof finding.path === 'string' && finding.path ? finding.path : (relPath || '—'),
        proposedTarget: typeof finding.proposedTarget === 'string' ? finding.proposedTarget : '',
        archiveReason: typeof finding.archiveReason === 'string' ? finding.archiveReason : '',
        action: typeof finding.action === 'string' ? finding.action : '',
        kind: typeof finding.kind === 'string' ? finding.kind : '',
        title: typeof finding.title === 'string' ? finding.title : '',
        detail: typeof finding.detail === 'string' && finding.detail ? finding.detail : '—',
        basis: typeof finding.basis === 'string' && finding.basis ? finding.basis : '—',
        threshold: typeof finding.threshold === 'string'
          ? finding.threshold
          : (typeof finding.threshold === 'number' ? String(finding.threshold) : '—'),
      };
    }

    // findings 可能在 report.findings，也可能是 byRule = { M01: [...] } 的映射。
    function extractReportFindings(report) {
      const source = report && typeof report === 'object' ? report : {};
      if (Array.isArray(source.findings)) return source.findings.map((item, index) => normalizeReportFinding(item, index, ''));
      const out = [];
      if (source.byRule && typeof source.byRule === 'object' && !Array.isArray(source.byRule)) {
        Object.keys(source.byRule).forEach((ruleId) => {
          const list = source.byRule[ruleId];
          if (Array.isArray(list)) {
            list.forEach((item, index) => {
              out.push(normalizeReportFinding(item, index, ruleId));
            });
          }
        });
      }
      return out;
    }

    function presentReport(raw, index) {
      const report = raw && typeof raw === 'object' ? raw : {};
      const id = typeof report.id === 'string' && report.id ? report.id : 'report-' + index;
      return {
        id: id,
        kind: typeof report.kind === 'string' ? report.kind : '',
        period: typeof report.period === 'string' && report.period ? report.period : '—',
        summary: typeof report.summary === 'string' && report.summary ? report.summary : '—',
        path: typeof report.path === 'string' ? report.path : '',
        createdAtText: formatTimestamp(report.createdAt),
        findings: extractReportFindings(report),
      };
    }

    function presentReports(data) {
      const source = data && typeof data === 'object' ? data : {};
      const list = Array.isArray(source.reports) ? source.reports : (Array.isArray(data) ? data : []);
      return list.map(presentReport);
    }

    function normalizeReportsResponse(result) {
      if (result && result.ok === true) return { ok: true, reports: presentReports(result) };
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    // 固定 M01/M03/M04/M08 顺序，其它 ruleId 追加在后。
    function groupReportFindings(findings) {
      const list = Array.isArray(findings) ? findings : [];
      const groups = REPORT_RULE_ORDER.map((ruleId) => ({ key: ruleId, ruleId: ruleId, items: [] }));
      const extras = {};
      list.forEach((finding) => {
        const ruleId = finding && typeof finding.ruleId === 'string' ? finding.ruleId : '';
        const fixed = groups.filter((group) => group.ruleId === ruleId)[0];
        if (fixed) {
          fixed.items.push(finding);
          return;
        }
        const key = ruleId || '其它';
        if (!extras[key]) extras[key] = { key: key, ruleId: key, items: [] };
        extras[key].items.push(finding);
      });
      Object.keys(extras).forEach((key) => groups.push(extras[key]));
      // 只保留有条目的组（固定顺序的四个规则按出现顺序排列，空组不显示）。
      return groups.filter((group) => group.items.length > 0);
    }

    function openReportPath(path) {
      const value = String(path == null ? '' : path);
      if (!value) return false;
      try {
        if (typeof window !== 'undefined' && window && typeof window.open === 'function') {
          window.open(value, '_blank', 'noopener');
          return true;
        }
      } catch (err) { /* 打开失败静默 */ }
      return false;
    }

    // ───────────────────────────── SKILL 注册表 / 调用日志 / 新建技能 ─────────────────────────────
    const SKILL_REQUIRED_FIELDS = [
      { key: 'name', label: '名称' },
      { key: 'purpose', label: '用途' },
      { key: 'scenario', label: '适用场景' },
    ];
    const SKILL_SIMILARITY_THRESHOLD = 0.55;

    // 与 host/skills/lifecycle.js 同口径：小写、只留中英文数字、去常见虚词。
    function normalizeSkillText(text) {
      const raw = String(text == null ? '' : text).toLowerCase();
      let out = '';
      for (let i = 0; i < raw.length; i += 1) {
        const ch = raw.charAt(i);
        const code = raw.charCodeAt(i);
        const keep = (code >= 0x4e00 && code <= 0x9fff)
          || (code >= 0x30 && code <= 0x39)
          || (code >= 0x61 && code <= 0x7a)
          || (code >= 0x41 && code <= 0x5a);
        if (keep && '的了和与及或'.indexOf(ch) < 0) out += ch;
      }
      return out;
    }

    function levenshtein(a, b) {
      const left = String(a == null ? '' : a);
      const right = String(b == null ? '' : b);
      if (left.length === 0) return right.length;
      if (right.length === 0) return left.length;
      let prev = [];
      for (let j = 0; j <= right.length; j += 1) prev.push(j);
      for (let i = 1; i <= left.length; i += 1) {
        const row = [i];
        for (let j = 1; j <= right.length; j += 1) {
          const cost = left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1;
          row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost));
        }
        prev = row;
      }
      return prev[right.length];
    }

    function similarity(a, b) {
      const left = String(a == null ? '' : a);
      const right = String(b == null ? '' : b);
      const max = Math.max(left.length, right.length);
      if (max === 0) return 0;
      return 1 - (levenshtein(left, right) / max);
    }

    function skillMatchFrom(raw, score) {
      const skill = raw && typeof raw === 'object' ? raw : {};
      return {
        id: typeof skill.id === 'string' ? skill.id : '',
        name: typeof skill.name === 'string' ? skill.name : '—',
        version: typeof skill.version === 'string' ? skill.version : '—',
        purpose: typeof skill.purpose === 'string' ? skill.purpose : '',
        pagePath: typeof skill.pagePath === 'string' ? skill.pagePath : (typeof skill.path === 'string' ? skill.path : ''),
        score: Math.round(score * 100) / 100,
      };
    }

    // 先判重再落盘：名称完全相同 → duplicate；名称+用途相似度 ≥ 0.55 → similar。
    function decideSkillCreate(input, existing) {
      const source = input && typeof input === 'object' ? input : {};
      const name = String(source.name == null ? '' : source.name).trim();
      const purpose = String(source.purpose == null ? '' : source.purpose);
      const list = Array.isArray(existing) ? existing : [];
      const exact = name ? list.filter((skill) => String(skill && skill.name ? skill.name : '').trim() === name) : [];
      if (exact.length > 0) {
        return { action: 'duplicate', matches: exact.map((skill) => skillMatchFrom(skill, 1)) };
      }
      const target = normalizeSkillText(name) + normalizeSkillText(purpose);
      const matches = [];
      list.forEach((skill) => {
        const candidate = normalizeSkillText(skill && skill.name) + normalizeSkillText(skill && skill.purpose);
        const score = similarity(target, candidate);
        if (score >= SKILL_SIMILARITY_THRESHOLD) matches.push(skillMatchFrom(skill, score));
      });
      matches.sort((a, b) => b.score - a.score);
      return { action: matches.length > 0 ? 'similar' : 'ok', matches: matches };
    }

    function parseSkillList(value) {
      let text = String(value == null ? '' : value);
      [String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(9), '，', '、', ';', '；'].forEach((delimiter) => {
        text = text.split(delimiter).join(',');
      });
      return text.split(',').map((item) => item.trim()).filter(Boolean);
    }

    function validateSkillForm(form) {
      const source = form && typeof form === 'object' ? form : {};
      const missing = SKILL_REQUIRED_FIELDS
        .filter((field) => !String(source[field.key] == null ? '' : source[field.key]).trim())
        .map((field) => field.key);
      return { ok: missing.length === 0, missing: missing };
    }

    function buildSkillPayload(form, options) {
      const source = form && typeof form === 'object' ? form : {};
      const o = options || {};
      const input = {
        name: String(source.name == null ? '' : source.name).trim(),
        purpose: String(source.purpose == null ? '' : source.purpose).trim(),
        scenario: String(source.scenario == null ? '' : source.scenario).trim(),
        keywords: parseSkillList(source.keywords),
        fields: parseSkillList(source.fields),
      };
      if (o.confirmed === true) input.confirm = true;
      return { kind: 'skill', input: input };
    }

    // 手动回执：POST /skill-calls（宿主复用 jk_kb_skill_run 的同一套校验）。
    function parseOutputs(value) {
      let text = String(value == null ? '' : value);
      text = text.split(String.fromCharCode(13)).join(String.fromCharCode(10));
      return text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    }

    function normalizeSkillCallResult(value) {
      return String(value == null ? '' : value).trim().toLowerCase() === 'fail' ? 'fail' : 'ok';
    }

    function validateSkillCallForm(form, hasSkills) {
      const source = form && typeof form === 'object' ? form : {};
      const skillId = String(source.skillId == null ? '' : source.skillId).trim();
      const task = String(source.task == null ? '' : source.task).trim();
      const result = normalizeSkillCallResult(source.result);
      const reason = String(source.reason == null ? '' : source.reason).trim();
      const missing = [];
      if (!skillId) missing.push('skillId');
      if (!task) missing.push('task');
      else if (task.length > 200) missing.push('taskTooLong');
      if (result === 'fail' && reason.length < 4) missing.push('reason');
      return {
        ok: hasSkills !== false && missing.length === 0,
        missing: missing,
        result: result,
      };
    }

    function buildSkillCallPayload(form) {
      const source = form && typeof form === 'object' ? form : {};
      const payload = {
        skillId: String(source.skillId == null ? '' : source.skillId).trim(),
        task: String(source.task == null ? '' : source.task).trim(),
        result: normalizeSkillCallResult(source.result),
      };
      const reason = String(source.reason == null ? '' : source.reason).trim();
      if (reason) payload.reason = reason;
      const outputs = parseOutputs(source.outputs);
      if (outputs.length > 0) payload.outputs = outputs;
      return payload;
    }

    async function startSkillCallRequest(form, options) {
      const o = options || {};
      const validation = validateSkillCallForm(form, o.hasSkills);
      if (validation.ok !== true) {
        return { submitted: false, code: 'invalid-form', missing: validation.missing, message: '请补全必填项' };
      }
      const result = await hostRequest(HOST_SKILL_CALLS_PATH, {
        method: 'POST',
        body: JSON.stringify(buildSkillCallPayload(form)),
      });
      if (result && result.ok === true) {
        return { submitted: true, id: typeof result.id === 'string' ? result.id : '', call: result.call || null };
      }
      const error = result && result.error && typeof result.error === 'object' ? result.error : {};
      const code = typeof error.code === 'string' ? error.code : '';
      let message = '';
      if (code === 'skill-not-found') message = '技能不存在，请重新选择';
      else if (code === 'reason-required') message = '失败必须填写原因（至少 4 个字符）';
      else if (code === 'output-forbidden') {
        const blocked = Array.isArray(error.outputs) ? error.outputs : [];
        message = '产物路径不合法：只能放在 03..12 顶层目录内' + (blocked.length > 0 ? '（' + blocked.join('、') + '）' : '');
      } else {
        message = (code ? code + ' ' : '') + (error.message || '登记失败');
      }
      return {
        submitted: false,
        code: code,
        message: message,
        outputs: Array.isArray(error.outputs) ? error.outputs : [],
      };
    }

    // ───────────────────────────── 归档执行（破坏性，严格闸门） ─────────────────────────────
    function buildArchivePayload(finding) {
      const f = finding && typeof finding === 'object' ? finding : {};
      const item = {
        relPath: typeof f.path === 'string' ? f.path : '',
        reason: typeof f.archiveReason === 'string' ? f.archiveReason : '',
      };
      if (typeof f.successorLink === 'string' && f.successorLink) item.successorLink = f.successorLink;
      return { kind: 'archive', input: { items: [item], confirmed: true } };
    }

    async function startArchiveRequest(finding) {
      const payload = buildArchivePayload(finding);
      const item = payload.input.items[0];
      if (!item.relPath || item.reason.trim().length < 4) {
        return {
          started: false,
          code: 'invalid-item',
          message: '归档需要原路径与至少 4 个字符的原因',
          preview: [],
          checks: [],
        };
      }
      const result = await hostRequest(HOST_RUN_PATH, { method: 'POST', body: JSON.stringify(payload) });
      if (result && result.ok === true) return { started: true, result: result };
      const error = result && result.error && typeof result.error === 'object' ? result.error : {};
      const code = typeof error.code === 'string' ? error.code : '';
      if (code === 'NEED_CONFIRM') {
        return {
          started: false,
          code: 'need-confirm',
          preview: Array.isArray(error.preview) ? error.preview : [],
          message: error.message || '宿主要求再次确认',
        };
      }
      return {
        started: false,
        code: code,
        status: result && result.status,
        checks: Array.isArray(error.checks) ? error.checks : [],
        preview: [],
        message: describeRunError(result),
      };
    }

    // 成功 → 收起弹层 + 刷新报告 + 通知任务列表刷新；NEED_CONFIRM → 保留弹层并展示 preview。
    function planArchiveResult(outcome) {
      if (outcome && outcome.started === true) {
        return {
          closeDialog: true,
          refreshReports: true,
          notifyRuns: true,
          notice: { kind: 'ok', text: '已提交归档任务' },
        };
      }
      if (outcome && outcome.code === 'need-confirm') {
        return {
          closeDialog: false,
          refreshReports: false,
          notifyRuns: false,
          preview: Array.isArray(outcome.preview) ? outcome.preview : [],
          notice: { kind: 'error', text: '宿主要求再次确认，请核对 preview 后重试' },
        };
      }
      return {
        closeDialog: false,
        refreshReports: false,
        notifyRuns: false,
        notice: { kind: 'error', text: (outcome && outcome.message) || '归档提交失败' },
      };
    }

    // 回执成功后收起表单 + 刷新调用日志；失败保留表单并显示宿主提示。
    function planSkillCallResult(outcome) {
      if (outcome && outcome.submitted === true) {
        return { closeForm: true, refresh: true, notice: { kind: 'ok', text: '已登记' } };
      }
      return {
        closeForm: false,
        refresh: false,
        notice: { kind: 'error', text: (outcome && outcome.message) || '登记失败' },
      };
    }

    async function startSkillRequest(form, options) {
      const validation = validateSkillForm(form);
      if (validation.ok !== true) {
        return {
          started: false,
          code: 'invalid-form',
          missing: validation.missing,
          message: '名称、用途、适用场景都要填写',
          checks: [],
        };
      }
      const payload = buildSkillPayload(form, options);
      const result = await hostRequest(HOST_RUN_PATH, { method: 'POST', body: JSON.stringify(payload) });
      if (result && result.ok === true) return { started: true, result: result };
      return {
        started: false,
        status: result && result.status,
        code: (result && result.error && result.error.code) || 'request-failed',
        checks: result && result.error && Array.isArray(result.error.checks) ? result.error.checks : [],
        matches: result && result.error && Array.isArray(result.error.matches) ? result.error.matches : [],
        message: describeRunError(result),
      };
    }

    function buildPagedQuery(options, defaultLimit) {
      const o = options || {};
      const limit = typeof o.limit === 'number' && isFinite(o.limit) && o.limit > 0
        ? Math.min(100, Math.floor(o.limit))
        : (typeof defaultLimit === 'number' && defaultLimit > 0 ? defaultLimit : 20);
      const parts = ['limit=' + limit];
      if (typeof o.before === 'string' && o.before) parts.push('before=' + encodeURIComponent(o.before));
      return '?' + parts.join('&');
    }

    function fetchSkillRegistry(options) {
      return hostRequest(HOST_SKILL_REGISTRY_PATH + buildPagedQuery(options, 50), { method: 'GET' });
    }

    function fetchSkillCalls(options) {
      return hostRequest(HOST_SKILL_CALLS_PATH + buildPagedQuery(options, 100), { method: 'GET' });
    }

    function presentRegistrySkill(raw, index) {
      const skill = raw && typeof raw === 'object' ? raw : {};
      return {
        id: typeof skill.id === 'string' && skill.id ? skill.id : 'skill-' + index,
        name: typeof skill.name === 'string' && skill.name ? skill.name : '—',
        version: typeof skill.version === 'string' && skill.version ? skill.version : '—',
        status: typeof skill.status === 'string' ? skill.status : '',
        keywords: (Array.isArray(skill.keywords) ? skill.keywords : []).map(String),
        path: typeof skill.path === 'string' ? skill.path : '',
        purpose: typeof skill.purpose === 'string' ? skill.purpose : '',
      };
    }

    function normalizeRegistryResponse(result) {
      if (result && result.ok === true) {
        const list = Array.isArray(result.skills) ? result.skills : (Array.isArray(result.items) ? result.items : []);
        return { ok: true, skills: list.map(presentRegistrySkill) };
      }
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function presentSkillCall(raw, index) {
      const call = raw && typeof raw === 'object' ? raw : {};
      const ts = typeof call.ts === 'string' ? call.ts : '';
      const result = String(call.result == null ? '' : call.result).trim().toLowerCase();
      return {
        key: (ts || 'call') + '-' + index,
        ts: ts,
        tsText: formatTimestamp(ts),
        date: ts ? toLocalDateString(ts) : '',
        skill: typeof call.skill === 'string' ? call.skill : '',
        name: typeof call.name === 'string' && call.name ? call.name : '—',
        version: typeof call.version === 'string' && call.version ? call.version : '—',
        task: typeof call.task === 'string' && call.task ? call.task : '—',
        result: result,
        resultLabel: result === 'ok' ? '成功' : (result === 'fail' ? '失败' : (result || '—')),
        reason: typeof call.reason === 'string' && call.reason ? call.reason : '',
        outputs: (Array.isArray(call.outputs) ? call.outputs : []).map(String),
      };
    }

    function normalizeCallsResponse(result) {
      if (result && result.ok === true) {
        return {
          ok: true,
          calls: (Array.isArray(result.calls) ? result.calls : []).map(presentSkillCall),
          nextBefore: typeof result.nextBefore === 'string' && result.nextBefore ? result.nextBefore : null,
        };
      }
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    // 调用日志按本地日期归组（倒序），供月网格与当天列表共用。
    function groupSkillCallsByDate(calls) {
      const groups = {};
      (Array.isArray(calls) ? calls : []).forEach((call) => {
        if (!call || typeof call.date !== 'string' || !call.date) return;
        if (!groups[call.date]) groups[call.date] = [];
        groups[call.date].push(call);
      });
      Object.keys(groups).forEach((date) => {
        groups[date].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      });
      return groups;
    }

    function buildSkillCallMonthGrid(year, month, calls) {
      const groups = groupSkillCallsByDate(calls);
      const days = Object.keys(groups).map((date) => ({
        date: date,
        runCount: groups[date].length,
        failed: groups[date].filter((call) => call.result === 'fail').length,
        totalMs: 0,
        inputTokens: null,
        outputTokens: null,
        hasUsage: false,
        tokenText: '',
      }));
      return { cells: buildMonthGrid(year, month, days), groups: groups };
    }

    // ───────────────────────────── 业务专家（experts） ─────────────────────────────
    const EXPERT_RESPONSIBILITY_MIN = 10;
    const EXPERT_NAME_MAX = 60;
    const EXPERT_DOMAIN_MAX = 40;
    const EXPERT_PROMPT_MAX = 2000;
    const EXPERT_EMPTY_TEXT = '还没有业务专家。专家 = 一组技能 + 一段职责说明，入柜时可以指定由谁处理。';

    function fetchExperts(options) {
      const o = options || {};
      const status = o.status === 'archived' ? 'archived' : 'active';
      return hostRequest(HOST_EXPERTS_PATH + '?status=' + status, { method: 'GET' });
    }

    // skillStates 兼容 { id: {ok} } 或 [{ id, ok }]，统一成 { id: ok } 映射。
    function normalizeExpertSkillStates(raw) {
      const map = {};
      if (Array.isArray(raw)) {
        raw.forEach((item) => {
          if (item && typeof item.id === 'string') map[item.id] = item.ok !== false;
        });
        return map;
      }
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach((id) => {
          const value = raw[id];
          map[id] = !(value && typeof value === 'object' && value.ok === false) && value !== false;
        });
      }
      return map;
    }

    function expertDanglingSkillIds(expert) {
      const source = expert && typeof expert === 'object' ? expert : {};
      const out = [];
      const seen = {};
      (Array.isArray(source.danglingSkillIds) ? source.danglingSkillIds : []).forEach((id) => {
        if (typeof id === 'string' && !seen[id]) { seen[id] = true; out.push(id); }
      });
      const states = source.skillStates && typeof source.skillStates === 'object' ? source.skillStates : {};
      Object.keys(states).forEach((id) => {
        if (states[id] === false && !seen[id]) { seen[id] = true; out.push(id); }
      });
      return out;
    }

    function presentExpert(raw, index) {
      const expert = raw && typeof raw === 'object' ? raw : {};
      return {
        key: typeof expert.id === 'string' && expert.id ? expert.id : 'expert-' + index,
        id: typeof expert.id === 'string' && expert.id ? expert.id : '',
        name: typeof expert.name === 'string' && expert.name ? expert.name : '—',
        domain: typeof expert.domain === 'string' && expert.domain ? expert.domain : '—',
        responsibility: typeof expert.responsibility === 'string' ? expert.responsibility : '',
        skillIds: (Array.isArray(expert.skillIds) ? expert.skillIds : []).map(String),
        promptFragment: typeof expert.promptFragment === 'string' ? expert.promptFragment : '',
        status: typeof expert.status === 'string' ? expert.status : '',
        cardCount: typeof expert.cardCount === 'number' && isFinite(expert.cardCount) ? expert.cardCount : 0,
        lastUsedAtText: formatTimestamp(expert.lastUsedAt),
        skillStates: normalizeExpertSkillStates(expert.skillStates),
        danglingSkillIds: (Array.isArray(expert.danglingSkillIds) ? expert.danglingSkillIds : []).map(String),
        createdAtText: formatTimestamp(expert.createdAt),
        updatedAtText: formatTimestamp(expert.updatedAt),
      };
    }

    function normalizeExpertsResponse(result) {
      if (result && result.ok === true) {
        const list = Array.isArray(result.experts) ? result.experts : [];
        return { ok: true, experts: list.map(presentExpert) };
      }
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function expertToForm(expert) {
      const source = expert && typeof expert === 'object' ? expert : {};
      return {
        id: typeof source.id === 'string' ? source.id : '',
        name: typeof source.name === 'string' ? source.name : '',
        domain: typeof source.domain === 'string' ? source.domain : '',
        responsibility: typeof source.responsibility === 'string' ? source.responsibility : '',
        skillIds: (Array.isArray(source.skillIds) ? source.skillIds : []).map(String),
        promptFragment: typeof source.promptFragment === 'string' ? source.promptFragment : '',
      };
    }

    function validateExpertForm(form) {
      const source = form && typeof form === 'object' ? form : {};
      const name = String(source.name == null ? '' : source.name).trim();
      const domain = String(source.domain == null ? '' : source.domain).trim();
      const responsibility = String(source.responsibility == null ? '' : source.responsibility).trim();
      const prompt = String(source.promptFragment == null ? '' : source.promptFragment);
      const errors = {};
      if (!name) errors.name = '名称必填';
      else if (name.length > EXPERT_NAME_MAX) errors.name = '名称不能超过 ' + EXPERT_NAME_MAX + ' 字符';
      if (!domain) errors.domain = '领域必填';
      else if (domain.length > EXPERT_DOMAIN_MAX) errors.domain = '领域不能超过 ' + EXPERT_DOMAIN_MAX + ' 字符';
      if (!responsibility) errors.responsibility = '职责必填';
      else if (responsibility.length < EXPERT_RESPONSIBILITY_MIN) errors.responsibility = '职责至少 ' + EXPERT_RESPONSIBILITY_MIN + ' 个字符';
      if (prompt.length > EXPERT_PROMPT_MAX) errors.promptFragment = '提示词片段不能超过 ' + EXPERT_PROMPT_MAX + ' 字符';
      return { ok: Object.keys(errors).length === 0, errors: errors };
    }

    function buildExpertPayload(form) {
      const source = form && typeof form === 'object' ? form : {};
      return {
        name: String(source.name == null ? '' : source.name).trim(),
        domain: String(source.domain == null ? '' : source.domain).trim(),
        responsibility: String(source.responsibility == null ? '' : source.responsibility).trim(),
        skillIds: (Array.isArray(source.skillIds) ? source.skillIds : []).map(String),
        promptFragment: String(source.promptFragment == null ? '' : source.promptFragment),
      };
    }

    function filterSkillGroups(groups, query) {
      const list = Array.isArray(groups) ? groups : [];
      const keyword = String(query == null ? '' : query).trim().toLowerCase();
      if (!keyword) return list;
      const out = [];
      list.forEach((group) => {
        const skills = (Array.isArray(group && group.skills) ? group.skills : []).filter((skill) => {
          const name = String(skill && skill.name ? skill.name : '').toLowerCase();
          const id = String(skill && skill.id ? skill.id : '').toLowerCase();
          return name.indexOf(keyword) >= 0 || id.indexOf(keyword) >= 0;
        });
        if (skills.length > 0) out.push({ key: group.key, label: group.label, skills: skills });
      });
      return out;
    }

    // 入柜按专家绑定过滤技能分组（保留组顺序与组内顺序）。
    function filterSkillGroupsByIds(groups, skillIds) {
      const allowed = {};
      (Array.isArray(skillIds) ? skillIds : []).forEach((id) => { allowed[String(id)] = true; });
      const out = [];
      (Array.isArray(groups) ? groups : []).forEach((group) => {
        const skills = (Array.isArray(group && group.skills) ? group.skills : []).filter((skill) => skill && allowed[String(skill.id)]);
        if (skills.length > 0) out.push({ key: group.key, label: group.label, skills: skills });
      });
      return out;
    }

    function expertSkillNameMap(groups) {
      const map = {};
      (Array.isArray(groups) ? groups : []).forEach((group) => {
        (Array.isArray(group && group.skills) ? group.skills : []).forEach((skill) => {
          if (skill && skill.id) map[skill.id] = skill.name;
        });
      });
      return map;
    }

    const EXPERT_ERROR_MESSAGES = {
      'name-required': '名称必填',
      'name-too-long': '名称不能超过 ' + EXPERT_NAME_MAX + ' 字符',
      'domain-required': '领域必填',
      'domain-too-long': '领域不能超过 ' + EXPERT_DOMAIN_MAX + ' 字符',
      'responsibility-too-short': '职责至少 ' + EXPERT_RESPONSIBILITY_MIN + ' 个字符',
      'prompt-too-long': '提示词片段不能超过 ' + EXPERT_PROMPT_MAX + ' 字符',
      'expert-not-found': '专家不存在（可能已被删除）',
      'already-archived': '该专家已归档',
    };

    function collectUnknownSkills(error) {
      const source = error && typeof error === 'object' ? error : {};
      const candidates = [source.skillIds, source.unknownSkills, source.unknown, source.ids];
      for (let i = 0; i < candidates.length; i += 1) {
        if (Array.isArray(candidates[i])) return candidates[i].map(String);
      }
      return [];
    }

    function describeExpertError(result) {
      const error = result && result.error && typeof result.error === 'object' ? result.error : {};
      const code = typeof error.code === 'string' ? error.code : '';
      if (code === 'unknown-skill') {
        const ids = collectUnknownSkills(error);
        return '未知技能：' + (ids.length > 0 ? ids.join('、') : '（宿主未列出）');
      }
      if (EXPERT_ERROR_MESSAGES[code]) return EXPERT_ERROR_MESSAGES[code];
      return (code ? code + ' ' : '') + (error.message || '请求失败');
    }

    function expertEndpoint(id, suffix) {
      const base = HOST_EXPERTS_PATH + '/' + encodeURIComponent(String(id == null ? '' : id));
      return suffix ? base + '/' + suffix : base;
    }

    function normalizeExpertWrite(result) {
      if (result && result.ok === true && result.expert) {
        return { ok: true, expert: presentExpert(result.expert, 0) };
      }
      const error = result && result.error && typeof result.error === 'object' ? result.error : {};
      return {
        ok: false,
        code: typeof error.code === 'string' ? error.code : '',
        message: describeExpertError(result),
        unknownSkills: collectUnknownSkills(error),
      };
    }

    async function createExpertRequest(form) {
      const result = await hostRequest(HOST_EXPERTS_PATH, {
        method: 'POST',
        body: JSON.stringify(buildExpertPayload(form)),
      });
      return normalizeExpertWrite(result);
    }

    async function updateExpertRequest(id, form) {
      const result = await hostRequest(expertEndpoint(id), {
        method: 'PATCH',
        body: JSON.stringify(buildExpertPayload(form)),
      });
      return normalizeExpertWrite(result);
    }

    async function archiveExpertRequest(id) {
      const result = await hostRequest(expertEndpoint(id, 'archive'), { method: 'POST', body: JSON.stringify({}) });
      return normalizeExpertWrite(result);
    }

    async function restoreExpertRequest(id) {
      const result = await hostRequest(expertEndpoint(id, 'restore'), { method: 'POST', body: JSON.stringify({}) });
      return normalizeExpertWrite(result);
    }

    // 解绑：只提交剩余 skillIds（PATCH 局部更新，其余字段由宿主保留）。
    async function unbindExpertSkillRequest(id, remainingSkillIds) {
      const result = await hostRequest(expertEndpoint(id), {
        method: 'PATCH',
        body: JSON.stringify({ skillIds: (Array.isArray(remainingSkillIds) ? remainingSkillIds : []).map(String) }),
      });
      return normalizeExpertWrite(result);
    }

    // 成功：收起表单/弹层、刷新列表；归档后切到 archived 视图。失败保留 UI 并显示可读原因。
    function planExpertWriteResult(kind, outcome) {
      if (outcome && outcome.ok === true) {
        const labels = { create: '已创建', update: '已保存', archive: '已归档', restore: '已恢复' };
        return {
          ok: true,
          closeForm: kind !== 'archive',
          closeArchive: kind === 'archive',
          refresh: true,
          nextStatus: kind === 'archive' ? 'archived' : 'active',
          notice: { kind: 'ok', text: labels[kind] || '已完成' },
        };
      }
      return {
        ok: false,
        closeForm: false,
        closeArchive: false,
        refresh: false,
        notice: { kind: 'error', text: (outcome && outcome.message) || '提交失败' },
      };
    }

    // ───────────────────────────── 仪表盘（只读快照） ─────────────────────────────
    function fetchDashboard() {
      return hostRequest(HOST_DASHBOARD_PATH, { method: 'GET' });
    }

    function presentDashboardRecent(raw, index) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const updatedMs = toMillis(item.updatedAt);
      return {
        key: typeof item.relPath === 'string' && item.relPath ? item.relPath : 'recent-' + index,
        relPath: typeof item.relPath === 'string' ? item.relPath : '',
        title: typeof item.title === 'string' && item.title ? item.title : '—',
        updatedAtText: formatTimestamp(item.updatedAt),
        updatedMs: updatedMs,
        size: typeof item.size === 'number' && isFinite(item.size) ? item.size : null,
      };
    }

    function estimateWeekAdded(recent, nowValue) {
      const now = resolveNow(nowValue);
      const since = now - 7 * 24 * 60 * 60 * 1000;
      return (Array.isArray(recent) ? recent : []).filter((item) => typeof item.updatedMs === 'number' && item.updatedMs >= since).length;
    }

    function presentDashboard(raw) {
      const data = raw && typeof raw === 'object' ? raw : {};
      const counts = data.counts && typeof data.counts === 'object' ? data.counts : {};
      const runtime = data.runtime && typeof data.runtime === 'object' ? data.runtime : {};
      const today = data.today && typeof data.today === 'object' ? data.today : {};
      const health = data.health && typeof data.health === 'object' ? data.health : {};
      const tools = health.tools && typeof health.tools === 'object' ? health.tools : {};
      const subagents = health.subagents && typeof health.subagents === 'object' ? health.subagents : {};
      const maintain = data.maintain && typeof data.maintain === 'object' ? data.maintain : {};
      const recent = (Array.isArray(data.recent) ? data.recent : []).map(presentDashboardRecent);
      const lastRun = runtime.lastRun && typeof runtime.lastRun === 'object'
        ? {
            id: typeof runtime.lastRun.id === 'string' ? runtime.lastRun.id : '',
            title: typeof runtime.lastRun.title === 'string' && runtime.lastRun.title ? runtime.lastRun.title : '—',
            status: normalizeRunStatus(runtime.lastRun.status),
            statusLabel: statusLabel(runtime.lastRun.status),
            elapsedText: typeof runtime.lastRun.elapsedMs === 'number' && isFinite(runtime.lastRun.elapsedMs)
              ? formatSpan(runtime.lastRun.elapsedMs)
              : '—',
          }
        : null;
      const byRule = maintain.lastReport && maintain.lastReport.byRule && typeof maintain.lastReport.byRule === 'object'
        ? maintain.lastReport.byRule
        : null;
      return {
        generatedAtText: formatTimestamp(data.generatedAt),
        counts: {
          notes: numberOrZero(counts.notes),
          dirs: numberOrZero(counts.dirs),
          files: numberOrZero(counts.files),
          topDirs: (Array.isArray(counts.topDirs) ? counts.topDirs : []).map((item, index) => ({
            key: (item && typeof item.name === 'string' ? item.name : 'dir-' + index),
            name: item && typeof item.name === 'string' ? item.name : '—',
            notes: numberOrZero(item && item.notes),
          })),
          truncated: counts.truncated === true,
          weekAdded: typeof counts.weekAdded === 'number' && isFinite(counts.weekAdded) ? counts.weekAdded : null,
        },
        recent: recent,
        weekAddedEstimate: estimateWeekAdded(recent, null),
        runtime: {
          root: typeof runtime.root === 'string' ? runtime.root : '',
          hasVault: runtime.hasVault === true,
          mode: typeof runtime.mode === 'string' ? runtime.mode : '',
          vaultUpdatedAtText: formatTimestamp(runtime.vaultUpdatedAt),
          lastRun: lastRun,
          running: numberOrZero(runtime.running),
        },
        today: {
          runs: numberOrZero(today.runs),
          completed: numberOrZero(today.completed),
          failed: numberOrZero(today.failed),
          totalMsText: typeof today.totalMs === 'number' && isFinite(today.totalMs) ? formatSpan(today.totalMs) : '—',
          inputTokens: numberOrNull(today.inputTokens),
          outputTokens: numberOrNull(today.outputTokens),
          tokenText: tokenTotalText(today.inputTokens, today.outputTokens) || '—',
        },
        health: {
          storeGuard: typeof health.storeGuard === 'string' ? health.storeGuard : '',
          toolsRegistered: numberOrZero(tools.registered),
          toolsFailed: numberOrZero(tools.failed),
          subagentsAvailable: subagents.available === true,
          providers: (Array.isArray(subagents.providers) ? subagents.providers : []).map(String),
        },
        maintain: {
          lastReport: maintain.lastReport && typeof maintain.lastReport === 'object'
            ? {
                period: typeof maintain.lastReport.period === 'string' ? maintain.lastReport.period : '—',
                summary: typeof maintain.lastReport.summary === 'string' ? maintain.lastReport.summary : '—',
                byRule: byRule,
              }
            : null,
        },
      };
    }

    function normalizeDashboardResponse(result) {
      if (result && result.ok === true) return { ok: true, data: presentDashboard(result) };
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    // ───────────────────────────── doctor（体检 / 修复） ─────────────────────────────
    const DOCTOR_LEVELS = ['blocked', 'error', 'warn', 'ok'];
    const DOCTOR_LEVEL_LABELS = {
      blocked: '阻塞',
      error: '可修',
      warn: '建议',
      ok: '正常',
    };

    function fetchDoctor() {
      return hostRequest(HOST_DOCTOR_PATH, { method: 'GET' });
    }

    function presentDoctorCheck(raw, index) {
      const check = raw && typeof raw === 'object' ? raw : {};
      const rawLevel = String(check.level == null ? '' : check.level).trim().toLowerCase();
      const level = DOCTOR_LEVELS.indexOf(rawLevel) >= 0 ? rawLevel : 'warn';
      return {
        key: typeof check.id === 'string' && check.id ? check.id : 'CHECK-' + index,
        id: typeof check.id === 'string' && check.id ? check.id : 'CHECK-' + index,
        level: level,
        title: typeof check.title === 'string' && check.title ? check.title : '—',
        detail: typeof check.detail === 'string' && check.detail ? check.detail : '—',
        repairId: typeof check.repairId === 'string' ? check.repairId : '',
        repairable: check.repairable === true,
        code: typeof check.code === 'string' ? check.code : '',
      };
    }

    function presentDoctor(raw) {
      const data = raw && typeof raw === 'object' ? raw : {};
      const checks = (Array.isArray(data.checks) ? data.checks : []).map(presentDoctorCheck);
      const groups = {};
      DOCTOR_LEVELS.forEach((level) => { groups[level] = []; });
      checks.forEach((check) => { groups[check.level].push(check); });
      const summaryRaw = data.summary && typeof data.summary === 'object' ? data.summary : {};
      const repairable = typeof summaryRaw.repairable === 'number' && isFinite(summaryRaw.repairable)
        ? summaryRaw.repairable
        : checks.filter((check) => check.level === 'error' && check.repairable).length;
      return {
        generatedAtText: formatTimestamp(data.generatedAt),
        root: typeof data.root === 'string' ? data.root : '',
        checks: checks,
        groups: groups,
        summary: {
          total: typeof summaryRaw.total === 'number' && isFinite(summaryRaw.total) ? summaryRaw.total : checks.length,
          ok: typeof summaryRaw.ok === 'number' && isFinite(summaryRaw.ok) ? summaryRaw.ok : groups.ok.length,
          warn: typeof summaryRaw.warn === 'number' && isFinite(summaryRaw.warn) ? summaryRaw.warn : groups.warn.length,
          error: typeof summaryRaw.error === 'number' && isFinite(summaryRaw.error) ? summaryRaw.error : groups.error.length,
          blocked: typeof summaryRaw.blocked === 'number' && isFinite(summaryRaw.blocked) ? summaryRaw.blocked : groups.blocked.length,
          repairable: repairable,
        },
      };
    }

    function normalizeDoctorResponse(result) {
      if (result && result.ok === true) return { ok: true, data: presentDoctor(result) };
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function normalizeDoctorPlan(raw, index) {
      const item = raw && typeof raw === 'object' ? raw : {};
      return {
        key: (typeof item.repairId === 'string' ? item.repairId : 'plan') + '-' + index,
        repairId: typeof item.repairId === 'string' ? item.repairId : '',
        checkId: typeof item.checkId === 'string' ? item.checkId : '',
        action: typeof item.action === 'string' && item.action ? item.action : '—',
        targets: (Array.isArray(item.targets) ? item.targets : []).map(String),
        risk: item.risk === 'medium' ? 'medium' : 'low',
      };
    }

    function normalizeDoctorApplied(raw, index) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const rawStatus = String(item.status == null ? '' : item.status).trim().toLowerCase();
      return {
        key: (typeof item.repairId === 'string' ? item.repairId : 'applied') + '-' + index,
        repairId: typeof item.repairId === 'string' ? item.repairId : '',
        status: rawStatus === 'applied' || rawStatus === 'skipped' || rawStatus === 'failed' ? rawStatus : 'failed',
        detail: typeof item.detail === 'string' ? item.detail : '',
        movedTo: (Array.isArray(item.movedTo) ? item.movedTo : []).map(String),
      };
    }

    async function requestDoctorRepair(repairIds, options) {
      const o = options || {};
      const ids = (Array.isArray(repairIds) ? repairIds : []).map(String).filter(Boolean);
      const body = { repairIds: ids, dryRun: o.dryRun === true };
      if (o.confirm === true) body.confirm = true;
      const result = await hostRequest(HOST_DOCTOR_REPAIR_PATH, { method: 'POST', body: JSON.stringify(body) });
      if (result && result.ok === true) {
        return {
          ok: true,
          dryRun: result.dryRun === true,
          planned: (Array.isArray(result.planned) ? result.planned : []).map(normalizeDoctorPlan),
          applied: (Array.isArray(result.applied) ? result.applied : []).map(normalizeDoctorApplied),
          auditError: typeof result.auditError === 'string' ? result.auditError : '',
        };
      }
      const error = result && result.error && typeof result.error === 'object' ? result.error : {};
      const code = typeof error.code === 'string' ? error.code : '';
      if ((result && result.status === 409) || code === 'RUN_IN_PROGRESS') {
        return {
          ok: false,
          kind: 'run-in-progress',
          runs: (Array.isArray(error.runs) ? error.runs : []).map(String),
          message: error.message || '有任务正在执行，请等其结束后再修复',
        };
      }
      return {
        ok: false,
        kind: 'error',
        code: code,
        message: (code ? code + ' ' : '') + (error.message || '修复失败'),
      };
    }

    // 可勾选 = error 且 repairable 且有 repairId。
    function selectableRepairIds(checks) {
      const seen = {};
      const out = [];
      (Array.isArray(checks) ? checks : []).forEach((check) => {
        if (!check || check.level !== 'error' || check.repairable !== true || !check.repairId) return;
        if (seen[check.repairId]) return;
        seen[check.repairId] = true;
        out.push(check.repairId);
      });
      return out;
    }

    // 错误码兜底建议：只有宿主没给 checks 明细时才用，宿主 message / checks 永远优先。
    const PREFLIGHT_FALLBACKS = {
      TOO_MANY_FILES: '文件数超过上限，请换一个更小的目录作为根，或提高上限配置',
      DISK_LOW: '磁盘剩余空间不足 200MB',
      ROOT_NOT_WRITABLE: '该目录当前不可写，请检查权限或磁盘挂载',
      ROOT_NOT_AUTHORIZED: '根目录授权已失效，请回设置重新确认并保存',
      TOOLS_MISSING: '宿主工具未全部注册，请重启应用',
    };

    function fetchPreflight() {
      return hostRequest(HOST_PREFLIGHT_PATH, { method: 'GET' });
    }

    // 200 + checks / ok:false + checks 都是「体检报告」，只有真正的请求失败才当不可用。
    function normalizePreflightResponse(result) {
      if (result && Array.isArray(result.checks)) return { ok: true, report: result };
      if (result && result.ok === true) return { ok: true, report: result };
      if (result && result.ok === false && !result.error) return { ok: true, report: result };
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function formatBytes(value) {
      const bytes = typeof value === 'number' && isFinite(value) ? value : null;
      if (bytes === null) return '—';
      const mb = bytes / (1024 * 1024);
      if (mb >= 1024) return (Math.round((mb / 1024) * 10) / 10) + ' GB';
      return Math.round(mb) + ' MB';
    }

    function presentPreflight(raw) {
      const report = raw && typeof raw === 'object' ? raw : {};
      const checks = (Array.isArray(report.checks) ? report.checks : []).map((item, index) => {
        const check = item && typeof item === 'object' ? item : {};
        const rawLevel = String(check.level == null ? '' : check.level).trim().toLowerCase();
        return {
          key: typeof check.id === 'string' && check.id ? check.id : 'check-' + index,
          id: typeof check.id === 'string' && check.id ? check.id : '',
          level: rawLevel === 'error' ? 'error' : (rawLevel === 'warn' ? 'warn' : 'ok'),
          title: typeof check.title === 'string' && check.title ? check.title : '—',
          detail: typeof check.detail === 'string' && check.detail ? check.detail : '—',
          fix: typeof check.fix === 'string' && check.fix ? check.fix : '',
        };
      });
      const code = typeof report.code === 'string' ? report.code : '';
      const hasError = checks.some((check) => check.level === 'error');
      const warnCount = checks.filter((check) => check.level === 'warn').length;
      const failed = report.ok === false || hasError || (checks.length === 0 && code !== '');
      const level = failed ? 'error' : (warnCount > 0 ? 'warn' : 'ok');
      const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
      const files = typeof counts.files === 'number' && isFinite(counts.files) ? counts.files : null;
      const notes = typeof counts.notes === 'number' && isFinite(counts.notes) ? counts.notes : null;
      const limit = typeof counts.limit === 'number' && isFinite(counts.limit) ? counts.limit : null;
      const countsText = files === null && notes === null && limit === null
        ? '—'
        : '文件 ' + (files === null ? '—' : files)
          + ' / 上限 ' + (limit === null ? '—' : limit)
          + ' · 笔记 ' + (notes === null ? '—' : notes);
      const elapsed = typeof report.elapsedMs === 'number' && isFinite(report.elapsedMs) ? report.elapsedMs : null;
      return {
        level: level,
        code: code,
        label: level === 'error' ? '失败' : (level === 'warn' ? warnCount + ' 项警告' : '通过'),
        checks: checks,
        countsText: countsText,
        freeText: formatBytes(report.freeBytes),
        elapsedText: elapsed === null ? '—' : Math.round(elapsed) + ' ms',
        // checks 为空时才用兜底建议；未知码原样显示。
        advice: checks.length === 0 && code ? (PREFLIGHT_FALLBACKS[code] || code) : '',
      };
    }

    // 建库前预检：只有拿到报告且结论为 error 才拦截；请求失败不阻塞（降级放行）。
    function shouldBlockBootstrap(preflightResult) {
      if (!preflightResult || preflightResult.ok !== true) return false;
      return presentPreflight(preflightResult.report).level === 'error';
    }

    // 预检 → 放行才允许 start（组件用它保证「拦截时绝不发 POST」）；start 可注入便于单测。
    async function beginBootstrap(options) {
      const o = options || {};
      let pre = null;
      try {
        pre = typeof o.checkPreflight === 'function' ? await o.checkPreflight() : null;
      } catch (err) {
        pre = { ok: false, error: { code: 'preflight-failed', message: String(err && err.message ? err.message : err) } };
      }
      if (shouldBlockBootstrap(pre)) return { proceed: false, preflight: pre, reason: 'preflight-failed' };
      if (typeof o.start === 'function') return { proceed: true, preflight: pre, outcome: await o.start() };
      return { proceed: true, preflight: pre };
    }

    // host 契约（host/trace.js:94,206）里 currentStep 是「当前步骤标题」字符串；
    // 若将来改回数字（brief 里的 3/5），也照样支持。
    function formatProgress(run) {
      const source = run && typeof run === 'object' ? run : {};
      const total = typeof source.stepCount === 'number' && isFinite(source.stepCount) ? source.stepCount : null;
      const current = source.currentStep;
      if (typeof current === 'number' && isFinite(current)) {
        return total === null ? String(current) : current + '/' + total;
      }
      if (typeof current === 'string' && current.trim()) {
        const title = current.trim();
        return total === null ? title : total + ' 步 · ' + title;
      }
      return total === null ? '—' : total + ' 步';
    }

    // degraded 可能是字符串、对象 {reason|message|code} 或布尔；空值不显示徽标。
    // host/orchestrator.js 只写降级码（'no-route' / 'no-agent'），中文解释在渲染层补。
    const DEGRADED_REASONS = {
      'no-route': '没有可用的 agent 路由，已降级为规则引擎执行',
      'no-agent': '未检测到可用的 agent，已降级为规则引擎执行',
    };

    function describeDegraded(degraded) {
      if (degraded === null || degraded === undefined || degraded === false || degraded === '') return '';
      if (degraded === true) return '无 agent 降级（宿主未提供原因）';
      if (typeof degraded === 'string') return DEGRADED_REASONS[degraded] || degraded;
      if (typeof degraded === 'object') {
        const reason = degraded.reason || degraded.message || degraded.code || '';
        return typeof reason === 'string' && reason ? reason : '无 agent 降级（宿主未提供原因）';
      }
      return String(degraded);
    }

    function presentRun(raw, nowValue) {
      const run = raw && typeof raw === 'object' ? raw : {};
      const tone = normalizeRunStatus(run.status);
      const degradedText = describeDegraded(run.degraded);
      const now = resolveNow(nowValue);
      const budget = readBudget(run, now);
      const heartbeatBy = typeof run.heartbeatBy === 'string' && run.heartbeatBy ? run.heartbeatBy : '';
      return {
        id: run.id == null ? '' : String(run.id),
        title: typeof run.title === 'string' && run.title ? run.title : '未命名任务',
        kind: typeof run.kind === 'string' ? run.kind : '',
        kindLabel: runKindLabel(run.kind),
        status: tone,
        statusRaw: run.status == null ? '' : String(run.status),
        statusLabel: statusLabel(run.status),
        progressText: formatProgress(run),
        startedText: formatTimestamp(run.startedAt),
        endedText: formatTimestamp(run.endedAt),
        durationText: formatDuration(run.startedAt, run.endedAt, nowValue),
        summary: typeof run.summary === 'string' ? run.summary : '',
        degraded: degradedText,
        hasDegraded: degradedText.length > 0,
        heartbeatAtText: formatTimestamp(run.heartbeatAt),
        heartbeatAgeText: formatHeartbeatAge(run.heartbeatAt, now),
        heartbeatBy: heartbeatBy,
        heartbeatByText: heartbeatBy || '—',
        heartbeatThresholdMs: heartbeatThresholdMs(heartbeatBy),
        deadlineText: formatTimestamp(run.deadlineAt),
        cancelRequestedText: formatTimestamp(run.cancelRequestedAt),
        stalledText: formatTimestamp(run.stalledAt),
        timedOutText: formatTimestamp(run.timedOutAt),
        acceptanceFailed: run.acceptanceFailed === true,
        usage: normalizeUsage(run.usage),
        usageSource: normalizeUsageSource(run.usageSource),
        usageText: usageListText(run),
        acceptance: normalizeAcceptance(run.acceptance),
        acceptanceBadge: describeAcceptanceBadge(run),
        budgetUsed: budget.used,
        budgetTotal: budget.total,
        budgetText: budget.text,
        budgetOver: budget.over,
        budgetSource: budget.source,
        suspectedStall: isSuspectedStall(run, now),
      };
    }

    function presentRuns(runs, nowValue) {
      const list = Array.isArray(runs) ? runs : [];
      return list.map((run) => presentRun(run, nowValue));
    }

    function hasRunningRuns(runs) {
      const list = Array.isArray(runs) ? runs : [];
      return list.some((run) => normalizeRunStatus(run && run.status) === 'running');
    }

    function summarizeValue(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      try { return JSON.stringify(value); } catch (err) { return ''; }
    }

    // 父子链可能断链 / 成环：缺父按 0 缩进，环最多跟 16 层。
    function computeStepDepths(steps) {
      const list = Array.isArray(steps) ? steps : [];
      const byId = {};
      list.forEach((step) => {
        if (step && step.id != null) byId[String(step.id)] = step;
      });
      return list.map((step) => {
        let depth = 0;
        let cursor = step;
        const seen = {};
        while (cursor && cursor.parentId != null && byId[String(cursor.parentId)] && depth < 16) {
          const key = String(cursor.parentId);
          if (seen[key]) break;
          seen[key] = true;
          depth += 1;
          cursor = byId[key];
        }
        return depth;
      });
    }

    function normalizeArtifacts(value) {
      const list = Array.isArray(value) ? value : [];
      return list.map((item, index) => {
        if (typeof item === 'string') return { key: 'artifact-' + index, path: item, label: item };
        if (item && typeof item === 'object') {
          const path = typeof item.path === 'string' ? item.path : (typeof item.file === 'string' ? item.file : '');
          const label = typeof item.label === 'string' && item.label ? item.label : path;
          return { key: 'artifact-' + index, path: path || label, label: label || '未命名产物' };
        }
        return { key: 'artifact-' + index, path: String(item), label: String(item) };
      }).filter((item) => item.path);
    }

    function describeStepError(value) {
      if (value === null || value === undefined || value === false || value === '') return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'object') {
        const message = value.message || value.error || '';
        if (typeof message === 'string' && message) return message;
        try { return JSON.stringify(value); } catch (err) { return '宿主返回了未知错误'; }
      }
      return String(value);
    }

    function presentSteps(steps) {
      const list = Array.isArray(steps) ? steps : [];
      const depths = computeStepDepths(list);
      return list.map((raw, index) => {
        const step = raw && typeof raw === 'object' ? raw : {};
        const tone = normalizeStepStatus(step.status);
        return {
          key: step.id != null ? String(step.id) : 'step-' + index,
          id: step.id != null ? String(step.id) : '',
          parentId: step.parentId != null ? String(step.parentId) : '',
          depth: depths[index],
          role: typeof step.role === 'string' && step.role ? step.role : 'UNKNOWN',
          title: typeof step.title === 'string' && step.title
            ? step.title
            : (typeof step.name === 'string' && step.name ? step.name : '未命名步骤'),
          status: tone,
          statusRaw: step.status == null ? '' : String(step.status),
          statusLabel: stepStatusLabel(step.status),
          startedText: formatTimestamp(step.startedAt),
          durationText: formatDuration(step.startedAt, step.endedAt, null),
          inputSummary: summarizeValue(step.inputSummary),
          outputSummary: summarizeValue(step.outputSummary),
          artifacts: normalizeArtifacts(step.artifacts),
          error: describeStepError(step.error),
        };
      });
    }

    function presentRunDetail(payload, nowValue) {
      const data = payload && typeof payload === 'object' ? payload : {};
      return {
        run: presentRun(data.run, nowValue),
        steps: presentSteps(data.steps),
        hasRunning: normalizeRunStatus(data.run && data.run.status) === 'running',
        recovery: normalizeRecovery(
          data.recovery || data.decision || (data.run && data.run.recovery)
        ),
      };
    }

    // ───────────────────────────── 运行任务：状态机（纯函数） ─────────────────────────────
    function normalizeRunsResponse(result) {
      if (result && result.ok === true) {
        return {
          type: 'loaded',
          runs: Array.isArray(result.runs) ? result.runs : [],
          nextBefore: typeof result.nextBefore === 'string' && result.nextBefore ? result.nextBefore : null,
        };
      }
      return {
        type: 'failed',
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function seedRunsPageState(feed) {
      const base = createRunsPageState();
      if (feed && feed.phase === 'ready' && Array.isArray(feed.runs)) {
        base.phase = 'ready';
        base.runs = feed.runs.slice();
      }
      return base;
    }

    function createRunsPageState() {
      return {
        phase: 'loading',
        runs: [],
        nextBefore: null,
        pages: 1,
        loadingMore: false,
        error: null,
        notice: null,
        busy: false,
        confirm: '',
      };
    }

    // 失败即清空列表：宁可不显示，也不拿旧数据假装正常。
    function reduceRunsPage(state, action) {
      const base = state && typeof state === 'object' ? state : createRunsPageState();
      const act = action || {};
      if (act.type === 'loaded') {
        return Object.assign({}, base, {
          phase: 'ready',
          runs: Array.isArray(act.runs) ? act.runs : [],
          nextBefore: typeof act.nextBefore === 'string' && act.nextBefore ? act.nextBefore : null,
          pages: 1,
          loadingMore: false,
          error: null,
        });
      }
      if (act.type === 'appendLoaded') {
        return Object.assign({}, base, {
          phase: 'ready',
          runs: mergeRunPages(base.runs, act.runs),
          nextBefore: typeof act.nextBefore === 'string' && act.nextBefore ? act.nextBefore : null,
          pages: (typeof base.pages === 'number' ? base.pages : 1) + 1,
          loadingMore: false,
          error: null,
        });
      }
      if (act.type === 'loadingMore') {
        return Object.assign({}, base, { loadingMore: act.value === true });
      }
      if (act.type === 'failed') {
        return Object.assign({}, base, {
          phase: 'error',
          runs: [],
          nextBefore: null,
          pages: 1,
          loadingMore: false,
          error: act.error || { code: 'host-unreachable', message: '宿主服务未连接' },
        });
      }
      if (act.type === 'busy') return Object.assign({}, base, { busy: act.busy === true });
      if (act.type === 'notice') return Object.assign({}, base, { notice: act.notice || null });
      if (act.type === 'confirm') return Object.assign({}, base, { confirm: typeof act.kind === 'string' ? act.kind : '' });
      if (act.type === 'loading') return Object.assign({}, base, { phase: 'loading', error: null });
      return base;
    }

    function normalizeRunDetailResponse(result) {
      if (result && result.ok === true) {
        return {
          type: 'loaded',
          data: {
            run: result.run || null,
            steps: Array.isArray(result.steps) ? result.steps : [],
            recovery: result.recovery || result.decision || null,
          },
        };
      }
      return {
        type: 'failed',
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    function createRunDetailState() {
      return { phase: 'loading', data: null, error: null, notice: null, busy: false };
    }

    function reduceRunDetail(state, action) {
      const base = state && typeof state === 'object' ? state : createRunDetailState();
      const act = action || {};
      if (act.type === 'loaded') return Object.assign({}, base, { phase: 'ready', data: act.data || null, error: null });
      if (act.type === 'failed') {
        return Object.assign({}, base, {
          phase: 'error',
          data: null,
          error: act.error || { code: 'host-unreachable', message: '宿主服务未连接' },
        });
      }
      if (act.type === 'busy') return Object.assign({}, base, { busy: act.busy === true });
      if (act.type === 'notice') return Object.assign({}, base, { notice: act.notice || null });
      if (act.type === 'loading') return Object.assign({}, base, { phase: 'loading', error: null, data: null });
      return base;
    }

    // ───────────────────────────── 运行任务：发起 / 中止 ─────────────────────────────
    function planRunStart(input) {
      const i = input || {};
      const kind = normalizeRunKind(i.kind);
      if (!kind) return { ok: false, code: 'unknown-kind', message: '未知的任务类型' };
      // 建库必须二次确认：默认不传 force，避免覆盖已有 _说明.md。
      if (kind === 'bootstrap' && i.confirmed !== true) {
        return { ok: false, code: 'confirm-required', kind: kind, message: '开始建库需要二次确认' };
      }
      return { ok: true, kind: kind };
    }

    // host 的 409 有两种：run-conflict（真冲突）与 root-missing（还没配置根目录）。
    function isRunConflict(result) {
      if (!result) return false;
      const code = result.error && result.error.code;
      // 只认「run 相关的冲突码」，避免 MODE_CONFLICT 这类业务错误被误判。
      if (typeof code === 'string' && /^run-(conflict|in-?progress|running)$/i.test(code)) return true;
      return result.status === 409 && code !== 'root-missing';
    }

    function describeRunError(result, conflictText) {
      if (isRunConflict(result)) {
        return conflictText || '已有任务在运行中：请等它结束或先「中止」后再发起新任务';
      }
      const error = result && result.error ? result.error : null;
      const base = error ? (error.code ? error.code + ' ' : '') + (error.message || '') : '未知错误';
      if (!error || /host-unreachable|无法访问|未连接/.test(base)) {
        return '宿主服务未连接：无法访问插件后端（' + base + '）';
      }
      return base;
    }

    async function startRunRequest(input) {
      const plan = planRunStart(input || {});
      if (!plan.ok) {
        return { started: false, code: plan.code, message: plan.message, kind: plan.kind || '' };
      }
      const result = await startHostRun(plan.kind);
      if (result && result.ok === true) return { started: true, kind: plan.kind, result: result };
      return {
        started: false,
        kind: plan.kind,
        code: (result && result.error && result.error.code) || 'request-failed',
        status: result && result.status,
        conflict: isRunConflict(result),
        // 422 的 error.checks 原样带回，交给体检卡片渲染（不自己编文案）。
        checks: result && result.error && Array.isArray(result.error.checks) ? result.error.checks : [],
        message: describeRunError(result),
      };
    }

    async function cancelRunRequest(runId) {
      const result = await cancelHostRun(runId);
      if (result && result.ok === true) return { cancelled: true, result: result };
      return {
        cancelled: false,
        status: result && result.status,
        message: describeRunError(result, '任务已结束，无法中止'),
      };
    }

    // ───────────────────────────── 轮询控制器（纯逻辑 + 可注入 timer） ─────────────────────────────
    // 组件只负责 sync(active)：running 时起 interval，全部结束或卸载时 stop。
    function createPollController(options) {
      const o = options || {};
      const env = typeof globalThis !== 'undefined' ? globalThis : {};
      const setIntervalFn = o.setInterval || env.setInterval || null;
      const clearIntervalFn = o.clearInterval || env.clearInterval || null;
      const intervalMs = typeof o.intervalMs === 'number' && o.intervalMs > 0 ? o.intervalMs : POLL_INTERVAL_MS;
      const onTick = typeof o.tick === 'function' ? o.tick : function () {};
      let handle = null;
      let ticks = 0;

      function stop() {
        if (handle !== null && typeof clearIntervalFn === 'function') {
          try { clearIntervalFn(handle); } catch (err) { /* 清理失败也不能阻挡卸载 */ }
        }
        handle = null;
        return true;
      }

      function fire() {
        ticks += 1;
        try { onTick(); } catch (err) { /* 单次刷新失败由组件错误态承担 */ }
      }

      return {
        intervalMs: intervalMs,
        sync(active) {
          if (active !== true) {
            stop();
            return false;
          }
          if (handle !== null) return true;
          if (typeof setIntervalFn !== 'function') return false;
          handle = setIntervalFn(fire, intervalMs);
          if (handle === undefined || handle === null) handle = null;
          return handle !== null;
        },
        stop: stop,
        isActive() { return handle !== null; },
        getTickCount() { return ticks; },
      };
    }

    // tick 永远指向最新闭包，避免 effect 依赖 refresh 函数身份而反复重建 interval。
    function usePollingEffect(tick, active) {
      const tickRef = React.useRef ? React.useRef(tick) : { current: tick };
      tickRef.current = tick;
      React.useEffect(function () {
        const controller = createPollController({
          tick: function () {
            if (typeof tickRef.current === 'function') tickRef.current();
          },
        });
        controller.sync(active === true);
        return function () { controller.stop(); };
      }, [active === true]);
      return null;
    }

    async function copyToClipboard(text) {
      const value = String(text == null ? '' : text);
      if (!value) return false;
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch (err) { /* 剪贴板被拒时静默降级 */ }
      return false;
    }

    // ───────────────────────────── 目录选择器（可选的原生能力）─────────────────────────────
    function getDirectoryPicker() {
      try {
        const picker = typeof globalThis !== 'undefined' ? globalThis.__DSH_DIRECTORY_PICKER__ : null;
        if (picker && typeof picker.pick === 'function') return picker;
      } catch (err) { /* 拿不到就当没有 */ }
      return null;
    }

    function hasDirectoryPicker() {
      return getDirectoryPicker() !== null;
    }

    // 没有 preload 注入时返回 null，调用方降级为手填绝对路径。
    async function pickDirectory() {
      const picker = getDirectoryPicker();
      if (!picker) return null;
      try {
        const picked = await picker.pick();
        return typeof picked === 'string' && picked.trim().length > 0 ? picked : null;
      } catch (err) {
        return null;
      }
    }

    // ───────────────────────────── 风险确认判定（纯函数）─────────────────────────────
    function normalizeForCompare(value) {
      return String(value == null ? '' : value).trim().replace(/\/+$/, '');
    }

    // 路径与已保存的不同，或从未确认过（缺 rootConfirmedAt / rootRiskAck）→ 必须重新确认。
    function needsRiskAck(draftRoot, settings) {
      const draft = normalizeForCompare(draftRoot);
      if (!draft) return false;
      const saved = settings && typeof settings === 'object' ? settings : {};
      if (!saved.root || !saved.rootConfirmedAt || !saved.rootRiskAck) return true;
      return normalizeForCompare(saved.root) !== draft;
    }

    // 保存按钮的启用条件集中在这里，UI 与 smoke 用同一份判定。
    function canSave(input) {
      const i = input || {};
      if (i.saving === true || i.hostReady !== true) return false;
      if (!normalizeForCompare(i.draftRoot)) return false;
      const validation = i.validation;
      if (!validation || validation.ok !== true) return false;
      if (validation.level === 'reject' || validation.level === 'error') return false;
      if (i.needsAck === true && i.acknowledged !== true) return false;
      return true;
    }

    // ───────────────────────────── 设置左栏图标（结构选择器 + mask 样式） ─────────────────────────────
    // 设置左栏的图标由 closed list 决定，第三方分区只能拿到默认齿轮；这里按 dshmarket 的已验证做法，
    // 用结构选择器认领自己那一行，注入一段 mask 样式，既不替换节点也不依赖 CSS Module 类名。
    const NAV_ROW_SELECTOR = '[role="dialog"] nav button';
    const NAV_ICON_MARKER = 'data-jk-kb-nav-icon';
    const NAV_STYLE_SELECTOR = 'style[data-plugin="jk-knowledge-base"][data-plugin-css="jk-knowledge-base/settings-nav-icon"]';

    // mask 只读 alpha：必须是实心填充，不能用 stroke（两端书页，中间留 0.7 脊缝）。
    function bookMaskSvg() {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">'
        + '<path d="M8 4.1C6.9 3.4 5.2 3.1 3.2 3.2v8.4c2-.1 3.7.2 4.8.9V4.1Zm.7 0c1.1-.7 2.8-1 4.8-.9v8.4c-2-.1-3.7.2-4.8.9V4.1Z"/></svg>';
    }

    // 运行时编码，绝不手写转义。
    function bookMaskUrl() {
      return 'data:image/svg+xml,' + encodeURIComponent(bookMaskSvg());
    }

    // 纯判定：空标签一律不匹配（本地化未就绪时不能误标整栏）。
    function isOwnNavRow(rowText, wantedLabel) {
      const wanted = String(wantedLabel == null ? '' : wantedLabel).trim();
      if (!wanted) return false;
      return String(rowText == null ? '' : rowText).trim() === wanted;
    }

    // 命中行隐藏原来的齿轮，用 ::before + mask 画出书本。
    function navIconCss(maskUrl) {
      return [
        '[data-jk-kb-nav-icon] > svg{display:none;}',
        '[data-jk-kb-nav-icon]::before{content:\'\';flex:none;width:16px;height:16px;background-color:currentColor;'
          + '-webkit-mask-image:url("' + maskUrl + '");mask-image:url("' + maskUrl + '");'
          + '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;'
          + '-webkit-mask-size:16px 16px;mask-size:16px 16px;}',
      ].join('\n');
    }

    // 安装即返回 dispose；document 缺失时直接 no-op（SSR / 纯 node 测试环境）。
    function installSettingsNavIcon(options) {
      const o = options || {};
      const doc = o.document || (typeof document !== 'undefined' ? document : null);
      if (!doc) return function () {};
      const Observer = o.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      const enqueue = typeof o.queueMicrotask === 'function'
        ? o.queueMicrotask
        : (typeof queueMicrotask === 'function' ? queueMicrotask : function (fn) { fn(); });
      const resolveLabel = typeof o.resolveLabel === 'function'
        ? o.resolveLabel
        : function () { return NAV_LABEL_TEXT; };

      let tag = null;
      let observer = null;
      let disposed = false;
      let scheduled = false;

      function removeNode(node) {
        if (!node) return;
        try {
          if (typeof node.remove === 'function') node.remove();
          else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
        } catch (err) { /* 忽略 */ }
      }

      function sync() {
        scheduled = false;
        if (disposed) return;
        const labelValue = resolveLabel();
        const wanted = String(labelValue == null ? '' : labelValue).trim();
        const rows = doc.querySelectorAll(NAV_ROW_SELECTOR);
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          if (!row) continue;
          try {
            if (isOwnNavRow(row.textContent, wanted)) row.setAttribute(NAV_ICON_MARKER, '');
            else row.removeAttribute(NAV_ICON_MARKER);
          } catch (err) { /* 单行失败不影响其余行 */ }
        }
      }

      function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        enqueue(sync);
      }

      try {
        // 重复安装不叠加：先清掉同 plugin 的旧 style。
        const previous = doc.querySelectorAll(NAV_STYLE_SELECTOR);
        for (let i = 0; i < previous.length; i += 1) removeNode(previous[i]);
        tag = doc.createElement('style');
        tag.setAttribute('data-plugin', PLUGIN_ID);
        tag.setAttribute('data-plugin-css', PLUGIN_ID + '/settings-nav-icon');
        tag.textContent = navIconCss(bookMaskUrl());
        doc.head.appendChild(tag);
        // 首帧先同步一次，之后交给 MutationObserver（微任务合并）。
        sync();
        if (Observer && doc.body) {
          observer = new Observer(schedule);
          observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
        }
      } catch (err) {
        // 任何一步失败都退化成「没有图标」，绝不影响设置面板本身。
      }

      return function dispose() {
        disposed = true;
        if (observer && typeof observer.disconnect === 'function') {
          try { observer.disconnect(); } catch (err) { /* 忽略 */ }
        }
        observer = null;
        try {
          const marked = doc.querySelectorAll('[' + NAV_ICON_MARKER + ']');
          for (let i = 0; i < marked.length; i += 1) {
            try { marked[i].removeAttribute(NAV_ICON_MARKER); } catch (err) { /* 忽略 */ }
          }
          removeNode(tag);
        } catch (err) { /* 忽略 */ }
        tag = null;
      };
    }

    // ───────────────────────────── 侧边栏图标 ─────────────────────────────
    function KnowledgeBaseIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-dsh-panel-entry': PANEL_ID,
      },
        h('path', { d: 'M8 3.4C6.8 2.5 5.2 2.2 3 2.4v10.2c2.2-.2 3.8.1 5 1 1.2-.9 2.8-1.2 5-1V2.4c-2.2-.2-3.8.1-5 1z' }),
        h('path', { d: 'M8 3.4v10.2' }),
        h('path', { d: 'M4.6 5.4h2M4.6 7.4h2M9.4 5.4h2M9.4 7.4h2' })
      );
    }

    // ───────────────────────────── 样式（JS 常量 + <style> 注入） ─────────────────────────────
    // 只用已核实存在的 --dsw-alias-* 主题 token，深浅色自动跟随；不写死颜色、不引字体。
    const SETTINGS_STYLE = [
      '.jk-kb-root{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:20px clamp(14px,3vw,32px) 32px;display:flex;flex-direction:column;gap:16px;}',
      '.jk-kb-head{display:flex;align-items:flex-start;gap:12px;}',
      '.jk-kb-title{margin:0;font-size:16px;font-weight:600;line-height:1.4;}',
      '.jk-kb-subtitle{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;}',
      '.jk-kb-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px;}',
      '.jk-kb-switch-row{display:flex;align-items:center;gap:12px;}',
      '.jk-kb-switch-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.jk-kb-switch{margin-left:auto;display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:4px 10px 4px 6px;}',
      '.jk-kb-switch:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-switch-on{border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary);}',
      '.jk-kb-switch-track{position:relative;display:inline-block;width:34px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background-color .15s ease;}',
      '.jk-kb-switch-on .jk-kb-switch-track{background:var(--dsw-alias-button-primary-fill);}',
      '.jk-kb-switch-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease;}',
      '.jk-kb-switch-on .jk-kb-switch-thumb{transform:translateX(16px);}',
      '.jk-kb-switch-state{white-space:nowrap;}',
      '.jk-kb-hint{margin:10px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.7;}',
      '.jk-kb-notice{margin:0;font-size:12px;line-height:1.6;}',
      '.jk-kb-notice-ok{color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-notice-warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));}',
      '.jk-kb-notice-error{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-footer{margin-top:auto;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:12px;}',
      '.jk-kb-meta{margin:0 0 0 auto;display:flex;flex-direction:column;gap:2px;align-items:flex-end;text-align:right;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-meta-version{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-section-head{display:flex;align-items:center;gap:8px;}',
      '.jk-kb-host-badge{margin-left:auto;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;white-space:nowrap;}',
      '.jk-kb-root-row{display:flex;align-items:baseline;gap:10px;margin-top:8px;font-size:12px;line-height:1.6;}',
      '.jk-kb-root-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-path{margin:0;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all;}',
      '.jk-kb-root-actions{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;}',
      '.jk-kb-input{flex:1 1 220px;min-width:0;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 10px;}',
      '.jk-kb-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-btn{font:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 12px;}',
      '.jk-kb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-btn:disabled{opacity:.55;cursor:not-allowed;}',
      '.jk-kb-btn:disabled:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.jk-kb-validation{margin-top:10px;display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-validation-ok{border-color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-validation-warn{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));}',
      '.jk-kb-validation-reject{border-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-validation-error{border-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-validation-line{margin:0;}',
      '.jk-kb-risk{margin-top:10px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-radius:10px;padding:10px 12px;}',
      '.jk-kb-risk-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-risk-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-risk-item{}',
      '.jk-kb-ack{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.jk-kb-ack-box{margin:2px 0 0;}',
      '.jk-kb-ack-text{}',
      '.jk-kb-save{font:inherit;font-size:13px;font-weight:600;line-height:1.4;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));padding:7px 20px;}',
      '.jk-kb-save:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-save:disabled{opacity:.55;cursor:not-allowed;}',
      '.jk-kb-save:disabled:hover{background:var(--dsw-alias-button-primary-fill);}',
      '.jk-kb-info{position:relative;display:inline-flex;align-items:center;}',
      '.jk-kb-info-btn{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;cursor:pointer;border:0;border-radius:50%;background:none;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-info-btn:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-info-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-tooltip{position:absolute;top:calc(100% + 6px);left:0;z-index:20;width:max-content;max-width:320px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;pointer-events:none;box-shadow:0 6px 16px var(--dsw-alias-border-l1);}',
      '.jk-kb-focus-pulse{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;animation:jk-kb-focus-pulse 1.25s ease-in-out 2;}',
      '@keyframes jk-kb-focus-pulse{0%,100%{opacity:1;}50%{opacity:.55;}}',
    ].join('');

    const PANEL_STYLE = [
      '.jk-kb-panel{height:100%;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:20px clamp(14px,3vw,32px) 24px;display:flex;flex-direction:column;gap:14px;}',
      '.jk-kb-panel-head{display:flex;align-items:flex-start;gap:12px;}',
      '.jk-kb-example-badge{margin-left:auto;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;white-space:nowrap;}',
      '.jk-kb-panel-body{flex:1 1 auto;min-height:0;display:flex;gap:16px;align-items:stretch;}',
      '.jk-kb-side{flex:0 0 232px;min-width:200px;min-height:0;display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-menu-group{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:8px;}',
      '.jk-kb-menu{font:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);padding:7px 10px;}',
      '.jk-kb-menu:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-menu:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-menu-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.jk-kb-tasks{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:10px 12px;}',
      '.jk-kb-section-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-task-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-task{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-task-name{color:var(--dsw-alias-label-primary);}',
      '.jk-kb-task-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-more{font:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:4px 10px;align-self:flex-start;}',
      '.jk-kb-more:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-content{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:14px;}',
      '.jk-kb-dash{display:flex;flex-direction:column;gap:14px;}',
      '.jk-kb-dash-head{display:flex;align-items:flex-start;gap:12px;}',
      '.jk-kb-dash-head .jk-kb-btn{margin-left:auto;}',
      '.jk-kb-stat-head{display:flex;align-items:center;gap:6px;}',
      '.jk-kb-truncated{font-size:10px;font-weight:600;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-radius:999px;padding:0 6px;white-space:nowrap;}',
      '.jk-kb-recent-item{align-items:center;}',
      '.jk-kb-recent-copy{flex:none;}',
      '.jk-kb-maintain{display:flex;flex-direction:column;gap:4px;}',
      '.jk-kb-maintain-period{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-maintain-summary{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-maintain-rules{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-tasks-head-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.jk-kb-doctor-launch{margin-left:auto;}',
      '.jk-kb-doctor{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2);}',
      '.jk-kb-doctor-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-doctor-head .jk-kb-btn:first-of-type{margin-left:auto;}',
      '.jk-kb-doctor-summary{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-doctor-groups{display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-doctor-group{display:flex;flex-direction:column;gap:4px;}',
      '.jk-kb-doctor-group-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-doctor-checks{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-doctor-check{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;}',
      '.jk-kb-doctor-check-blocked{border-color:var(--dsw-alias-state-error-primary);border-left-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-doctor-check-error{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-left-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));}',
      '.jk-kb-doctor-check-warn{border-left-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));}',
      '.jk-kb-doctor-check-ok{border-left-color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-doctor-check-body{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.jk-kb-doctor-check-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-doctor-check-detail{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;}',
      '.jk-kb-doctor-conflict{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;}',
      '.jk-kb-doctor-conflict p{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-doctor-plan,.jk-kb-doctor-result{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
      '.jk-kb-doctor-plan-list,.jk-kb-doctor-result-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-doctor-plan-row,.jk-kb-doctor-result-row{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;}',
      '.jk-kb-doctor-result-failed{border-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-doctor-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-guide-bar{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);}',
      '.jk-kb-guide-bar-text{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-guide-bar-action{flex:none;}',
      '.jk-kb-sidebar-task{cursor:pointer;align-items:center;}',
      '.jk-kb-sidebar-task-meta{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-sidebar-task-status-label{white-space:nowrap;}',
      '.jk-kb-sidebar-task-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-task-heartbeat{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:jk-kb-heartbeat 1.2s ease-in-out infinite;}',
      '.jk-kb-sidebar-task[data-jk-kb-sidebar-task-status="failed"] .jk-kb-sidebar-task-status-label{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-sidebar-task[data-jk-kb-sidebar-task-status="done"] .jk-kb-sidebar-task-status-label{color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-sidebar-task[data-jk-kb-sidebar-task-status="running"] .jk-kb-sidebar-task-status-label{color:var(--dsw-alias-brand-primary);}',
      '@keyframes jk-kb-heartbeat{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.45;transform:scale(.8);}}',
      '@media (prefers-reduced-motion: reduce){.jk-kb-task-heartbeat{animation:none;}}',
      '.jk-kb-skel-tasks{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;}',
      '.jk-kb-skel-task{display:flex;align-items:center;gap:8px;}',
      '.jk-kb-skel-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-border-l2);animation:jk-kb-skel-pulse 1.2s ease-in-out infinite;}',
      '.jk-kb-skel-bar{display:inline-block;height:10px;border-radius:6px;background:var(--dsw-alias-border-l1);animation:jk-kb-skel-pulse 1.2s ease-in-out infinite;}',
      '.jk-kb-skel-task .jk-kb-skel-bar{flex:1;}',
      '.jk-kb-skel-bar-sm{width:46%;}',
      '.jk-kb-skel-bar-md{width:62%;}',
      '.jk-kb-skel-bar-lg{width:76%;height:18px;margin-top:8px;}',
      '.jk-kb-skel-card{display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-skel-list{display:flex;flex-direction:column;gap:10px;}',
      '.jk-kb-skel-row{display:flex;align-items:center;gap:10px;}',
      '@keyframes jk-kb-skel-pulse{0%,100%{opacity:1;}50%{opacity:.45;}}',
      '@media (prefers-reduced-motion: reduce){.jk-kb-skel-bar,.jk-kb-skel-dot{animation:none;opacity:1;}}',
      '.jk-kb-note{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;}',
      '.jk-kb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;}',
      '.jk-kb-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-stat-label{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-stat-value{font-size:20px;font-weight:600;line-height:1.2;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-stat-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-dash-columns{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;}',
      '.jk-kb-block{flex:1 1 240px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-list-item{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-list-title{min-width:0;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.jk-kb-list-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-runtime-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.5;}',
      '.jk-kb-runtime-key{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-runtime-value{margin-left:auto;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-placeholder{display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-placeholder-title{margin:0;font-size:14px;font-weight:600;line-height:1.4;}',
      '.jk-kb-guidance{display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-runs{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-runs-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}',
      '.jk-kb-run-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-btn-primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));font-weight:600;}',
      '.jk-kb-btn-primary:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-btn-primary:disabled:hover{background:var(--dsw-alias-button-primary-fill);}',
      '.jk-kb-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-recover{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}',
      '.jk-kb-recover-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-btn-suggested{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;font-weight:600;}',
      '.jk-kb-run-table{display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-run-row{display:grid;grid-template-columns:minmax(120px,1.6fr) 64px 76px minmax(96px,1.2fr) 116px 76px minmax(84px,0.9fr) 64px 74px minmax(0,auto);align-items:center;gap:8px;width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;text-align:left;border:1px solid transparent;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);padding:8px 10px;cursor:pointer;}',
      '.jk-kb-run-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-run-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-run-header{cursor:default;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;}',
      '.jk-kb-run-header:hover{background:none;}',
      '.jk-kb-run-cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-run-title{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.jk-kb-status{font-weight:600;}',
      '.jk-kb-status-running{color:var(--dsw-alias-brand-primary);}',
      '.jk-kb-status-done{color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-status-failed{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-status-timed_out{color:var(--dsw-alias-state-error-primary);font-weight:700;animation:jk-kb-status-pulse 1.6s ease-in-out infinite;}',
      '.jk-kb-status-stalled{color:var(--dsw-alias-state-error-primary);font-weight:700;animation:jk-kb-status-pulse 1.6s ease-in-out infinite;}',
      '.jk-kb-status-abandoned{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-status-cancelled{color:var(--dsw-alias-label-tertiary);}',
      '@keyframes jk-kb-status-pulse{0%,100%{opacity:1;}50%{opacity:.55;}}',
      '.jk-kb-status-skipped{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-status-unknown{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-run-heartbeat{display:flex;align-items:center;gap:4px;}',
      '.jk-kb-suspected{flex:none;font-size:10px;font-weight:600;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-radius:999px;padding:0 6px;white-space:nowrap;}',
      '.jk-kb-budget-over{color:var(--dsw-alias-state-error-primary);font-weight:600;}',
      '.jk-kb-degraded{font-size:11px;font-weight:600;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-radius:999px;padding:1px 8px;white-space:nowrap;}',
      '.jk-kb-empty{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;}',
      '.jk-kb-error{display:flex;flex-direction:column;gap:8px;align-items:flex-start;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:12px 14px;}',
      '.jk-kb-confirm{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-radius:10px;padding:10px 12px;}',
      '.jk-kb-run-detail-page{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-detail{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-detail-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.jk-kb-detail-actions{margin-left:auto;display:flex;align-items:center;gap:8px;}',
      '.jk-kb-detail-meta{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-detail-row{display:flex;align-items:baseline;gap:10px;font-size:12px;line-height:1.6;}',
      '.jk-kb-detail-key{min-width:64px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-detail-value{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-all;}',
      '.jk-kb-timeline{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-step{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;}',
      '.jk-kb-step-error{border-color:var(--dsw-alias-state-error-primary);border-left-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-step-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-role{font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 6px;white-space:nowrap;}',
      '.jk-kb-step-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-step-duration{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-step-line{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;}',
      '.jk-kb-artifacts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.jk-kb-artifact{font:inherit;font-size:11px;line-height:1.4;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);padding:2px 8px;}',
      '.jk-kb-artifact:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-artifact:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-step-error-box{border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;padding:6px 8px;}',
      '.jk-kb-step-error-box .jk-kb-step-line{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-guide-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:16px;}',
      '.jk-kb-guide-title{margin:0;font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-guide-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-guide-step{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;text-align:left;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 10px;}',
      '.jk-kb-guide-step:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary);}',
      '.jk-kb-guide-step:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-guide-index{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary);}',
      '.jk-kb-guide-step-title{min-width:0;}',
      '.jk-kb-guide-arrow{margin-left:auto;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-guide-cta{align-self:flex-start;font:inherit;font-size:13px;font-weight:600;line-height:1.4;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));padding:7px 18px;}',
      '.jk-kb-guide-cta:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-guide-cta:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-guide-footnote{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-preflight{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:8px 12px;}',
      '.jk-kb-preflight-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-preflight-summary{font-size:12px;font-weight:600;}',
      '.jk-kb-preflight-ok{color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-preflight-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));}',
      '.jk-kb-preflight-error{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-preflight-unavailable,.jk-kb-preflight-idle{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-preflight-loading{color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-preflight-actions{margin-left:auto;display:flex;align-items:center;gap:8px;}',
      '.jk-kb-preflight-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-preflight-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-preflight-code{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 6px;}',
      '.jk-kb-preflight-meta{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-preflight-checks{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-check{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;}',
      '.jk-kb-check-error{border-color:var(--dsw-alias-state-error-primary);border-left-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-check-warn{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-left-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));}',
      '.jk-kb-check-ok{border-left-color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-check-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-check-detail{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;}',
      '.jk-kb-check-fix{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-brand-primary);word-break:break-word;}',
      '.jk-kb-run-status-cell{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.jk-kb-acceptance-badge{flex:none;font-size:10px;font-weight:600;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;white-space:nowrap;}',
      '.jk-kb-acceptance-passed{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-acceptance-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-acceptance{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-token{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.jk-kb-token-degraded{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-usage{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-curate{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:12px;}',
      '.jk-kb-curate-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-field-input,.jk-kb-textarea,.jk-kb-select{box-sizing:border-box;width:100%;font:inherit;font-size:12px;line-height:1.5;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 10px;}',
      '.jk-kb-textarea{min-height:96px;resize:vertical;}',
      '.jk-kb-field-input:focus-visible,.jk-kb-textarea:focus-visible,.jk-kb-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-curate-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-reports{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-reports-head{display:flex;align-items:center;gap:8px;}',
      '.jk-kb-report-item{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);}',
      '.jk-kb-report-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-report-summary-btn{flex:1 1 240px;min-width:0;display:flex;align-items:baseline;gap:8px;font:inherit;font-size:12px;text-align:left;cursor:pointer;border:0;background:none;color:var(--dsw-alias-label-secondary);padding:0;}',
      '.jk-kb-report-summary-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-report-period{font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;}',
      '.jk-kb-report-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-report-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-report-actions{display:flex;align-items:center;gap:6px;}',
      '.jk-kb-report-findings{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
      '.jk-kb-report-group{display:flex;flex-direction:column;gap:4px;}',
      '.jk-kb-report-rule{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-report-rule-items{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-report-finding{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;}',
      '.jk-kb-report-path{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary);word-break:break-all;}',
      '.jk-kb-report-title{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-report-proposed{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-brand-primary);word-break:break-all;}',
      '.jk-kb-skill-view{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-skill-registry,.jk-kb-skill-calls{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-skill-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-skill-item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;font-size:12px;}',
      '.jk-kb-skill-id{font-weight:600;color:var(--dsw-alias-brand-primary);}',
      '.jk-kb-skill-name{font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-skill-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-skill-status{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-skill-keywords{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-skill-matches{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-skill-match{}',
      '.jk-kb-skill-call{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:6px 10px;font-size:12px;}',
      '.jk-kb-skill-call-time{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-skill-call-name{font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;}',
      '.jk-kb-skill-call-task{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-skill-call-reason{font-size:11px;color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-skill-call-outputs{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-experts{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-experts-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}',
      '.jk-kb-experts-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-expert-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;}',
      '.jk-kb-expert-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;}',
      '.jk-kb-expert-card-head{display:flex;align-items:baseline;gap:8px;}',
      '.jk-kb-expert-name{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-expert-domain{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-expert-responsibility{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.jk-kb-expert-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-expert-card-actions{margin-left:auto;display:flex;align-items:center;gap:6px;}',
      '.jk-kb-expert-skill-group{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;}',
      '.jk-kb-expert-skill-group-title{margin:0;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-expert-output{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-expert-dangling-list{display:flex;flex-direction:column;gap:4px;margin-top:6px;}',
      '.jk-kb-expert-dangling{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));border-radius:8px;padding:4px 8px;background:var(--dsw-alias-bg-layer-2);}',
      '.jk-kb-expert-dangling-text{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));}',
      '.jk-kb-check{display:flex;align-items:center;gap:6px;}',
      '.jk-kb-expert-skills-picker{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto;}',
      '.jk-kb-tasks-page{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-view-switch{display:flex;align-items:center;gap:6px;}',
      '.jk-kb-view-tab{font:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:4px 14px;}',
      '.jk-kb-view-tab:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-view-tab-active{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));font-weight:600;}',
      '.jk-kb-view-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-calendar{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-cal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-cal-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:96px;}',
      '.jk-kb-cal-totals{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;}',
      '.jk-kb-cal-weekday{font-size:11px;text-align:center;color:var(--dsw-alias-label-tertiary);padding:2px 0;}',
      '.jk-kb-cal-cell{min-height:58px;box-sizing:border-box;display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 6px;background:var(--dsw-alias-bg-layer-2);font:inherit;font-size:11px;text-align:left;}',
      '.jk-kb-cal-cell-blank{background:none;border-color:transparent;}',
      '.jk-kb-cal-day{cursor:pointer;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-cal-day:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-cal-day:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-cal-day-active{border-color:var(--dsw-alias-border-l2);}',
      '.jk-kb-cal-today{border:2px solid var(--dsw-alias-brand-primary);}',
      '.jk-kb-cal-selected{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-cal-day-number{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-cal-day-count{font-size:11px;color:var(--dsw-alias-brand-primary);}',
      '.jk-kb-cal-day-failed{font-size:11px;color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-cal-day-token{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
      '.jk-kb-cal-year{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;}',
      '.jk-kb-cal-month{display:flex;flex-direction:column;align-items:flex-start;gap:2px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:8px 10px;font:inherit;font-size:11px;}',
      '.jk-kb-cal-month:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-cal-month:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-cal-month-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-cal-month-failed{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-cal-month-token{color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-ledger-day{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-ledger-runs{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-ledger-run{display:flex;align-items:baseline;gap:8px;width:100%;box-sizing:border-box;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:6px 10px;font:inherit;font-size:12px;text-align:left;}',
      '.jk-kb-ledger-run:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-ledger-run:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-ledger-run-title{min-width:0;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.jk-kb-ledger-run-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-acceptance-mismatch{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));}',
      '.jk-kb-acceptance-errors{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-acceptance-error{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:6px 10px;}',
    ].join('');

    // ───────────────────────────── 风险提示清单 ─────────────────────────────
    // 设置页与 README 的措辞保持一致；13 这个数字来自 host/root-policy.js。
    const RISK_POINTS = [
      '会在该目录下创建 ' + VAULT_TOP_LEVEL_COUNT + ' 个顶层目录，并写入 <root>/.jkkb/vault.json 元数据。',
      '本插件会用 node:fs 直接读写该目录，不经过 DSH 的 workspace-write 沙箱。',
      '因此该目录不在「仅会话工作区可写」的保护范围内，写入边界由插件自身负责。',
      '已有的同名目录不会被删除，只会补写 _说明.md。',
      '请避开系统目录、家目录根、~/.dsh 以及 .ssh / Keychains 等敏感目录。',
    ];

    // ───────────────────────────── 设置页：根目录区块（展示组件，便于单测） ─────────────────────────────
    function RootSection(props) {
      const p = props || {};
      const host = p.host && typeof p.host === 'object' ? p.host : { status: 'loading', error: null };
      const settings = p.settings && typeof p.settings === 'object' ? p.settings : {};
      const savedRoot = typeof settings.root === 'string' && settings.root ? settings.root : null;
      const draftRoot = typeof p.draftRoot === 'string' ? p.draftRoot : '';
      const validation = p.validation && typeof p.validation === 'object' ? p.validation : null;
      const hostError = host.error || { code: 'host-unreachable', message: '宿主服务未连接' };
      // 有探活结果时以探活为唯一诊断来源；没有时保持旧的 host.status 行为（兼容既有调用）。
      const probe = p.probe && typeof p.probe === 'object' ? p.probe : null;
      const health = probe ? describeHealth(probe, PLUGIN_VERSION) : null;
      let hostNotice = null;
      if (health) {
        if (health.text) {
          hostNotice = {
            level: 'error',
            code: health.status === 'mismatch'
              ? 'host-version-mismatch'
              : (health.status === 'not-loaded' ? 'host-half-not-loaded' : (hostError.code || 'host-unreachable')),
            text: health.text,
          };
        } else if (host.status === 'error') {
          hostNotice = { level: 'error', code: hostError.code || 'host-unreachable', text: '读取知识库配置失败：' + (hostError.message || '无法访问插件后端') };
        }
      } else if (host.status === 'error') {
        hostNotice = {
          level: 'error',
          code: hostError.code || 'host-unreachable',
          text: '宿主服务未连接：' + (hostError.message || '无法访问插件后端，知识库设置暂不可用'),
        };
      }
      const hostLabel = health
        ? health.label
        : (host.status === 'ready' ? '宿主已连接' : (host.status === 'error' ? '宿主服务未连接' : '连接中…'));
      const hostLoading = (health ? health.status === 'loading' : false) || host.status === 'loading';
      const level = validation && validation.level ? validation.level : '';
      const summary = validation && validation.summary ? validation.summary : null;
      const writable = validation && validation.writable ? validation.writable : null;
      const picking = p.picking === true;
      const validating = p.validating === true;
      const hostReady = host.status === 'ready';

      function onDraftChange(event) {
        if (typeof p.onDraftChange === 'function') p.onDraftChange(event && event.target ? event.target.value : '');
      }
      function onAckChange(event) {
        if (typeof p.onAckChange === 'function') p.onAckChange(event && event.target ? !!event.target.checked : false);
      }

      return h('section', {
        className: 'jk-kb-card' + (p.focusActive === true ? ' jk-kb-focus-pulse' : ''),
        ref: p.sectionRef || undefined,
        'data-jk-kb-card': 'root',
        'data-jk-kb-focus': p.focusActive === true ? 'root' : undefined,
      },
        h('div', { className: 'jk-kb-section-head' },
          h('h2', { className: 'jk-kb-section-title' }, '知识库根目录'),
          h('span', {
            className: 'jk-kb-host-badge',
            'data-jk-kb-host': health ? health.status : (host.status || 'loading'),
          }, hostLabel)
        ),
        hostNotice
          ? h('p', {
              className: 'jk-kb-notice jk-kb-notice-error',
              'data-jk-kb-host-error': hostNotice.code,
            }, hostNotice.text)
          : null,
        hostLoading
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-host-loading': 'true' }, '正在连接宿主服务…')
          : null,
        h('div', { className: 'jk-kb-root-row' },
          h('span', { className: 'jk-kb-root-label' }, '当前根目录'),
          h('code', { className: 'jk-kb-path', 'data-jk-kb-root': 'saved' }, savedRoot || '未设置')
        ),
        h('div', { className: 'jk-kb-root-row' },
          h('span', { className: 'jk-kb-root-label' }, '待保存'),
          h('code', { className: 'jk-kb-path', 'data-jk-kb-root': 'draft' }, draftRoot || '尚未选择')
        ),
        h('div', { className: 'jk-kb-root-actions' },
          p.pickerAvailable === true
            ? [
                h('button', {
                  key: 'pick',
                  type: 'button',
                  className: 'jk-kb-btn',
                  'data-jk-kb-pick': 'true',
                  disabled: picking || !hostReady,
                  onClick: typeof p.onPick === 'function' ? p.onPick : undefined,
                }, picking ? '正在选择…' : '选择目录'),
                h('button', {
                  key: 'revalidate',
                  type: 'button',
                  className: 'jk-kb-btn',
                  'data-jk-kb-validate': 'true',
                  disabled: validating || !draftRoot || !hostReady,
                  onClick: typeof p.onValidate === 'function' ? p.onValidate : undefined,
                }, validating ? '校验中…' : '重新校验'),
              ]
            : [
                h('input', {
                  key: 'root-input',
                  type: 'text',
                  className: 'jk-kb-input',
                  'data-jk-kb-root-input': 'true',
                  placeholder: '/绝对/路径/知识库',
                  value: draftRoot,
                  onChange: onDraftChange,
                  disabled: !hostReady,
                }),
                h('button', {
                  key: 'root-validate',
                  type: 'button',
                  className: 'jk-kb-btn',
                  'data-jk-kb-validate': 'true',
                  disabled: validating || !hostReady,
                  onClick: typeof p.onValidate === 'function' ? p.onValidate : undefined,
                }, validating ? '校验中…' : '校验'),
              ]
        ),
        validation
          ? h('div', {
              className: 'jk-kb-validation jk-kb-validation-' + (level || 'unknown'),
              'data-jk-kb-validate-result': level || 'unknown',
            },
              h('p', { className: 'jk-kb-validation-line' },
                '校验结果：' + (level === 'ok' ? '通过' : level === 'warn' ? '通过（有风险提示）' : level === 'reject' ? '不可用' : '请求失败')),
              validation.normalized
                ? h('p', { className: 'jk-kb-validation-line' }, '规范化路径：' + validation.normalized)
                : null,
              validation.reasons && validation.reasons.length
                ? h('ul', { className: 'jk-kb-risk-list' },
                    validation.reasons.map((item, index) => h('li', {
                      key: (item && item.code) || 'reason-' + index,
                      className: 'jk-kb-risk-item',
                    }, item && item.message ? item.message : String(item))))
                : null,
              writable
                ? h('p', { className: 'jk-kb-validation-line' },
                    '可写性实测：' + (writable.ok ? '通过（已建临时文件并删除）' : '失败（' + (writable.message || 'unknown') + '）'))
                : null,
              summary
                ? h('p', { className: 'jk-kb-validation-line' },
                    '目录概要：顶层 ' + summary.topLevelCount + ' 项；' + summary.expectedDirs + ' 个目录中已有 '
                    + (summary.existingDirs ? summary.existingDirs.length : 0) + ' 个'
                    + (summary.hasVault ? '；已存在 vault.json' : ''))
                : null
            )
          : null,
        p.needsAck === true
          ? h('div', { className: 'jk-kb-risk', 'data-jk-kb-risk': 'true' },
              h('h3', { className: 'jk-kb-risk-title' }, '写入前的风险确认'),
              h('ul', { className: 'jk-kb-risk-list' },
                RISK_POINTS.map((text, index) => h('li', { key: 'risk-' + index, className: 'jk-kb-risk-item' }, text))
              ),
              h('label', { className: 'jk-kb-ack' },
                h('input', {
                  type: 'checkbox',
                  className: 'jk-kb-ack-box',
                  'data-jk-kb-ack': 'true',
                  checked: p.acknowledged === true,
                  onChange: onAckChange,
                }),
                h('span', { className: 'jk-kb-ack-text' }, RISK_ACK_TEXT)
              )
            )
          : null,
        h('p', { className: 'jk-kb-hint' },
          '知识库会以该目录为根写入自己的结构；路径变更后需要重新勾选风险确认才能保存。')
      );
    }

    // ───────────────────────────── 开关说明 tooltip ─────────────────────────────
    // 纯 reducer 便于单测：hover / focus 打开，离开 / 失焦 / Escape 关闭。
    function reduceInfoTip(open, action) {
      const act = action || {};
      if (act.type === 'hover' || act.type === 'focus' || act.type === 'open') return true;
      if (act.type === 'leave' || act.type === 'blur' || act.type === 'escape' || act.type === 'close') return false;
      if (act.type === 'toggle') return open !== true;
      return open === true;
    }

    function SwitchInfoView(props) {
      const p = props || {};
      const open = p.open === true;
      const call = (fn, arg) => { if (typeof fn === 'function') fn(arg); };
      return h('span', { className: 'jk-kb-info' },
        h('button', {
          type: 'button',
          className: 'jk-kb-info-btn',
          'data-jk-kb-info': 'true',
          'aria-label': '说明',
          'aria-expanded': open,
          // title 只作兜底：真正展示的是下面的气泡。
          title: SWITCH_HINT_TEXT,
          onMouseEnter: () => call(p.onHover),
          onMouseLeave: () => call(p.onLeave),
          onFocus: () => call(p.onFocus),
          onBlur: () => call(p.onBlur),
          onClick: () => call(p.onToggle),
          onKeyDown: (event) => {
            if (event && event.key === 'Escape') {
              if (typeof event.preventDefault === 'function') event.preventDefault();
              call(p.onEscape);
            }
          },
        },
          h('svg', {
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
            h('circle', { cx: 8, cy: 8, r: 6 }),
            h('path', { d: 'M8 7.2v4' }),
            h('path', { d: 'M8 4.9v.2' })
          )
        ),
        open
          ? h('span', { className: 'jk-kb-tooltip', 'data-jk-kb-tooltip': 'true', role: 'tooltip' }, SWITCH_HINT_TEXT)
          : null
      );
    }

    function SwitchInfo() {
      const [open, dispatch] = React.useReducer(reduceInfoTip, false);
      return SwitchInfoView({
        open: open,
        onHover: () => dispatch({ type: 'hover' }),
        onLeave: () => dispatch({ type: 'leave' }),
        onFocus: () => dispatch({ type: 'focus' }),
        onBlur: () => dispatch({ type: 'blur' }),
        onEscape: () => dispatch({ type: 'escape' }),
        onToggle: () => dispatch({ type: 'toggle' }),
      });
    }

    // ───────────────────────────── 引导卡：打开设置并聚焦根目录 ─────────────────────────────
    async function openSettingsForRoot(options) {
      const o = options || {};
      const storage = o.storage || resolveStorage();
      // 一次性标记：设置页消费后删除；写失败也不阻塞打开面板。
      try {
        if (storage && typeof storage.setItem === 'function') storage.setItem(FOCUS_KEY, 'root');
      } catch (err) { /* 隐私模式等场景忽略 */ }
      const ctx = o.ctx || pluginCtx;
      try {
        // 客户端服务门禁：必须走 ctx.get，直读 ctx.shortcuts 会被拒。
        const shortcuts = ctx && typeof ctx.get === 'function' ? ctx.get('shortcuts') : null;
        if (!shortcuts || typeof shortcuts.invoke !== 'function') {
          return { ok: false, code: 'shortcuts-unavailable', message: GUIDE_STEP_HINT };
        }
        await shortcuts.invoke('settings.open', { modal: null });
        return { ok: true };
      } catch (err) {
        return { ok: false, code: 'settings-open-failed', message: GUIDE_STEP_HINT };
      }
    }

    // 读一次即删：返回是否为 'root'（没有 key / 其它值都返回 false）。
    function consumeFocusFlag(storage, key) {
      const store_ = storage || resolveStorage();
      const target = typeof key === 'string' ? key : FOCUS_KEY;
      try {
        if (!store_ || typeof store_.getItem !== 'function') return false;
        const value = store_.getItem(target);
        if (value === null || value === undefined) return false;
        try {
          if (typeof store_.removeItem === 'function') store_.removeItem(target);
        } catch (err) { /* 删除失败也不重复消费 */ }
        return String(value).trim() === 'root';
      } catch (err) {
        return false;
      }
    }

    // 2px 品牌色描边 + 两次淡出（约 2.5s）；测试可注入 timer。
    function startFocusHighlight(element, options) {
      const o = options || {};
      const env = typeof globalThis !== 'undefined' ? globalThis : {};
      const setTimer = o.setTimeout || env.setTimeout || null;
      const clearTimer = o.clearTimeout || env.clearTimeout || null;
      const onEnd = typeof o.onEnd === 'function' ? o.onEnd : null;
      if (!element) return { active: false, stop: function () {} };
      try {
        if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
      } catch (err) { /* 滚动失败不影响高亮 */ }
      let handle = null;
      if (typeof setTimer === 'function') {
        handle = setTimer(function () {
          handle = null;
          if (onEnd) {
            try { onEnd(); } catch (err) { /* 忽略 */ }
          }
        }, typeof o.durationMs === 'number' ? o.durationMs : FOCUS_HIGHLIGHT_MS);
      }
      return {
        active: true,
        stop: function () {
          if (handle !== null && typeof clearTimer === 'function') {
            try { clearTimer(handle); } catch (err) { /* 忽略 */ }
          }
          handle = null;
        },
      };
    }

    // ───────────────────────────── 主页面引导态 ─────────────────────────────
    function GuidancePage(props) {
      const p = props || {};
      const unavailable = p.reason === 'host-unreachable';
      const error = p.error && typeof p.error === 'object' ? p.error : null;
      const onOpenSettings = typeof p.onOpenSettings === 'function' ? p.onOpenSettings : null;
      const hint = typeof p.hint === 'string' ? p.hint : '';

      if (unavailable) {
        return h('div', {
          className: 'jk-kb-guidance',
          'data-jk-kb-guidance': 'host-unreachable',
        },
          h('h2', { className: 'jk-kb-placeholder-title' }, '宿主服务未连接'),
          h('p', { className: 'jk-kb-hint' },
            '无法访问插件后端（/plugins/jk-knowledge-base/health 无响应），知识库功能暂不可用。请确认 DSH 已重启并加载了本插件的宿主半。'),
          error ? h('p', { className: 'jk-kb-note' }, '详情：' + (error.code || 'unknown') + ' ' + (error.message || '')) : null,
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-host-retry': 'true',
            onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
          }, '重试')
        );
      }

      return h('div', {
        className: 'jk-kb-guidance jk-kb-guide-card',
        'data-jk-kb-guidance': 'no-root',
      },
        h('h2', { className: 'jk-kb-guide-title' }, '还没有配置知识库根目录'),
        h('ol', { className: 'jk-kb-guide-steps' },
          GUIDE_STEPS.map((step) => h('li', { key: step.id, className: 'jk-kb-guide-step-item' },
            h('button', {
              type: 'button',
              className: 'jk-kb-guide-step',
              'data-jk-kb-guide-step': step.id,
              onClick: onOpenSettings || undefined,
            },
              h('span', { className: 'jk-kb-guide-index' }, step.index),
              h('span', { className: 'jk-kb-guide-step-title' }, step.title),
              h('span', { className: 'jk-kb-guide-arrow', 'aria-hidden': 'true' }, '›')
            )
          ))
        ),
        h('button', {
          type: 'button',
          className: 'jk-kb-save jk-kb-guide-cta',
          'data-jk-kb-guide-open-settings': 'true',
          onClick: onOpenSettings || undefined,
        }, '去设置里设置根目录'),
        h('p', { className: 'jk-kb-guide-footnote' }, '配置完成后本页自动切换成仪表盘，不会白屏。'),
        hint
          ? h('p', {
              className: 'jk-kb-notice jk-kb-notice-error',
              'data-jk-kb-guide-hint': 'true',
              'aria-live': 'polite',
            }, hint)
          : null,
        error ? h('p', { className: 'jk-kb-note' }, '详情：' + (error.code || 'unknown') + ' ' + (error.message || '')) : null
      );
    }

    // 未配根目录时的仪表盘骨架：细引导条 + 四张卡骨架 + recent/runtime 骨架。
    // 纯 CSS 呼吸动画（respect prefers-reduced-motion），不挂任何 JS 定时器。
    function DashboardSkeleton(props) {
      const p = props || {};
      const row = (key, marker) => h('div', { key: key, className: 'jk-kb-skel-row', [marker]: 'true' },
        h('span', { className: 'jk-kb-skel-bar jk-kb-skel-bar-sm' }),
        h('span', { className: 'jk-kb-skel-bar jk-kb-skel-bar-md' })
      );
      return h('div', {
        className: 'jk-kb-dash jk-kb-skeleton',
        'data-jk-kb-skeleton': 'dashboard',
        'data-jk-kb-guidance': 'no-root',
      },
        h('div', { className: 'jk-kb-guide-bar', 'data-jk-kb-guide-bar': 'no-root' },
          h('span', { className: 'jk-kb-guide-bar-text' }, '还没有配置知识库根目录'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn jk-kb-guide-bar-action',
            'data-jk-kb-guide-bar-open-settings': 'true',
            'data-jk-kb-guide-open-settings': 'true',
            onClick: typeof p.onOpenSettings === 'function' ? p.onOpenSettings : undefined,
          }, '去设置')
        ),
        typeof p.hint === 'string' && p.hint
          ? h('p', { className: 'jk-kb-notice jk-kb-notice-error', 'data-jk-kb-guide-hint': 'true' }, p.hint)
          : null,
        h('div', { className: 'jk-kb-stats' },
          ['entries', 'weekly', 'today', 'skills'].map((id) => h('div', {
            key: id,
            className: 'jk-kb-stat jk-kb-skel-card',
            'data-jk-kb-skeleton-card': id,
          },
            h('span', { className: 'jk-kb-skel-bar jk-kb-skel-bar-sm' }),
            h('span', { className: 'jk-kb-skel-bar jk-kb-skel-bar-lg' })
          ))
        ),
        h('div', { className: 'jk-kb-dash-columns' },
          h('section', { className: 'jk-kb-block' },
            h('h2', { className: 'jk-kb-section-title' }, '最近入库'),
            h('div', { className: 'jk-kb-skel-list', 'data-jk-kb-skeleton-recent': 'true' },
              [0, 1, 2].map((index) => row('recent-' + index, 'data-jk-kb-skeleton-recent-row'))
            )
          ),
          h('section', { className: 'jk-kb-block' },
            h('h2', { className: 'jk-kb-section-title' }, '运行状态'),
            h('div', { className: 'jk-kb-skel-list', 'data-jk-kb-skeleton-runtime': 'true' },
              [0, 1, 2].map((index) => row('runtime-' + index, 'data-jk-kb-skeleton-runtime-row'))
            )
          )
        )
      );
    }

    // 右栏分发：配置读取中 → 读配置；host 不可用 → 提示未连接；未配置根目录 → 引导；
    // 已配置 → 当前菜单的页面（仪表盘 / 任务列表 / 任务详情，其余菜单自动落占位页）。
    // 注意：任务页内部有 hooks，必须以元素形式（h(Component)）挂载，不能当普通函数调用。
    function PanelContent(props) {
      const p = props || {};
      const activeMenu = p.activeMenu || MENUS[0];
      if (p.rootStatus === 'loading') {
        return h('p', { className: 'jk-kb-hint', 'data-jk-kb-root-loading': 'true' }, '正在读取知识库配置…');
      }
      if (p.rootStatus === 'error') {
        return GuidancePage({ reason: 'host-unreachable', error: p.error, onRetry: p.onRetryHost });
      }
      if (!p.root) {
        // 未配根目录：保留完整布局的骨架（不挂 Dashboard/Tasks 等会发请求的组件）。
        return DashboardSkeleton({ onOpenSettings: p.onOpenSettings, hint: p.guideHint });
      }
      if (activeMenu.id === DASHBOARD_ID) return h(DashboardPage, { 'data-jk-kb-dashboard': 'true' });
      if (activeMenu.id === EXPERTS_ID) return h(ExpertsPage, null);
      if (activeMenu.id === TASKS_ID) {
        if (p.selectedRunId) {
          return h(RunDetailPage, { runId: p.selectedRunId, onBack: p.onBack });
        }
        return h(TasksPage, { onOpenRun: p.onOpenRun, seedFeed: p.runsFeed, onFeed: p.onFeed });
      }
      return PlaceholderPage(activeMenu);
    }

    // ───────────────────────────── 设置页 ─────────────────────────────
    function SettingsSection() {
      const [state, setLocal] = React.useState(() => store.get());
      const [notice, setNotice] = React.useState({ kind: '', text: '' });
      const [host, setHost] = React.useState({ status: 'loading', settings: null, discovery: null, error: null });
      const [probe, setProbe] = React.useState({ status: 'loading', version: '', error: null });
      const [draftRoot, setDraftRoot] = React.useState('');
      const [validation, setValidation] = React.useState(null);
      const [picking, setPicking] = React.useState(false);
      const [validating, setValidating] = React.useState(false);
      const [acknowledged, setAcknowledged] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [focusActive, setFocusActive] = React.useState(false);
      const rootSectionRef = React.useRef ? React.useRef(null) : { current: null };
      const enabled = isEnabled(state);
      const settings = host.settings || {};
      const hostReady = host.status === 'ready';
      const needsAck = needsRiskAck(draftRoot, settings);
      const saveEnabled = canSave({
        hostReady: hostReady,
        saving: saving,
        draftRoot: draftRoot,
        validation: validation,
        needsAck: needsAck,
        acknowledged: acknowledged,
      });

      React.useEffect(() => {
        let alive = true;
        // 入口探活：唯一一处宿主健康诊断（404 / 版本不一致 / 网络不通）。
        probeHost().then((result) => { if (alive) setProbe(result); });
        loadHostConfig().then((result) => { if (alive) applyHostResult(result); });
        return () => { alive = false; };
      }, []);

      // 引导卡写入的 focus 标记：一次性消费 → 滚动到根目录区块 + 高亮约 2.5s。
      React.useEffect(() => {
        let highlight = null;
        if (consumeFocusFlag(resolveStorage())) {
          highlight = startFocusHighlight(rootSectionRef.current, {
            onEnd: () => setFocusActive(false),
          });
          if (highlight.active) setFocusActive(true);
        }
        return () => { if (highlight) highlight.stop(); };
      }, []);

      function applyHostResult(result) {
        if (result && result.ok === true) {
          const next = result.settings && typeof result.settings === 'object' ? result.settings : {};
          setHost({ status: 'ready', settings: next, discovery: result.discovery || null, error: null });
          setDraftRoot(typeof next.root === 'string' ? next.root : '');
          setValidation(null);
          setAcknowledged(false);
          return;
        }
        setHost({
          status: 'error',
          settings: null,
          discovery: null,
          error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
        });
      }

      async function runValidate(target) {
        const value = typeof target === 'string' ? target : draftRoot;
        if (!value || !value.trim()) {
          setValidation({
            ok: false,
            level: 'reject',
            reasons: [{ code: 'root-empty', message: '请先选择或填写目录' }],
            writable: null,
            summary: null,
          });
          return;
        }
        setValidating(true);
        const result = await validateRoot(value);
        setValidating(false);
        if (!result || (result.error && typeof result.level !== 'string')) {
          setValidation({
            ok: false,
            level: 'error',
            reasons: [{
              code: (result && result.error && result.error.code) || 'host-unreachable',
              message: (result && result.error && result.error.message) || '宿主服务未连接',
            }],
            writable: null,
            summary: null,
          });
          return;
        }
        setValidation({
          ok: result.ok === true,
          level: typeof result.level === 'string' ? result.level : (result.ok === true ? 'ok' : 'reject'),
          reasons: Array.isArray(result.reasons) ? result.reasons : [],
          normalized: typeof result.normalized === 'string' ? result.normalized : '',
          writable: result.writable || null,
          summary: result.summary || null,
        });
      }

      async function onPick() {
        setPicking(true);
        const picked = await pickDirectory();
        setPicking(false);
        if (!picked) return;
        setDraftRoot(picked);
        setAcknowledged(false);
        await runValidate(picked);
      }

      function onToggle() {
        const next = { enabled: !enabled };
        const saved = persistState(resolveStorage(), next);
        if (!saved.ok) {
          setNotice({ kind: 'error', text: '保存失败：浏览器存储不可用，开关未生效' });
          return;
        }
        setLocal(saved.state);
        // 通知 apply()：立刻按新状态注册 / 释放侧边栏与主区域两个席位。
        store.set(saved.state);
        setNotice({
          kind: 'ok',
          text: saved.state.enabled ? '已开启：侧边栏「插件」下方出现「知识库」' : '已关闭：「知识库」菜单与页面已移除',
        });
      }

      async function onSave() {
        if (!saveEnabled) return;
        setSaving(true);
        const result = await saveRoot(draftRoot, true);
        setSaving(false);
        if (result && result.ok === true) {
          const savedSettings = result.settings && typeof result.settings === 'object' ? result.settings : {};
          setHost({ status: 'ready', settings: savedSettings, discovery: null, error: null });
          setDraftRoot(typeof savedSettings.root === 'string' ? savedSettings.root : draftRoot);
          setValidation(null);
          setAcknowledged(false);
          setNotice({ kind: 'ok', text: '已保存：' + (savedSettings.root || draftRoot) });
          return;
        }
        setNotice({ kind: 'error', text: '保存失败：' + describeHostError(result) });
      }

      return h('div', {
        className: 'jk-kb-root',
        'data-jk-kb-settings': 'true',
        'data-jk-kb-enabled': enabled ? 'on' : 'off',
      },
        h('style', { dangerouslySetInnerHTML: { __html: SETTINGS_STYLE } }),
        h('header', { className: 'jk-kb-head' },
          h('div', null,
            h('h1', { className: 'jk-kb-title' }, PLUGIN_NAME),
            h('p', { className: 'jk-kb-subtitle' }, '知识库入口开关、根目录与插件信息。')
          )
        ),
        h('section', { className: 'jk-kb-card', 'data-jk-kb-card': 'switch' },
          h('div', { className: 'jk-kb-switch-row' },
            h('span', { className: 'jk-kb-switch-label', id: 'jk-kb-switch-label' }, '启动JK知识库'),
            h(SwitchInfo, null),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': enabled,
              'aria-labelledby': 'jk-kb-switch-label',
              className: 'jk-kb-switch' + (enabled ? ' jk-kb-switch-on' : ''),
              'data-jk-kb-switch': enabled ? 'on' : 'off',
              onClick: onToggle,
            },
              h('span', { className: 'jk-kb-switch-track' },
                h('span', { className: 'jk-kb-switch-thumb' })
              ),
              h('span', { className: 'jk-kb-switch-state' }, enabled ? '已开启' : '已关闭')
            )
          )
        ),
        RootSection({
          host: host,
          probe: probe,
          settings: settings,
          draftRoot: draftRoot,
          validation: validation,
          needsAck: needsAck,
          acknowledged: acknowledged,
          sectionRef: rootSectionRef,
          focusActive: focusActive,
          pickerAvailable: hasDirectoryPicker(),
          picking: picking,
          validating: validating,
          onPick: onPick,
          onValidate: () => runValidate(draftRoot),
          onDraftChange: (value) => {
            setDraftRoot(value);
            setAcknowledged(false);
            setValidation(null);
          },
          onAckChange: (value) => setAcknowledged(value === true),
        }),
        notice.kind
          ? h('p', {
              className: 'jk-kb-notice jk-kb-notice-' + notice.kind,
              'data-jk-kb-notice': notice.kind,
              'aria-live': 'polite',
            }, notice.text)
          : null,
        h('footer', { className: 'jk-kb-footer' },
          h('button', {
            type: 'button',
            className: 'jk-kb-save',
            'data-jk-kb-save': 'true',
            disabled: !saveEnabled,
            onClick: onSave,
          }, saving ? '保存中…' : '保存'),
          h('div', { className: 'jk-kb-meta', 'data-jk-kb-meta': 'true' },
            h('span', {
              className: 'jk-kb-meta-version',
              'data-jk-kb-version': PLUGIN_VERSION,
            }, PLUGIN_NAME + ' v' + PLUGIN_VERSION),
            h('span', {
              className: 'jk-kb-meta-author',
              'data-jk-kb-author': PLUGIN_AUTHOR,
            }, '作者 ' + PLUGIN_AUTHOR)
          )
        )
      );
    }

    // ───────────────────────────── 仪表盘（真实数据来自 GET /dashboard） ─────────────────────────────
    function DashboardPage() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const [registryCount, setRegistryCount] = React.useState(null);
      const [reload, setReload] = React.useState(0);

      React.useEffect(function () {
        let alive = true;
        setState((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchDashboard().then((result) => {
          if (!alive) return;
          const norm = normalizeDashboardResponse(result);
          setState(norm.ok === true
            ? { phase: 'ready', data: norm.data, error: null }
            : { phase: 'error', data: null, error: norm.error });
        });
        fetchSkillRegistry({ limit: 100 }).then((result) => {
          if (!alive) return;
          const norm = normalizeRegistryResponse(result);
          setRegistryCount(norm.ok === true ? norm.skills.length : null);
        });
        return function () { alive = false; };
      }, [reload]);

      return DashboardView({
        phase: state.phase,
        data: state.data,
        error: state.error,
        registryCount: registryCount,
        onRefresh: () => setReload(reload + 1),
        onRetry: () => setReload(reload + 1),
      });
    }

    function DashboardView(props) {
      const p = props || {};
      const phase = p.phase || 'loading';
      const data = p.data && typeof p.data === 'object' ? p.data : null;
      const error = p.error && typeof p.error === 'object' ? p.error : null;
      const registryCount = typeof p.registryCount === 'number' ? p.registryCount : null;

      const header = h('div', { className: 'jk-kb-dash-head' },
        h('div', null,
          h('h2', { className: 'jk-kb-section-title' }, '仪表盘'),
          data && data.generatedAtText && data.generatedAtText !== '—'
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-dashboard-generated': 'true' }, '生成于 ' + data.generatedAtText)
            : null
        ),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-dashboard-refresh': 'true',
          disabled: phase === 'loading',
          onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
        }, phase === 'loading' ? '加载中…' : '刷新')
      );

      const errorBox = phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-dashboard-error': 'true' },
            h('h3', { className: 'jk-kb-placeholder-title' }, '仪表盘数据不可用'),
            h('p', { className: 'jk-kb-hint' }, '无法读取仪表盘（' + HOST_DASHBOARD_PATH + '）。'),
            error
              ? h('p', { className: 'jk-kb-note' }, '详情：' + (error.code || 'unknown') + ' ' + (error.message || ''))
              : null,
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-dashboard-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      if (phase !== 'ready' || !data) {
        return h('div', { className: 'jk-kb-dash', 'data-jk-kb-dashboard': 'true', 'data-jk-kb-dashboard-phase': phase },
          header,
          errorBox,
          phase === 'loading'
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-dashboard-loading': 'true' }, '正在读取仪表盘…')
            : null
        );
      }

      const counts = data.counts;
      const weekValue = counts.weekAdded !== null ? counts.weekAdded : data.weekAddedEstimate;
      const customSkillText = registryCount === null ? '内置 ' + BUILTIN_SKILL_COUNT : '内置 ' + BUILTIN_SKILL_COUNT + ' · 自定义 ' + registryCount;
      const truncatedBadge = counts.truncated
        ? h('span', { className: 'jk-kb-truncated', 'data-jk-kb-truncated': 'true' }, '已截断')
        : null;
      const cards = [
        { id: 'entries', label: '知识条目', value: formatTokenCount(counts.notes), hint: counts.dirs + ' 个顶层目录' },
        { id: 'weekly', label: '本周新增', value: String(weekValue), hint: counts.weekAdded !== null ? '宿主统计' : '按最近入库估算（近 7 天）' },
        { id: 'today', label: '今日任务', value: String(data.today.runs), hint: '完成 ' + data.today.completed + ' · 失败 ' + data.today.failed },
        { id: 'skills', label: '技能数', value: String(BUILTIN_SKILL_COUNT + (registryCount || 0)), hint: customSkillText },
      ];

      const stats = h('div', { className: 'jk-kb-stats' },
        cards.map((card) => h('div', {
          key: card.id,
          className: 'jk-kb-stat',
          'data-jk-kb-stat': card.id,
        },
          h('div', { className: 'jk-kb-stat-head' },
            h('span', { className: 'jk-kb-stat-label' }, card.label),
            truncatedBadge
          ),
          h('span', { className: 'jk-kb-stat-value' }, card.value),
          h('span', { className: 'jk-kb-stat-hint' }, card.hint)
        ))
      );

      const emptyNote = counts.notes === 0 && data.recent.length === 0
        ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-dashboard-empty': 'true' }, '还没有内容')
        : null;

      const recentBlock = h('section', { className: 'jk-kb-block', 'data-jk-kb-block': 'recent' },
        h('h2', { className: 'jk-kb-section-title' }, '最近入库'),
        data.recent.length > 0
          ? h('ul', { className: 'jk-kb-list' },
              data.recent.map((item) => h('li', {
                key: item.key,
                className: 'jk-kb-list-item jk-kb-recent-item',
                'data-jk-kb-recent': item.relPath || item.key,
              },
                h('span', { className: 'jk-kb-list-title' }, item.title),
                h('span', { className: 'jk-kb-list-meta' }, item.relPath + ' · ' + item.updatedAtText),
                h('button', {
                  type: 'button',
                  className: 'jk-kb-btn jk-kb-recent-copy',
                  'data-jk-kb-recent-copy': item.relPath || item.key,
                  disabled: !item.relPath,
                  onClick: () => copyToClipboard(item.relPath),
                }, '复制路径')
              ))
            )
          : h('p', { className: 'jk-kb-hint', 'data-jk-kb-recent-empty': 'true' }, '还没有内容')
      );

      const runtimeRows = [
        ['root', '根目录', data.runtime.root || '—'],
        ['mode', '模式', data.runtime.mode || '—'],
        ['vault', 'vault 更新', data.runtime.vaultUpdatedAtText],
        ['lastRun', '最近一次 run', data.runtime.lastRun
          ? data.runtime.lastRun.title + ' · ' + data.runtime.lastRun.statusLabel + ' · ' + data.runtime.lastRun.elapsedText
          : '还没有 run'],
        ['running', '运行中', String(data.runtime.running)],
        ['storeGuard', 'store guard', data.health.storeGuard || '—'],
        ['tools', '工具注册', data.health.toolsRegistered + ' 个（失败 ' + data.health.toolsFailed + '）'],
        ['subagents', '子代理', data.health.subagentsAvailable
          ? '可用' + (data.health.providers.length > 0 ? '（' + data.health.providers.join('、') + '）' : '')
          : '不可用'],
      ];
      const runtimeBlock = h('section', { className: 'jk-kb-block', 'data-jk-kb-block': 'runtime' },
        h('h2', { className: 'jk-kb-section-title' }, '运行状态'),
        runtimeRows.map((row) => h('div', {
          key: row[0],
          className: 'jk-kb-runtime-row',
          'data-jk-kb-runtime': row[0],
        },
          h('span', { className: 'jk-kb-runtime-key' }, row[1]),
          h('span', { className: 'jk-kb-runtime-value' }, row[2])
        ))
      );

      const lastReport = data.maintain.lastReport;
      const maintainBlock = h('section', { className: 'jk-kb-block', 'data-jk-kb-block': 'maintain' },
        h('h2', { className: 'jk-kb-section-title' }, '最近整理'),
        lastReport
          ? h('div', { className: 'jk-kb-maintain', 'data-jk-kb-maintain': 'true' },
              h('p', { className: 'jk-kb-maintain-period', 'data-jk-kb-maintain-period': 'true' }, lastReport.period),
              h('p', { className: 'jk-kb-maintain-summary', 'data-jk-kb-maintain-summary': 'true' }, lastReport.summary),
              lastReport.byRule
                ? h('p', { className: 'jk-kb-maintain-rules', 'data-jk-kb-maintain-rules': 'true' },
                    REPORT_RULE_ORDER.map((ruleId) => ruleId + '=' + numberOrZero(lastReport.byRule[ruleId])).join(' · ')
                  )
                : null
            )
          : h('p', { className: 'jk-kb-hint', 'data-jk-kb-maintain-empty': 'true' }, '还没有整理报告')
      );

      return h('div', { className: 'jk-kb-dash', 'data-jk-kb-dashboard': 'true', 'data-jk-kb-dashboard-phase': 'ready' },
        header,
        stats,
        emptyNote,
        h('div', { className: 'jk-kb-dash-columns' }, recentBlock, runtimeBlock, maintainBlock)
      );
    }

    // 将来往 MENUS 里加菜单时自动落到这里：无需改动页面分发结构。
    function PlaceholderPage(menu) {
      const label = menu && menu.label ? menu.label : '该菜单';
      const id = menu && menu.id ? menu.id : 'unknown';
      const description = menu && typeof menu.description === 'string' && menu.description
        ? menu.description
        : '「' + label + '」页面尚未实现。新增页面只需在 MENUS 数组里加一条，并在页面分发处补一个分支，'
          + '左栏菜单与任务区结构不用改。';
      return h('div', { className: 'jk-kb-placeholder', 'data-jk-kb-placeholder': id },
        h('h2', { className: 'jk-kb-placeholder-title' }, label),
        h('p', { className: 'jk-kb-hint' }, description)
      );
    }

    // ───────────────────────────── 左栏「执行任务」 ─────────────────────────────
    // 默认 TASK_LIMIT 条；超过时给「更多 / 收起」按钮，点击由父组件派发状态变更。
    function TaskList(props) {
      const view = buildTasksView(props && props.tasks, props && props.limit, props && props.expanded);
      const onToggle = props && typeof props.onToggle === 'function' ? props.onToggle : null;
      return h('section', { className: 'jk-kb-tasks', 'aria-label': '执行任务' },
        h('h2', { className: 'jk-kb-section-title' }, '执行任务'),
        h('ul', { className: 'jk-kb-task-list' },
          view.items.map((task) => h('li', {
            key: task.id,
            className: 'jk-kb-task',
            'data-jk-kb-task': task.id,
          },
            h('span', { className: 'jk-kb-task-name' }, task.name),
            h('span', { className: 'jk-kb-task-meta' }, task.meta)
          ))
        ),
        view.hasMore
          ? h('button', {
              type: 'button',
              className: 'jk-kb-more',
              'data-jk-kb-more': view.moreState,
              'aria-expanded': view.expanded,
              onClick: onToggle || undefined,
            }, view.moreLabel)
          : null
      );
    }

    // 菜单导航：按 rootStatus 过滤（no-root 只显示仪表盘），结构仍由 MENUS 驱动。
    function MenusNav(props) {
      const p = props || {};
      const menus = visibleMenus(p.rootStatus);
      const activeId = typeof p.activeId === 'string' && menus.some((menu) => menu.id === p.activeId)
        ? p.activeId
        : (menus[0] && menus[0].id);
      return h('nav', { className: 'jk-kb-menu-group', 'aria-label': '知识库菜单' },
        menus.map((menu) => h('button', {
          key: menu.id,
          type: 'button',
          className: 'jk-kb-menu' + (menu.id === activeId ? ' jk-kb-menu-active' : ''),
          'data-jk-kb-menu': menu.id,
          'aria-current': menu.id === activeId ? 'page' : 'false',
          onClick: () => { if (typeof p.onSelect === 'function') p.onSelect(menu.id); },
        }, menu.label))
      );
    }

    // 侧栏执行任务：消费面板共享的 /runs feed（不单独发请求）。
    function SidebarTasks(props) {
      const p = props || {};
      const feed = p.feed && typeof p.feed === 'object' ? p.feed : { phase: 'idle', runs: [], error: null };
      if (feed.phase === 'loading' || feed.phase === 'idle') return TaskListSkeleton();
      if (feed.phase === 'error') {
        return h('section', { className: 'jk-kb-tasks', 'data-jk-kb-sidebar-tasks': 'error', 'aria-label': '执行任务' },
          h('h2', { className: 'jk-kb-section-title' }, '执行任务'),
          h('p', { className: 'jk-kb-hint', 'data-jk-kb-sidebar-tasks-error': 'true' }, '任务列表暂不可用'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-sidebar-tasks-retry': 'true',
            onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
          }, '重试')
        );
      }
      const runs = Array.isArray(feed.runs) ? feed.runs : [];
      if (runs.length === 0) {
        return h('section', { className: 'jk-kb-tasks', 'data-jk-kb-sidebar-tasks': 'empty', 'aria-label': '执行任务' },
          h('h2', { className: 'jk-kb-section-title' }, '执行任务'),
          h('p', { className: 'jk-kb-hint', 'data-jk-kb-sidebar-tasks-empty': 'true' }, '还没有任务')
        );
      }
      const view = buildTasksView(runs, 3, p.expanded === true);
      return h('section', { className: 'jk-kb-tasks', 'data-jk-kb-sidebar-tasks': 'ready', 'aria-label': '执行任务' },
        h('h2', { className: 'jk-kb-section-title' }, '执行任务'),
        h('ul', { className: 'jk-kb-task-list' },
          view.items.map((item) => {
            const run = presentRun(item);
            return h('li', {
              key: run.id || item.id,
              className: 'jk-kb-task jk-kb-sidebar-task',
              'data-jk-kb-sidebar-task': run.id,
              role: 'button',
              tabIndex: 0,
              onClick: () => { if (typeof p.onSelectRun === 'function') p.onSelectRun(run.id); },
            },
              h('span', { className: 'jk-kb-task-name' }, run.title),
              h('span', {
                className: 'jk-kb-sidebar-task-meta',
                'data-jk-kb-sidebar-task-status': run.status,
              },
                run.status === 'running'
                  ? h('span', { className: 'jk-kb-task-heartbeat', 'aria-hidden': 'true' })
                  : null,
                h('span', { className: 'jk-kb-sidebar-task-status-label' }, run.statusLabel)
              ),
              h('span', { className: 'jk-kb-sidebar-task-time', 'data-jk-kb-sidebar-task-time': 'true' },
                formatRelativeTime(item.startedAt))
            );
          })
        ),
        view.hasMore
          ? h('button', {
              type: 'button',
              className: 'jk-kb-more',
              'data-jk-kb-more': view.moreState,
              'aria-expanded': view.expanded,
              onClick: typeof p.onToggle === 'function' ? p.onToggle : undefined,
            }, view.moreLabel)
          : null
      );
    }

    // 未配根目录时的执行任务骨架：固定 3 行，不渲染「更多/收起」。
    function TaskListSkeleton() {
      return h('section', { className: 'jk-kb-tasks', 'data-jk-kb-skeleton': 'tasks', 'aria-label': '执行任务' },
        h('h2', { className: 'jk-kb-section-title' }, '执行任务'),
        h('ul', { className: 'jk-kb-skel-tasks' },
          [0, 1, 2].map((index) => h('li', {
            key: 'skel-task-' + index,
            className: 'jk-kb-skel-task',
            'data-jk-kb-skeleton-row': String(index),
          },
            h('span', { className: 'jk-kb-skel-dot' }),
            h('span', { className: 'jk-kb-skel-bar' })
          ))
        )
      );
    }

    // ───────────────────────────── 任务看板（总视图） ─────────────────────────────
    // 容器：唯一的数据入口是 GET /runs（全量刷新，不做本地累积）。轮询由 running 驱动。
    function RunsBoardPage(props) {
      const p = props || {};
      const [state, setState] = React.useState(() => seedRunsPageState(p.seedFeed));
      const [preflight, setPreflight] = React.useState({ phase: 'idle', report: null, error: null, expanded: false });
      const [curateOpen, setCurateOpen] = React.useState(false);
      const [curateForm, setCurateForm] = React.useState({ text: '', skillId: '', expertId: '', title: '', source: '', showAllSkills: false });
      const [curateBusy, setCurateBusy] = React.useState(false);
      const [skills, setSkills] = React.useState({ phase: 'loading', groups: [], count: 0, error: null });
      const [experts, setExperts] = React.useState({ phase: 'loading', list: [], error: null });
      const [skillFormOpen, setSkillFormOpen] = React.useState(false);
      const [skillForm, setSkillForm] = React.useState({ name: '', purpose: '', scenario: '', keywords: '', fields: '' });
      const [skillAck, setSkillAck] = React.useState(false);
      const [skillBusy, setSkillBusy] = React.useState(false);
      const [skillRegistry, setSkillRegistry] = React.useState({ phase: 'loading', skills: [], error: null });
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      // 防连点：POST 未结算前不再发第二次（否则宿主只能回 409）。
      const inflightRef = React.useRef ? React.useRef(false) : { current: false };

      async function refresh() {
        const result = await fetchRuns({ limit: RUNS_PAGE_SIZE });
        if (!aliveRef.current) return;
        const norm = normalizeRunsResponse(result);
        setState((prev) => reduceRunsPage(prev, norm));
        if (typeof p.onFeed === 'function') {
          p.onFeed(norm.type === 'loaded'
            ? { phase: 'ready', runs: norm.runs, error: null }
            : { phase: 'error', runs: [], error: norm.error });
        }
      }

      // 「加载更多」：用 nextBefore 追加；失败不破坏已加载的列表。
      async function loadMore() {
        if (state.nextBefore === null || state.loadingMore === true) return;
        const before = state.nextBefore;
        setState((prev) => reduceRunsPage(prev, { type: 'loadingMore', value: true }));
        const result = await fetchRuns({ limit: RUNS_PAGE_SIZE, before: before });
        if (!aliveRef.current) return;
        if (result && result.ok === true) {
          setState((prev) => reduceRunsPage(prev, {
            type: 'appendLoaded',
            runs: Array.isArray(result.runs) ? result.runs : [],
            nextBefore: typeof result.nextBefore === 'string' && result.nextBefore ? result.nextBefore : null,
          }));
          return;
        }
        setState((prev) => reduceRunsPage(
          reduceRunsPage(prev, { type: 'loadingMore', value: false }),
          { type: 'notice', notice: { kind: 'error', text: '加载更多失败：' + describeHostError(result) } }
        ));
      }

      // 体检一次：进页面执行一次 + 手动按钮，绝不并入 runs 轮询（没有第二条定时器链）。
      async function checkPreflight() {
        setPreflight((prev) => Object.assign({}, prev, { phase: 'loading' }));
        const result = await fetchPreflight();
        if (!aliveRef.current) return null;
        const norm = normalizePreflightResponse(result);
        const view = norm.ok === true ? presentPreflight(norm.report) : null;
        setPreflight({
          phase: norm.ok === true ? 'ready' : 'error',
          report: norm.ok === true ? norm.report : null,
          error: norm.ok === true ? null : norm.error,
          expanded: norm.ok === true && view && view.level === 'error',
        });
        return norm;
      }

      // 技能目录只取一次（失败只影响下拉，不影响页面）。
      async function loadSkills() {
        setSkills((prev) => Object.assign({}, prev, { phase: 'loading' }));
        const result = await fetchSkills();
        if (!aliveRef.current) return;
        const norm = normalizeSkillsResponse(result);
        setSkills(norm.ok === true
          ? { phase: 'ready', groups: norm.groups, count: norm.count, error: null }
          : { phase: 'error', groups: [], count: 0, error: norm.error });
      }

      async function loadExpertsForCurate() {
        setExperts((prev) => Object.assign({}, prev, { phase: 'loading' }));
        const result = await fetchExperts({ status: 'active' });
        if (!aliveRef.current) return;
        const norm = normalizeExpertsResponse(result);
        setExperts(norm.ok === true
          ? { phase: 'ready', list: norm.experts, error: null }
          : { phase: 'error', list: [], error: norm.error });
      }

      async function loadSkillRegistryForRisk() {
        setSkillRegistry((prev) => Object.assign({}, prev, { phase: 'loading' }));
        const result = await fetchSkillRegistry({ limit: 50 });
        if (!aliveRef.current) return;
        const norm = normalizeRegistryResponse(result);
        setSkillRegistry(norm.ok === true
          ? { phase: 'ready', skills: norm.skills, error: null }
          : { phase: 'error', skills: [], error: norm.error });
      }

      React.useEffect(function () {
        aliveRef.current = true;
        if (!(p.seedFeed && p.seedFeed.phase === 'ready')) refresh();
        checkPreflight();
        loadSkills();
        loadSkillRegistryForRisk();
        loadExpertsForCurate();
        return function () { aliveRef.current = false; };
      }, [p.reloadKey]);

      // 归档任务 422：把宿主 checks 塞进既有体检卡片。
      React.useEffect(function () {
        const injected = p.archiveChecks;
        if (!injected || !Array.isArray(injected.checks) || injected.checks.length === 0) return;
        setPreflight({
          phase: 'ready',
          report: {
            ok: false,
            code: injected.code || '',
            checks: injected.checks,
            counts: null,
            freeBytes: null,
            elapsedMs: null,
          },
          error: null,
          expanded: true,
        });
      }, [p.archiveChecks]);

      function setSkillField(field, value) {
        setSkillForm((prev) => Object.assign({}, prev, { [field]: value }));
        setSkillAck(false);
      }

      async function submitSkill() {
        const validation = validateSkillForm(skillForm);
        if (validation.ok !== true || skillBusy) return;
        const risk = decideSkillCreate(skillForm, skillRegistry.skills);
        if (risk.action !== 'ok' && skillAck !== true) return;
        setSkillBusy(true);
        const outcome = await startSkillRequest(skillForm, { confirmed: risk.action !== 'ok' && skillAck === true });
        if (!aliveRef.current) return;
        setSkillBusy(false);
        if (outcome && outcome.started === true) {
          setSkillFormOpen(false);
          setSkillForm({ name: '', purpose: '', scenario: '', keywords: '', fields: '' });
          setSkillAck(false);
          setState((prev) => reduceRunsPage(prev, {
            type: 'notice',
            notice: { kind: 'ok', text: '已提交新建技能，正在刷新…' },
          }));
          await refresh();
          await loadSkillRegistryForRisk();
          return;
        }
        if (outcome && Array.isArray(outcome.checks) && outcome.checks.length > 0) {
          setPreflight({
            phase: 'ready',
            report: { ok: false, code: outcome.code || '', checks: outcome.checks, counts: null, freeBytes: null, elapsedMs: null },
            error: null,
            expanded: true,
          });
        }
        setState((prev) => reduceRunsPage(prev, {
          type: 'notice',
          notice: { kind: 'error', text: (outcome && outcome.message) || '新建技能失败' },
        }));
      }

      function requestMaintain() {
        setState((prev) => reduceRunsPage(prev, { type: 'confirm', kind: 'maintain' }));
      }

      async function confirmMaintain() {
        if (inflightRef.current) return;
        inflightRef.current = true;
        setState((prev) => reduceRunsPage(
          reduceRunsPage(prev, { type: 'confirm', kind: '' }),
          { type: 'busy', busy: true }
        ));
        let outcome = null;
        try {
          outcome = await startMaintainRequest();
        } finally {
          inflightRef.current = false;
        }
        if (!aliveRef.current) return;
        setState((prev) => reduceRunsPage(prev, { type: 'busy', busy: false }));
        if (outcome && outcome.started === true) {
          setState((prev) => reduceRunsPage(prev, {
            type: 'notice',
            notice: { kind: 'ok', text: '已开始整理（只读扫描），正在刷新任务列表…' },
          }));
          await refresh();
          return;
        }
        if (outcome && Array.isArray(outcome.checks) && outcome.checks.length > 0) {
          setPreflight({
            phase: 'ready',
            report: { ok: false, code: outcome.code || '', checks: outcome.checks, counts: null, freeBytes: null, elapsedMs: null },
            error: null,
            expanded: true,
          });
        }
        setState((prev) => reduceRunsPage(prev, {
          type: 'notice',
          notice: { kind: 'error', text: (outcome && outcome.message) || '整理启动失败' },
        }));
      }

      function setCurateField(field, value) {
        setCurateForm((prev) => Object.assign({}, prev, { [field]: value }));
      }

      async function submitCurate() {
        if (!canSubmitCurate(curateForm, curateBusy)) return;
        setCurateBusy(true);
        const outcome = await startCurateRequest(curateForm);
        if (!aliveRef.current) return;
        setCurateBusy(false);
        const plan = planCurateResult(outcome);
        if (plan.expandChecks) {
          setPreflight({
            phase: 'ready',
            report: {
              ok: false,
              code: (outcome && outcome.code) || '',
              checks: outcome.checks,
              counts: null,
              freeBytes: null,
              elapsedMs: null,
            },
            error: null,
            expanded: true,
          });
        }
        setState((prev) => reduceRunsPage(prev, { type: 'notice', notice: plan.notice }));
        if (plan.closeForm) {
          setCurateOpen(false);
          setCurateForm({ text: '', skillId: '', expertId: '', title: '', source: '', showAllSkills: false });
        }
        if (plan.refresh) await refresh();
      }

      usePollingEffect(refresh, shouldPollRunsPage(state));

      async function onRunKind(kind) {
        // 建库第一次点击：先跑 preflight，error 直接拦下（不发 POST），warn 放行。
        if (kind === 'bootstrap' && state.confirm !== 'bootstrap') {
          if (inflightRef.current) return;
          inflightRef.current = true;
          let gate = null;
          try {
            gate = await beginBootstrap({ checkPreflight: checkPreflight });
          } finally {
            inflightRef.current = false;
          }
          if (!aliveRef.current) return;
          if (gate && gate.proceed !== true) {
            setPreflight((prev) => Object.assign({}, prev, { expanded: true }));
            setState((prev) => reduceRunsPage(prev, {
              type: 'notice',
              notice: { kind: 'error', text: '环境体检未通过：请先按下面的提示处理后再开始建库。' },
            }));
            return;
          }
          const pre = gate ? gate.preflight : null;
          if (pre && pre.ok === false) {
            setState((prev) => reduceRunsPage(prev, {
              type: 'notice',
              notice: {
                kind: 'error',
                text: '体检不可用，已跳过预检（' + ((pre.error && pre.error.message) || '宿主服务未连接') + '）',
              },
            }));
          }
          setState((prev) => reduceRunsPage(prev, { type: 'confirm', kind: 'bootstrap' }));
          return;
        }
        if (inflightRef.current) return;
        inflightRef.current = true;
        setState((prev) => reduceRunsPage(prev, { type: 'busy', busy: true }));
        let outcome = null;
        try {
          outcome = await startRunRequest({ kind: kind, confirmed: true });
        } finally {
          inflightRef.current = false;
        }
        if (!aliveRef.current) return;
        setState((prev) => reduceRunsPage(
          reduceRunsPage(prev, { type: 'busy', busy: false }),
          { type: 'confirm', kind: '' }
        ));
        if (outcome && outcome.started === true) {
          setState((prev) => reduceRunsPage(prev, {
            type: 'notice',
            notice: { kind: 'ok', text: '「' + runKindActionLabel(kind) + '」已启动，正在刷新任务列表…' },
          }));
          await refresh();
          return;
        }
        // 422 等失败带 checks 时，原样铺到体检卡片里（宿主 message 优先，不另编文案）。
        if (outcome && Array.isArray(outcome.checks) && outcome.checks.length > 0) {
          setPreflight({
            phase: 'ready',
            report: { ok: false, code: outcome.code || '', checks: outcome.checks, counts: null, freeBytes: null, elapsedMs: null },
            error: null,
            expanded: true,
          });
        }
        setState((prev) => reduceRunsPage(prev, {
          type: 'notice',
          notice: { kind: 'error', text: (outcome && outcome.message) || '请求失败' },
        }));
      }

      return RunsBoardView({
        phase: state.phase,
        runs: presentRuns(state.runs, p.now),
        error: state.error,
        busy: state.busy,
        confirm: state.confirm,
        notice: state.notice,
        onOpenRun: p.onOpenRun,
        onRunKind: onRunKind,
        onConfirm: () => onRunKind('bootstrap'),
        onCancelConfirm: () => setState((prev) => reduceRunsPage(prev, { type: 'confirm', kind: '' })),
        onRetry: refresh,
        curateOpen: curateOpen,
        curateForm: curateForm,
        curateBusy: curateBusy,
        skills: skills,
        experts: experts,
        onCurateOpen: () => setCurateOpen(true),
        onCurateClose: () => { setCurateOpen(false); setCurateBusy(false); },
        onCurateField: setCurateField,
        onCurateSubmit: submitCurate,
        onMaintainOpen: requestMaintain,
        onMaintainConfirm: confirmMaintain,
        onMaintainCancel: () => setState((prev) => reduceRunsPage(prev, { type: 'confirm', kind: '' })),
        skillFormOpen: skillFormOpen,
        skillForm: skillForm,
        skillAck: skillAck,
        skillBusy: skillBusy,
        skillRegistry: skillRegistry,
        onSkillCreateOpen: () => setSkillFormOpen(true),
        onSkillCreateClose: () => { setSkillFormOpen(false); setSkillBusy(false); },
        onSkillField: setSkillField,
        onSkillAck: (checked) => setSkillAck(checked === true),
        onSkillSubmit: submitSkill,
        nextBefore: state.nextBefore,
        loadingMore: state.loadingMore,
        onLoadMore: loadMore,
        preflight: preflight,
        onRecheck: checkPreflight,
        onTogglePreflight: () => setPreflight((prev) => Object.assign({}, prev, { expanded: prev.expanded !== true })),
      });
    }

    // 展示组件：纯 props → 元素树，测试直接调用即可断言（不依赖 hooks）。
    function RunsBoardView(props) {
      const p = props || {};
      const phase = p.phase || 'loading';
      const runs = Array.isArray(p.runs) ? p.runs : [];
      const busy = p.busy === true;
      const notice = p.notice && p.notice.kind ? p.notice : null;
      const confirming = p.confirm === 'bootstrap';
      const maintainConfirming = p.confirm === 'maintain';
      const error = p.error && typeof p.error === 'object' ? p.error : null;
      const preflight = p.preflight && typeof p.preflight === 'object'
        ? p.preflight
        : { phase: 'idle', report: null, error: null, expanded: false };
      const pf = preflight.report ? presentPreflight(preflight.report) : null;
      const curateForm = p.curateForm && typeof p.curateForm === 'object'
        ? p.curateForm
        : { text: '', skillId: '', title: '', source: '' };
      const skills = p.skills && typeof p.skills === 'object'
        ? p.skills
        : { phase: 'loading', groups: [], count: 0 };
      const curateExperts = p.experts && p.experts.phase === 'ready' && Array.isArray(p.experts.list)
        ? p.experts.list
        : [];
      const curateExpert = curateExperts.filter((expert) => expert.id === curateForm.expertId)[0] || null;
      const curateShowAll = curateForm.showAllSkills === true;
      const allCurateGroups = Array.isArray(skills.groups) ? skills.groups : [];
      const curateSkillGroups = curateExpert && !curateShowAll
        ? filterSkillGroupsByIds(allCurateGroups, curateExpert.skillIds)
        : allCurateGroups;
      const curateSkillWarning = !!(curateExpert && curateForm.skillId
        && (curateExpert.skillIds || []).indexOf(curateForm.skillId) < 0);
      const curateSkillPresent = curateSkillGroups.some((group) => (group.skills || []).some((skill) => skill.id === curateForm.skillId));
      const curateText = typeof curateForm.text === 'string' ? curateForm.text : '';
      const curateCanSubmit = canSubmitCurate(curateForm, p.curateBusy === true);
      const pfPhase = preflight.phase || 'idle';
      const pfTone = pfPhase === 'loading'
        ? 'loading'
        : (pfPhase === 'error' ? 'unavailable' : (pf ? pf.level : 'idle'));
      const pfText = pfPhase === 'loading'
        ? '体检中…'
        : (pfPhase === 'error' ? '体检不可用' : (pf ? pf.label : '—'));

      const actions = h('div', { className: 'jk-kb-run-actions' },
        RUN_KINDS.map((kind) => h('button', {
          key: kind.id,
          type: 'button',
          className: 'jk-kb-btn' + (kind.id === 'bootstrap' ? ' jk-kb-btn-primary' : ''),
          'data-jk-kb-run-action': kind.id,
          disabled: busy,
          onClick: () => { if (typeof p.onRunKind === 'function') p.onRunKind(kind.id); },
        }, kind.action)),
        h('button', {
          key: 'curate',
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-curate-open': 'true',
          disabled: busy,
          onClick: typeof p.onCurateOpen === 'function' ? p.onCurateOpen : undefined,
        }, '入柜'),
        h('button', {
          key: 'maintain',
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-maintain-open': 'true',
          disabled: busy,
          onClick: typeof p.onMaintainOpen === 'function' ? p.onMaintainOpen : undefined,
        }, '整理'),
        h('button', {
          key: 'skill-create',
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-skill-create-open': 'true',
          disabled: busy,
          onClick: typeof p.onSkillCreateOpen === 'function' ? p.onSkillCreateOpen : undefined,
        }, '新建技能')
      );

      const preflightRow = h('div', {
        className: 'jk-kb-preflight',
        'data-jk-kb-preflight': pfTone,
        'data-jk-kb-preflight-status': pfPhase,
      },
        h('span', { className: 'jk-kb-preflight-label' }, '环境体检'),
        h('span', {
          className: 'jk-kb-preflight-summary jk-kb-preflight-' + pfTone,
          'data-jk-kb-preflight-summary': 'true',
        }, pfText),
        pf && pf.checks.length > 0
          ? h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-preflight-toggle': 'true',
              'aria-expanded': preflight.expanded === true,
              onClick: typeof p.onTogglePreflight === 'function' ? p.onTogglePreflight : undefined,
            }, preflight.expanded === true ? '收起' : '展开')
          : null,
        h('div', { className: 'jk-kb-preflight-actions' },
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-preflight-recheck': 'true',
            disabled: pfPhase === 'loading',
            onClick: typeof p.onRecheck === 'function' ? p.onRecheck : undefined,
          }, pfPhase === 'loading' ? '检查中…' : '重新检查')
        )
      );

      const preflightError = pfPhase === 'error' && preflight.error
        ? h('p', {
            className: 'jk-kb-hint',
            'data-jk-kb-preflight-error': (preflight.error && preflight.error.code) || 'host-unreachable',
          }, '体检不可用：' + ((preflight.error && preflight.error.message) || '宿主服务未连接'))
        : null;

      const preflightCard = pf && preflight.expanded === true
        ? h('div', {
            className: 'jk-kb-preflight-card',
            'data-jk-kb-preflight-card': pf.level,
          },
            h('div', { className: 'jk-kb-preflight-head' },
              h('span', null, '体检结果'),
              pf.code ? h('span', { className: 'jk-kb-preflight-code', 'data-jk-kb-preflight-code': pf.code }, pf.code) : null
            ),
            h('p', { className: 'jk-kb-preflight-meta' },
              h('span', { 'data-jk-kb-preflight-counts': 'true' }, pf.countsText),
              ' · 剩余 ',
              h('span', { 'data-jk-kb-preflight-free': 'true' }, pf.freeText),
              ' · 耗时 ',
              h('span', { 'data-jk-kb-preflight-elapsed': 'true' }, pf.elapsedText)
            ),
            pf.checks.length > 0
              ? h('ul', { className: 'jk-kb-preflight-checks', 'data-jk-kb-preflight-checks': 'true' },
                  pf.checks.map((check) => h('li', {
                    key: check.key,
                    className: 'jk-kb-check jk-kb-check-' + check.level,
                    'data-jk-kb-check': check.id || check.key,
                    'data-jk-kb-check-level': check.level,
                  },
                    h('span', { className: 'jk-kb-check-title' }, check.title),
                    h('p', { className: 'jk-kb-check-detail' }, check.detail),
                    check.fix
                      ? h('p', { className: 'jk-kb-check-fix', 'data-jk-kb-check-fix': check.id || check.key }, '修复：' + check.fix)
                      : null
                  ))
                )
              : h('p', { className: 'jk-kb-hint', 'data-jk-kb-preflight-empty': 'true' }, '宿主未返回体检明细。'),
            pf.advice
              ? h('p', { className: 'jk-kb-check-fix', 'data-jk-kb-preflight-advice': pf.code }, pf.advice)
              : null
          )
        : null;

      const skillForm = p.skillForm && typeof p.skillForm === 'object'
        ? p.skillForm
        : { name: '', purpose: '', scenario: '', keywords: '', fields: '' };
      const skillValidation = validateSkillForm(skillForm);
      const skillRegistry = p.skillRegistry && typeof p.skillRegistry === 'object'
        ? p.skillRegistry
        : { phase: 'loading', skills: [] };
      const skillRisk = decideSkillCreate(skillForm, Array.isArray(skillRegistry.skills) ? skillRegistry.skills : []);
      const skillAck = p.skillAck === true;
      const skillHasRisk = skillRisk.action !== 'ok' && String(skillForm.name == null ? '' : skillForm.name).trim().length > 0;
      const skillCanSubmit = skillValidation.ok === true
        && p.skillBusy !== true
        && (skillHasRisk ? skillAck : true);
      const skillField = (key, label) => h('label', { className: 'jk-kb-field' }, label);
      const skillInput = (key, label) => [
        skillField(key, label),
        h('input', {
          key: 'input-' + key,
          type: 'text',
          className: 'jk-kb-field-input',
          ['data-jk-kb-skill-' + key]: 'true',
          value: typeof skillForm[key] === 'string' ? skillForm[key] : '',
          onChange: (event) => {
            if (typeof p.onSkillField === 'function') {
              p.onSkillField(key, event && event.target ? event.target.value : '');
            }
          },
        }),
      ];

      const skillFormBox = p.skillFormOpen === true
        ? h('section', { className: 'jk-kb-curate jk-kb-skill-form', 'data-jk-kb-skill-form': 'true' },
            h('h3', { className: 'jk-kb-curate-title' }, '新建技能'),
            skillInput('name', '名称（必填）'),
            skillInput('purpose', '用途（必填）'),
            skillInput('scenario', '适用场景（必填）'),
            skillInput('keywords', '关键词（逗号分隔）'),
            skillInput('fields', '要记录的字段（逗号分隔）'),
            skillValidation.ok === true
              ? null
              : h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-required': 'true' },
                  '还要填写：' + skillValidation.missing.map((key) => ({ name: '名称', purpose: '用途', scenario: '适用场景' })[key] || key).join('、')),
            skillHasRisk
              ? h('div', { className: 'jk-kb-risk', 'data-jk-kb-skill-risk': skillRisk.action },
                  h('h3', { className: 'jk-kb-risk-title' }, skillRisk.action === 'duplicate' ? '已存在同名技能' : '发现相似技能'),
                  h('ul', { className: 'jk-kb-skill-matches' },
                    skillRisk.matches.map((match) => h('li', {
                      key: match.id || match.name,
                      className: 'jk-kb-skill-match',
                      'data-jk-kb-skill-match': match.id || match.name,
                    }, match.name + ' · ' + match.version + ' · 相似度 ' + match.score))),
                  h('label', { className: 'jk-kb-ack' },
                    h('input', {
                      type: 'checkbox',
                      className: 'jk-kb-ack-box',
                      'data-jk-kb-skill-ack': 'true',
                      checked: skillAck,
                      onChange: (event) => {
                        if (typeof p.onSkillAck === 'function') {
                          p.onSkillAck(event && event.target ? !!event.target.checked : false);
                        }
                      },
                    }),
                    h('span', { className: 'jk-kb-ack-text' }, '我已确认，继续创建')
                  )
                )
              : null,
            h('div', { className: 'jk-kb-curate-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save jk-kb-guide-cta',
                'data-jk-kb-skill-submit': 'true',
                disabled: !skillCanSubmit,
                onClick: typeof p.onSkillSubmit === 'function' ? p.onSkillSubmit : undefined,
              }, p.skillBusy === true ? '提交中…' : '创建技能'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-skill-cancel': 'true',
                onClick: typeof p.onSkillCreateClose === 'function' ? p.onSkillCreateClose : undefined,
              }, '取消')
            )
          )
        : null;

      const maintainConfirmBox = maintainConfirming
        ? h('div', { className: 'jk-kb-confirm', 'data-jk-kb-maintain-confirm': 'true', role: 'alertdialog' },
            h('p', { className: 'jk-kb-risk-title' }, '确认开始整理？'),
            h('p', { className: 'jk-kb-hint' }, '整理是只读扫描，不会移动或删除任何文件。'),
            h('div', { className: 'jk-kb-root-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save',
                'data-jk-kb-maintain-confirm-yes': 'true',
                disabled: busy,
                onClick: typeof p.onMaintainConfirm === 'function' ? p.onMaintainConfirm : undefined,
              }, busy ? '启动中…' : '确认整理'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-maintain-confirm-no': 'true',
                disabled: busy,
                onClick: typeof p.onMaintainCancel === 'function' ? p.onMaintainCancel : undefined,
              }, '取消')
            )
          )
        : null;

      const curateBox = p.curateOpen === true
        ? h('section', { className: 'jk-kb-curate', 'data-jk-kb-curate-form': 'true' },
            h('h3', { className: 'jk-kb-curate-title' }, '入柜'),
            h('p', { className: 'jk-kb-hint' }, '把原始信息按内置技能定型成卡片，落进知识库。'),
            h('label', { className: 'jk-kb-field' }, '原始文本（必填）'),
            h('textarea', {
              className: 'jk-kb-textarea',
              'data-jk-kb-curate-text': 'true',
              value: curateText,
              rows: 5,
              placeholder: '粘贴访谈 / 会议 / 文章 / 故障记录…',
              onChange: (event) => {
                if (typeof p.onCurateField === 'function') {
                  p.onCurateField('text', event && event.target ? event.target.value : '');
                }
              },
            }),
            curateText.trim().length > 0
              ? null
              : h('p', { className: 'jk-kb-hint', 'data-jk-kb-curate-required': 'true' }, '请先粘贴原始文本'),
            h('label', { className: 'jk-kb-field' }, '技能（可选；空 = 让 agent 自动判定）'),
            h('select', {
              className: 'jk-kb-select',
              'data-jk-kb-curate-skill': 'true',
              value: typeof curateForm.skillId === 'string' ? curateForm.skillId : '',
              onChange: (event) => {
                if (typeof p.onCurateField === 'function') {
                  p.onCurateField('skillId', event && event.target ? event.target.value : '');
                }
              },
            },
              h('option', { value: '' }, '让 agent 自动判定'),
              skills.phase === 'error'
                ? h('option', { value: '', disabled: true, 'data-jk-kb-curate-skills-unavailable': 'true' }, '技能目录不可用')
                : (skills.phase === 'loading'
                    ? h('option', { value: '', disabled: true }, '技能目录加载中…')
                    : curateSkillGroups.map((group) => h('optgroup', {
                        key: group.key,
                        label: group.label,
                        'data-jk-kb-curate-group': group.key,
                      },
                        (Array.isArray(group.skills) ? group.skills : []).map((skill) => h('option', {
                          key: skill.id,
                          value: skill.id,
                        }, skill.label))
                      )).concat(curateSkillWarning && !curateSkillPresent
                        ? [h('option', {
                            key: 'out-of-range',
                            value: curateForm.skillId,
                            'data-jk-kb-curate-skill-out-of-range': 'true',
                          }, curateForm.skillId + '（不在该专家绑定范围）')]
                        : []))
            ),
            h('label', { className: 'jk-kb-field' }, '业务专家（可选，入柜时指定由谁处理）'),
            h('select', {
              className: 'jk-kb-select',
              'data-jk-kb-curate-expert': 'true',
              value: typeof curateForm.expertId === 'string' ? curateForm.expertId : '',
              onChange: (event) => {
                if (typeof p.onCurateField === 'function') {
                  p.onCurateField('expertId', event && event.target ? event.target.value : '');
                }
              },
            },
              h('option', { value: '' }, '不指定'),
              (p.experts && p.experts.phase === 'ready' && Array.isArray(p.experts.list) && p.experts.list.length > 0)
                ? p.experts.list.map((expert) => h('option', {
                    key: expert.id,
                    value: expert.id,
                  }, expert.id + ' · ' + expert.name))
                : h('option', { value: '', disabled: true, 'data-jk-kb-curate-no-experts': 'true' }, '暂无业务专家')
            ),
            h('label', { className: 'jk-kb-check jk-kb-field' },
              h('input', {
                type: 'checkbox',
                'data-jk-kb-curate-show-all-skills': 'true',
                checked: curateShowAll,
                disabled: !curateExpert,
                onChange: (event) => {
                  if (typeof p.onCurateField === 'function') {
                    p.onCurateField('showAllSkills', !!(event && event.target && event.target.checked));
                  }
                },
              }),
              h('span', null, '显示全部技能')
            ),
            curateSkillWarning
              ? h('p', { className: 'jk-kb-notice jk-kb-notice-warning', 'data-jk-kb-curate-skill-warning': 'true' },
                  '该技能不在该专家绑定范围内（仍可提交，宿主会告警）')
              : null,
            h('label', { className: 'jk-kb-field' }, '标题（可选）'),
            h('input', {
              type: 'text',
              className: 'jk-kb-field-input',
              'data-jk-kb-curate-title': 'true',
              value: typeof curateForm.title === 'string' ? curateForm.title : '',
              onChange: (event) => {
                if (typeof p.onCurateField === 'function') {
                  p.onCurateField('title', event && event.target ? event.target.value : '');
                }
              },
            }),
            h('label', { className: 'jk-kb-field' }, '来源（可选，如「客户访谈 2026-10-17」）'),
            h('input', {
              type: 'text',
              className: 'jk-kb-field-input',
              'data-jk-kb-curate-source': 'true',
              value: typeof curateForm.source === 'string' ? curateForm.source : '',
              onChange: (event) => {
                if (typeof p.onCurateField === 'function') {
                  p.onCurateField('source', event && event.target ? event.target.value : '');
                }
              },
            }),
            h('div', { className: 'jk-kb-curate-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save jk-kb-guide-cta',
                'data-jk-kb-curate-submit': 'true',
                disabled: !curateCanSubmit,
                onClick: typeof p.onCurateSubmit === 'function' ? p.onCurateSubmit : undefined,
              }, p.curateBusy === true ? '提交中…' : '开始入柜'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-curate-cancel': 'true',
                onClick: typeof p.onCurateClose === 'function' ? p.onCurateClose : undefined,
              }, '取消')
            )
          )
        : null;

      const confirmBox = confirming
        ? h('div', { className: 'jk-kb-confirm', 'data-jk-kb-confirm': 'bootstrap', role: 'alertdialog' },
            h('p', { className: 'jk-kb-risk-title' }, '确认开始建库？'),
            h('p', { className: 'jk-kb-hint' },
              '建库会向知识库根目录写入 ' + VAULT_TOP_LEVEL_COUNT
              + ' 个顶层目录与 _说明.md。已有的同名目录不会被删除；本次不启用 force，不会覆盖已有的 _说明.md。'),
            h('div', { className: 'jk-kb-root-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save',
                'data-jk-kb-confirm-yes': 'true',
                disabled: busy,
                onClick: typeof p.onConfirm === 'function' ? p.onConfirm : undefined,
              }, busy ? '启动中…' : '确认开始建库'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-confirm-no': 'true',
                disabled: busy,
                onClick: typeof p.onCancelConfirm === 'function' ? p.onCancelConfirm : undefined,
              }, '取消')
            )
          )
        : null;

      const errorBox = phase === 'error'
        ? h('div', {
            className: 'jk-kb-error',
            'data-jk-kb-runs-error': (error && error.code) || 'host-unreachable',
          },
            h('h3', { className: 'jk-kb-placeholder-title' }, '宿主服务未连接'),
            h('p', { className: 'jk-kb-hint' },
              '无法访问插件后端（GET ' + HOST_RUNS_PATH + '），任务列表暂不可用。请确认 DSH 已重启并加载了本插件的宿主半。'),
            error
              ? h('p', { className: 'jk-kb-note' }, '详情：' + (error.code || 'unknown') + ' ' + (error.message || ''))
              : null,
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const emptyBox = h('div', { className: 'jk-kb-empty', 'data-jk-kb-runs-empty': 'true' },
        h('h3', { className: 'jk-kb-placeholder-title' }, '还没有任务'),
        h('p', { className: 'jk-kb-hint' },
          '先到「设置 → JK知识库」确认知识库根目录（需勾选风险确认并保存），再点上方「开始建库」。'),
        h('p', { className: 'jk-kb-hint' },
          '建库完成后，可以随时用「体检」检查结构、用「重建索引」刷新索引。')
      );

      const headerRow = h('div', { className: 'jk-kb-run-row jk-kb-run-header', 'aria-hidden': 'true' },
        h('span', { className: 'jk-kb-run-cell jk-kb-run-title' }, '标题'),
        h('span', { className: 'jk-kb-run-cell' }, '类型'),
        h('span', { className: 'jk-kb-run-cell' }, '状态'),
        h('span', { className: 'jk-kb-run-cell' }, '步骤'),
        h('span', { className: 'jk-kb-run-cell' }, '开始时间'),
        h('span', { className: 'jk-kb-run-cell' }, '耗时'),
        h('span', { className: 'jk-kb-run-cell' }, 'Token'),
        h('span', { className: 'jk-kb-run-cell' }, '心跳'),
        h('span', { className: 'jk-kb-run-cell' }, '预算'),
        h('span', { className: 'jk-kb-run-cell' }, '')
      );

      const list = h('div', { className: 'jk-kb-run-table', 'data-jk-kb-run-table': 'true' },
        headerRow,
        runs.map((run) => h('button', {
          key: run.id,
          type: 'button',
          className: 'jk-kb-run-row',
          'data-jk-kb-run': run.id,
          'data-jk-kb-run-status': run.status,
          onClick: () => { if (typeof p.onOpenRun === 'function') p.onOpenRun(run.id); },
        },
          h('span', { className: 'jk-kb-run-cell jk-kb-run-title', title: run.title }, run.title),
          h('span', { className: 'jk-kb-run-cell' }, run.kindLabel),
          h('span', { className: 'jk-kb-run-cell jk-kb-run-status-cell' },
            h('span', {
              className: 'jk-kb-status jk-kb-status-' + run.status,
              'data-jk-kb-run-status-label': run.status,
            }, run.statusLabel),
            run.acceptanceBadge
              ? h('span', {
                  className: 'jk-kb-acceptance-badge jk-kb-acceptance-' + run.acceptanceBadge.state,
                  'data-jk-kb-acceptance-badge': run.id,
                  'data-jk-kb-acceptance-state': run.acceptanceBadge.state,
                  title: run.acceptanceBadge.tooltip,
                }, run.acceptanceBadge.label)
              : null
          ),
          h('span', { className: 'jk-kb-run-cell', title: run.progressText }, run.progressText),
          h('span', { className: 'jk-kb-run-cell jk-kb-run-time' }, run.startedText),
          h('span', { className: 'jk-kb-run-cell' }, run.durationText),
          h('span', {
            className: 'jk-kb-run-cell jk-kb-token' + (run.usageText === '无 agent' ? ' jk-kb-token-degraded' : ''),
            'data-jk-kb-token': run.id,
            'data-jk-kb-usage-source': run.usageSource || undefined,
            title: run.usageText === '无 agent' ? '无 agent 降级，未消耗 token' : '输入 / 输出 token',
          }, run.usageText),
          h('span', { className: 'jk-kb-run-cell jk-kb-run-heartbeat' },
            h('span', {
              'data-jk-kb-heartbeat': run.id,
              title: run.heartbeatAtText === '—' ? '无心跳记录' : '最近心跳：' + run.heartbeatAtText,
            }, run.heartbeatAgeText),
            run.suspectedStall
              ? h('span', {
                  className: 'jk-kb-suspected',
                  'data-jk-kb-suspected': run.id,
                  title: '心跳已超过 ' + Math.round(run.heartbeatThresholdMs / 1000) + ' 秒阈值（' + (run.heartbeatBy || 'agent') + '）',
                }, '疑似卡住')
              : null
          ),
          h('span', {
            className: 'jk-kb-run-cell jk-kb-budget' + (run.budgetOver ? ' jk-kb-budget-over' : ''),
            'data-jk-kb-budget': run.id,
            'data-jk-kb-budget-over': run.budgetOver ? 'true' : undefined,
            title: '已用 / 总预算',
          }, run.budgetText),
          run.hasDegraded
            ? h('span', {
                className: 'jk-kb-degraded',
                'data-jk-kb-run-degraded': run.id,
                title: run.degraded,
                'aria-label': '无 agent 降级：' + run.degraded,
              }, '无 agent 降级')
            : h('span', { className: 'jk-kb-run-cell' }, '')
        ))
      );

      return h('div', { className: 'jk-kb-runs', 'data-jk-kb-runs': phase },
        h('div', { className: 'jk-kb-runs-head' },
          h('div', null,
            h('h2', { className: 'jk-kb-section-title' }, '任务'),
            h('p', { className: 'jk-kb-hint' },
              '列表来自宿主 GET ' + HOST_RUNS_PATH + '；有运行中的任务时每 1.5 秒全量刷新一次，全部结束后自动停止。')
          ),
          actions
        ),
        maintainConfirmBox,
        skillFormBox,
        curateBox,
        preflightRow,
        preflightError,
        preflightCard,
        confirmBox,
        notice
          ? h('p', {
              className: 'jk-kb-notice jk-kb-notice-' + notice.kind,
              'data-jk-kb-runs-notice': notice.kind,
              'aria-live': 'polite',
            }, notice.text)
          : null,
        errorBox,
        phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-runs-loading': 'true' }, '正在读取任务列表…')
          : null,
        phase === 'ready' ? (runs.length === 0 ? emptyBox : list) : null,
        phase === 'ready' && p.nextBefore
          ? h('div', { className: 'jk-kb-load-more' },
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-load-more': 'true',
                disabled: p.loadingMore === true,
                onClick: typeof p.onLoadMore === 'function' ? p.onLoadMore : undefined,
              }, p.loadingMore === true ? '加载中…' : '加载更多')
            )
          : null
      );
    }

    // ───────────────────────────── 任务详情（单任务视图） ─────────────────────────────
    function RunDetailPage(props) {
      const p = props || {};
      const runId = p.runId == null ? '' : String(p.runId);
      const [state, setState] = React.useState(createRunDetailState);
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const inflightRef = React.useRef ? React.useRef(false) : { current: false };

      async function refresh() {
        const result = await fetchRunDetail(runId);
        if (!aliveRef.current) return;
        setState((prev) => reduceRunDetail(prev, normalizeRunDetailResponse(result)));
      }

      React.useEffect(function () {
        aliveRef.current = true;
        setState((prev) => reduceRunDetail(prev, { type: 'loading' }));
        refresh();
        return function () { aliveRef.current = false; };
      }, [runId]);

      const detail = presentRunDetail(state.data, p.now);
      usePollingEffect(refresh, state.phase === 'ready' && detail.hasRunning);

      const [recover, setRecover] = React.useState({ pending: '', busy: false, notice: null, suggested: '' });

      function requestRecover(action) {
        setRecover((prev) => Object.assign({}, prev, { pending: action, notice: null }));
      }

      function cancelRecover() {
        setRecover({ pending: '', busy: false, notice: null, suggested: '' });
      }

      async function confirmRecover() {
        const action = recover.pending;
        if (!action) return;
        setRecover((prev) => Object.assign({}, prev, { busy: true, notice: null }));
        const result = await recoverHostRun(runId, action);
        if (!aliveRef.current) return;
        const outcome = describeRecoverOutcome(result);
        if (outcome.ok === true) {
          setRecover({ pending: '', busy: false, notice: { kind: 'ok', text: '已提交「' + recoverActionLabel(action) + '」' }, suggested: '' });
          await refresh();
          return;
        }
        setRecover({
          pending: '',
          busy: false,
          notice: { kind: 'error', text: outcome.message },
          suggested: outcome.suggested,
        });
      }

      async function onCancel() {
        if (inflightRef.current) return;
        inflightRef.current = true;
        setState((prev) => reduceRunDetail(prev, { type: 'busy', busy: true }));
        let outcome = null;
        try {
          outcome = await cancelRunRequest(runId);
        } finally {
          inflightRef.current = false;
        }
        if (!aliveRef.current) return;
        setState((prev) => reduceRunDetail(
          reduceRunDetail(prev, { type: 'busy', busy: false }),
          {
            type: 'notice',
            notice: outcome && outcome.cancelled
              ? { kind: 'ok', text: '已请求中止，等待宿主结算…' }
              : { kind: 'error', text: (outcome && outcome.message) || '中止失败' },
          }
        ));
        if (outcome && outcome.cancelled) await refresh();
      }

      return RunDetailView({
        phase: state.phase,
        detail: detail,
        error: state.error,
        busy: state.busy,
        notice: state.notice,
        onBack: p.onBack,
        onCancel: onCancel,
        onRetry: refresh,
        recoverPending: recover.pending,
        recoverBusy: recover.busy,
        recoverNotice: recover.notice,
        recoverSuggested: recover.suggested,
        onRecoverRequest: requestRecover,
        onRecoverConfirm: confirmRecover,
        onRecoverCancel: cancelRecover,
      });
    }

    function renderTimelineStep(step) {
      return h('li', {
        key: step.key,
        className: 'jk-kb-step' + (step.error ? ' jk-kb-step-error' : ''),
        'data-jk-kb-step': step.key,
        'data-jk-kb-step-status': step.status,
        'data-jk-kb-step-depth': String(step.depth),
        style: { marginLeft: (step.depth * 16) + 'px' },
      },
        h('div', { className: 'jk-kb-step-head' },
          h('span', { className: 'jk-kb-role', 'data-jk-kb-step-role': step.role }, step.role),
          h('span', { className: 'jk-kb-step-title' }, step.title),
          h('span', { className: 'jk-kb-status jk-kb-status-' + step.status }, step.statusLabel),
          h('span', { className: 'jk-kb-step-duration' }, step.durationText)
        ),
        step.parentId
          ? h('p', { className: 'jk-kb-step-line', 'data-jk-kb-step-parent': step.parentId }, '父步骤：' + step.parentId)
          : null,
        step.inputSummary
          ? h('p', { className: 'jk-kb-step-line' }, '输入：' + step.inputSummary)
          : null,
        step.outputSummary
          ? h('p', { className: 'jk-kb-step-line' }, '输出：' + step.outputSummary)
          : null,
        step.artifacts.length
          ? h('div', { className: 'jk-kb-artifacts', 'data-jk-kb-artifacts': step.key },
              h('span', { className: 'jk-kb-step-line' }, '产物'),
              step.artifacts.map((artifact) => h('button', {
                key: artifact.key,
                type: 'button',
                className: 'jk-kb-artifact',
                'data-jk-kb-artifact': artifact.path,
                title: '点击复制路径：' + artifact.path,
                onClick: () => copyToClipboard(artifact.path),
              }, artifact.label))
            )
          : null,
        step.error
          ? h('div', { className: 'jk-kb-step-error-box', 'data-jk-kb-step-error': step.key },
              h('p', { className: 'jk-kb-step-line' }, '错误：' + step.error))
          : null
      );
    }

    function RunDetailView(props) {
      const p = props || {};
      const phase = p.phase || 'loading';
      const detail = p.detail && typeof p.detail === 'object' ? p.detail : presentRunDetail(null);
      const run = detail.run;
      const steps = Array.isArray(detail.steps) ? detail.steps : [];
      const busy = p.busy === true;
      const notice = p.notice && p.notice.kind ? p.notice : null;
      const error = p.error && typeof p.error === 'object' ? p.error : null;
      const running = run.status === 'running';
      const recoverActions = buildRecoverActions(detail.run, detail.recovery);
      const recoverPending = typeof p.recoverPending === 'string' ? p.recoverPending : '';
      const recoverBusy = p.recoverBusy === true;
      const recoverNotice = p.recoverNotice && p.recoverNotice.kind ? p.recoverNotice : null;
      const recoverSuggested = typeof p.recoverSuggested === 'string' ? p.recoverSuggested : '';
      const recoveryDecision = detail.recovery && detail.recovery.action ? detail.recovery : null;
      const topNotice = describeTopNotice(run.status, run.acceptanceFailed);
      const acceptance = run.acceptance;
      const acceptanceState = !acceptance ? 'missing' : ((acceptance.ok && run.acceptanceFailed !== true) ? 'ok' : 'failed');
      const greenMismatch = run.acceptanceFailed === true && stepsAllGreen(steps);
      const usageState = run.usageSource === 'degraded'
        ? 'degraded'
        : (usageHasTokens(run.usage) ? 'agent' : 'unavailable');

      const backButton = h('button', {
        type: 'button',
        className: 'jk-kb-btn',
        'data-jk-kb-back': 'true',
        onClick: typeof p.onBack === 'function' ? p.onBack : undefined,
      }, '← 返回任务列表');

      const errorBox = phase === 'error'
        ? h('div', {
            className: 'jk-kb-error',
            'data-jk-kb-run-error': (error && error.code) || 'host-unreachable',
          },
            h('h3', { className: 'jk-kb-placeholder-title' }, '宿主服务未连接'),
            h('p', { className: 'jk-kb-hint' },
              '无法访问插件后端（GET ' + HOST_RUNS_PATH + '/:id），任务详情暂不可用。'),
            error
              ? h('p', { className: 'jk-kb-note' }, '详情：' + (error.code || 'unknown') + ' ' + (error.message || ''))
              : null,
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const body = phase === 'ready'
        ? h('div', { className: 'jk-kb-detail', 'data-jk-kb-run-detail': run.id },
            h('div', { className: 'jk-kb-detail-head' },
              h('h2', { className: 'jk-kb-section-title' }, run.title),
              h('span', {
                className: 'jk-kb-status jk-kb-status-' + run.status,
                'data-jk-kb-detail-status': run.status,
              }, run.statusLabel),
              run.hasDegraded
                ? h('span', {
                    className: 'jk-kb-degraded',
                    'data-jk-kb-detail-degraded': 'true',
                    title: run.degraded,
                  }, '无 agent 降级')
                : null,
              h('div', { className: 'jk-kb-detail-actions' },
                running
                  ? h('button', {
                      type: 'button',
                      className: 'jk-kb-btn jk-kb-btn-danger',
                      'data-jk-kb-cancel': 'true',
                      disabled: busy,
                      onClick: typeof p.onCancel === 'function' ? p.onCancel : undefined,
                    }, busy ? '中止中…' : '中止')
                  : null
              )
            ),
            topNotice
              ? h('p', {
                  className: 'jk-kb-notice jk-kb-notice-warning',
                  'data-jk-kb-run-notice': run.status,
                  'data-jk-kb-acceptance-notice': run.acceptanceFailed ? 'true' : undefined,
                  'aria-live': 'polite',
                }, topNotice)
              : null,
            run.hasDegraded
              ? h('p', { className: 'jk-kb-note', 'data-jk-kb-detail-degraded-reason': 'true' }, '降级原因：' + run.degraded)
              : null,
            h('div', { className: 'jk-kb-detail-meta' },
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '类型'),
                h('span', { className: 'jk-kb-detail-value' }, run.kindLabel)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '开始'),
                h('span', { className: 'jk-kb-detail-value' }, run.startedText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '结束'),
                h('span', { className: 'jk-kb-detail-value' }, run.endedText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '总耗时'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-duration': 'true' }, run.durationText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '心跳'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-heartbeat': 'true' }, run.heartbeatAtText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '心跳来源'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-heartbeat-by': 'true' }, run.heartbeatByText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '截止时间'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-deadline': 'true' }, run.deadlineText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '中止请求'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-cancel-requested': 'true' }, run.cancelRequestedText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '卡住标记'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-stalled': 'true' }, run.stalledText)
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '超时标记'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-timed-out': 'true' }, run.timedOutText)
              ),
              run.acceptanceFailed
                ? h('div', { className: 'jk-kb-detail-row' },
                    h('span', { className: 'jk-kb-detail-key' }, '验收失败'),
                    h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-acceptance-failed': 'true' }, '是')
                  )
                : null,
              run.summary
                ? h('div', { className: 'jk-kb-detail-row' },
                    h('span', { className: 'jk-kb-detail-key' }, '摘要'),
                    h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-detail-summary': 'true' }, run.summary)
                  )
                : null
            ),
            h('div', {
              className: 'jk-kb-usage',
              'data-jk-kb-usage': usageState,
              'data-jk-kb-usage-source': run.usageSource || 'unknown',
            },
              h('h3', { className: 'jk-kb-section-title' }, '用量'),
              usageState === 'degraded'
                ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-usage-degraded': 'true' }, '无 agent 降级，未消耗 token')
                : (usageState === 'unavailable'
                    ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-usage-empty': 'true' }, '未采集到用量')
                    : h('div', { className: 'jk-kb-detail-meta' },
                        h('div', { className: 'jk-kb-detail-row' },
                          h('span', { className: 'jk-kb-detail-key' }, '输入'),
                          h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-usage-input': 'true' }, formatTokenCount(run.usage.inputTokens))
                        ),
                        h('div', { className: 'jk-kb-detail-row' },
                          h('span', { className: 'jk-kb-detail-key' }, '输出'),
                          h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-usage-output': 'true' }, formatTokenCount(run.usage.outputTokens))
                        ),
                        h('div', { className: 'jk-kb-detail-row' },
                          h('span', { className: 'jk-kb-detail-key' }, '缓存读'),
                          h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-usage-cache-read': 'true' }, formatTokenCount(run.usage.cacheReadTokens))
                        ),
                        h('div', { className: 'jk-kb-detail-row' },
                          h('span', { className: 'jk-kb-detail-key' }, '缓存写'),
                          h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-usage-cache-write': 'true' }, formatTokenCount(run.usage.cacheWriteTokens))
                        ),
                        h('div', { className: 'jk-kb-detail-row' },
                          h('span', { className: 'jk-kb-detail-key' }, '来源'),
                          h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-usage-source-label': 'true' }, run.usageSource || '—')
                        )
                      )
                  )
            ),
            h('div', { className: 'jk-kb-acceptance', 'data-jk-kb-acceptance': acceptanceState },
              h('h3', { className: 'jk-kb-section-title' }, '验收'),
              greenMismatch
                ? h('p', {
                    className: 'jk-kb-acceptance-mismatch',
                    'data-jk-kb-acceptance-mismatch': 'true',
                  }, '所有步骤成功，但验收未通过')
                : null,
              acceptance
                ? h('div', { className: 'jk-kb-detail-meta' },
                    h('div', { className: 'jk-kb-detail-row' },
                      h('span', { className: 'jk-kb-detail-key' }, '结论'),
                      h('span', {
                        className: 'jk-kb-detail-value',
                        'data-jk-kb-acceptance-ok': acceptance.ok ? 'true' : 'false',
                      }, acceptance.ok ? '通过' : '未通过')
                    ),
                    h('div', { className: 'jk-kb-detail-row' },
                      h('span', { className: 'jk-kb-detail-key' }, '检查时间'),
                      h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-acceptance-checked': 'true' }, acceptance.checkedAtText)
                    ),
                    h('div', { className: 'jk-kb-detail-row' },
                      h('span', { className: 'jk-kb-detail-key' }, '摘要'),
                      h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-acceptance-summary': 'true' }, acceptance.summary || '—')
                    ),
                    acceptance.errors.length > 0
                      ? h('ul', { className: 'jk-kb-acceptance-errors', 'data-jk-kb-acceptance-errors': 'true' },
                          acceptance.errors.map((issue) => h('li', {
                            key: issue.key,
                            className: 'jk-kb-acceptance-error jk-kb-check-' + issue.level,
                            'data-jk-kb-acceptance-error': issue.id || issue.key,
                          },
                            h('span', { className: 'jk-kb-check-title' }, issue.id || '验收项'),
                            h('p', { className: 'jk-kb-check-detail' }, issue.message),
                            issue.fix
                              ? h('p', {
                                  className: 'jk-kb-check-fix',
                                  'data-jk-kb-acceptance-fix': issue.id || issue.key,
                                }, '修复：' + issue.fix)
                              : null
                          ))
                        )
                      : h('p', { className: 'jk-kb-hint', 'data-jk-kb-acceptance-errors-empty': 'true' }, '—')
                  )
                : h('p', { className: 'jk-kb-hint', 'data-jk-kb-acceptance-missing': 'true' }, '—')
            ),
            h('h3', { className: 'jk-kb-section-title' }, '时间线'),
            steps.length
              ? h('ul', { className: 'jk-kb-timeline', 'data-jk-kb-timeline': 'true' },
                  steps.map((step) => renderTimelineStep(step)))
              : h('p', { className: 'jk-kb-hint', 'data-jk-kb-timeline-empty': 'true' }, '宿主暂未返回步骤。'),
            h('div', { className: 'jk-kb-recover', 'data-jk-kb-recover': 'true' },
              recoveryDecision
                ? h('p', {
                    className: 'jk-kb-hint',
                    'data-jk-kb-recovery': recoveryDecision.action,
                  }, '恢复建议：' + recoverActionLabel(recoveryDecision.action)
                    + (recoveryDecision.reason ? '（原因：' + recoveryDecision.reason + '）' : ''))
                : null,
              recoverNotice
                ? h('p', {
                    className: 'jk-kb-notice jk-kb-notice-' + recoverNotice.kind,
                    'data-jk-kb-recover-notice': recoverNotice.kind,
                    'aria-live': 'polite',
                  }, recoverNotice.text)
                : null,
              h('div', { className: 'jk-kb-recover-actions' },
                recoverActions.map((action) => {
                  const highlighted = recoverSuggested === action.id
                    || (recoverSuggested === '' && recoveryDecision && recoveryDecision.action === action.id);
                  return h('button', {
                    key: action.id,
                    type: 'button',
                    className: 'jk-kb-btn'
                      + (highlighted ? ' jk-kb-btn-suggested' : '')
                      + (action.id === 'abandon' ? ' jk-kb-btn-danger' : ''),
                    'data-jk-kb-recover-action': action.id,
                    'data-jk-kb-recover-enabled': action.enabled ? 'true' : 'false',
                    'data-jk-kb-suggested': highlighted ? 'true' : undefined,
                    disabled: !action.enabled || recoverBusy,
                    onClick: () => { if (typeof p.onRecoverRequest === 'function') p.onRecoverRequest(action.id); },
                  }, action.label);
                })
              ),
              recoverPending
                ? h('div', {
                    className: 'jk-kb-confirm',
                    'data-jk-kb-recover-confirm': recoverPending,
                  },
                    h('p', { className: 'jk-kb-risk-title' }, '确认「' + recoverActionLabel(recoverPending) + '」？'),
                    h('p', { className: 'jk-kb-hint' }, recoverConfirmText(recoverPending)),
                    h('div', { className: 'jk-kb-root-actions' },
                      h('button', {
                        type: 'button',
                        className: 'jk-kb-save',
                        'data-jk-kb-recover-confirm-yes': 'true',
                        disabled: recoverBusy,
                        onClick: typeof p.onRecoverConfirm === 'function' ? p.onRecoverConfirm : undefined,
                      }, recoverBusy ? '提交中…' : '确认' + recoverActionLabel(recoverPending)),
                      h('button', {
                        type: 'button',
                        className: 'jk-kb-btn',
                        'data-jk-kb-recover-confirm-no': 'true',
                        disabled: recoverBusy,
                        onClick: typeof p.onRecoverCancel === 'function' ? p.onRecoverCancel : undefined,
                      }, '取消')
                    )
                  )
                : null
            )
          )
        : null;

      return h('div', { className: 'jk-kb-run-detail-page', 'data-jk-kb-run-page': phase },
        h('div', { className: 'jk-kb-detail-head' }, backButton),
        notice
          ? h('p', {
              className: 'jk-kb-notice jk-kb-notice-' + notice.kind,
              'data-jk-kb-detail-notice': notice.kind,
              'aria-live': 'polite',
            }, notice.text)
          : null,
        errorBox,
        phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-run-loading': 'true' }, '正在读取任务详情…')
          : null,
        body
      );
    }

    // ───────────────────────────── 业务专家（可配置角色卡） ─────────────────────────────
    function ExpertsPage() {
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const [status, setStatus] = React.useState('active');
      const [experts, setExperts] = React.useState({ phase: 'loading', list: [], error: null });
      const [skills, setSkills] = React.useState({ phase: 'loading', groups: [], error: null });
      const [reload, setReload] = React.useState(0);
      const [form, setForm] = React.useState({ open: false, mode: 'create', id: '', fields: expertToForm(null), search: '', busy: false, notice: null });
      const [archive, setArchive] = React.useState({ target: null, confirmed: false, busy: false, notice: null });
      const [writeNotice, setWriteNotice] = React.useState(null);
      const busyRef = React.useRef ? React.useRef(false) : { current: false };

      React.useEffect(function () {
        let alive = true;
        setExperts((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchExperts({ status: status }).then((result) => {
          if (!alive) return;
          const norm = normalizeExpertsResponse(result);
          setExperts(norm.ok === true
            ? { phase: 'ready', list: norm.experts, error: null }
            : { phase: 'error', list: [], error: norm.error });
        });
        fetchSkills().then((result) => {
          if (!alive) return;
          const norm = normalizeSkillsResponse(result);
          setSkills(norm.ok === true
            ? { phase: 'ready', groups: norm.groups, error: null }
            : { phase: 'error', groups: [], error: norm.error });
        });
        return function () { alive = false; aliveRef.current = false; };
      }, [status, reload]);

      function openCreate() {
        setForm({ open: true, mode: 'create', id: '', fields: expertToForm(null), search: '', notice: null });
      }

      function openEdit(expert) {
        setForm({ open: true, mode: 'edit', id: expert.id, fields: expertToForm(expert), search: '', notice: null });
      }

      function closeForm() {
        setForm((prev) => Object.assign({}, prev, { open: false, notice: null }));
      }

      function setField(field, value) {
        setForm((prev) => Object.assign({}, prev, {
          fields: Object.assign({}, prev.fields, { [field]: value }),
          notice: null,
        }));
      }

      function toggleSkill(skillId) {
        setForm((prev) => {
          const current = Array.isArray(prev.fields.skillIds) ? prev.fields.skillIds : [];
          const next = current.indexOf(skillId) >= 0
            ? current.filter((id) => id !== skillId)
            : current.concat([skillId]);
          return Object.assign({}, prev, {
            fields: Object.assign({}, prev.fields, { skillIds: next }),
            notice: null,
          });
        });
      }

      async function submitForm() {
        const validation = validateExpertForm(form.fields);
        if (validation.ok !== true || busyRef.current) return;
        busyRef.current = true;
        setForm((prev) => Object.assign({}, prev, { busy: true, notice: null }));
        const kind = form.mode === 'edit' ? 'update' : 'create';
        const outcome = kind === 'update'
          ? await updateExpertRequest(form.id, form.fields)
          : await createExpertRequest(form.fields);
        busyRef.current = false;
        if (!aliveRef.current) return;
        const plan = planExpertWriteResult(kind, outcome);
        setForm((prev) => Object.assign({}, prev, {
          busy: false,
          open: plan.closeForm ? false : prev.open,
          notice: plan.ok ? null : plan.notice,
        }));
        setWriteNotice(plan.notice);
        if (plan.refresh) {
          if (plan.nextStatus) setStatus(plan.nextStatus);
          setReload(reload + 1);
        }
      }

      function openArchive(expert) {
        setArchive({ target: expert, confirmed: false, busy: false, notice: null });
      }

      function closeArchive() {
        setArchive({ target: null, confirmed: false, busy: false, notice: null });
      }

      async function confirmArchive() {
        if (!archive.target || archive.confirmed !== true || busyRef.current) return;
        busyRef.current = true;
        setArchive((prev) => Object.assign({}, prev, { busy: true, notice: null }));
        const outcome = await archiveExpertRequest(archive.target.id);
        busyRef.current = false;
        if (!aliveRef.current) return;
        const plan = planExpertWriteResult('archive', outcome);
        setArchive((prev) => Object.assign({}, prev, {
          busy: false,
          target: plan.closeArchive ? null : prev.target,
          confirmed: false,
          notice: plan.ok ? null : plan.notice,
        }));
        setWriteNotice(plan.notice);
        if (plan.refresh) {
          if (plan.nextStatus) setStatus(plan.nextStatus);
          setReload(reload + 1);
        }
      }

      return ExpertsView({
        status: status,
        experts: experts,
        skills: skills,
        form: form,
        archive: archive,
        writeNotice: writeNotice,
        onToggleStatus: () => setStatus(status === 'active' ? 'archived' : 'active'),
        onRefresh: () => setReload(reload + 1),
        onRetry: () => setReload(reload + 1),
        onNew: openCreate,
        onEdit: openEdit,
        onCloseForm: closeForm,
        onField: setField,
        onToggleSkill: toggleSkill,
        onSearch: (value) => setForm((prev) => Object.assign({}, prev, { search: value })),
        onSubmit: submitForm,
        onArchive: openArchive,
        onArchiveClose: closeArchive,
        onArchiveConfirm: (checked) => setArchive((prev) => Object.assign({}, prev, { confirmed: checked === true })),
        onArchiveSubmit: confirmArchive,
        onUnbindSkill: unbindSkill,
        onRestore: restoreExpert,
      });
    }

    function ExpertsView(props) {
      const p = props || {};
      const status = p.status === 'archived' ? 'archived' : 'active';
      const experts = p.experts && typeof p.experts === 'object' ? p.experts : { phase: 'loading', list: [], error: null };
      const skills = p.skills && typeof p.skills === 'object' ? p.skills : { phase: 'loading', groups: [], error: null };
      const list = Array.isArray(experts.list) ? experts.list : [];
      const groups = Array.isArray(skills.groups) ? skills.groups : [];
      const nameMap = expertSkillNameMap(groups);
      const form = p.form && typeof p.form === 'object'
        ? p.form
        : { open: false, mode: 'create', id: '', fields: expertToForm(null), search: '', notice: null };
      const fields = form.fields && typeof form.fields === 'object' ? form.fields : expertToForm(null);
      const validation = validateExpertForm(fields);
      const filteredGroups = filterSkillGroups(groups, form.search);
      const archive = p.archive && typeof p.archive === 'object' ? p.archive : { target: null, confirmed: false, busy: false, notice: null };
      const writeNotice = p.writeNotice && p.writeNotice.kind ? p.writeNotice : null;

      const header = h('div', { className: 'jk-kb-experts-head' },
        h('div', null,
          h('h2', { className: 'jk-kb-section-title' }, '业务专家'),
          h('p', { className: 'jk-kb-hint' }, '专家 = 一组技能 + 一段职责说明，入柜时可以指定由谁处理。')
        ),
        h('div', { className: 'jk-kb-experts-actions' },
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-experts-status': status === 'active' ? 'archived' : 'active',
            onClick: typeof p.onToggleStatus === 'function' ? p.onToggleStatus : undefined,
          }, status === 'active' ? '查看归档' : '查看活跃'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-experts-refresh': 'true',
            onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
          }, '刷新'),
          h('button', {
            type: 'button',
            className: 'jk-kb-save jk-kb-guide-cta',
            'data-jk-kb-expert-new': 'true',
            onClick: typeof p.onNew === 'function' ? p.onNew : undefined,
          }, '新建专家')
        )
      );

      const errorBox = experts.phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-experts-error': 'true' },
            h('h3', { className: 'jk-kb-placeholder-title' }, '专家列表不可用'),
            h('p', { className: 'jk-kb-hint' }, '无法读取专家列表（' + HOST_EXPERTS_PATH + '）。'),
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-experts-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const emptyText = status === 'active' ? EXPERT_EMPTY_TEXT : '还没有归档专家。';
      const cards = experts.phase === 'ready'
        ? (list.length === 0
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-experts-empty': 'true' }, emptyText)
            : h('div', { className: 'jk-kb-expert-grid', 'data-jk-kb-experts-list': 'true' },
                list.map((expert) => {
                  const skillNames = (expert.skillIds || []).map((id) => nameMap[id] || id);
                  return h('article', {
                    key: expert.key,
                    className: 'jk-kb-expert-card',
                    'data-jk-kb-expert': expert.id,
                  },
                    h('div', { className: 'jk-kb-expert-card-head' },
                      h('h3', { className: 'jk-kb-expert-name', 'data-jk-kb-expert-name': expert.id }, expert.name),
                      h('span', { className: 'jk-kb-expert-domain', 'data-jk-kb-expert-domain': expert.id }, expert.domain),
                      h('div', { className: 'jk-kb-expert-card-actions' },
                        h('button', {
                          type: 'button',
                          className: 'jk-kb-btn',
                          'data-jk-kb-expert-edit': expert.id,
                          onClick: () => { if (typeof p.onEdit === 'function') p.onEdit(expert); },
                        }, '编辑'),
                        status === 'active'
                          ? h('button', {
                              type: 'button',
                              className: 'jk-kb-btn jk-kb-btn-danger',
                              'data-jk-kb-expert-archive': expert.id,
                              onClick: () => { if (typeof p.onArchive === 'function') p.onArchive(expert); },
                            }, '归档')
                          : h('button', {
                              type: 'button',
                              className: 'jk-kb-btn',
                              'data-jk-kb-expert-restore': expert.id,
                              onClick: () => { if (typeof p.onRestore === 'function') p.onRestore(expert); },
                            }, '恢复')
                      )
                    ),
                    h('p', { className: 'jk-kb-expert-output', 'data-jk-kb-expert-output': expert.id },
                      expert.cardCount > 0
                        ? expert.cardCount + ' 张卡片 · 最近使用 ' + expert.lastUsedAtText
                        : '还没有入柜记录'),
                    h('p', { className: 'jk-kb-expert-responsibility', 'data-jk-kb-expert-responsibility': expert.id }, expert.responsibility || '—'),
                    h('div', { className: 'jk-kb-expert-meta' },
                      h('span', {
                        className: 'jk-kb-expert-skills',
                        'data-jk-kb-expert-skills': expert.id,
                        title: skillNames.length > 0 ? skillNames.join('、') : '未绑定技能',
                      }, '技能 ' + (expert.skillIds || []).length),
                      h('span', {
                        className: 'jk-kb-expert-prompt',
                        'data-jk-kb-expert-prompt': expert.id,
                      }, expert.promptFragment ? '提示词：有' : '提示词：无')
                    ),
                    expertDanglingSkillIds(expert).length > 0
                      ? h('div', { className: 'jk-kb-expert-dangling-list', 'data-jk-kb-expert-dangling-list': expert.id },
                          expertDanglingSkillIds(expert).map((skillId) => h('div', {
                            key: expert.id + ':' + skillId,
                            className: 'jk-kb-expert-dangling',
                            'data-jk-kb-expert-dangling': expert.id + ':' + skillId,
                          },
                            h('span', { className: 'jk-kb-expert-dangling-text' }, '悬空技能：' + (nameMap[skillId] || skillId)),
                            h('button', {
                              type: 'button',
                              className: 'jk-kb-btn',
                              'data-jk-kb-expert-unbind': expert.id + ':' + skillId,
                              onClick: () => {
                                if (typeof p.onUnbindSkill === 'function') p.onUnbindSkill(expert, skillId);
                              },
                            }, '解绑')
                          ))
                        )
                      : null
                  );
                })
              ))
        : null;

      const fieldError = (key) => (validation.errors[key]
        ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-expert-error': key }, validation.errors[key])
        : null);
      const inputFor = (key, label) => [
        h('label', { key: 'label-' + key, className: 'jk-kb-field' }, label),
        h('input', {
          key: 'input-' + key,
          type: 'text',
          className: 'jk-kb-field-input',
          ['data-jk-kb-expert-' + key]: 'true',
          value: typeof fields[key] === 'string' ? fields[key] : '',
          onChange: (event) => {
            if (typeof p.onField === 'function') p.onField(key, event && event.target ? event.target.value : '');
          },
        }),
        fieldError(key),
      ];

      const skillPicker = h('div', { className: 'jk-kb-expert-skills-picker' },
        h('label', { className: 'jk-kb-field' }, '绑定技能（可多选；来自内置技能目录）'),
        h('input', {
          type: 'text',
          className: 'jk-kb-field-input',
          'data-jk-kb-expert-skill-search': 'true',
          placeholder: '搜索技能名称或 id',
          value: typeof form.search === 'string' ? form.search : '',
          onChange: (event) => {
            if (typeof p.onSearch === 'function') p.onSearch(event && event.target ? event.target.value : '');
          },
        }),
        skills.phase === 'error'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-expert-skills-error': 'true' }, '技能目录不可用，可先不绑定技能')
          : null,
        skills.phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-expert-skills-loading': 'true' }, '正在读取技能目录…')
          : null,
        filteredGroups.map((group) => h('section', {
          key: group.key,
          className: 'jk-kb-expert-skill-group',
          'data-jk-kb-expert-skill-group': group.key,
        },
          h('h4', { className: 'jk-kb-expert-skill-group-title' }, group.label),
          group.skills.map((skill) => h('label', { key: skill.id, className: 'jk-kb-ack' },
            h('input', {
              type: 'checkbox',
              className: 'jk-kb-ack-box',
              'data-jk-kb-expert-skill': skill.id,
              checked: (fields.skillIds || []).indexOf(skill.id) >= 0,
              onChange: () => {
                if (typeof p.onToggleSkill === 'function') p.onToggleSkill(skill.id);
              },
            }),
            h('span', { className: 'jk-kb-ack-text' }, skill.id + ' · ' + skill.name)
          ))
        ))
      );

      const formBox = form.open
        ? h('section', { className: 'jk-kb-curate jk-kb-expert-form', 'data-jk-kb-expert-form': 'true' },
            h('h3', { className: 'jk-kb-curate-title' }, form.mode === 'edit' ? '编辑专家 ' + form.id : '新建专家'),
            inputFor('name', '名称（必填，≤60 字符）'),
            inputFor('domain', '领域（必填，≤40 字符）'),
            h('label', { className: 'jk-kb-field' }, '职责（必填，≥10 字符）'),
            h('textarea', {
              className: 'jk-kb-textarea',
              'data-jk-kb-expert-responsibility': 'true',
              value: typeof fields.responsibility === 'string' ? fields.responsibility : '',
              onChange: (event) => {
                if (typeof p.onField === 'function') p.onField('responsibility', event && event.target ? event.target.value : '');
              },
            }),
            fieldError('responsibility'),
            skillPicker,
            h('label', { className: 'jk-kb-field' }, '提示词片段（可选，≤2000 字符）'),
            h('textarea', {
              className: 'jk-kb-textarea',
              'data-jk-kb-expert-prompt-fragment': 'true',
              value: typeof fields.promptFragment === 'string' ? fields.promptFragment : '',
              onChange: (event) => {
                if (typeof p.onField === 'function') p.onField('promptFragment', event && event.target ? event.target.value : '');
              },
            }),
            fieldError('promptFragment'),
            form.notice && form.notice.kind
              ? h('p', {
                  className: 'jk-kb-notice jk-kb-notice-' + form.notice.kind,
                  'data-jk-kb-expert-form-notice': form.notice.kind,
                }, form.notice.text)
              : null,
            h('div', { className: 'jk-kb-curate-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save jk-kb-guide-cta',
                'data-jk-kb-expert-submit': 'true',
                disabled: validation.ok !== true || form.busy === true,
                onClick: typeof p.onSubmit === 'function' ? p.onSubmit : undefined,
              }, form.busy === true ? '提交中…' : (form.mode === 'edit' ? '保存修改' : '创建专家')),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-expert-cancel': 'true',
                onClick: typeof p.onCloseForm === 'function' ? p.onCloseForm : undefined,
              }, '取消')
            )
          )
        : null;

      const archiveTarget = archive.target && typeof archive.target === 'object' ? archive.target : null;
      const archiveDialog = archiveTarget
        ? h('div', { className: 'jk-kb-confirm', 'data-jk-kb-expert-archive-confirm': archiveTarget.id },
            h('p', { className: 'jk-kb-risk-title' }, '确认归档「' + archiveTarget.name + '」？'),
            h('p', { className: 'jk-kb-hint' }, '归档不会删除数据，只把状态改成 archived；之后可用「查看归档」（?status=archived）查看。'),
            archive.notice && archive.notice.kind
              ? h('p', {
                  className: 'jk-kb-notice jk-kb-notice-' + archive.notice.kind,
                  'data-jk-kb-expert-archive-notice': archive.notice.kind,
                }, archive.notice.text)
              : null,
            h('label', { className: 'jk-kb-ack' },
              h('input', {
                type: 'checkbox',
                className: 'jk-kb-ack-box',
                'data-jk-kb-expert-archive-ack': 'true',
                checked: archive.confirmed === true,
                onChange: (event) => {
                  if (typeof p.onArchiveConfirm === 'function') {
                    p.onArchiveConfirm(event && event.target ? !!event.target.checked : false);
                  }
                },
              }),
              h('span', { className: 'jk-kb-ack-text' }, '我已确认')
            ),
            h('div', { className: 'jk-kb-root-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save',
                'data-jk-kb-expert-archive-yes': 'true',
                disabled: archive.confirmed !== true || archive.busy === true,
                onClick: typeof p.onArchiveSubmit === 'function' ? p.onArchiveSubmit : undefined,
              }, archive.busy === true ? '归档中…' : '确认归档'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-expert-archive-no': 'true',
                onClick: typeof p.onArchiveClose === 'function' ? p.onArchiveClose : undefined,
              }, '取消')
            )
          )
        : null;

      return h('div', { className: 'jk-kb-experts', 'data-jk-kb-experts': status },
        header,
        writeNotice
          ? h('p', {
              className: 'jk-kb-notice jk-kb-notice-' + writeNotice.kind,
              'data-jk-kb-experts-notice': writeNotice.kind,
              'aria-live': 'polite',
            }, writeNotice.text)
          : null,
        errorBox,
        experts.phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-experts-loading': 'true' }, '正在读取专家列表…')
          : null,
        formBox,
        archiveDialog,
        cards
      );
    }

    // ───────────────────────────── doctor 界面（体检 / 修复） ─────────────────────────────
    function TasksPageHeader(props) {
      const p = props || {};
      return h('div', { className: 'jk-kb-tasks-head-row' },
        TasksViewSwitch({ viewMode: p.viewMode, onChange: p.onChange }),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn jk-kb-doctor-launch',
          'data-jk-kb-doctor-open': 'true',
          onClick: typeof p.onDoctorOpen === 'function' ? p.onDoctorOpen : undefined,
        }, '体检修复')
      );
    }

    function DoctorPanel(props) {
      const p = props || {};
      const open = p.open === true;
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const busyRef = React.useRef ? React.useRef(false) : { current: false };
      const [reload, setReload] = React.useState(0);
      const [state, setState] = React.useState({ phase: 'idle', data: null, error: null });
      const [selected, setSelected] = React.useState([]);
      const [showOk, setShowOk] = React.useState(false);
      const [view, setView] = React.useState('checks');
      const [plan, setPlan] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [conflict, setConflict] = React.useState([]);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(function () {
        if (!open) return function () {};
        let alive = true;
        setState((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchDoctor().then((result) => {
          if (!alive) return;
          const norm = normalizeDoctorResponse(result);
          setState(norm.ok === true
            ? { phase: 'ready', data: norm.data, error: null }
            : { phase: 'error', data: null, error: norm.error });
        });
        return function () { alive = false; aliveRef.current = false; };
      }, [open, reload]);

      React.useEffect(function () {
        if (!open) return;
        setSelected([]);
        setView('checks');
        setPlan(null);
        setResult(null);
        setConflict([]);
        setNotice(null);
      }, [open]);

      function toggleCheck(repairId) {
        setSelected((prev) => (prev.indexOf(repairId) >= 0
          ? prev.filter((id) => id !== repairId)
          : prev.concat([repairId])));
      }

      function selectAll() {
        setSelected(selectableRepairIds(state.data ? state.data.checks : []));
      }

      async function runRepair(dryRun) {
        if (busyRef.current) return;
        const ids = selected.slice();
        if (ids.length === 0) return;
        busyRef.current = true;
        setBusy(true);
        setNotice(null);
        const outcome = await requestDoctorRepair(ids, dryRun ? { dryRun: true } : { dryRun: false, confirm: true });
        busyRef.current = false;
        if (!aliveRef.current) return;
        setBusy(false);
        if (outcome && outcome.ok === true) {
          if (dryRun) {
            setPlan(outcome);
            setView('plan');
          } else {
            setResult(outcome);
            setView('result');
            setReload(reload + 1);
          }
          return;
        }
        if (outcome && outcome.kind === 'run-in-progress') {
          setConflict(outcome.runs.length > 0 ? outcome.runs : ['未知']);
          setNotice({ kind: 'error', text: outcome.message });
          return;
        }
        setNotice({ kind: 'error', text: (outcome && outcome.message) || '修复失败' });
      }

      async function goSettings() {
        const outcome = await openSettingsForRoot({});
        if (outcome && outcome.ok === true) return;
        setNotice({ kind: 'error', text: (outcome && outcome.message) || GUIDE_STEP_HINT });
      }

      return DoctorView({
        open: open,
        phase: state.phase,
        data: state.data,
        error: state.error,
        selected: selected,
        showOk: showOk,
        view: view,
        plan: plan,
        result: result,
        conflict: conflict,
        notice: notice,
        busy: busy,
        onToggleCheck: toggleCheck,
        onSelectAll: selectAll,
        onPreview: () => runRepair(true),
        onConfirm: () => runRepair(false),
        onRefresh: () => setReload(reload + 1),
        onRetry: () => setReload(reload + 1),
        onToggleOk: () => setShowOk(!showOk),
        onClose: p.onClose,
        onGoTasks: p.onGoTasks,
        onGoSettings: goSettings,
      });
    }

    function DoctorView(props) {
      const p = props || {};
      if (p.open !== true) return null;
      const phase = p.phase || 'loading';
      const data = p.data && typeof p.data === 'object' ? p.data : null;
      const selected = Array.isArray(p.selected) ? p.selected : [];
      const error = p.error && typeof p.error === 'object' ? p.error : null;
      const notice = p.notice && p.notice.kind ? p.notice : null;
      const conflict = Array.isArray(p.conflict) ? p.conflict : [];
      const plan = p.plan && typeof p.plan === 'object' ? p.plan : null;
      const result = p.result && typeof p.result === 'object' ? p.result : null;
      const busy = p.busy === true;

      const header = h('div', { className: 'jk-kb-doctor-head' },
        h('div', null,
          h('h3', { className: 'jk-kb-section-title' }, '体检修复'),
          data
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-doctor-generated': 'true' }, '生成于 ' + data.generatedAtText)
            : null
        ),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-doctor-refresh': 'true',
          disabled: phase === 'loading',
          onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
        }, phase === 'loading' ? '检查中…' : '重新体检'),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-doctor-close': 'true',
          onClick: typeof p.onClose === 'function' ? p.onClose : undefined,
        }, '关闭')
      );

      const errorBox = phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-doctor-error': 'true' },
            h('p', { className: 'jk-kb-hint' }, '体检接口不可用：' + ((error && error.message) || '宿主服务未连接')),
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-doctor-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const summary = data
        ? h('p', { className: 'jk-kb-doctor-summary', 'data-jk-kb-doctor-summary': 'true' },
            '正常 ' + data.summary.ok + ' · 建议 ' + data.summary.warn
            + ' · 可修 ' + data.summary.repairable + ' · 阻塞 ' + data.summary.blocked)
        : null;

      const renderCheck = (check) => h('li', {
        key: check.key,
        className: 'jk-kb-doctor-check jk-kb-doctor-check-' + check.level,
        'data-jk-kb-doctor-check': check.id,
        'data-jk-kb-doctor-level': check.level,
      },
        check.level === 'error' && check.repairable && check.repairId
          ? h('input', {
              type: 'checkbox',
              className: 'jk-kb-ack-box',
              'data-jk-kb-doctor-checkbox': check.repairId,
              checked: selected.indexOf(check.repairId) >= 0,
              onChange: () => { if (typeof p.onToggleCheck === 'function') p.onToggleCheck(check.repairId); },
            })
          : null,
        h('div', { className: 'jk-kb-doctor-check-body' },
          h('p', { className: 'jk-kb-doctor-check-title' }, check.id + ' · ' + check.title),
          h('p', { className: 'jk-kb-doctor-check-detail' }, check.detail),
          check.id === 'CFG-01'
            ? h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-doctor-settings': 'true',
                onClick: typeof p.onGoSettings === 'function' ? p.onGoSettings : undefined,
              }, '去设置')
            : null
        )
      );

      const group = (level) => {
        if (!data || data.groups[level].length === 0) return null;
        return h('section', { key: level, className: 'jk-kb-doctor-group', 'data-jk-kb-doctor-group': level },
          h('h4', { className: 'jk-kb-doctor-group-title' }, DOCTOR_LEVEL_LABELS[level] + '（' + data.groups[level].length + '）'),
          h('ul', { className: 'jk-kb-doctor-checks' }, data.groups[level].map(renderCheck))
        );
      };

      const okSection = data && data.groups.ok.length > 0
        ? h('div', { className: 'jk-kb-doctor-ok' },
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-doctor-toggle-ok': 'true',
              'aria-expanded': p.showOk === true,
              onClick: typeof p.onToggleOk === 'function' ? p.onToggleOk : undefined,
            }, p.showOk === true ? '收起正常项（' + data.groups.ok.length + '）' : '展开正常项（' + data.groups.ok.length + '）'),
            p.showOk === true ? group('ok') : null
          )
        : null;

      const conflictBar = conflict.length > 0
        ? h('div', { className: 'jk-kb-doctor-conflict', 'data-jk-kb-doctor-conflict': 'true' },
            h('p', null, '有任务正在执行（' + conflict.join('、') + '），请等其结束后再修复。'),
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-doctor-go-tasks': 'true',
              onClick: typeof p.onGoTasks === 'function' ? p.onGoTasks : undefined,
            }, '去任务列表')
          )
        : null;

      const noticeBar = notice
        ? h('p', {
            className: 'jk-kb-notice jk-kb-notice-' + notice.kind,
            'data-jk-kb-doctor-notice': notice.kind,
            'aria-live': 'polite',
          }, notice.text)
        : null;

      const planSection = p.view === 'plan' && plan
        ? h('div', { className: 'jk-kb-doctor-plan', 'data-jk-kb-doctor-plan': 'true' },
            h('p', { className: 'jk-kb-hint', 'data-jk-kb-doctor-plan-warning': 'true' },
              '不会删除文件，损坏产物会移入 .jkkb/quarantine。'),
            h('ul', { className: 'jk-kb-doctor-plan-list' },
              plan.planned.map((item) => h('li', {
                key: item.key,
                className: 'jk-kb-doctor-plan-row',
                'data-jk-kb-doctor-plan-row': item.repairId,
                'data-jk-kb-doctor-plan-risk': item.risk,
              },
                h('p', { className: 'jk-kb-doctor-check-title' }, item.repairId + ' · ' + item.action),
                h('p', { className: 'jk-kb-doctor-check-detail' }, '目标：' + (item.targets.length > 0 ? item.targets.join('、') : '—')),
                h('p', { className: 'jk-kb-doctor-check-detail' }, '风险：' + (item.risk === 'medium' ? '中' : '低'))
              ))
            ),
            h('button', {
              type: 'button',
              className: 'jk-kb-save jk-kb-guide-cta',
              'data-jk-kb-doctor-confirm': 'true',
              disabled: busy,
              onClick: typeof p.onConfirm === 'function' ? p.onConfirm : undefined,
            }, busy ? '修复中…' : '确认修复')
          )
        : null;

      const resultSection = p.view === 'result' && result
        ? h('div', { className: 'jk-kb-doctor-result', 'data-jk-kb-doctor-result': 'true' },
            result.auditError
              ? h('p', { className: 'jk-kb-notice jk-kb-notice-warning', 'data-jk-kb-doctor-audit': 'true' },
                  '修复已生效，但审计记录写入失败')
              : null,
            h('ul', { className: 'jk-kb-doctor-result-list' },
              result.applied.map((item) => h('li', {
                key: item.key,
                className: 'jk-kb-doctor-result-row' + (item.status === 'failed' ? ' jk-kb-doctor-result-failed' : ''),
                'data-jk-kb-doctor-result-row': item.repairId,
                'data-jk-kb-doctor-result-status': item.status,
              },
                h('p', { className: 'jk-kb-doctor-check-title' }, item.repairId + ' · ' + (item.status === 'applied' ? '成功' : (item.status === 'skipped' ? '跳过' : '失败'))),
                item.detail ? h('p', { className: 'jk-kb-doctor-check-detail' }, item.detail) : null,
                item.movedTo.length > 0
                  ? h('p', { className: 'jk-kb-doctor-check-detail', 'data-jk-kb-doctor-moved': item.repairId }, '已移至：' + item.movedTo.join('、'))
                  : null
              ))
            )
          )
        : null;

      return h('section', { className: 'jk-kb-doctor', 'data-jk-kb-doctor': 'open', 'data-jk-kb-doctor-panel': 'true' },
        header,
        summary,
        errorBox,
        noticeBar,
        conflictBar,
        phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-doctor-loading': 'true' }, '正在体检…')
          : null,
        phase === 'ready' && data
          ? h('div', { className: 'jk-kb-doctor-groups' },
              group('blocked'),
              group('error'),
              group('warn'),
              okSection
            )
          : null,
        planSection,
        resultSection,
        h('div', { className: 'jk-kb-doctor-actions' },
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-doctor-select-all': 'true',
            onClick: typeof p.onSelectAll === 'function' ? p.onSelectAll : undefined,
          }, '全选可修项'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-doctor-preview': 'true',
            disabled: busy || selected.length === 0,
            onClick: typeof p.onPreview === 'function' ? p.onPreview : undefined,
          }, busy ? '处理中…' : '预览修复'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-doctor-close-footer': 'true',
            onClick: typeof p.onClose === 'function' ? p.onClose : undefined,
          }, '关闭')
        )
      );
    }

    // ───────────────────────────── 任务管理：列表 / 日历双视图 ─────────────────────────────
    function TasksViewSwitch(props) {
      const p = props || {};
      const mode = p.viewMode === 'calendar' ? 'calendar' : (p.viewMode === 'skills' ? 'skills' : 'list');
      return h('div', { className: 'jk-kb-view-switch', 'data-jk-kb-view-switch': 'true' },
        [['list', '列表'], ['calendar', '日历'], ['skills', '技能']].map((entry) => h('button', {
          key: entry[0],
          type: 'button',
          className: 'jk-kb-view-tab' + (mode === entry[0] ? ' jk-kb-view-tab-active' : ''),
          'data-jk-kb-view-tab': entry[0],
          'aria-pressed': mode === entry[0],
          onClick: () => { if (typeof p.onChange === 'function') p.onChange(entry[0]); },
        }, entry[1]))
      );
    }

    // ───────────────────────────── 技能视图（注册表 + 调用日志） ─────────────────────────────
    function SkillViewPage() {
      const now = new Date();
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const [registry, setRegistry] = React.useState({ phase: 'loading', skills: [], error: null });
      const [calls, setCalls] = React.useState({ phase: 'loading', calls: [], nextBefore: null, error: null });
      const [cursor, setCursor] = React.useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
      const [selectedDate, setSelectedDate] = React.useState('');
      const [reload, setReload] = React.useState(0);
      const [callFormOpen, setCallFormOpen] = React.useState(false);
      const [callForm, setCallForm] = React.useState({ skillId: '', task: '', result: 'ok', reason: '', outputs: '' });
      const [callBusy, setCallBusy] = React.useState(false);
      const [callNotice, setCallNotice] = React.useState(null);

      React.useEffect(function () {
        let alive = true;
        setRegistry((prev) => Object.assign({}, prev, { phase: 'loading' }));
        setCalls((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchSkillRegistry({ limit: 50 }).then((result) => {
          if (!alive) return;
          const norm = normalizeRegistryResponse(result);
          setRegistry(norm.ok === true
            ? { phase: 'ready', skills: norm.skills, error: null }
            : { phase: 'error', skills: [], error: norm.error });
        });
        fetchSkillCalls({ limit: 100 }).then((result) => {
          if (!alive) return;
          const norm = normalizeCallsResponse(result);
          setCalls(norm.ok === true
            ? { phase: 'ready', calls: norm.calls, nextBefore: norm.nextBefore, error: null }
            : { phase: 'error', calls: [], nextBefore: null, error: norm.error });
        });
        return function () { alive = false; aliveRef.current = false; };
      }, [reload]);

      function shiftMonth(delta) {
        const total = cursor.year * 12 + (cursor.month - 1) + delta;
        setCursor({ year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 + 1 });
        setSelectedDate('');
      }

      const registrySkills = registry.phase === 'ready' && Array.isArray(registry.skills) ? registry.skills : [];
      const hasSkills = registrySkills.length > 0;

      function openCallForm(skillId) {
        setCallForm({ skillId: skillId || '', task: '', result: 'ok', reason: '', outputs: '' });
        setCallNotice(null);
        setCallFormOpen(true);
      }

      function setCallField(field, value) {
        setCallForm((prev) => Object.assign({}, prev, { [field]: value }));
      }

      async function submitCall() {
        const validation = validateSkillCallForm(callForm, hasSkills);
        if (validation.ok !== true || callBusy) return;
        setCallBusy(true);
        setCallNotice(null);
        const outcome = await startSkillCallRequest(callForm, { hasSkills: hasSkills });
        if (!aliveRef.current) return;
        setCallBusy(false);
        const plan = planSkillCallResult(outcome);
        setCallNotice(plan.notice);
        if (plan.closeForm) {
          setCallFormOpen(false);
          setCallForm({ skillId: '', task: '', result: 'ok', reason: '', outputs: '' });
        }
        if (plan.refresh) setReload(reload + 1);
      }

      return SkillViewView({
        registry: registry,
        calls: calls,
        year: cursor.year,
        month: cursor.month,
        today: toLocalDateString(new Date()),
        selectedDate: selectedDate,
        onPrev: () => shiftMonth(-1),
        onNext: () => shiftMonth(1),
        onSelectDay: (date) => setSelectedDate(date),
        onRefresh: () => setReload(reload + 1),
        onRetry: () => setReload(reload + 1),
        onCopyPath: (path) => copyToClipboard(path),
        callFormOpen: callFormOpen,
        callForm: callForm,
        callBusy: callBusy,
        callNotice: callNotice,
        onCallOpen: openCallForm,
        onCallClose: () => { setCallFormOpen(false); setCallNotice(null); },
        onCallField: setCallField,
        onCallSubmit: submitCall,
      });
    }

    function SkillViewView(props) {
      const p = props || {};
      const registry = p.registry && typeof p.registry === 'object' ? p.registry : { phase: 'loading', skills: [], error: null };
      const calls = p.calls && typeof p.calls === 'object' ? p.calls : { phase: 'loading', calls: [], nextBefore: null, error: null };
      const registrySkills = Array.isArray(registry.skills) ? registry.skills : [];
      const callList = Array.isArray(calls.calls) ? calls.calls : [];
      const grid = buildSkillCallMonthGrid(p.year, p.month, callList);
      const dayCalls = p.selectedDate && grid.groups[p.selectedDate] ? grid.groups[p.selectedDate] : [];
      const callForm = p.callForm && typeof p.callForm === 'object'
        ? p.callForm
        : { skillId: '', task: '', result: 'ok', reason: '', outputs: '' };
      const callHasSkills = registrySkills.length > 0;
      const callValidation = validateSkillCallForm(callForm, callHasSkills);
      const callNotice = p.callNotice && p.callNotice.kind ? p.callNotice : null;
      const callMissingLabels = {
        skillId: '技能',
        task: '任务描述',
        taskTooLong: '任务描述（≤200 字符）',
        reason: '失败原因（≥4 字符）',
      };
      const callFormBox = p.callFormOpen === true
        ? h('section', { className: 'jk-kb-curate jk-kb-skill-call-form', 'data-jk-kb-skill-call-form': 'true' },
            h('h3', { className: 'jk-kb-curate-title' }, '记录一次调用'),
            callHasSkills
              ? [
                  h('label', { key: 'call-skill-label', className: 'jk-kb-field' }, '技能'),
                  h('select', {
                    key: 'call-skill',
                    className: 'jk-kb-select',
                    'data-jk-kb-call-skill': 'true',
                    value: typeof callForm.skillId === 'string' ? callForm.skillId : '',
                    onChange: (event) => {
                      if (typeof p.onCallField === 'function') p.onCallField('skillId', event && event.target ? event.target.value : '');
                    },
                  },
                    h('option', { value: '' }, '请选择技能'),
                    registrySkills.map((skill) => h('option', { key: skill.id, value: skill.id }, skill.id + ' · ' + skill.name))
                  ),
                ]
              : h('p', { className: 'jk-kb-hint', 'data-jk-kb-call-no-skills': 'true' }, '还没有自定义 SKILL，请先新建'),
            h('label', { className: 'jk-kb-field' }, '任务描述（必填，≤200 字符）'),
            h('input', {
              type: 'text',
              className: 'jk-kb-field-input',
              'data-jk-kb-call-task': 'true',
              value: typeof callForm.task === 'string' ? callForm.task : '',
              onChange: (event) => {
                if (typeof p.onCallField === 'function') p.onCallField('task', event && event.target ? event.target.value : '');
              },
            }),
            h('label', { className: 'jk-kb-field' }, '结果'),
            h('select', {
              className: 'jk-kb-select',
              'data-jk-kb-call-result': 'true',
              value: normalizeSkillCallResult(callForm.result),
              onChange: (event) => {
                if (typeof p.onCallField === 'function') p.onCallField('result', event && event.target ? event.target.value : 'ok');
              },
            },
              h('option', { value: 'ok' }, '成功'),
              h('option', { value: 'fail' }, '失败')
            ),
            h('label', { className: 'jk-kb-field' }, '失败原因（result=fail 必填，≥4 字符）'),
            h('input', {
              type: 'text',
              className: 'jk-kb-field-input',
              'data-jk-kb-call-reason': 'true',
              value: typeof callForm.reason === 'string' ? callForm.reason : '',
              onChange: (event) => {
                if (typeof p.onCallField === 'function') p.onCallField('reason', event && event.target ? event.target.value : '');
              },
            }),
            h('label', { className: 'jk-kb-field' }, '产物路径（每行一个，仅 03..12 顶层目录）'),
            h('textarea', {
              className: 'jk-kb-textarea',
              'data-jk-kb-call-outputs': 'true',
              value: typeof callForm.outputs === 'string' ? callForm.outputs : '',
              rows: 3,
              onChange: (event) => {
                if (typeof p.onCallField === 'function') p.onCallField('outputs', event && event.target ? event.target.value : '');
              },
            }),
            callValidation.ok === true
              ? null
              : h('p', { className: 'jk-kb-hint', 'data-jk-kb-call-required': 'true' },
                  '还需填写：' + callValidation.missing.map((key) => callMissingLabels[key] || key).join('、')),
            callNotice
              ? h('p', {
                  className: 'jk-kb-notice jk-kb-notice-' + callNotice.kind,
                  'data-jk-kb-skill-call-notice': callNotice.kind,
                  'aria-live': 'polite',
                }, callNotice.text)
              : null,
            h('div', { className: 'jk-kb-curate-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save jk-kb-guide-cta',
                'data-jk-kb-call-submit': 'true',
                disabled: callValidation.ok !== true || p.callBusy === true,
                onClick: typeof p.onCallSubmit === 'function' ? p.onCallSubmit : undefined,
              }, p.callBusy === true ? '提交中…' : '提交回执'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-call-cancel': 'true',
                onClick: typeof p.onCallClose === 'function' ? p.onCallClose : undefined,
              }, '取消')
            )
          )
        : null;

      const registrySection = h('section', {
        className: 'jk-kb-skill-registry',
        'data-jk-kb-skill-registry': registry.phase,
      },
        h('div', { className: 'jk-kb-reports-head' },
          h('h3', { className: 'jk-kb-section-title' }, '已登记 SKILL'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-skill-view-refresh': 'true',
            disabled: registry.phase === 'loading' && calls.phase === 'loading',
            onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
          }, (registry.phase === 'loading' && calls.phase === 'loading') ? '加载中…' : '刷新'),
          h('button', {
            type: 'button',
            className: 'jk-kb-btn',
            'data-jk-kb-skill-call-new': 'true',
            onClick: () => { if (typeof p.onCallOpen === 'function') p.onCallOpen(''); },
          }, '记录一次调用')
        ),
        registry.phase === 'error'
          ? h('div', { className: 'jk-kb-error', 'data-jk-kb-skill-registry-error': 'true' },
              h('h3', { className: 'jk-kb-placeholder-title' }, '技能库不可用'),
              h('p', { className: 'jk-kb-hint' }, '无法读取技能注册表（' + HOST_SKILL_REGISTRY_PATH + '）。'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-skill-registry-retry': 'true',
                onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
              }, '重试')
            )
          : null,
        registry.phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-registry-loading': 'true' }, '正在读取技能注册表…')
          : null,
        registry.phase === 'ready' && registrySkills.length === 0
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-registry-empty': 'true' }, '还没有自定义 SKILL，点上方『新建技能』')
          : null,
        registry.phase === 'ready' && registrySkills.length > 0
          ? h('ul', { className: 'jk-kb-skill-list', 'data-jk-kb-skill-registry-list': 'true' },
              registrySkills.map((skill) => h('li', {
                key: skill.id,
                className: 'jk-kb-skill-item',
                'data-jk-kb-skill': skill.id,
              },
                h('span', { className: 'jk-kb-skill-id', 'data-jk-kb-skill-id': skill.id }, skill.id),
                h('span', { className: 'jk-kb-skill-name' }, skill.name),
                h('span', { className: 'jk-kb-skill-meta' }, skill.version),
                skill.status ? h('span', { className: 'jk-kb-skill-status' }, skill.status) : null,
                h('span', { className: 'jk-kb-skill-keywords' }, skill.keywords.length > 0 ? skill.keywords.join('、') : '—'),
                h('button', {
                  type: 'button',
                  className: 'jk-kb-btn',
                  'data-jk-kb-skill-path': skill.id,
                  disabled: !skill.path,
                  onClick: () => { if (typeof p.onCopyPath === 'function') p.onCopyPath(skill.path); },
                }, '复制路径'),
                h('button', {
                  type: 'button',
                  className: 'jk-kb-btn',
                  'data-jk-kb-skill-call-entry': skill.id,
                  onClick: () => { if (typeof p.onCallOpen === 'function') p.onCallOpen(skill.id); },
                }, '记录一次调用')
              ))
            )
          : null
      );

      const callsSection = h('section', {
        className: 'jk-kb-skill-calls',
        'data-jk-kb-skill-calls': calls.phase,
      },
        h('div', { className: 'jk-kb-cal-head' },
          h('h3', { className: 'jk-kb-section-title' }, '调用日志'),
          h('button', { type: 'button', className: 'jk-kb-btn', 'data-jk-kb-skill-calls-prev': 'true', onClick: p.onPrev }, '‹'),
          h('span', { className: 'jk-kb-cal-label', 'data-jk-kb-skill-calls-label': 'true' }, p.year + '年' + p.month + '月'),
          h('button', { type: 'button', className: 'jk-kb-btn', 'data-jk-kb-skill-calls-next': 'true', onClick: p.onNext }, '›')
        ),
        calls.phase === 'error'
          ? h('div', { className: 'jk-kb-error', 'data-jk-kb-skill-calls-error': 'true' },
              h('h3', { className: 'jk-kb-placeholder-title' }, '技能库不可用'),
              h('p', { className: 'jk-kb-hint' }, '无法读取调用日志（' + HOST_SKILL_CALLS_PATH + '）。'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-skill-calls-retry': 'true',
                onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
              }, '重试')
            )
          : null,
        calls.phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-calls-loading': 'true' }, '正在读取调用日志…')
          : null,
        calls.phase === 'ready'
          ? h('div', null,
              h('div', { className: 'jk-kb-cal-grid', 'data-jk-kb-skill-calls-grid': 'month' },
                WEEKDAY_LABELS.map((labelText, index) => h('span', { key: 'weekday-' + index, className: 'jk-kb-cal-weekday' }, labelText)),
                grid.cells.map((cell) => (cell.blank
                  ? h('span', { key: cell.key, className: 'jk-kb-cal-cell jk-kb-cal-cell-blank' })
                  : h('button', {
                      key: cell.key,
                      type: 'button',
                      className: 'jk-kb-cal-cell jk-kb-cal-day'
                        + (cell.hasTasks ? ' jk-kb-cal-day-active' : '')
                        + (cell.date === p.today ? ' jk-kb-cal-today' : '')
                        + (cell.date === p.selectedDate ? ' jk-kb-cal-selected' : ''),
                      'data-jk-kb-skill-call-day': cell.date,
                      'data-jk-kb-skill-call-count': String(cell.runCount),
                      'data-jk-kb-skill-call-failed': cell.hasFailed ? 'true' : undefined,
                      'data-jk-kb-skill-call-today': cell.date === p.today ? 'true' : undefined,
                      onClick: () => { if (typeof p.onSelectDay === 'function') p.onSelectDay(cell.date); },
                    },
                      h('span', { className: 'jk-kb-cal-day-number' }, String(cell.day)),
                      cell.hasTasks ? h('span', { className: 'jk-kb-cal-day-count' }, String(cell.runCount)) : null,
                      cell.hasFailed ? h('span', { className: 'jk-kb-cal-day-failed', 'data-jk-kb-skill-call-failed-dot': 'true' }, '●') : null
                    )))
              ),
              Object.keys(grid.groups).length === 0
                ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-calls-empty': 'true' }, '本月暂无调用')
                : null
            )
          : null,
        p.selectedDate
          ? h('div', { className: 'jk-kb-ledger-day', 'data-jk-kb-skill-call-day-panel': p.selectedDate },
              h('h3', { className: 'jk-kb-section-title' }, p.selectedDate + ' 调用'),
              dayCalls.length > 0
                ? h('ul', { className: 'jk-kb-ledger-runs', 'data-jk-kb-skill-calls-day-list': 'true' },
                    dayCalls.map((call) => h('li', { key: call.key, className: 'jk-kb-ledger-run-item' },
                      h('div', { className: 'jk-kb-ledger-run', 'data-jk-kb-skill-call': call.key },
                        h('span', { className: 'jk-kb-skill-call-time', 'data-jk-kb-skill-call-time': call.key }, call.tsText),
                        h('span', { className: 'jk-kb-skill-call-name' }, call.name + ' ' + call.version),
                        h('span', { className: 'jk-kb-skill-call-task' }, call.task),
                        h('span', {
                          className: 'jk-kb-status ' + (call.result === 'fail' ? 'jk-kb-status-failed' : (call.result === 'ok' ? 'jk-kb-status-done' : '')),
                        }, call.resultLabel),
                        call.reason ? h('span', { className: 'jk-kb-skill-call-reason', 'data-jk-kb-skill-call-reason': call.key }, call.reason) : null,
                        h('span', { className: 'jk-kb-skill-call-outputs', 'data-jk-kb-skill-call-outputs': call.key },
                          call.outputs.length > 0 ? call.outputs.join('、') : '—')
                      )
                    ))
                  )
                : h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-calls-day-empty': 'true' }, '当天暂无调用')
            )
          : null
      );

      return h('div', { className: 'jk-kb-skill-view', 'data-jk-kb-skill-view': 'true' },
        callFormBox,
        registrySection,
        callsSection
      );
    }

    // 整理报告：进入页面取一次 + 手动刷新；不挂定时器。
    function ReportsPanel(props) {
      const p = props || {};
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const [state, setState] = React.useState({ phase: 'loading', reports: [], error: null });
      const [expandedId, setExpandedId] = React.useState('');
      const [reload, setReload] = React.useState(0);
      const [archive, setArchive] = React.useState({ target: null, confirmed: false, busy: false, notice: null, preview: [] });

      React.useEffect(function () {
        let alive = true;
        setState((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchReports({ limit: REPORTS_PAGE_LIMIT }).then((result) => {
          if (!alive) return;
          const norm = normalizeReportsResponse(result);
          setState(norm.ok === true
            ? { phase: 'ready', reports: norm.reports, error: null }
            : { phase: 'error', reports: [], error: norm.error });
        });
        return function () { alive = false; aliveRef.current = false; };
      }, [reload]);

      function openArchive(finding) {
        setArchive({ target: finding || null, confirmed: false, busy: false, notice: null, preview: [] });
      }

      function closeArchive() {
        setArchive({ target: null, confirmed: false, busy: false, notice: null, preview: [] });
      }

      async function submitArchive() {
        if (!archive.target || archive.confirmed !== true || archive.busy) return;
        setArchive((prev) => Object.assign({}, prev, { busy: true, notice: null }));
        const outcome = await startArchiveRequest(archive.target);
        if (!aliveRef.current) return;
        const plan = planArchiveResult(outcome);
        setArchive((prev) => Object.assign({}, prev, {
          target: plan.closeDialog ? null : prev.target,
          confirmed: false,
          busy: false,
          notice: plan.notice,
          preview: Array.isArray(plan.preview) ? plan.preview : [],
        }));
        if (plan.refreshReports) setReload(reload + 1);
        if (plan.notifyRuns && typeof p.onArchived === 'function') p.onArchived();
        if (outcome && Array.isArray(outcome.checks) && outcome.checks.length > 0
          && typeof p.onArchiveChecks === 'function') {
          p.onArchiveChecks({ code: outcome.code, checks: outcome.checks });
        }
      }

      return ReportsView({
        phase: state.phase,
        reports: state.reports,
        error: state.error,
        expandedId: expandedId,
        onToggleReport: (id) => setExpandedId(expandedId === id ? '' : id),
        onRefresh: () => setReload(reload + 1),
        onRetry: () => setReload(reload + 1),
        onOpenPath: (path) => openReportPath(path),
        onCopyPath: (path) => copyToClipboard(path),
        archiveTarget: archive.target,
        archiveConfirmed: archive.confirmed,
        archiveBusy: archive.busy,
        archiveNotice: archive.notice,
        archivePreview: archive.preview,
        onArchiveRequest: openArchive,
        onArchiveClose: closeArchive,
        onArchiveConfirm: (checked) => setArchive((prev) => Object.assign({}, prev, { confirmed: checked === true })),
        onArchiveSubmit: submitArchive,
      });
    }

    function ReportsView(props) {
      const p = props || {};
      const phase = p.phase || 'loading';
      const reports = Array.isArray(p.reports) ? p.reports : [];
      const expandedId = typeof p.expandedId === 'string' ? p.expandedId : '';
      const archiveTarget = p.archiveTarget && typeof p.archiveTarget === 'object' ? p.archiveTarget : null;
      const archiveConfirmed = p.archiveConfirmed === true;
      const archiveBusy = p.archiveBusy === true;
      const archiveNotice = p.archiveNotice && p.archiveNotice.kind ? p.archiveNotice : null;
      const archivePreview = Array.isArray(p.archivePreview) ? p.archivePreview : [];

      const header = h('div', { className: 'jk-kb-reports-head' },
        h('h3', { className: 'jk-kb-section-title' }, '整理报告'),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-reports-refresh': 'true',
          disabled: phase === 'loading',
          onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
        }, phase === 'loading' ? '加载中…' : '刷新')
      );

      const errorBox = phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-reports-error': 'true' },
            h('h3', { className: 'jk-kb-placeholder-title' }, '报告不可用'),
            h('p', { className: 'jk-kb-hint' },
              '无法读取整理报告（' + HOST_REPORTS_PATH + '）。任务列表与日历不受影响。'),
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-reports-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const archiveIsDir = !!archiveTarget && (archiveTarget.ruleId === 'M06' || archiveTarget.kind === 'dir');
      const archiveDialog = archiveTarget
        ? h('div', {
            className: 'jk-kb-confirm jk-kb-archive-confirm',
            'data-jk-kb-archive-confirm': 'true',
            'data-jk-kb-archive-kind': archiveIsDir ? 'dir' : 'file',
            role: 'alertdialog',
          },
            h('p', { className: 'jk-kb-risk-title' }, archiveIsDir ? '确认归档整个目录？' : '确认归档？'),
            h('p', { className: 'jk-kb-hint' }, archiveIsDir
              ? '归档会移动整个目录到 12_归档与历史，目录内文件与结构保持不变；不会删除内容。'
              : '归档会移动文件到 12_归档与历史，四要素会写进文件头；不会删除内容。'),
            h('div', { className: 'jk-kb-acceptance' },
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '原路径'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-archive-from': 'true' }, archiveTarget.path || '—')
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '目标路径'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-archive-to': 'true' }, archiveTarget.proposedTarget || '—')
              ),
              h('div', { className: 'jk-kb-detail-row' },
                h('span', { className: 'jk-kb-detail-key' }, '归档原因'),
                h('span', { className: 'jk-kb-detail-value', 'data-jk-kb-archive-reason': 'true' }, archiveTarget.archiveReason || '—')
              )
            ),
            archivePreview.length > 0
              ? h('ul', { className: 'jk-kb-skill-matches', 'data-jk-kb-archive-preview': 'true' },
                  archivePreview.map((item, index) => h('li', {
                    key: 'preview-' + index,
                    className: 'jk-kb-skill-match',
                    'data-jk-kb-archive-preview-item': String(index),
                  }, (item && item.from ? item.from : '—') + ' → ' + (item && item.to ? item.to : '—')
                    + (item && item.reason ? '（' + item.reason + '）' : ''))))
              : null,
            h('label', { className: 'jk-kb-ack' },
              h('input', {
                type: 'checkbox',
                className: 'jk-kb-ack-box',
                'data-jk-kb-archive-ack': 'true',
                checked: archiveConfirmed,
                onChange: (event) => {
                  if (typeof p.onArchiveConfirm === 'function') {
                    p.onArchiveConfirm(event && event.target ? !!event.target.checked : false);
                  }
                },
              }),
              h('span', { className: 'jk-kb-ack-text' }, '我已确认')
            ),
            archiveNotice
              ? h('p', {
                  className: 'jk-kb-notice jk-kb-notice-' + archiveNotice.kind,
                  'data-jk-kb-archive-notice': archiveNotice.kind,
                  'aria-live': 'polite',
                }, archiveNotice.text)
              : null,
            h('div', { className: 'jk-kb-root-actions' },
              h('button', {
                type: 'button',
                className: 'jk-kb-save',
                'data-jk-kb-archive-submit': 'true',
                disabled: !archiveConfirmed || archiveBusy,
                onClick: typeof p.onArchiveSubmit === 'function' ? p.onArchiveSubmit : undefined,
              }, archiveBusy ? '提交中…' : '确认归档'),
              h('button', {
                type: 'button',
                className: 'jk-kb-btn',
                'data-jk-kb-archive-cancel': 'true',
                onClick: typeof p.onArchiveClose === 'function' ? p.onArchiveClose : undefined,
              }, '取消')
            )
          )
        : null;

      const list = phase === 'ready'
        ? (reports.length === 0
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-reports-empty': 'true' }, '还没有整理报告，点上方「整理」开始一次只读扫描')
            : h('ul', { className: 'jk-kb-reports', 'data-jk-kb-reports': 'true' },
                reports.map((report) => {
                  const expanded = expandedId === report.id;
                  const groups = expanded ? groupReportFindings(report.findings) : [];
                  const hasProposal = groups.some((group) => group.items.some((item) => item.proposedTarget));
                  let findingsBlock = null;
                  if (expanded) {
                    findingsBlock = groups.length > 0
                      ? h('div', { className: 'jk-kb-report-findings', 'data-jk-kb-report-findings': report.id },
                          groups.map((group) => h('section', {
                            key: group.key,
                            className: 'jk-kb-report-group',
                            'data-jk-kb-report-group': group.ruleId,
                          },
                            h('h4', { className: 'jk-kb-report-rule' }, group.ruleId + '（' + group.items.length + '）'),
                            h('ul', { className: 'jk-kb-report-rule-items' },
                              group.items.map((finding) => h('li', {
                                key: finding.key,
                                className: 'jk-kb-report-finding',
                                'data-jk-kb-report-finding': finding.key,
                              },
                                h('p', { className: 'jk-kb-report-path' }, finding.path),
                                finding.proposedTarget
                                  ? h('p', {
                                      className: 'jk-kb-report-proposed',
                                      'data-jk-kb-report-proposed': finding.key,
                                    }, '建议归档到 ' + finding.proposedTarget)
                                  : null,
                                finding.archiveReason
                                  ? h('p', {
                                      className: 'jk-kb-check-detail',
                                      'data-jk-kb-report-archive-reason': finding.key,
                                    }, '原因：' + finding.archiveReason)
                                  : null,
                                (finding.ruleId === 'M06' || finding.ruleId === 'M07')
                                  ? h('button', {
                                      type: 'button',
                                      className: 'jk-kb-btn',
                                      'data-jk-kb-archive-button': finding.key,
                                      'data-jk-kb-archive-kind': (finding.ruleId === 'M06' || finding.kind === 'dir') ? 'dir' : 'file',
                                      onClick: () => { if (typeof p.onArchiveRequest === 'function') p.onArchiveRequest(finding); },
                                    }, (finding.ruleId === 'M06' || finding.kind === 'dir') ? '归档目录' : '归档')
                                  : null,
                                finding.title
                                  ? h('p', { className: 'jk-kb-report-title' }, finding.title)
                                  : null,
                                h('p', { className: 'jk-kb-check-detail' }, '说明：' + finding.detail),
                                h('p', { className: 'jk-kb-check-detail', 'data-jk-kb-report-basis': finding.key }, '依据：' + finding.basis),
                                h('p', { className: 'jk-kb-check-detail', 'data-jk-kb-report-threshold': finding.key }, '阈值：' + finding.threshold)
                              ))
                            )
                          ))
                        )
                      : h('p', { className: 'jk-kb-hint', 'data-jk-kb-report-no-findings': report.id }, '该报告未附带明细');
                  }
                  return h('li', { key: report.id, className: 'jk-kb-report-item', 'data-jk-kb-report-item': report.id },
                    h('div', { className: 'jk-kb-report-row' },
                      h('button', {
                        type: 'button',
                        className: 'jk-kb-report-summary-btn',
                        'data-jk-kb-report': report.id,
                        'aria-expanded': expanded,
                        onClick: () => { if (typeof p.onToggleReport === 'function') p.onToggleReport(report.id); },
                      },
                        h('span', { className: 'jk-kb-report-period', 'data-jk-kb-report-period': report.id }, report.period),
                        h('span', { className: 'jk-kb-report-summary', 'data-jk-kb-report-summary': report.id }, report.summary),
                        h('span', { className: 'jk-kb-report-time', 'data-jk-kb-report-created': report.id }, report.createdAtText)
                      ),
                      h('div', { className: 'jk-kb-report-actions' },
                        h('button', {
                          type: 'button',
                          className: 'jk-kb-btn',
                          'data-jk-kb-report-open': report.id,
                          disabled: !report.path,
                          onClick: () => { if (typeof p.onOpenPath === 'function') p.onOpenPath(report.path); },
                        }, '打开'),
                        h('button', {
                          type: 'button',
                          className: 'jk-kb-btn',
                          'data-jk-kb-report-copy': report.id,
                          disabled: !report.path,
                          onClick: () => { if (typeof p.onCopyPath === 'function') p.onCopyPath(report.path); },
                        }, '复制路径')
                      )
                    ),
                    findingsBlock
                  );
                })
              ))
        : null;

      return h('section', { className: 'jk-kb-reports', 'data-jk-kb-reports-panel': phase },
        header,
        errorBox,
        archiveDialog,
        phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-reports-loading': 'true' }, '正在读取整理报告…')
          : null,
        list
      );
    }

    // 视图切换只影响右栏内容，不改左栏菜单条目。
    function TasksPage(props) {
      const p = props || {};
      const [viewMode, setViewMode] = React.useState('list');
      const [runsReloadKey, setRunsReloadKey] = React.useState(0);
      const [doctorOpen, setDoctorOpen] = React.useState(false);
      const [archiveChecks, setArchiveChecks] = React.useState(null);
      return h('div', {
        className: 'jk-kb-tasks-page',
        'data-jk-kb-tasks-page': 'true',
        'data-jk-kb-view': viewMode,
      },
        TasksPageHeader({
          viewMode: viewMode,
          onChange: setViewMode,
          onDoctorOpen: () => setDoctorOpen(true),
        }),
        h(DoctorPanel, {
          open: doctorOpen,
          onClose: () => setDoctorOpen(false),
          onGoTasks: () => setViewMode('list'),
        }),
        viewMode === 'calendar'
          ? h(LedgerCalendarPage, { onOpenRun: p.onOpenRun })
          : (viewMode === 'skills'
              ? h(SkillViewPage, null)
              : h(RunsBoardPage, {
                  onOpenRun: p.onOpenRun,
                  reloadKey: runsReloadKey,
                  archiveChecks: archiveChecks,
                  seedFeed: p.seedFeed,
                  onFeed: p.onFeed,
                })),
        h(ReportsPanel, {
          onArchived: () => setRunsReloadKey(runsReloadKey + 1),
          onArchiveChecks: (payload) => setArchiveChecks(payload),
        })
      );
    }

    // 日历页：按视图/游标加载，手动刷新；不挂任何定时器。
    function LedgerCalendarPage(props) {
      const p = props || {};
      const now = new Date();
      const [mode, setMode] = React.useState('month');
      const [cursor, setCursor] = React.useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
      const [reload, setReload] = React.useState(0);
      const [calendar, setCalendar] = React.useState({ phase: 'loading', data: null, error: null });
      const [selectedDate, setSelectedDate] = React.useState('');
      const [day, setDay] = React.useState({ phase: 'idle', data: null, error: null });

      React.useEffect(function () {
        let alive = true;
        setCalendar((prev) => Object.assign({}, prev, { phase: 'loading' }));
        const request = mode === 'year'
          ? fetchLedgerCalendar({ year: cursor.year })
          : fetchLedgerCalendar({ year: cursor.year, month: cursor.month });
        request.then((result) => {
          if (!alive) return;
          const norm = normalizeLedgerResponse(result);
          setCalendar({
            phase: norm.ok === true ? 'ready' : 'error',
            data: norm.ok === true ? norm.data : null,
            error: norm.ok === true ? null : norm.error,
          });
        });
        return function () { alive = false; };
      }, [mode, cursor.year, cursor.month, reload]);

      React.useEffect(function () {
        if (!selectedDate) {
          setDay({ phase: 'idle', data: null, error: null });
          return function () {};
        }
        let alive = true;
        setDay((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchLedgerDay(selectedDate).then((result) => {
          if (!alive) return;
          const norm = normalizeLedgerResponse(result);
          setDay({
            phase: norm.ok === true ? 'ready' : 'error',
            data: norm.ok === true ? norm.data : null,
            error: norm.ok === true ? null : norm.error,
          });
        });
        return function () { alive = false; };
      }, [selectedDate, reload]);

      function shiftMonth(delta) {
        const total = cursor.year * 12 + (cursor.month - 1) + delta;
        setCursor({ year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 + 1 });
        setSelectedDate('');
      }

      function shiftYear(delta) {
        setCursor({ year: cursor.year + delta, month: cursor.month });
        setSelectedDate('');
      }

      function toggleMode() {
        setMode(mode === 'month' ? 'year' : 'month');
        setSelectedDate('');
      }

      function selectMonth(month) {
        setCursor({ year: cursor.year, month: month });
        setMode('month');
        setSelectedDate('');
      }

      return LedgerCalendarView({
        mode: mode,
        year: cursor.year,
        month: cursor.month,
        today: toLocalDateString(new Date()),
        phase: calendar.phase,
        calendar: calendar.data ? presentLedger(calendar.data) : null,
        error: calendar.error,
        selectedDate: selectedDate,
        dayPhase: day.phase,
        day: day.data ? presentLedgerDay(day.data) : null,
        dayError: day.error,
        onPrev: () => (mode === 'year' ? shiftYear(-1) : shiftMonth(-1)),
        onNext: () => (mode === 'year' ? shiftYear(1) : shiftMonth(1)),
        onToggleMode: toggleMode,
        onRefresh: () => setReload(reload + 1),
        onSelectDay: (date) => setSelectedDate(date),
        onSelectMonth: selectMonth,
        onRetry: () => setReload(reload + 1),
        onOpenRun: p.onOpenRun,
      });
    }

    function LedgerCalendarView(props) {
      const p = props || {};
      const mode = p.mode === 'year' ? 'year' : 'month';
      const phase = p.phase || 'loading';
      const calendar = p.calendar && typeof p.calendar === 'object'
        ? p.calendar
        : (mode === 'year' ? presentLedgerYear(null) : presentLedgerMonth(null));
      const label = mode === 'year'
        ? (calendar.yearLabel || '—')
        : (calendar.monthLabel || '—');

      const header = h('div', { className: 'jk-kb-cal-head' },
        h('button', { type: 'button', className: 'jk-kb-btn', 'data-jk-kb-cal-prev': 'true', onClick: p.onPrev }, '‹'),
        h('span', { className: 'jk-kb-cal-label', 'data-jk-kb-cal-label': 'true' }, label),
        h('button', { type: 'button', className: 'jk-kb-btn', 'data-jk-kb-cal-next': 'true', onClick: p.onNext }, '›'),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-cal-mode': mode === 'month' ? 'year' : 'month',
          onClick: p.onToggleMode,
        }, mode === 'month' ? '年' : '月'),
        h('button', {
          type: 'button',
          className: 'jk-kb-btn',
          'data-jk-kb-cal-refresh': 'true',
          onClick: p.onRefresh,
        }, '刷新'),
        h('span', { className: 'jk-kb-cal-totals', 'data-jk-kb-cal-totals': 'true' },
          '共 ' + calendar.totals.runCount + ' 次 · 失败 ' + calendar.totals.failed
          + ' · 耗时 ' + calendar.totals.durationText + ' · token ' + calendar.totals.tokenText)
      );

      const errorBox = phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-ledger-error': 'true' },
            h('h3', { className: 'jk-kb-placeholder-title' }, '台账不可用'),
            h('p', { className: 'jk-kb-hint' },
              '无法读取台账接口（' + HOST_LEDGER_CALENDAR_PATH + '）。列表视图不受影响。'),
            h('button', {
              type: 'button',
              className: 'jk-kb-btn',
              'data-jk-kb-ledger-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const monthCells = mode === 'month' ? buildMonthGrid(p.year, p.month, calendar.days) : [];
      const monthEmpty = mode === 'month' && calendar.days.length === 0;

      const monthGrid = mode === 'month'
        ? h('div', null,
            h('div', { className: 'jk-kb-cal-grid', 'data-jk-kb-cal-grid': 'month' },
              WEEKDAY_LABELS.map((labelText, index) => h('span', {
                key: 'weekday-' + index,
                className: 'jk-kb-cal-weekday',
              }, labelText)),
              monthCells.map((cell) => (cell.blank
                ? h('span', { key: cell.key, className: 'jk-kb-cal-cell jk-kb-cal-cell-blank' })
                : h('button', {
                    key: cell.key,
                    type: 'button',
                    className: 'jk-kb-cal-cell jk-kb-cal-day'
                      + (cell.hasTasks ? ' jk-kb-cal-day-active' : '')
                      + (cell.date === p.today ? ' jk-kb-cal-today' : '')
                      + (cell.date === p.selectedDate ? ' jk-kb-cal-selected' : ''),
                    'data-jk-kb-cal-day': cell.date,
                    'data-jk-kb-cal-has-tasks': cell.hasTasks ? 'true' : undefined,
                    'data-jk-kb-cal-has-failed': cell.hasFailed ? 'true' : undefined,
                    'data-jk-kb-cal-has-token': cell.hasToken ? 'true' : undefined,
                    'data-jk-kb-cal-today': cell.date === p.today ? 'true' : undefined,
                    onClick: () => { if (typeof p.onSelectDay === 'function') p.onSelectDay(cell.date); },
                  },
                    h('span', { className: 'jk-kb-cal-day-number' }, String(cell.day)),
                    cell.hasTasks
                      ? h('span', { className: 'jk-kb-cal-day-count', 'data-jk-kb-cal-count': String(cell.runCount) }, String(cell.runCount))
                      : null,
                    cell.hasFailed
                      ? h('span', { className: 'jk-kb-cal-day-failed', 'data-jk-kb-cal-failed': 'true' }, '●')
                      : null,
                    cell.hasToken
                      ? h('span', { className: 'jk-kb-cal-day-token', 'data-jk-kb-cal-token': cell.tokenText }, cell.tokenText)
                      : null
                  )))
            ),
            monthEmpty
              ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-cal-empty': 'true' }, '本月暂无任务')
              : null
          )
        : null;

      const yearGrid = mode === 'year'
        ? h('div', { className: 'jk-kb-cal-year', 'data-jk-kb-cal-grid': 'year' },
            calendar.months.map((entry) => h('button', {
              key: 'month-' + entry.month,
              type: 'button',
              className: 'jk-kb-cal-month',
              'data-jk-kb-cal-month': String(entry.month),
              onClick: () => { if (typeof p.onSelectMonth === 'function') p.onSelectMonth(entry.month); },
            },
              h('span', { className: 'jk-kb-cal-month-label' }, entry.month + ' 月'),
              h('span', { className: 'jk-kb-cal-month-runs', 'data-jk-kb-cal-month-runs': String(entry.runCount) }, entry.runCount + ' 次'),
              entry.failed > 0
                ? h('span', { className: 'jk-kb-cal-month-failed', 'data-jk-kb-cal-month-failed': String(entry.failed) }, entry.failed + ' 失败')
                : null,
              entry.tokenText
                ? h('span', { className: 'jk-kb-cal-month-token', 'data-jk-kb-cal-month-token': entry.tokenText }, entry.tokenText)
                : null
            )))
        : null;

      const day = p.day && typeof p.day === 'object' ? p.day : null;
      const dayPanel = p.selectedDate
        ? h('div', { className: 'jk-kb-ledger-day', 'data-jk-kb-ledger-day': p.selectedDate },
            h('h3', { className: 'jk-kb-section-title' }, p.selectedDate + ' 任务'),
            p.dayPhase === 'loading'
              ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-ledger-day-loading': 'true' }, '正在读取当天任务…')
              : (p.dayPhase === 'error'
                  ? h('div', { className: 'jk-kb-error', 'data-jk-kb-ledger-error': 'true' },
                      h('h3', { className: 'jk-kb-placeholder-title' }, '台账不可用'),
                      h('button', {
                        type: 'button',
                        className: 'jk-kb-btn',
                        'data-jk-kb-ledger-retry': 'true',
                        onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
                      }, '重试')
                    )
                  : (day && day.runs.length > 0
                      ? h('ul', { className: 'jk-kb-ledger-runs', 'data-jk-kb-ledger-runs': 'true' },
                          day.runs.map((run) => h('li', { key: run.id, className: 'jk-kb-ledger-run-item' },
                            h('button', {
                              type: 'button',
                              className: 'jk-kb-ledger-run',
                              'data-jk-kb-ledger-run': run.id,
                              onClick: () => { if (typeof p.onOpenRun === 'function') p.onOpenRun(run.id); },
                            },
                              h('span', { className: 'jk-kb-ledger-run-title' }, run.title),
                              h('span', { className: 'jk-kb-status jk-kb-status-' + run.status }, run.statusLabel),
                              h('span', { className: 'jk-kb-ledger-run-meta' },
                                run.kindLabel + ' · ' + run.durationText + ' · ' + run.usageText)
                            )
                          ))
                        )
                      : h('p', { className: 'jk-kb-hint', 'data-jk-kb-ledger-day-empty': 'true' }, '当天暂无任务'))),
            day && p.dayPhase === 'ready'
              ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-ledger-day-totals': 'true' },
                  '共 ' + day.totals.runCount + ' 次 · 耗时 ' + day.totals.durationText + ' · token ' + day.totals.tokenText)
              : null
          )
        : null;

      return h('div', { className: 'jk-kb-calendar', 'data-jk-kb-calendar': mode },
        header,
        errorBox,
        phase === 'loading'
          ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-cal-loading': 'true' }, '正在读取台账…')
          : null,
        phase === 'ready' ? monthGrid : null,
        phase === 'ready' ? yearGrid : null,
        dayPanel
      );
    }

    // ───────────────────────────── 知识库主页面 ─────────────────────────────
    function KnowledgeBasePanel() {
      const [uiState, dispatch] = React.useReducer(reducePanel, null, createPanelState);
      const [rootState, setRootState] = React.useState({ status: 'loading', root: null, error: null });
      const [configReload, setConfigReload] = React.useState(0);
      const [sidebarReload, setSidebarReload] = React.useState(0);
      const [runsFeed, setRunsFeed] = React.useState({ phase: 'idle', runs: [], error: null });
      // 任务详情用页面级选中态（不是弹窗）：空串 = 列表，非空 = 该任务的独立详情页。
      const [selectedRunId, setSelectedRunId] = React.useState('');
      // 引导卡点「去设置」失败时的一行提示（拿不到 shortcuts 服务 / invoke 抛错）。
      const [guideHint, setGuideHint] = React.useState('');
      // 未配根目录：菜单只保留仪表盘，执行任务区改成骨架（不发任何数据请求）。
      const menuRootStatus = rootState.status === 'ready' && !rootState.root ? 'no-root' : rootState.status;
      const menus = visibleMenus(menuRootStatus);
      const activeMenu = menus.filter((menu) => menu.id === uiState.selected)[0] || menus[0];

      // 侧栏执行任务：与任务管理页共用同一份 /runs 结果（任务页挂载时由它推送 feed）。
      React.useEffect(function () {
        if (rootState.status !== 'ready' || !rootState.root) return function () {};
        if (activeMenu.id === TASKS_ID && runsFeed.phase !== 'error') return function () {};
        let alive = true;
        setRunsFeed((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchRuns({ limit: RUNS_PAGE_SIZE }).then((result) => {
          if (!alive) return;
          if (result && result.ok === true) {
            setRunsFeed({ phase: 'ready', runs: Array.isArray(result.runs) ? result.runs : [], error: null });
            return;
          }
          setRunsFeed({
            phase: 'error',
            runs: [],
            error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
          });
        });
        return function () { alive = false; };
      }, [rootState.status, rootState.root, activeMenu.id, sidebarReload]);

      async function openSettingsFromGuide() {
        const result = await openSettingsForRoot({});
        setGuideHint(result && result.ok === true ? '' : ((result && result.message) || GUIDE_STEP_HINT));
      }

      // 主页面自己读一次配置：host 不可用 / 根目录未配置时不能白屏。
      React.useEffect(() => {
        let alive = true;
        loadHostConfig().then((result) => {
          if (!alive) return;
          if (result && result.ok === true) {
            const settings = result.settings && typeof result.settings === 'object' ? result.settings : {};
            setRootState({
              status: 'ready',
              root: typeof settings.root === 'string' && settings.root ? settings.root : null,
              error: null,
            });
            return;
          }
          setRootState({
            status: 'error',
            root: null,
            error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
          });
        });
        return () => { alive = false; };
      }, [configReload]);

      return h('div', {
        className: 'jk-kb-panel',
        'data-dsh-plugin': PANEL_ID,
        'data-jk-kb-panel': PLUGIN_ID,
        'data-jk-kb-active': activeMenu.id,
      },
        h('style', { dangerouslySetInnerHTML: { __html: PANEL_STYLE } }),
        h('header', { className: 'jk-kb-panel-head' },
          h('div', null,
            h('h1', { className: 'jk-kb-title' }, '知识库'),
            h('p', { className: 'jk-kb-subtitle' }, '左栏选择菜单、下方查看执行任务，右栏显示当前菜单对应的页面。')
          ),
          null
        ),
        h('div', { className: 'jk-kb-panel-body' },
          h('aside', { className: 'jk-kb-side' },
            MenusNav({
              rootStatus: menuRootStatus,
              activeId: activeMenu.id,
              onSelect: (menuId) => {
                // 切菜单一律回到列表页：切走再回来不该停在上次的详情。
                setSelectedRunId('');
                dispatch({ type: 'select', id: menuId });
              },
            }),
            menuRootStatus === 'no-root'
              ? TaskListSkeleton()
              : SidebarTasks({
                  feed: runsFeed,
                  expanded: uiState.expanded,
                  onToggle: () => dispatch({ type: 'toggleTasks' }),
                  onRetry: () => setSidebarReload(sidebarReload + 1),
                  onSelectRun: (runId) => {
                    setSelectedRunId(runId == null ? '' : String(runId));
                    dispatch({ type: 'select', id: TASKS_ID });
                  },
                })
          ),
          h('section', { className: 'jk-kb-content', 'data-jk-kb-page': activeMenu.id },
            PanelContent({
              activeMenu: activeMenu,
              rootStatus: rootState.status,
              root: rootState.root,
              error: rootState.error,
              selectedRunId: selectedRunId,
              onOpenRun: (runId) => setSelectedRunId(runId == null ? '' : String(runId)),
              onBack: () => setSelectedRunId(''),
              runsFeed: runsFeed,
              onFeed: (feed) => setRunsFeed(feed),
              onOpenSettings: openSettingsFromGuide,
              onRetryHost: () => setConfigReload(configReload + 1),
              guideHint: guideHint,
            })
          )
        )
      );
    }

    // ───────────────────────────── 席位注册 ─────────────────────────────
    function apply(ctx) {
      pluginCtx = ctx || null;
      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

      const scope = typeof ctx.effect === 'function'
        ? ctx.effect
        : (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; };

      // 用已保存的开关状态初始化共享状态：刷新 / 重启后侧边栏入口立即恢复。
      store.set(readState(resolveStorage()));

      // 设置左栏图标：document 缺失时 installSettingsNavIcon 内部直接 no-op。
      scope(() => installSettingsNavIcon({ resolveLabel: () => NAV_LABEL_TEXT }), 'jk-knowledge-base: settings nav icon');

      scope(() => {
        // 设置子菜单常驻：无论开关开不开，设置页都要能进去把它打开。
        const disposeSettings = slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: PLUGIN_ID,
          // order:110 —— 排在 logo-substitute 的设置子菜单（order 100）之后，避免同值并列。
          order: 110,
          label: () => PLUGIN_NAME,
        }, SettingsSection));

        // 侧边栏菜单行 + 主区域页面：成对注册、成对释放。
        let disposePanels = [];

        function releasePanels() {
          const pending = disposePanels;
          disposePanels = [];
          pending.forEach((dispose) => { if (typeof dispose === 'function') dispose(); });
        }

        function syncPanels() {
          releasePanels();
          if (!isEnabled(store.get())) return;
          disposePanels = [
            // order:1 —— 官方「插件」行是 order 0，因此本行紧邻其正下方。
            slots.inject('sidebar.panellist', () => slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 1,
              label: () => '知识库',
            }, KnowledgeBaseIcon)),
            // 主区域页面：只在其被选中时由 layout 挂载。
            slots.inject('main', () => slots.register({
              name: 'main',
              key: PANEL_ID,
            }, KnowledgeBasePanel)),
          ];
        }

        syncPanels();
        const unsubscribe = store.subscribe(syncPanels);

        return () => {
          unsubscribe();
          releasePanels();
          if (typeof disposeSettings === 'function') disposeSettings();
        };
      }, 'jk-knowledge-base: slots');

      return undefined;
    }

    // 测试缝：仅供 tools/smoke-test.mjs 直接调用；DSH loader 只读 inject/apply。
    const __internals = {
      PLUGIN_ID: PLUGIN_ID,
      PANEL_ID: PANEL_ID,
      PLUGIN_NAME: PLUGIN_NAME,
      PLUGIN_VERSION: PLUGIN_VERSION,
      PLUGIN_AUTHOR: PLUGIN_AUTHOR,
      STORAGE_KEY: STORAGE_KEY,
      TASK_LIMIT: TASK_LIMIT,
      DASHBOARD_ID: DASHBOARD_ID,
      EXPERTS_ID: EXPERTS_ID,
      TASKS_ID: TASKS_ID,
      POLL_INTERVAL_MS: POLL_INTERVAL_MS,
      SETTINGS_STYLE: SETTINGS_STYLE,
      PANEL_STYLE: PANEL_STYLE,
      MENUS: MENUS,
      RUN_KINDS: RUN_KINDS,
      TASKS: TASKS,
      defaultState: defaultState,
      normalizeState: normalizeState,
      isEnabled: isEnabled,
      readState: readState,
      writeState: writeState,
      persistState: persistState,
      createStore: createStore,
      getStore: () => store,
      HOST_CONFIG_PATH: HOST_CONFIG_PATH,
      HOST_VALIDATE_PATH: HOST_VALIDATE_PATH,
      HOST_HEALTH_PATH: HOST_HEALTH_PATH,
      HOST_NOT_LOADED_MESSAGE: HOST_NOT_LOADED_MESSAGE,
      FOCUS_KEY: FOCUS_KEY,
      GUIDE_STEP_HINT: GUIDE_STEP_HINT,
      GUIDE_STEPS: GUIDE_STEPS,
      SWITCH_HINT_TEXT: SWITCH_HINT_TEXT,
      NAV_LABEL_TEXT: NAV_LABEL_TEXT,
      NAV_ROW_SELECTOR: NAV_ROW_SELECTOR,
      NAV_ICON_MARKER: NAV_ICON_MARKER,
      NAV_STYLE_SELECTOR: NAV_STYLE_SELECTOR,
      FOCUS_HIGHLIGHT_MS: FOCUS_HIGHLIGHT_MS,
      HOST_RUNS_PATH: HOST_RUNS_PATH,
      HOST_PREFLIGHT_PATH: HOST_PREFLIGHT_PATH,
      HOST_LEDGER_CALENDAR_PATH: HOST_LEDGER_CALENDAR_PATH,
      HOST_LEDGER_DAY_PATH: HOST_LEDGER_DAY_PATH,
      HOST_SKILLS_PATH: HOST_SKILLS_PATH,
      HOST_REPORTS_PATH: HOST_REPORTS_PATH,
      HOST_SKILL_REGISTRY_PATH: HOST_SKILL_REGISTRY_PATH,
      HOST_SKILL_CALLS_PATH: HOST_SKILL_CALLS_PATH,
      HOST_EXPERTS_PATH: HOST_EXPERTS_PATH,
      HOST_DASHBOARD_PATH: HOST_DASHBOARD_PATH,
      HOST_DOCTOR_PATH: HOST_DOCTOR_PATH,
      HOST_DOCTOR_REPAIR_PATH: HOST_DOCTOR_REPAIR_PATH,
      BUILTIN_SKILL_COUNT: BUILTIN_SKILL_COUNT,
      REPORT_RULE_ORDER: REPORT_RULE_ORDER,
      REPORTS_PAGE_LIMIT: REPORTS_PAGE_LIMIT,
      PREFLIGHT_FALLBACKS: PREFLIGHT_FALLBACKS,
      HOST_RUN_PATH: HOST_RUN_PATH,
      RISK_ACK_TEXT: RISK_ACK_TEXT,
      RISK_POINTS: RISK_POINTS,
      VAULT_TOP_LEVEL_COUNT: VAULT_TOP_LEVEL_COUNT,
      needsRiskAck: needsRiskAck,
      canSave: canSave,
      normalizeForCompare: normalizeForCompare,
      describeHostError: describeHostError,
      hasDirectoryPicker: hasDirectoryPicker,
      pickDirectory: pickDirectory,
      hostRequest: hostRequest,
      loadHostConfig: loadHostConfig,
      probeHost: probeHost,
      describeHealth: describeHealth,
      openSettingsForRoot: openSettingsForRoot,
      consumeFocusFlag: consumeFocusFlag,
      startFocusHighlight: startFocusHighlight,
      reduceInfoTip: reduceInfoTip,
      SwitchInfoView: SwitchInfoView,
      SwitchInfo: SwitchInfo,
      bookMaskSvg: bookMaskSvg,
      bookMaskUrl: bookMaskUrl,
      isOwnNavRow: isOwnNavRow,
      navIconCss: navIconCss,
      installSettingsNavIcon: installSettingsNavIcon,
      getPluginContext: () => pluginCtx,
      validateRoot: validateRoot,
      saveRoot: saveRoot,
      fetchRuns: fetchRuns,
      fetchRunDetail: fetchRunDetail,
      startHostRun: startHostRun,
      cancelHostRun: cancelHostRun,
      recoverHostRun: recoverHostRun,
      RECOVER_ACTIONS: RECOVER_ACTIONS,
      RECOVER_ACTION_IDS: RECOVER_ACTION_IDS,
      RUNS_PAGE_SIZE: RUNS_PAGE_SIZE,
      buildRunsQuery: buildRunsQuery,
      mergeRunPages: mergeRunPages,
      shouldPollRunsPage: shouldPollRunsPage,
      recoverActionLabel: recoverActionLabel,
      recoverConfirmText: recoverConfirmText,
      normalizeRecovery: normalizeRecovery,
      buildRecoverActions: buildRecoverActions,
      describeRecoverOutcome: describeRecoverOutcome,
      startRunRequest: startRunRequest,
      cancelRunRequest: cancelRunRequest,
      planRunStart: planRunStart,
      normalizeRunKind: normalizeRunKind,
      normalizeRunStatus: normalizeRunStatus,
      statusLabel: statusLabel,
      normalizeStepStatus: normalizeStepStatus,
      stepStatusLabel: stepStatusLabel,
      runKindLabel: runKindLabel,
      runKindActionLabel: runKindActionLabel,
      toMillis: toMillis,
      formatTimestamp: formatTimestamp,
      formatDuration: formatDuration,
      formatProgress: formatProgress,
      resolveNow: resolveNow,
      formatHeartbeatAge: formatHeartbeatAge,
      heartbeatThresholdMs: heartbeatThresholdMs,
      isSuspectedStall: isSuspectedStall,
      readBudget: readBudget,
      describeStallNotice: describeStallNotice,
      normalizeAcceptance: normalizeAcceptance,
      describeAcceptanceBadge: describeAcceptanceBadge,
      stepsAllGreen: stepsAllGreen,
      describeAcceptanceNotice: describeAcceptanceNotice,
      describeTopNotice: describeTopNotice,
      fetchPreflight: fetchPreflight,
      normalizePreflightResponse: normalizePreflightResponse,
      formatBytes: formatBytes,
      presentPreflight: presentPreflight,
      normalizeUsage: normalizeUsage,
      usageHasTokens: usageHasTokens,
      formatTokenCount: formatTokenCount,
      normalizeUsageSource: normalizeUsageSource,
      usageListText: usageListText,
      buildLedgerCalendarQuery: buildLedgerCalendarQuery,
      fetchLedgerCalendar: fetchLedgerCalendar,
      fetchLedgerDay: fetchLedgerDay,
      normalizeLedgerResponse: normalizeLedgerResponse,
      presentLedgerTotals: presentLedgerTotals,
      presentLedgerDayCell: presentLedgerDayCell,
      presentLedgerMonth: presentLedgerMonth,
      presentLedgerYear: presentLedgerYear,
      presentLedger: presentLedger,
      presentLedgerDay: presentLedgerDay,
      presentLedgerRun: presentLedgerRun,
      toLocalDateString: toLocalDateString,
      buildMonthGrid: buildMonthGrid,
      fetchSkills: fetchSkills,
      normalizeSkill: normalizeSkill,
      presentSkills: presentSkills,
      normalizeSkillsResponse: normalizeSkillsResponse,
      buildCuratePayload: buildCuratePayload,
      canSubmitCurate: canSubmitCurate,
      startCurateRequest: startCurateRequest,
      planCurateResult: planCurateResult,
      startMaintainRequest: startMaintainRequest,
      buildReportsQuery: buildReportsQuery,
      fetchReports: fetchReports,
      normalizeReportFinding: normalizeReportFinding,
      extractReportFindings: extractReportFindings,
      presentReport: presentReport,
      presentReports: presentReports,
      normalizeReportsResponse: normalizeReportsResponse,
      groupReportFindings: groupReportFindings,
      openReportPath: openReportPath,
      normalizeSkillText: normalizeSkillText,
      levenshtein: levenshtein,
      similarity: similarity,
      decideSkillCreate: decideSkillCreate,
      parseSkillList: parseSkillList,
      validateSkillForm: validateSkillForm,
      buildSkillPayload: buildSkillPayload,
      startSkillRequest: startSkillRequest,
      parseOutputs: parseOutputs,
      validateSkillCallForm: validateSkillCallForm,
      buildSkillCallPayload: buildSkillCallPayload,
      startSkillCallRequest: startSkillCallRequest,
      planSkillCallResult: planSkillCallResult,
      buildArchivePayload: buildArchivePayload,
      startArchiveRequest: startArchiveRequest,
      planArchiveResult: planArchiveResult,
      EXPERT_EMPTY_TEXT: EXPERT_EMPTY_TEXT,
      EXPERT_RESPONSIBILITY_MIN: EXPERT_RESPONSIBILITY_MIN,
      fetchExperts: fetchExperts,
      normalizeExpertSkillStates: normalizeExpertSkillStates,
      expertDanglingSkillIds: expertDanglingSkillIds,
      restoreExpertRequest: restoreExpertRequest,
      unbindExpertSkillRequest: unbindExpertSkillRequest,
      filterSkillGroupsByIds: filterSkillGroupsByIds,
      presentExpert: presentExpert,
      normalizeExpertsResponse: normalizeExpertsResponse,
      expertToForm: expertToForm,
      validateExpertForm: validateExpertForm,
      buildExpertPayload: buildExpertPayload,
      filterSkillGroups: filterSkillGroups,
      expertSkillNameMap: expertSkillNameMap,
      EXPERT_ERROR_MESSAGES: EXPERT_ERROR_MESSAGES,
      describeExpertError: describeExpertError,
      normalizeExpertWrite: normalizeExpertWrite,
      createExpertRequest: createExpertRequest,
      updateExpertRequest: updateExpertRequest,
      archiveExpertRequest: archiveExpertRequest,
      planExpertWriteResult: planExpertWriteResult,
      fetchDashboard: fetchDashboard,
      presentDashboard: presentDashboard,
      presentDashboardRecent: presentDashboardRecent,
      estimateWeekAdded: estimateWeekAdded,
      normalizeDashboardResponse: normalizeDashboardResponse,
      DOCTOR_LEVELS: DOCTOR_LEVELS,
      DOCTOR_LEVEL_LABELS: DOCTOR_LEVEL_LABELS,
      fetchDoctor: fetchDoctor,
      presentDoctorCheck: presentDoctorCheck,
      presentDoctor: presentDoctor,
      normalizeDoctorResponse: normalizeDoctorResponse,
      normalizeDoctorPlan: normalizeDoctorPlan,
      normalizeDoctorApplied: normalizeDoctorApplied,
      requestDoctorRepair: requestDoctorRepair,
      selectableRepairIds: selectableRepairIds,
      buildPagedQuery: buildPagedQuery,
      fetchSkillRegistry: fetchSkillRegistry,
      fetchSkillCalls: fetchSkillCalls,
      presentRegistrySkill: presentRegistrySkill,
      normalizeRegistryResponse: normalizeRegistryResponse,
      presentSkillCall: presentSkillCall,
      normalizeCallsResponse: normalizeCallsResponse,
      groupSkillCallsByDate: groupSkillCallsByDate,
      buildSkillCallMonthGrid: buildSkillCallMonthGrid,
      shouldBlockBootstrap: shouldBlockBootstrap,
      beginBootstrap: beginBootstrap,
      describeDegraded: describeDegraded,
      DEGRADED_REASONS: DEGRADED_REASONS,
      presentRun: presentRun,
      presentRuns: presentRuns,
      presentSteps: presentSteps,
      presentRunDetail: presentRunDetail,
      computeStepDepths: computeStepDepths,
      normalizeArtifacts: normalizeArtifacts,
      describeStepError: describeStepError,
      hasRunningRuns: hasRunningRuns,
      createRunsPageState: createRunsPageState,
      reduceRunsPage: reduceRunsPage,
      normalizeRunsResponse: normalizeRunsResponse,
      createRunDetailState: createRunDetailState,
      reduceRunDetail: reduceRunDetail,
      normalizeRunDetailResponse: normalizeRunDetailResponse,
      isRunConflict: isRunConflict,
      describeRunError: describeRunError,
      createPollController: createPollController,
      usePollingEffect: usePollingEffect,
      copyToClipboard: copyToClipboard,
      RootSection: RootSection,
      GuidancePage: GuidancePage,
      PanelContent: PanelContent,
      sliceTasks: sliceTasks,
      buildTasksView: buildTasksView,
      createPanelState: createPanelState,
      reducePanel: reducePanel,
      KnowledgeBaseIcon: KnowledgeBaseIcon,
      SettingsSection: SettingsSection,
      visibleMenus: visibleMenus,
      MenusNav: MenusNav,
      TaskListSkeleton: TaskListSkeleton,
      SidebarTasks: SidebarTasks,
      formatRelativeTime: formatRelativeTime,
      seedRunsPageState: seedRunsPageState,
      DashboardSkeleton: DashboardSkeleton,
      TasksPageHeader: TasksPageHeader,
      DoctorPanel: DoctorPanel,
      DoctorView: DoctorView,
      DashboardPage: DashboardPage,
      DashboardView: DashboardView,
      PlaceholderPage: PlaceholderPage,
      TaskList: TaskList,
      RunsBoardPage: RunsBoardPage,
      RunsBoardView: RunsBoardView,
      RunDetailPage: RunDetailPage,
      RunDetailView: RunDetailView,
      ExpertsPage: ExpertsPage,
      ExpertsView: ExpertsView,
      SkillViewPage: SkillViewPage,
      SkillViewView: SkillViewView,
      ReportsPanel: ReportsPanel,
      ReportsView: ReportsView,
      TasksViewSwitch: TasksViewSwitch,
      TasksPage: TasksPage,
      LedgerCalendarPage: LedgerCalendarPage,
      LedgerCalendarView: LedgerCalendarView,
      KnowledgeBasePanel: KnowledgeBasePanel,
    };

    return {
      inject: ['slots'],
      apply: apply,
      __internals: __internals,
    };
  },
});
