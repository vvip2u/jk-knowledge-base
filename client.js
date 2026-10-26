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
    const PLUGIN_VERSION = '1.1.1';
    const PLUGIN_AUTHOR = 'JakeKim@XingHaoTech';
    const STORAGE_KEY = 'jk-knowledge-base:v1';
    // 左栏「执行任务」区最多展示的条数；超过它才出现「更多」按钮。
    const TASK_LIMIT = 3;
    const RUNS_PAGE_SIZE = 20;
    // 顶部导航「文档」指向仓库 README（与 package.json homepage 一致）。
    const DOCS_URL = 'https://github.com/vvip2u/jk-knowledge-base#readme';
    const DASHBOARD_ID = 'dashboard';
    const EXPERTS_ID = 'experts';
    const FILES_ID = 'files';
    const TASKS_ID = 'tasks';
    const SKILLS_ID = 'skills';
    const USAGE_ID = 'usage';
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
    const HOST_FILES_PATH = '/plugins/jk-knowledge-base/files';
    const HOST_FILE_PATH = '/plugins/jk-knowledge-base/file';
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

    // ───────────────────────────── 语音输入桥 ─────────────────────────────
    // DSH 对话框的语音转文字走宿主本地模型（remote.speech → SenseVoice），而非浏览器
    // Web Speech API（Electron webview 里不可用）。用户启用 DSH「语音输入 Bundle」后，
    // 客户端会挂载 remote.speech 服务；本插件动态注入该服务并在可用性变化时通知对话页。
    const speechBridge = { available: false, api: null };
    const speechListeners = [];

    function notifySpeechListeners() {
      speechListeners.slice().forEach(function (fn) {
        try { fn(speechBridge.available); } catch (err) { /* 单个订阅者出错不影响其它 */ }
      });
    }

    // 取语音转写 API（remote.speech 命名空间）；未启用语音输入 Bundle 时返回 null。
    function getSpeechApi() {
      return speechBridge.available && speechBridge.api ? speechBridge.api : null;
    }

    // 订阅语音桥可用性变化（挂载 → true / 卸载 → false），返回退订函数。
    function subscribeSpeech(fn) {
      if (typeof fn !== 'function') return function () {};
      speechListeners.push(fn);
      return function () {
        const at = speechListeners.indexOf(fn);
        if (at >= 0) speechListeners.splice(at, 1);
      };
    }

    // apply() 时调用：动态注入 remote.speech（与 DSH 语音输入插件同款用法）。
    // 宿主较旧不支持 ctx.inject 或未启用语音 Bundle 时静默降级（麦克风不显示）。
    function setupSpeechBridge(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return;
      try {
        ctx.inject(['remote.speech'], function mountSpeechBridge(speechCtx) {
          // 'remote.speech' 是 cordis 命名空间服务：fiber 激活后须用 ctx['remote.speech']
          // 取服务实例——写 ctx.remote.speech 需要 'remote' 也在注入链上，第三方插件拿不到
          // （否则抛 "cannot get property remote without inject"，麦克风会静默消失）。
          let api = null;
          try {
            api = speechCtx['remote.speech'] || null;
            if (!api && speechCtx.remote) api = speechCtx.remote.speech || null;
          } catch (err) { api = null; }
          if (api && typeof api.transcribe === 'function' && typeof api.catalog === 'function') {
            speechBridge.available = true;
            speechBridge.api = api;
            notifySpeechListeners();
          }
          return function () {
            speechBridge.available = false;
            speechBridge.api = null;
            notifySpeechListeners();
          };
        });
      } catch (err) { /* 注入失败：语音输入保持不可用 */ }
    }

    // 单声道浮点采样 → 16kHz PCM16 小端 WAV（宿主 speech/transcribe 的规范输入，与 DSH 同款编码）。
    function speechEncodeWav(samples) {
      const input = samples || new Float32Array(0);
      const bytes = new Uint8Array(44 + input.length * 2);
      const view = new DataView(bytes.buffer);
      function writeText(at, value) {
        for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i);
      }
      writeText(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      writeText(8, 'WAVE');
      writeText(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeText(36, 'data');
      view.setUint32(40, input.length * 2, true);
      for (let i = 0; i < input.length; i += 1) {
        const value = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    // WAV 字节 → 无前缀 base64（Remote JSON 载体；分块避免超长参数栈溢出）。
    function speechWavToBase64(bytes) {
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(text);
    }

    // 录音失败 → 中文文案（权限 / 设备 / 通用兜底）。
    function describeRecorderError(err) {
      const name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，请在系统设置中允许访问麦克风';
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return '未找到可用的麦克风设备';
      if (err && typeof err.message === 'string' && err.message) return err.message;
      return '录音失败，请重试';
    }

    // 语音录音器：getUserMedia + MediaRecorder 采集，停止后经 OfflineAudioContext
    // 重采样为 16kHz 单声道并编码为 PCM16 WAV（流程与 DSH 语音输入一致）。
    function createSpeechRecorder() {
      let stream = null;
      let recorder = null;
      let context = null;
      const chunks = [];
      function release() {
        try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (err) { /* 已停止 */ }
        try { if (stream) stream.getTracks().forEach(function (track) { track.stop(); }); } catch (err) { /* 已释放 */ }
        try { if (context && context.state !== 'closed') context.close(); } catch (err) { /* 已关闭 */ }
        stream = null;
        recorder = null;
        context = null;
        chunks.length = 0;
      }
      return {
        // 请求麦克风并开始录制；失败（权限/设备/不支持）抛错由调用方给出文案。
        start: async function () {
          if (typeof MediaRecorder === 'undefined'
            || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('当前环境不支持录音');
          }
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          });
          try {
            context = new AudioContext();
            recorder = new MediaRecorder(stream);
            recorder.ondataavailable = function (event) {
              if (event && event.data && event.data.size > 0) chunks.push(event.data);
            };
            recorder.start();
          } catch (err) {
            release();
            throw err;
          }
        },
        // 结束录制：等待最后一块数据 → 解码 → 重采样 → WAV 字节；无论成败都释放资源。
        stop: async function (maxDurationSeconds) {
          const activeRecorder = recorder;
          const activeContext = context;
          if (!activeRecorder || !activeContext || activeRecorder.state !== 'recording') {
            release();
            throw new Error('没有录到声音');
          }
          try {
            await new Promise(function (resolve, reject) {
              activeRecorder.onstop = resolve;
              activeRecorder.onerror = function () { reject(new Error('录音失败')); };
              activeRecorder.stop();
            });
            if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
            const blob = new Blob(chunks, { type: activeRecorder.mimeType });
            if (!blob || blob.size === 0) throw new Error('没有录到声音');
            const decoded = await activeContext.decodeAudioData(await blob.arrayBuffer());
            const limit = typeof maxDurationSeconds === 'number' && maxDurationSeconds > 0 ? maxDurationSeconds : 60;
            const seconds = Math.min(decoded.duration, limit);
            const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(seconds * 16000)), 16000);
            const source = offline.createBufferSource();
            source.buffer = decoded;
            source.connect(offline.destination);
            source.start();
            const resampled = await offline.startRendering();
            return speechEncodeWav(resampled.getChannelData(0));
          } finally {
            release();
          }
        },
        // 丢弃录音：同步释放麦克风（发送消息 / 卸载 / 取消时使用，不转写）。
        dispose: function () { release(); },
      };
    }

    // 侧边栏菜单图标（lucide 风格线稿）：stroke 跟随 currentColor，随按钮态变色。
    function makeNavIcon(paths, viewBox) {
      return function (props) {
        const rest = props && typeof props === 'object' ? props : {};
        const attrs = {
          className: cn('jk-kb-nav-menu-icon', rest.className),
          viewBox: viewBox || '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          'data-jk-kb-menu-icon': 'true',
        };
        Object.keys(rest).forEach(function (key) {
          if (key !== 'children' && key !== 'className') attrs[key] = rest[key];
        });
        return h('svg', attrs, paths.map(function (d, index) {
          return h('path', { key: 'p' + index, d: d });
        }));
      };
    }

    const MenuIconDashboard = makeNavIcon([
      'M3 4.5A1.5 1.5 0 0 1 4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5z',
      'M14 4.5A1.5 1.5 0 0 1 15.5 3h4A1.5 1.5 0 0 1 21 4.5v2A1.5 1.5 0 0 1 19.5 8h-4A1.5 1.5 0 0 1 14 6.5z',
      'M14 12.5A1.5 1.5 0 0 1 15.5 11h4A1.5 1.5 0 0 1 21 12.5v7A1.5 1.5 0 0 1 19.5 21h-4A1.5 1.5 0 0 1 14 19.5z',
      'M3 14.5A1.5 1.5 0 0 1 4.5 13h4A1.5 1.5 0 0 1 10 14.5v5A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5z',
    ]);
    const MenuIconExperts = makeNavIcon([
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
      'M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
      'M22 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ]);
    const MenuIconFiles = makeNavIcon([
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
      'M12.5 11.5a2.12 2.12 0 0 0-3 3',
      'M14.5 9.5a2.12 2.12 0 0 0-3 3',
      'M9.5 14.5a2.12 2.12 0 0 0 3 3',
    ]);
    const MenuIconTasks = makeNavIcon([
      'M3 17l2 2 4-4',
      'M3 7l2 2 4-4',
      'M13 6h8',
      'M13 12h8',
      'M13 18h8',
    ]);
    const MenuIconUsage = makeNavIcon([
      'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
    ]);
    // 技能管理菜单（lucide Wrench）。
    const MenuIconSkills = makeNavIcon([
      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    ]);
    // 品牌 Logo：星球填充图标（iconfont 导出，1024 画布单 path），fill 跟随 currentColor，放在品牌色圆底上由 CSS 控制。
    const BRAND_LOGO_PATH = 'M1023.968793 512.0972c0-282.258242-228.984556-511.073966-511.452563-511.073966-282.473122 0-511.462795 228.815722-511.462795 511.073966 0 260.737573 195.390741 475.854231 447.837044 507.156 14.231147 2.999101 31.564741 4.746785 52.209522 4.746785 5.795601 0 11.384509-0.304924 16.78207-0.857471C797.877943 1020.265179 1023.968793 792.575015 1023.968793 512.0972zM950.836169 519.328399c-1.471411-25.500029-4.8399-50.460814-9.969375-74.718637 0.455339-8.661681 0.579151-16.868022 0.346877-24.49726 6.343032 29.660502 9.687986 60.432236 9.687986 91.984698C950.902679 514.513057 950.875051 516.921751 950.836169 519.328399zM74.120572 512.0972c0-30.977405 3.225236-61.200685 9.345202-90.360825 18.931886 20.247766 63.554125 19.769915 74.436224-10.483039 19.471131 11.604504 45.637286 13.717484 45.637286 36.912165 0 76.550227 2.725897 158.618759 72.279247 159.886547 1.958471 0.025581 38.788778 13.957944 56.316786 59.416164 6.060619 15.711767 30.032959 0 56.321902 0 13.124008 0 0 22.110053 0 69.921714 0 47.626454 102.680569 120.959633 102.680569 120.959633-0.475804 31.525858 0.818588 57.017702 3.442161 77.38314-23.177287-0.426689-42.709813 2.645062-58.055262 7.868674C230.627375 907.644909 74.120572 728.142955 74.120572 512.0972zM620.440877 936.783561c-2.272604-11.126653-12.215375-17.220015-30.356301-12.451742 14.474677-61.640676 21.511461-96.169728 51.728602-122.387045 43.719746-37.898564 5.206218-80.04355-28.063232-75.076769-26.222433 3.958895-9.651149-32.467234-33.055594-34.481983-23.404445-1.958471-53.969486-48.511552-87.653346-64.530291-17.855443-8.479545-35.402894-31.203539-62.940184-32.221658-24.407215-0.946492-60.07615 20.637618-60.07615 3.999824 0-53.590889-5.426213-91.832236-6.541539-107.104012-0.900446-12.269607-8.020113-4.132845 24.974087-3.339838 17.956744 0.48092 9.185577-36.067997 26.959162-37.495409 17.456382-1.381367 59.052916 16.341056 69.650557 9.277668 9.845564-6.577352 72.371338 164.12683 72.371338 28.216717 0-16.126177-8.351641-44.163828 0-59.436629 33.030013-60.352424 63.952163-109.539311 61.175104-116.734697-1.575781-4.050986-33.792323-7.39594-59.569649 1.253462-8.699541 2.904963 2.766826 16.530355-9.727892 19.440434-46.814006 10.807404-88.175196-12.622623-73.691309-34.645701 14.831785-22.570509 68.571044-9.845564 73.282016-55.124718 2.710549-25.935927 4.956549-55.974003 6.45968-78.298935 63.004648 9.852726 56.069163-81.7677-37.613081-91.574381 189.525561 2.217349 350.128371 124.61565 409.062591 294.48692-2.980683-2.718734-6.448425-4.371258-10.453365-4.774413-28.324157-70.749511-97.074267-19.547874-73.752703 42.855112-124.959457 96.057172-92.973143 163.052434-51.9179 201.416569 21.603552 20.166931 42.200242 50.496628 55.610754 72.279247-14.596442 42.561444 53.781211 25.518448 87.503954-46.709636C890.911457 782.384621 771.249286 898.633281 620.440877 936.783561z';
    function BrandLogoMark(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = {
        className: cn('jk-kb-nav-menu-icon', rest.className),
        viewBox: '0 0 1024 1024',
        fill: 'currentColor',
        'aria-hidden': 'true',
        'data-jk-kb-menu-icon': 'true',
      };
      Object.keys(rest).forEach(function (key) {
        if (key !== 'children' && key !== 'className') attrs[key] = rest[key];
      });
      return h('svg', attrs, h('path', { key: 'p0', d: BRAND_LOGO_PATH }));
    }
    // 信号图标（lucide Signal）：专家卡片上 hover 出技能明细浮层的触发器。
    const SignalIcon = makeNavIcon([
      'M2 20h.01',
      'M7 20v-4',
      'M12 20v-8',
      'M17 20V8',
      'M22 4v16',
    ]);
    // 面板图标（lucide PanelLeft）：侧边栏折叠 / 展开的切换按钮，shadcn SidebarTrigger 同款。
    const PanelLeftIcon = makeNavIcon([
      'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      'M9 3v18',
    ]);
    // 下箭头（lucide ChevronDown）：技能行展开指示器，展开时 CSS 旋转 180°。
    const ChevronDownIcon = makeNavIcon(['M6 9l6 6 6-6']);

    // 未配置根目录时只保留仪表盘；其它状态（loading/error/ready）保持完整菜单。
    function visibleMenus(rootStatus) {
      if (rootStatus === 'no-root') return MENUS.filter((menu) => menu.id === DASHBOARD_ID);
      return MENUS.slice();
    }

    // 左栏菜单：数据驱动；顺序即展示顺序（icon 为侧边栏菜单按钮内的线稿图标）。
    const MENUS = [
      { id: DASHBOARD_ID, label: '仪表盘', icon: MenuIconDashboard, description: '知识库总览：统计与最近入库。' },
      { id: EXPERTS_ID, label: '业务专家', icon: MenuIconExperts, description: '按业务领域维护专家角色、绑定技能与提示词；卡片在设置页管理。' },
      { id: FILES_ID, label: '文件管理', icon: MenuIconFiles, description: '浏览知识库目录与文件：文件树导航、文件夹列表与按格式预览文件。' },
      { id: TASKS_ID, label: '任务管理', icon: MenuIconTasks, description: '执行任务、整理报告与技能台账。' },
      { id: SKILLS_ID, label: '技能管理', icon: MenuIconSkills, description: '浏览全部技能：按岗位分类查看技能说明与产出配置。' },
      { id: USAGE_ID, label: '使用信息', icon: MenuIconUsage, description: '知识库运行状态与宿主健康信息。' },
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

    // 主页面 UI 状态：选中菜单 + 任务区是否展开 + 侧边栏是否折叠。切换菜单一律收起任务区。
    function createPanelState() {
      return { selected: (MENUS[0] && MENUS[0].id) || DASHBOARD_ID, expanded: false, sidebarCollapsed: false };
    }

    function reducePanel(state, action) {
      const fallback = createPanelState();
      const base = state && typeof state === 'object' ? state : fallback;
      // 选中项不认识（脏状态 / 菜单被删）就整体回落到初始态。
      const match = MENUS.filter((menu) => menu.id === base.selected)[0];
      if (!match) return fallback;
      const collapsed = base.sidebarCollapsed === true;
      const act = action || {};
      if (act.type === 'select' && MENUS.filter((menu) => menu.id === act.id)[0]) {
        // 切菜单时复位展开态：切走再回来不该还是展开的；折叠态保留。
        return { selected: act.id, expanded: false, sidebarCollapsed: collapsed };
      }
      if (act.type === 'toggleTasks') return { selected: match.id, expanded: base.expanded !== true, sidebarCollapsed: collapsed };
      // 侧边栏折叠 / 展开：只翻折叠位，不影响任务区展开态。
      if (act.type === 'toggleSidebar') return { selected: match.id, expanded: base.expanded === true, sidebarCollapsed: !collapsed };
      return { selected: match.id, expanded: base.expanded === true, sidebarCollapsed: collapsed };
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
    // ───────────────────────────── 技能目录 ─────────────────────────────
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
        purpose: typeof skill.purpose === 'string' ? skill.purpose : '',
        // 展开明细需要的原始字段：岗位原名 / 产出目录 / 产出物 ID 前缀。
        profession: typeof skill.profession === 'string' ? skill.profession : role,
        outputDir: typeof skill.outputDir === 'string' ? skill.outputDir : '',
        idPrefix: typeof skill.idPrefix === 'string' ? skill.idPrefix : '',
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

    // 入柜（curate）run 的提交封装：业务专家对话页发送消息时复用（把输入文本作为 curate run 提交）。
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

    // 专家卡片「信号」浮层用：id → { name, purpose }（技能名 + 介绍）。
    function expertSkillMetaMap(groups) {
      const map = {};
      (Array.isArray(groups) ? groups : []).forEach((group) => {
        (Array.isArray(group && group.skills) ? group.skills : []).forEach((skill) => {
          if (skill && skill.id) {
            map[skill.id] = {
              name: (typeof skill.name === 'string' && skill.name) ? skill.name : skill.id,
              purpose: typeof skill.purpose === 'string' ? skill.purpose : '',
            };
          }
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

    // nowValue：可选的"当前时间"注入（测试传固定值保证确定性；生产不传即真实时间）。
    function presentDashboard(raw, nowValue) {
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
        weekAddedEstimate: estimateWeekAdded(recent, nowValue),
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

    // ───────────────────────────── 文件管理（目录列表 / 文件预览） ─────────────────────────────
    // 预览分类：与宿主端一致——text 白名单、image 白名单、其余 binary、超大文本 too-large。
    const FILE_PREVIEW_KINDS = ['text', 'image', 'binary', 'too-large'];

    function fetchFiles(dir) {
      const rel = typeof dir === 'string' ? dir : '';
      return hostRequest(HOST_FILES_PATH + '?dir=' + encodeURIComponent(rel), { method: 'GET' });
    }

    function fetchFileEntry(relPath) {
      const rel = typeof relPath === 'string' ? relPath : '';
      return hostRequest(HOST_FILE_PATH + '?path=' + encodeURIComponent(rel), { method: 'GET' });
    }

    /** 归一化目录条目：folders / files 各自排序后合并成展示列表（文件夹在前）。 */
    function presentFilesEntry(raw, index) {
      const entry = raw && typeof raw === 'object' ? raw : {};
      return {
        key: (typeof entry.name === 'string' && entry.name ? entry.name : 'entry-' + index),
        name: typeof entry.name === 'string' && entry.name ? entry.name : '—',
        ext: typeof entry.ext === 'string' ? entry.ext : '',
        size: typeof entry.size === 'number' && isFinite(entry.size) ? entry.size : null,
        sizeText: formatFileSize(typeof entry.size === 'number' && isFinite(entry.size) ? entry.size : null),
        mtimeText: formatTimestamp(entry.mtimeMs),
      };
    }

    function presentFiles(raw) {
      const data = raw && typeof raw === 'object' ? raw : {};
      const folders = (Array.isArray(data.folders) ? data.folders : []).map(presentFilesEntry);
      const files = (Array.isArray(data.files) ? data.files : []).map(presentFilesEntry);
      return {
        dir: typeof data.dir === 'string' ? data.dir : '',
        folders: folders,
        files: files,
      };
    }

    function normalizeFilesResponse(result) {
      if (result && result.ok === true) return { ok: true, data: presentFiles(result) };
      return {
        ok: false,
        status: result && result.status,
        error: (result && result.error) || { code: 'host-unreachable', message: '宿主服务未连接' },
      };
    }

    /** 归一化文件预览：kind 决定右栏分支（text → pre，image → img，其余 → 元信息提示）。 */
    function presentFilePreview(raw) {
      const data = raw && typeof raw === 'object' ? raw : {};
      const kind = FILE_PREVIEW_KINDS.indexOf(data.kind) >= 0 ? data.kind : 'binary';
      return {
        path: typeof data.path === 'string' ? data.path : '',
        name: typeof data.name === 'string' && data.name ? data.name : '—',
        ext: typeof data.ext === 'string' ? data.ext : '',
        kind: kind,
        sizeText: formatFileSize(typeof data.size === 'number' && isFinite(data.size) ? data.size : null),
        mtimeText: formatTimestamp(data.mtimeMs),
        text: typeof data.text === 'string' ? data.text : '',
        dataUrl: typeof data.dataUrl === 'string' ? data.dataUrl : '',
      };
    }

    function normalizeFileResponse(result) {
      if (result && result.ok === true) return { ok: true, data: presentFilePreview(result) };
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

    /** 文件管理专用字节格式化：B / KB / MB / GB 三位有效，比 formatBytes（MB 起）更细。 */
    function formatFileSize(value) {
      const bytes = typeof value === 'number' && isFinite(value) ? value : null;
      if (bytes === null) return '—';
      if (bytes < 1024) return bytes + ' B';
      const kb = bytes / 1024;
      if (kb < 1024) return (Math.round(kb * 10) / 10) + ' KB';
      const mb = kb / 1024;
      if (mb < 1024) return (Math.round(mb * 10) / 10) + ' MB';
      return (Math.round((mb / 1024) * 10) / 10) + ' GB';
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

    // ───── shadcn/ui 设计令牌桥：token 命名遵循 shadcn/ui 规范，取值全部映射宿主主题变量 ─────
    // 作用域限定在本插件的两个根容器（.jk-kb-root / .jk-kb-panel），绝不污染宿主全局。
    const TOKEN_CSS = '.jk-kb-root,.jk-kb-panel{'
      + '--background:var(--dsw-alias-bg-base);'
      + '--foreground:var(--dsw-alias-label-primary);'
      + '--card:var(--dsw-alias-bg-layer-1);'
      + '--card-foreground:var(--dsw-alias-label-primary);'
      + '--popover:var(--dsw-alias-bg-layer-2);'
      + '--popover-foreground:var(--dsw-alias-label-primary);'
      + '--primary:var(--dsw-alias-button-primary-fill);'
      + '--primary-foreground:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));'
      + '--secondary:var(--dsw-alias-bg-layer-2);'
      + '--secondary-foreground:var(--dsw-alias-label-primary);'
      + '--muted:var(--dsw-alias-bg-layer-2);'
      + '--muted-foreground:var(--dsw-alias-label-tertiary);'
      + '--accent:var(--dsw-alias-interactive-bg-hover);'
      + '--accent-foreground:var(--dsw-alias-label-primary);'
      + '--destructive:var(--dsw-alias-state-error-primary);'
      + '--success:var(--dsw-alias-state-success-primary);'
      + '--warning:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));'
      + '--border:var(--dsw-alias-border-l1);'
      + '--input:var(--dsw-alias-border-l2);'
      + '--ring:var(--dsw-alias-brand-primary);'
      + '--radius:0.5rem;}';

    // ───── shadcn/ui 组件层样式：变体类晚于既有规则注入，同优先级时覆盖旧观感 ─────
    // 类名一律 jk-kb- 前缀；颜色全部经 TOKEN_CSS 的令牌间接引用，不出现 rgb()/rgba()。
    const COMPONENT_CSS = [
      '.jk-kb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12px;font-weight:500;line-height:1.4;cursor:pointer;white-space:nowrap;border-radius:calc(var(--radius) - 2px);border:1px solid transparent;padding:6px 12px;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}',
      '.jk-kb-btn:disabled{opacity:.55;cursor:not-allowed;}',
      '.jk-kb-btn:focus-visible{outline:2px solid var(--ring);outline-offset:1px;}',
      '.jk-kb-btn-default{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);}',
      '.jk-kb-btn-default:hover:not(:disabled){background:var(--accent);color:var(--accent-foreground);border-color:var(--accent);}',
      '.jk-kb-btn-secondary{background:var(--secondary);color:var(--secondary-foreground);border-color:var(--border);}',
      '.jk-kb-btn-secondary:hover:not(:disabled){background:var(--accent);border-color:var(--input);}',
      '.jk-kb-btn-outline{background:transparent;color:var(--foreground);border-color:var(--input);}',
      '.jk-kb-btn-outline:hover:not(:disabled){background:var(--accent);border-color:var(--ring);}',
      '.jk-kb-btn-ghost{background:transparent;color:var(--foreground);border-color:transparent;}',
      '.jk-kb-btn-ghost:hover:not(:disabled){background:var(--accent);}',
      '.jk-kb-btn-link{background:transparent;color:var(--ring);border-color:transparent;padding-left:0;padding-right:0;}',
      '.jk-kb-btn-link:hover:not(:disabled){text-decoration:underline;}',
      '.jk-kb-btn-destructive{background:var(--destructive);color:var(--primary-foreground);border-color:var(--destructive);}',
      '.jk-kb-btn-destructive:hover:not(:disabled){background:var(--destructive);opacity:.85;}',
      '.jk-kb-btn-size-sm{font-size:11px;padding:4px 10px;border-radius:calc(var(--radius) - 4px);}',
      '.jk-kb-btn-size-lg{font-size:13px;font-weight:600;padding:8px 18px;}',
      '.jk-kb-btn-size-icon{width:28px;height:28px;padding:0;}',
      '.jk-kb-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;line-height:1.4;border-radius:999px;border:1px solid transparent;padding:2px 8px;white-space:nowrap;}',
      '.jk-kb-badge-default{background:var(--primary);color:var(--primary-foreground);}',
      '.jk-kb-badge-secondary{background:var(--secondary);color:var(--secondary-foreground);border-color:var(--border);}',
      '.jk-kb-badge-outline{background:transparent;color:var(--foreground);border-color:var(--input);}',
      '.jk-kb-badge-destructive{background:transparent;color:var(--destructive);border-color:var(--destructive);}',
      '.jk-kb-badge-success{background:transparent;color:var(--success);border-color:var(--success);}',
      '.jk-kb-badge-warning{background:transparent;color:var(--warning);border-color:var(--warning);}',
      '.jk-kb-card-head{display:flex;flex-direction:column;gap:4px;}',
      '.jk-kb-card-title{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--foreground);}',
      '.jk-kb-card-desc{margin:0;font-size:11px;line-height:1.6;color:var(--muted-foreground);}',
      '.jk-kb-card-content{display:flex;flex-direction:column;gap:10px;}',
      '.jk-kb-card-foot{display:flex;align-items:center;gap:8px;margin-top:10px;}',
      '.jk-kb-stat.jk-kb-card{padding:12px 14px;}',
      '.jk-kb-stat .jk-kb-card-head{flex-direction:row;align-items:center;justify-content:space-between;gap:8px;}',
      '.jk-kb-label{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--foreground);}',
      '.jk-kb-sep{border:0;margin:0;height:1px;width:100%;background:var(--border);}',
      '.jk-kb-notice-info{color:var(--muted-foreground);}',
      // ── shadcn 语义扩展：Alert / Checkbox / Tabs ──
      '.jk-kb-alert{display:flex;align-items:flex-start;gap:8px;margin:0;border:1px solid var(--border);border-left-width:3px;border-radius:var(--radius);background:var(--dsw-alias-bg-layer-1);padding:8px 12px;font-size:12px;line-height:1.6;color:var(--foreground);}',
      '.jk-kb-alert-info{border-left-color:var(--dsw-alias-brand-primary);}',
      '.jk-kb-alert-success{border-left-color:var(--dsw-alias-state-success-primary);}',
      '.jk-kb-alert-warning{border-left-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));}',
      '.jk-kb-alert-destructive{border-left-color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-alert-title{margin:0;font-size:12px;font-weight:600;line-height:1.5;color:var(--foreground);}',
      '.jk-kb-alert-desc{display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-alert.jk-kb-validation{flex-direction:column;align-items:stretch;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-alert.jk-kb-risk{flex-direction:column;align-items:stretch;gap:8px;border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));}',
      '.jk-kb-checkbox{width:16px;height:16px;margin:2px 0 0;flex:none;accent-color:var(--primary);cursor:pointer;}',
      '.jk-kb-checkbox:focus-visible{outline:2px solid var(--ring);outline-offset:2px;}',
      '.jk-kb-switch{margin-left:auto;display:inline-flex;flex:none;align-items:center;width:44px;height:24px;-webkit-appearance:none;appearance:none;border:0;border-radius:999px !important;background:var(--input);padding:0;cursor:pointer;transition:background-color .15s ease;}',
      '.jk-kb-switch:focus-visible{outline:2px solid var(--ring);outline-offset:2px;}',
      '.jk-kb-switch-on{background:var(--primary);}',
      '.jk-kb-switch-thumb{display:block;flex:none;width:20px;height:20px;margin-left:2px;border-radius:50% !important;background:var(--background);transition:transform .15s ease;}',
      '.jk-kb-switch-on .jk-kb-switch-thumb{transform:translateX(20px);}',
      '.jk-kb-navmenu{display:flex;align-items:center;}',
      '.jk-kb-navmenu-list{display:flex;align-items:center;gap:4px;list-style:none;margin:0;padding:0;}',
      '.jk-kb-navmenu-item{display:flex;align-items:center;}',
      '.jk-kb-navmenu-link{display:inline-flex;align-items:center;gap:6px;border-radius:var(--radius);padding:7px 12px;font-size:13px;line-height:1;color:var(--foreground);text-decoration:none;cursor:pointer;transition:color .15s ease,background-color .15s ease;}',
      '.jk-kb-navmenu-link:hover{background:var(--accent);color:var(--foreground);}',
      '.jk-kb-navmenu-link:focus-visible{outline:2px solid var(--ring);outline-offset:2px;}',
      '.jk-kb-navmenu-link-active{background:var(--accent);font-weight:500;}',
      '.jk-kb-tabs-list{display:inline-flex;align-items:center;gap:4px;border-radius:calc(var(--radius) + 4px);border:1px solid var(--border);background:var(--dsw-alias-bg-layer-2);padding:4px;}',
      '.jk-kb-tabs-trigger{font:inherit;font-size:12px;line-height:1.4;cursor:pointer;border:1px solid transparent;border-radius:var(--radius);background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 14px;white-space:nowrap;}',
      '.jk-kb-tabs-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-tabs-trigger:focus-visible{outline:2px solid var(--ring);outline-offset:1px;}',
      '.jk-kb-tabs-active{background:var(--primary);color:var(--primary-foreground);font-weight:600;}',
      '.jk-kb-tabs-list-vertical{flex-direction:column;align-items:stretch;border:0;background:transparent;padding:0;gap:2px;}',
      '.jk-kb-tabs-list-vertical .jk-kb-tabs-trigger{text-align:left;white-space:normal;font-size:13px;padding:7px 10px;}',
      // ── Button 附加类微调（双类优先级高于基础变体）──
      '.jk-kb-btn.jk-kb-more{font-size:12px;padding:4px 10px;align-self:flex-start;}',
      '.jk-kb-btn.jk-kb-info-btn{width:18px;height:18px;padding:0;border-radius:50%;}',
      '.jk-kb-btn.jk-kb-artifact{font-size:11px;padding:2px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;}',
    ].join('');

    const SETTINGS_STYLE = [
      '.jk-kb-root{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:20px clamp(14px,3vw,32px) 32px;display:flex;flex-direction:column;gap:16px;}',
      '.jk-kb-head{display:flex;align-items:flex-start;gap:12px;}',
      '.jk-kb-title{margin:0;font-size:16px;font-weight:600;line-height:1.4;}',
      '.jk-kb-subtitle{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;}',
      '.jk-kb-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px;}',
      '.jk-kb-switch-row{display:flex;align-items:center;gap:12px;}',
      '.jk-kb-switch-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer;}',
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
    ].join('') + TOKEN_CSS + COMPONENT_CSS;

    const PANEL_STYLE = [
      '.jk-kb-panel{height:100%;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:20px clamp(14px,3vw,32px) 24px;display:flex;flex-direction:column;gap:14px;}',
      '.jk-kb-panel-head{display:flex;align-items:flex-start;gap:12px;}',
      '.jk-kb-blockquote{margin:10px 0 0;padding:2px 0 2px 10px;border-left:3px solid var(--primary);font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;}',
      '.jk-kb-example-badge{margin-left:auto;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;white-space:nowrap;}',
      '.jk-kb-panel-body{flex:1 1 auto;min-height:0;display:flex;gap:16px;align-items:stretch;}',
      // ── shadcn/ui Sidebar 视觉（等宽列 + 边框分隔 + 分组滚动区 + 底部时钟） ──
      '.jk-kb-sidebar{flex:0 0 232px;min-width:200px;min-height:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:10px 8px;}',
      '.jk-kb-sidebar-header{display:flex;align-items:center;padding:2px 6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.jk-kb-sidebar-brand{flex:1 1 auto;display:flex;align-items:center;gap:8px;min-width:0;}',
      '.jk-kb-sidebar-brand-logo{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--primary-foreground,var(--dsw-alias-label-on-brand,var(--dsw-alias-label-primary)));}',
      '.jk-kb-sidebar-brand-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.jk-kb-sidebar-content{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:10px 2px 2px;}',
      '.jk-kb-sidebar-footer{flex:none;display:flex;align-items:center;justify-content:center;padding:10px 6px 2px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.jk-kb-sidebar-clock{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.5px;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-sidebar-group{display:flex;flex-direction:column;gap:6px;padding:0 4px;}',
      '.jk-kb-sidebar-group-label{font-size:11px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-tertiary);padding:0 6px;}',
      '.jk-kb-sidebar-menu{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-sidebar-menu-item{display:flex;}',
      '.jk-kb-sidebar-menu-button{flex:1;display:flex;align-items:center;gap:8px;font:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);padding:7px 8px;transition:background-color .15s ease,color .15s ease;}',
      '.jk-kb-sidebar-menu-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.jk-kb-sidebar-menu-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-sidebar-menu-button[data-active="true"]{background:var(--dsw-alias-button-info-fill);color:var(--primary-foreground);font-weight:600;}',
      '.jk-kb-nav-menu-icon{flex:none;}',
      '.jk-kb-sidebar-menu-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      // ── Sidebar 折叠 / 展开（icon 模式）：窄列只留品牌图标 + 菜单图标，宽度过渡平滑 ──
      '.jk-kb-sidebar{transition:flex-basis .2s ease,min-width .2s ease,padding .2s ease;}',
      '.jk-kb-sidebar-toggle{flex:none;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-sidebar-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.jk-kb-sidebar[data-collapsed="true"]{flex-basis:56px;min-width:56px;padding:10px 6px;}',
      '.jk-kb-sidebar[data-collapsed="true"] .jk-kb-sidebar-header{flex-direction:column;gap:8px;padding:2px 0 10px;}',
      '.jk-kb-sidebar[data-collapsed="true"] .jk-kb-sidebar-brand{flex:0 0 auto;justify-content:center;}',
      '.jk-kb-sidebar[data-collapsed="true"] .jk-kb-sidebar-brand-name{display:none;}',
      '.jk-kb-sidebar[data-collapsed="true"] .jk-kb-sidebar-content{padding:10px 0 2px;}',
      '.jk-kb-sidebar[data-collapsed="true"] .jk-kb-sidebar-group{padding:0;}',
      '.jk-kb-sidebar[data-collapsed="true"] .jk-kb-sidebar-menu-button{justify-content:center;gap:0;padding:8px 0;}',
      '.jk-kb-sidebar-task-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;}',
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
      // 执行任务条目：卡片式分隔（边框 + 圆角 + 内边距），左侧两行（标题 / 相对时间），右侧状态
      '.jk-kb-sidebar-task{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);transition:background .15s ease,border-color .15s ease;}',
      '.jk-kb-sidebar-task:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}',
      '.jk-kb-sidebar-task-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;align-items:flex-start;}',
      '.jk-kb-sidebar-task .jk-kb-task-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-sidebar-task-meta{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
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
      '.jk-kb-table{width:100%;box-sizing:border-box;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-table-head{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);text-align:left;vertical-align:middle;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.jk-kb-table-row{cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.jk-kb-table-row:last-child{border-bottom:none;}',
      '.jk-kb-table-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-table-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.jk-kb-table-cell{padding:8px 10px;text-align:left;vertical-align:middle;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(1){width:20%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(2){width:7%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(3){width:10%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(4){width:13%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(5){width:13%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(6){width:8%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(7){width:11%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(8){width:8%;}',
      '.jk-kb-table .jk-kb-table-head:nth-child(9){width:8%;}',
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
      '.jk-kb-empty-center{align-items:center;justify-content:center;text-align:center;gap:10px;padding:36px 16px;}',
      '.jk-kb-empty-icon{width:30px;height:30px;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-empty-icon-sm{width:22px;height:22px;}',
      '.jk-kb-empty-tasks{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:16px 0;text-align:center;}',
      '.jk-kb-empty-text{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);}',
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
      '.jk-kb-preflight-card{padding:12px;}',
      '.jk-kb-preflight-card .jk-kb-card-head{flex-direction:row;align-items:center;gap:8px;}',
      '.jk-kb-preflight-code{font-size:10px;padding:0 6px;}',
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
      '.jk-kb-report-table{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}',
      '.jk-kb-report-table .jk-kb-table-head:nth-child(1){width:18%;}',
      '.jk-kb-report-table .jk-kb-table-head:nth-child(2){width:46%;}',
      '.jk-kb-report-table .jk-kb-table-head:nth-child(3){width:18%;}',
      '.jk-kb-report-table .jk-kb-table-head:nth-child(4){width:18%;}',
      '.jk-kb-report-period{font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;}',
      '.jk-kb-report-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-report-time{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-report-actions{display:flex;align-items:center;gap:6px;}',
      '.jk-kb-report-detail-row{cursor:default;}',
      '.jk-kb-report-detail-row:hover{background:none;}',
      '.jk-kb-report-detail-cell{background:var(--dsw-alias-bg-layer-2);}',
      '.jk-kb-report-findings{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
      '.jk-kb-report-group{display:flex;flex-direction:column;gap:4px;}',
      '.jk-kb-report-rule{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-report-rule-items{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-report-finding{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;}',
      '.jk-kb-report-path{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary);word-break:break-all;}',
      '.jk-kb-report-title{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-report-proposed{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-brand-primary);word-break:break-all;}',
      '.jk-kb-skill-view{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-skill-registry{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;}',
      '.jk-kb-skill-matches{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-skill-match{}',
      // 技能说明视图：左栏分类导航（纵向）+ 右栏技能列表（行可展开明细）
      '.jk-kb-skill-layout{display:flex;gap:12px;align-items:flex-start;}',
      '.jk-kb-skill-roles{flex:0 0 168px;display:flex;flex-direction:column;gap:2px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.jk-kb-skill-role-item{display:flex;align-items:center;gap:8px;font:inherit;font-size:12px;line-height:1.5;text-align:left;cursor:pointer;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);padding:7px 10px;transition:background-color .15s ease,color .15s ease;}',
      '.jk-kb-skill-role-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.jk-kb-skill-role-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-skill-role-item[data-active="true"]{background:var(--dsw-alias-button-info-fill);color:var(--primary-foreground);font-weight:600;}',
      '.jk-kb-skill-role-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-skill-role-count{flex:none;font-size:10px;font-variant-numeric:tabular-nums;opacity:.75;}',
      '.jk-kb-skill-list{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;}',
      '.jk-kb-skill-desc-group{display:flex;flex-direction:column;gap:4px;}',
      '.jk-kb-skill-desc-group-title{margin:8px 0 0;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-skill-desc-list{margin:4px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-skill-desc-item{display:flex;flex-direction:column;border-radius:8px;font-size:12px;line-height:1.6;}',
      '.jk-kb-skill-desc-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-skill-desc-item[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-skill-desc-row{display:flex;align-items:baseline;gap:12px;padding:7px 10px;cursor:pointer;}',
      '.jk-kb-skill-desc-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.jk-kb-skill-desc-name{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-skill-desc-purpose{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);}',
      '.jk-kb-skill-desc-chevron{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;}',
      '.jk-kb-skill-desc-item[data-open="true"] .jk-kb-skill-desc-chevron{transform:rotate(180deg);}',
      '.jk-kb-skill-desc-detail{padding:2px 10px 10px 24px;}',
      '.jk-kb-skill-desc-detail-grid{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr);gap:6px 16px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));}',
      '.jk-kb-skill-desc-field{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.jk-kb-skill-desc-field-label{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-skill-desc-field-value{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
      '.jk-kb-experts{display:flex;flex-direction:column;gap:12px;}',
      '.jk-kb-experts-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}',
      '.jk-kb-experts-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-expert-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;}',
      '.jk-kb-expert-tabs{display:flex;flex-direction:column;gap:10px;}',
      // 专家对话（DSH 风格：下方输入框，上方执行过程原样显示）
      '.jk-kb-chat{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:12px;}',
      '.jk-kb-chat-head{display:flex;align-items:center;gap:10px;}',
      '.jk-kb-chat-title{display:flex;align-items:baseline;gap:8px;min-width:0;}',
      '.jk-kb-chat-name{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-chat-domain{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-chat-back{margin-left:auto;}',
      '.jk-kb-chat-body{display:flex;flex-direction:column;gap:12px;min-height:180px;max-height:52vh;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px;}',
      '.jk-kb-chat-entry{display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-chat-user{align-self:flex-end;max-width:78%;background:var(--primary);color:var(--primary-foreground);border-radius:12px 12px 2px 12px;padding:8px 12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}',
      '.jk-kb-chat-run{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-chat-run-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}',
      '.jk-kb-chat-summary{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      // 专家对话输入区（composer 卡片：多行输入 + 底部工具行，形似 DSH 对话框）
      '.jk-kb-chat-composer{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-chat-composer:focus-within{border-color:var(--ring);}',
      '.jk-kb-textarea{border:none;background:transparent;padding:2px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);width:100%;min-height:48px;resize:vertical;outline:none;font-family:inherit;}',
      '.jk-kb-chat-composer-row{position:relative;display:flex;align-items:center;gap:8px;min-height:30px;}',
      // 发送按钮：对标 DSH 原生发送按钮（button-info-fill 蓝、hover 加深、禁用 40% 透明浅蓝）。
      // box-sizing:border-box + 不用 size 变体：确保 30×30 含边框精确正圆（size-sm 的 padding 会让宽度出现亚像素偏差）。
      '.jk-kb-btn.jk-kb-chat-send-round{box-sizing:border-box;width:30px;height:30px;border-radius:999px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-button-info-fill);color:var(--primary-foreground);border-color:transparent;transition:background-color .1s;}',
      '.jk-kb-btn.jk-kb-chat-send-round:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);}',
      '.jk-kb-btn.jk-kb-chat-send-round:disabled{opacity:.4;cursor:default;}',
      '.jk-kb-btn.jk-kb-chat-plus{box-sizing:border-box;width:26px;height:26px;border-radius:999px;padding:0;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.jk-kb-btn.jk-kb-chat-plus:hover:not(:disabled){background:var(--dsw-alias-border-l1);}',
      // 聊天输入框：比通用 textarea 更大（更多行数、更大字号与内边距）
      '.jk-kb-textarea.jk-kb-chat-draft{padding:10px 12px;font-size:14px;line-height:1.7;min-height:120px;}',
      // 语音输入麦克风：与加号同规格圆形；录音中以主色呼吸闪烁 + 停止方块图标
      '.jk-kb-btn.jk-kb-chat-mic{box-sizing:border-box;width:26px;height:26px;border-radius:999px;padding:0;display:inline-flex;align-items:center;justify-content:center;}',
      '.jk-kb-btn.jk-kb-chat-mic-on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);animation:jkkb-mic-pulse 1.2s ease-in-out infinite;}',
      '@keyframes jkkb-mic-pulse{0%,100%{opacity:1;}50%{opacity:.45;}}',
      // 语音状态提示：请求麦克风 / 聆听中 / 转写中 / 错误反馈（错误用警示色）
      '.jk-kb-chat-send-slot{margin-left:auto;display:inline-flex;align-items:center;gap:8px;}',
      '.jk-kb-chat-speech-status{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}',
      '.jk-kb-chat-speech-status[data-jk-kb-chat-speech-status="feedback"]{color:var(--dsw-alias-state-error-primary);}',
      '.jk-kb-btn.jk-kb-chat-plus-open{color:var(--primary);background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-badge.jk-kb-chat-binding{font-size:11px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // 加号浮层：选择该专家绑定的技能（向上弹出，锚定加号所在的工具行，紧贴按钮上方）
      '.jk-kb-skill-menu{position:absolute;left:0;bottom:calc(100% + 8px);width:264px;max-height:248px;overflow:auto;z-index:30;display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 16px var(--dsw-alias-border-l1);padding:6px;}',
      '.jk-kb-skill-menu-item{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;border-radius:8px;padding:7px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;}',
      '.jk-kb-skill-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-skill-menu-item[data-state="checked"]{color:var(--primary);font-weight:600;}',
      '.jk-kb-skill-menu-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-skill-menu-id{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:inherit;}',
      '.jk-kb-skill-menu-group{display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-skill-menu-group-title{margin:4px 4px 2px;font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary);}',
      '.jk-kb-skill-menu-empty{margin:6px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      // 已选技能标签：挂在输入框顶部，× 可移除
      '.jk-kb-chat-tags{display:flex;flex-wrap:wrap;gap:6px;}',
      '.jk-kb-badge.jk-kb-chat-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 4px 2px 8px;}',
      '.jk-kb-chat-tag-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-chat-tag-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:none;border-radius:999px;background:transparent;color:inherit;cursor:pointer;padding:0;}',
      '.jk-kb-chat-tag-x:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      // 专家对话快捷选项（RadioGroup / RadioItem）
      '.jk-kb-radio-group{display:flex;flex-direction:column;gap:6px;}',
      '.jk-kb-radio-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary);text-align:left;width:100%;font-family:inherit;}',
      '.jk-kb-radio-item:hover{background:var(--accent);color:var(--accent-foreground);border-color:var(--ring);}',
      '.jk-kb-radio-dot{width:14px;height:14px;border-radius:999px;border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;}',
      '.jk-kb-radio-item[data-state="checked"] .jk-kb-radio-dot{border-color:var(--primary);}',
      '.jk-kb-radio-item[data-state="checked"] .jk-kb-radio-dot::after{content:"";width:6px;height:6px;border-radius:999px;background:var(--primary);}',
      '.jk-kb-expert-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;}',
      '.jk-kb-expert-card-head{display:flex;align-items:baseline;gap:8px;}',
      '.jk-kb-expert-name{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-expert-domain{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-expert-responsibility{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.jk-kb-expert-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}',
      '.jk-kb-expert-meta-divider{flex:none;width:1px;height:12px;background:var(--dsw-alias-border-l2);}',
      '.jk-kb-expert-signal{position:relative;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);cursor:help;padding:2px;border-radius:4px;}',
      '.jk-kb-expert-signal:hover,.jk-kb-expert-signal:focus-visible{color:var(--dsw-alias-label-primary);}',
      '.jk-kb-expert-signal:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-expert-signal-popover{display:none;position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);width:240px;max-width:64vw;z-index:30;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 16px var(--dsw-alias-border-l1);padding:8px 10px;text-align:left;}',
      '.jk-kb-expert-signal:hover .jk-kb-expert-signal-popover,.jk-kb-expert-signal:focus-visible .jk-kb-expert-signal-popover{display:flex;}',
      '.jk-kb-expert-signal-item{display:flex;flex-direction:column;gap:1px;}',
      '.jk-kb-expert-signal-item-name{font-size:11px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary);}',
      '.jk-kb-expert-signal-item-purpose{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
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
      // ── 文件管理三栏：左树 / 中目录列表 / 右预览（等高面板，宽度左固定右自适应）──
      '.jk-kb-files{display:grid;grid-template-columns:220px minmax(240px,1fr) minmax(280px,1.4fr);gap:12px;align-items:start;min-height:420px;}',
      '.jk-kb-files-pane{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px;min-height:420px;overflow:auto;}',
      '.jk-kb-file-tree-list,.jk-kb-file-tree-children{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:1px;}',
      '.jk-kb-file-tree-row{display:flex;align-items:center;gap:4px;border-radius:6px;}',
      '.jk-kb-file-tree-row-active{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-file-tree-caret{flex:none;width:16px;height:18px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:10px;line-height:1;padding:0;border-radius:4px;transition:transform .15s ease;}',
      '.jk-kb-file-tree-caret:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-file-tree-caret-open{transform:rotate(90deg);}',
      '.jk-kb-file-tree-caret-leaf{display:inline-flex;align-items:center;justify-content:center;cursor:default;}',
      '.jk-kb-file-tree-label{flex:1;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:1.6;text-align:left;padding:2px 6px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-file-tree-label:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-file-tree-label:focus-visible,.jk-kb-file-tree-caret:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-files-list-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.jk-kb-files-crumb{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all;}',
      '.jk-kb-files-list-actions{display:flex;align-items:center;gap:6px;}',
      '.jk-kb-files-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;}',
      '.jk-kb-file-entry-btn{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;text-align:left;padding:6px 8px;}',
      '.jk-kb-file-entry-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.jk-kb-file-entry-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.jk-kb-file-entry-icon{flex:none;font-size:14px;line-height:1;}',
      '.jk-kb-file-entry-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.jk-kb-file-entry-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
      '.jk-kb-file-preview-body{display:flex;flex-direction:column;gap:8px;}',
      '.jk-kb-file-preview-meta{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
      '.jk-kb-file-preview-text{flex:1;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;padding:10px 12px;max-height:60vh;overflow:auto;}',
      '.jk-kb-file-preview-image{max-width:100%;max-height:60vh;object-fit:contain;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
    ].join('') + TOKEN_CSS + COMPONENT_CSS;

    // ───────────────────────────── shadcn/ui 规范组件层 ─────────────────────────────
    // API 与变体语义遵循 shadcn/ui（variant / size / 复合组件），实现为零依赖手写版：
    // DSH 契约只允许 require('react')，tailwind / radix 无法引入，故类名与令牌按
    // shadcn 规范落到 jk-kb-* 前缀类 + TOKEN_CSS 令牌上，观感与 shadcn 默认主题对齐。

    /**
     * cn —— 类名合并工具（clsx 语义）：假值丢弃，数组递归展开，对象按真值取键。
     * @returns {string} 合并后的类名字符串
     */
    function cn() {
      const out = [];
      function push(value) {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(push); return; }
        if (typeof value === 'object') {
          Object.keys(value).forEach(function (key) { if (value[key]) out.push(key); });
          return;
        }
        out.push(String(value));
      }
      let index = 0;
      while (index < arguments.length) push(arguments[index++]);
      return out.join(' ');
    }

    /**
     * Button —— shadcn/ui Button。variant：default（主按钮）/ secondary / outline /
     * ghost / link / destructive（未知值原样透传成 jk-kb-btn-<variant>，兼容旧类）；
     * size：default / sm / lg / icon。props 其余键原样透传给 <button>。
     */
    function Button(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const variant = rest.variant ? String(rest.variant) : 'default';
      const size = rest.size ? String(rest.size) : 'default';
      const attrs = {
        // 原始按钮均显式 type="button"，缺省兜底避免 form 语境误触 submit。
        type: rest.type == null ? 'button' : rest.type,
        className: cn('jk-kb-btn', 'jk-kb-btn-' + variant, size === 'default' ? null : 'jk-kb-btn-size-' + size, rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'variant' || key === 'size' || key === 'className' || key === 'type') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['button', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * Badge —— shadcn/ui Badge。variant：default / secondary / outline / destructive /
     * success / warning；渲染为 <span>，未知 variant 同 Button 策略透传。
     */
    function Badge(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const variant = rest.variant ? String(rest.variant) : 'secondary';
      const attrs = { className: cn('jk-kb-badge', 'jk-kb-badge-' + variant, rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'variant' || key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['span', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * Card —— shadcn/ui Card 壳：<div class="jk-kb-card">，其余 props 透传。
     */
    function Card(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { className: cn('jk-kb-card', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['div', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /** CardHeader —— 卡片头（标题/描述的纵向容器）。 */
    function CardHeader(props) {
      return simplePart('div', 'jk-kb-card-head', props, arguments);
    }

    /** CardTitle —— 卡片标题（h3）。 */
    function CardTitle(props) {
      return simplePart('h3', 'jk-kb-card-title', props, arguments);
    }

    /** CardDescription —— 卡片辅助描述（p，弱化文字）。 */
    function CardDescription(props) {
      return simplePart('p', 'jk-kb-card-desc', props, arguments);
    }

    /** CardContent —— 卡片正文（纵向 gap 容器）。 */
    function CardContent(props) {
      return simplePart('div', 'jk-kb-card-content', props, arguments);
    }

    /** CardFooter —— 卡片脚（横向操作区）。 */
    function CardFooter(props) {
      return simplePart('div', 'jk-kb-card-foot', props, arguments);
    }

    /**
     * simplePart —— 复合卡片件与简单元素的公共构造：合并固定类名与 props.className，
     * 其余 props 原样透传，children 原样下挂。
     * @param {string} tag 元素标签名
     * @param {string} base 固定类名
     * @param {object|null} props 组件 props（可为 null）
     * @param {object} args 调用方 arguments（用于取 children）
     * @returns {object} React 元素
     */
    function simplePart(tag, base, props, args) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { className: cn(base, rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, [tag, attrs].concat(Array.prototype.slice.call(args, 1)));
    }

    /** Input —— shadcn/ui Input：<input class="jk-kb-input">。 */
    function Input(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { className: cn('jk-kb-input', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h('input', attrs);
    }

    /** Textarea —— shadcn/ui Textarea：多行文本输入（无边框形态，由容器提供边框与聚焦环）。 */
    function Textarea(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { className: cn('jk-kb-textarea', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h('textarea', attrs);
    }

    /** Label —— shadcn/ui Label：<label class="jk-kb-label">。 */
    function Label(props) {
      return simplePart('label', 'jk-kb-label', props, arguments);
    }

    /** Separator —— shadcn/ui Separator：横向分隔线（div role="separator"）。 */
    function Separator(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { role: 'separator', className: cn('jk-kb-sep', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h('div', attrs);
    }

    /**
     * Skeleton —— shadcn/ui Skeleton 骨架占位。kind：'bar'（条，默认）/ 'dot'（点），
     * 与既有 jk-kb-skel-* 类同名同义；不传 className 时输出类名与旧标记完全一致。
     */
    function Skeleton(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const kind = rest.kind === 'dot' ? 'dot' : 'bar';
      const attrs = { 'aria-hidden': 'true', className: cn('jk-kb-skel-' + kind, rest.className) };
      return h('span', attrs);
    }

    /**
     * ConfirmDialog —— shadcn/ui AlertDialog 语义的内联确认框。
     * 结构：div.jk-kb-confirm[role=alertdialog] > 标题 + 描述 + children 插槽
     * （勾选框 / 详情行 / 预告列表等由调用方塞入）+ 操作区（主按钮 + 取消按钮）。
     * props：title 标题、description 描述（falsy 时省略）、yesProps / noProps
     * 透传给两个按钮（data-jk-kb-*、disabled、onClick、busy 文案等），
     * 其余键（className / data-jk-kb-* 等）原样落到容器 div 上。
     */
    function ConfirmDialog(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const RESERVED = ['title', 'description', 'yesProps', 'noProps', 'className'];
      const attrs = { role: 'alertdialog', className: cn('jk-kb-confirm', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (RESERVED.indexOf(key) !== -1) return;
        attrs[key] = rest[key];
      });
      // 先组装按钮属性再建元素（React 元素 props 只读，不可事后补键）。
      const yes = rest.yesProps && typeof rest.yesProps === 'object' ? rest.yesProps : {};
      const no = rest.noProps && typeof rest.noProps === 'object' ? rest.noProps : {};
      const yesAttrs = { type: 'button', variant: 'default' };
      Object.keys(yes).forEach(function (key) { if (key !== 'label') yesAttrs[key] = yes[key]; });
      const noAttrs = { type: 'button', variant: 'outline' };
      Object.keys(no).forEach(function (key) { if (key !== 'label') noAttrs[key] = no[key]; });
      const parts = [
        h('p', { className: 'jk-kb-risk-title' }, rest.title == null ? '确认操作？' : rest.title),
      ];
      if (rest.description != null) {
        parts.push(h('p', { className: 'jk-kb-hint' }, rest.description));
      }
      parts.push.apply(parts, Array.prototype.slice.call(arguments, 1));
      parts.push(h('div', { className: 'jk-kb-root-actions' },
        Button(yesAttrs, yes.label == null ? '确认' : yes.label),
        Button(noAttrs, no.label == null ? '取消' : no.label)));
      return h.apply(null, ['div', attrs].concat(parts));
    }

    /**
     * Alert —— shadcn/ui Alert 语义的提示块。variant：info（默认）/ success / warning /
     * destructive（旧 error 自动映射）。输出 div[role=status].jk-kb-alert.jk-kb-alert-<variant>，
     * 其余 props（data-jk-kb-*、aria-live 等）原样透传到容器。
     */
    function Alert(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const raw = rest.variant ? String(rest.variant) : 'info';
      // 旧 kind 归一：error → destructive；ok → success；warn → warning（宿主 notice 与体检级别共用）。
      const variant = raw === 'error'
        ? 'destructive'
        : (raw === 'ok' ? 'success' : (raw === 'warn' ? 'warning' : raw));
      const attrs = { role: 'status', className: cn('jk-kb-alert', 'jk-kb-alert-' + variant, rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'variant' || key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['div', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /** AlertTitle —— shadcn/ui AlertTitle 语义：Alert 内标题行（h5）。 */
    function AlertTitle(props) {
      return simplePart('h5', 'jk-kb-alert-title', props, arguments);
    }

    /** AlertDescription —— shadcn/ui AlertDescription 语义：Alert 内描述区（弱化文字容器）。 */
    function AlertDescription(props) {
      return simplePart('div', 'jk-kb-alert-desc', props, arguments);
    }

    /**
     * Checkbox —— shadcn/ui Checkbox 语义。单文件零依赖下用原生 input[type=checkbox]
     * 实现，视觉按 shadcn 规范（16px 方框、主题 accent、focus ring）；checked / onChange
     * 等 props 原样透传。
     */
    function Checkbox(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { type: 'checkbox', className: cn('jk-kb-checkbox', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h('input', attrs);
    }

    /**
     * Switch —— shadcn/ui Switch 语义。button[role=switch] 即轨道（44×24 胶囊），
     * 内部仅一个滑块 span；checked 驱动 aria-checked / data-state / jk-kb-switch-on，
     * 其余 props（data-jk-kb-switch、aria-labelledby、onClick 等）原样透传。
     */
    function Switch(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const checked = rest.checked === true;
      const attrs = {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'data-state': checked ? 'checked' : 'unchecked',
        className: cn('jk-kb-switch', checked ? 'jk-kb-switch-on' : null, rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'checked' || key === 'className') return;
        attrs[key] = rest[key];
      });
      return h('button', attrs, h('span', { className: 'jk-kb-switch-thumb' }));
    }

    /**
     * RadioGroup —— shadcn/ui RadioGroup 语义：div[role=radiogroup] 纵向容器，
     * 其余 props 透传。
     */
    function RadioGroup(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { role: 'radiogroup', className: cn('jk-kb-radio-group', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['div', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * RadioItem —— shadcn/ui RadioItem 语义：button[role=radio] 单选行（圆形指示器 +
     * 标签）；checked 驱动 aria-checked / data-state，其余 props 透传，children 为标签内容。
     */
    function RadioItem(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const checked = rest.checked === true;
      const attrs = {
        type: 'button',
        role: 'radio',
        'aria-checked': checked,
        'data-state': checked ? 'checked' : 'unchecked',
        className: cn('jk-kb-radio-item', checked ? 'jk-kb-radio-item-checked' : null, rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'checked' || key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['button', attrs,
        h('span', { className: 'jk-kb-radio-dot', 'aria-hidden': 'true' })]
        .concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * TabsList —— shadcn/ui TabsList 语义：触发器组容器（pill 底衬）。仅作布局容器，
     * 其余 props（aria-label 等）透传到 div；orientation 支持 'horizontal'（默认）/
     * 'vertical'（纵向菜单，反射为 data-orientation，由外层容器提供底衬）。
     */
    function TabsList(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const vertical = rest.orientation === 'vertical';
      const attrs = {
        'data-orientation': vertical ? 'vertical' : 'horizontal',
        className: cn('jk-kb-tabs-list', vertical ? 'jk-kb-tabs-list-vertical' : null, rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className' || key === 'orientation') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['div', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * TabsTrigger —— shadcn/ui TabsTrigger 语义：单个触发器按钮。active 驱动
     * data-state="active" 与 jk-kb-tabs-active；data-jk-kb-*、aria-current、onClick
     * 等原样透传。
     */
    function TabsTrigger(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const active = rest.active === true;
      const attrs = {
        type: 'button',
        'data-state': active ? 'active' : 'inactive',
        'aria-pressed': active,
        className: cn('jk-kb-tabs-trigger', active ? 'jk-kb-tabs-active' : null, rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'active' || key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['button', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * NavigationMenu —— shadcn/ui NavigationMenu 语义：顶层导航容器（nav）。
     * label 进 aria-label；其余 props（className、data-jk-kb-* 等）原样透传。
     */
    function NavigationMenu(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = {
        'aria-label': rest.label || '主导航',
        className: cn('jk-kb-navmenu', rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className' || key === 'label') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['nav', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * NavigationMenuList —— shadcn/ui NavigationMenuList 语义：导航项横向列表（ul）。
     */
    function NavigationMenuList(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { className: cn('jk-kb-navmenu-list', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['ul', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * NavigationMenuItem —— shadcn/ui NavigationMenuItem 语义：单个导航项（li）。
     */
    function NavigationMenuItem(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = { className: cn('jk-kb-navmenu-item', rest.className) };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['li', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

    /**
     * NavigationMenuLink —— shadcn/ui NavigationMenuLink 语义：导航链接（a）。
     * active 驱动 data-active="true" 与 jk-kb-navmenu-link-active；
     * href / target / rel / data-jk-kb-* / onClick 等原样透传。
     */
    function NavigationMenuLink(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const active = rest.active === true;
      const attrs = {
        'data-active': active ? 'true' : undefined,
        'aria-current': active ? 'page' : undefined,
        className: cn('jk-kb-navmenu-link', active ? 'jk-kb-navmenu-link-active' : null, rest.className),
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'active' || key === 'className') return;
        attrs[key] = rest[key];
      });
      return h.apply(null, ['a', attrs].concat(Array.prototype.slice.call(arguments, 1)));
    }

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

      const hostStatus = health ? health.status : (host.status || 'loading');
      // 徽标变体按宿主状态映射：连通 → success，版本不一致/失败 → destructive，半加载 → warning。
      const hostBadgeVariant = hostStatus === 'ok' || hostStatus === 'ready'
        ? 'success'
        : (hostStatus === 'mismatch' || hostStatus === 'error'
          ? 'destructive'
          : (hostStatus === 'not-loaded' ? 'warning' : 'secondary'));

      return Card({
        className: p.focusActive === true ? 'jk-kb-focus-pulse' : undefined,
        ref: p.sectionRef || undefined,
        'data-jk-kb-card': 'root',
        'data-jk-kb-focus': p.focusActive === true ? 'root' : undefined,
      },
        h('div', { className: 'jk-kb-section-head' },
          h('h2', { className: 'jk-kb-section-title' }, '基本信息'),
          Badge({
            variant: hostBadgeVariant,
            className: 'jk-kb-host-badge',
            'data-jk-kb-host': hostStatus,
          }, hostLabel)
        ),
        hostNotice
          ? Alert({
              variant: 'error',
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
                Button({
                  key: 'pick',
                  variant: 'outline',
                  'data-jk-kb-pick': 'true',
                  disabled: picking || !hostReady,
                  onClick: typeof p.onPick === 'function' ? p.onPick : undefined,
                }, picking ? '正在选择…' : '选择目录'),
                Button({
                  key: 'revalidate',
                  variant: 'outline',
                  'data-jk-kb-validate': 'true',
                  disabled: validating || !draftRoot || !hostReady,
                  onClick: typeof p.onValidate === 'function' ? p.onValidate : undefined,
                }, validating ? '校验中…' : '重新校验'),
              ]
            : [
                Input({
                  key: 'root-input',
                  type: 'text',
                  'data-jk-kb-root-input': 'true',
                  placeholder: '/绝对/路径/知识库',
                  value: draftRoot,
                  onChange: onDraftChange,
                  disabled: !hostReady,
                }),
                Button({
                  key: 'root-validate',
                  variant: 'outline',
                  'data-jk-kb-validate': 'true',
                  disabled: validating || !hostReady,
                  onClick: typeof p.onValidate === 'function' ? p.onValidate : undefined,
                }, validating ? '校验中…' : '校验'),
              ]
        ),
        validation
          ? Alert({
              variant: level === 'reject' ? 'destructive' : (level === 'unknown' ? 'info' : level),
              className: 'jk-kb-validation',
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
          ? Alert({
              variant: 'warning',
              className: 'jk-kb-risk',
              'data-jk-kb-risk': 'true',
            },
              AlertTitle(null, '写入前的风险确认'),
              AlertDescription(null,
                h('ul', { className: 'jk-kb-risk-list' },
                  RISK_POINTS.map((text, index) => h('li', { key: 'risk-' + index, className: 'jk-kb-risk-item' }, text))
                ),
                h('label', { className: 'jk-kb-ack' },
                  Checkbox({
                    'data-jk-kb-ack': 'true',
                    checked: p.acknowledged === true,
                    onChange: onAckChange,
                  }),
                  h('span', { className: 'jk-kb-ack-text' }, RISK_ACK_TEXT)
                )
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
        Button({
          variant: 'ghost',
          size: 'icon',
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
          Button({
            variant: 'outline',
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
        Button({
          variant: 'default',
          className: 'jk-kb-guide-cta',
          'data-jk-kb-guide-open-settings': 'true',
          onClick: onOpenSettings || undefined,
        }, '去设置里设置根目录'),
        h('p', { className: 'jk-kb-guide-footnote' }, '配置完成后本页自动切换成仪表盘，不会白屏。'),
        hint
          ? Alert({
              variant: 'error',
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
          Button({
            type: 'button',
            variant: 'outline',
            size: 'sm',
            className: 'jk-kb-guide-bar-action',
            'data-jk-kb-guide-bar-open-settings': 'true',
            'data-jk-kb-guide-open-settings': 'true',
            onClick: typeof p.onOpenSettings === 'function' ? p.onOpenSettings : undefined,
          }, '去设置')
        ),
        typeof p.hint === 'string' && p.hint
          ? Alert({ variant: 'error', 'data-jk-kb-guide-hint': 'true' }, p.hint)
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
      // 主页面专家页：保留标题/表单/状态切换，卡片区域移至设置页 → 传 cardsHidden。
      if (activeMenu.id === EXPERTS_ID) return h(ExpertsPage, { cardsHidden: true });
      // 文件管理：左树 + 当前目录列表 + 按格式预览（依赖 root，no-root 已被菜单过滤拦住）。
      if (activeMenu.id === FILES_ID) return h(FilesPage, null);
      if (activeMenu.id === TASKS_ID) {
        if (p.selectedRunId) {
          return h(RunDetailPage, { runId: p.selectedRunId, onBack: p.onBack });
        }
        return h(TasksPage, { onOpenRun: p.onOpenRun, seedFeed: p.runsFeed, onFeed: p.onFeed });
      }
      // 技能管理：全量技能按岗位分类浏览 + 行展开明细（从任务管理「技能」标签页迁出）。
      if (activeMenu.id === SKILLS_ID) return h(SkillViewPage, null);
      if (activeMenu.id === USAGE_ID) return h(UsagePage, null);
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
        // 业务专家模块迁入设置页：其样式类（jk-kb-experts-*、blockquote 等）定义在面板样式表，这里一并注入。
        h('style', { dangerouslySetInnerHTML: { __html: PANEL_STYLE } }),
        h('header', { className: 'jk-kb-head' },
          h('div', null,
            h('h1', { className: 'jk-kb-title' }, PLUGIN_NAME),
            h('p', { className: 'jk-kb-subtitle' }, '知识库入口开关、根目录与插件信息。')
          )
        ),
        Card({ 'data-jk-kb-card': 'switch' },
          h('div', { className: 'jk-kb-switch-row' },
            h('span', { className: 'jk-kb-switch-label', id: 'jk-kb-switch-label' }, '启动JK知识库'),
            h(SwitchInfo, null),
            Switch({
              checked: enabled,
              'aria-labelledby': 'jk-kb-switch-label',
              'data-jk-kb-switch': enabled ? 'on' : 'off',
              onClick: onToggle,
            })
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
        // 业务专家管理：自知识库主页面迁入，「基本信息」下方的独立模块，套同款 Card 卡片壳。
        Card({ 'data-jk-kb-card': 'experts' },
          h('div', { className: 'jk-kb-experts-module', 'data-jk-kb-experts-module': 'true' },
            h(ExpertsPage, null)
          )
        ),
        notice.kind
          ? Alert({
              variant: notice.kind,
              'data-jk-kb-notice': notice.kind,
              'aria-live': 'polite',
            }, notice.text)
          : null,
        h('footer', { className: 'jk-kb-footer' },
          Button({
            variant: 'default',
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
    /** 空态图标：折角空文档（描边风格，颜色继承 currentColor），供各空态盒复用。 */
    function EmptyDocIcon(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const attrs = {
        className: cn('jk-kb-empty-icon', rest.className),
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      };
      Object.keys(rest).forEach(function (key) {
        if (key === 'className') return;
        attrs[key] = rest[key];
      });
      return h('svg', attrs,
        h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
        h('path', { d: 'M14 2v6h6' }),
        h('path', { d: 'M8 13h8' }),
        h('path', { d: 'M8 17h5' })
      );
    }

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
          h('h2', { className: 'jk-kb-section-title' }, '仪表盘')
        ),
        Button({
          variant: 'outline',
          size: 'sm',
          type: 'button',
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
            Button({
              variant: 'outline',
              size: 'sm',
              type: 'button',
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
        ? Badge({ variant: 'warning', 'data-jk-kb-truncated': 'true' }, '已截断')
        : null;
      const cards = [
        { id: 'entries', label: '知识条目', value: formatTokenCount(counts.notes), hint: counts.dirs + ' 个顶层目录' },
        { id: 'weekly', label: '本周新增', value: String(weekValue), hint: counts.weekAdded !== null ? '宿主统计' : '按最近入库估算（近 7 天）' },
        { id: 'today', label: '今日任务', value: String(data.today.runs), hint: '完成 ' + data.today.completed + ' · 失败 ' + data.today.failed },
        { id: 'skills', label: '技能数', value: String(BUILTIN_SKILL_COUNT + (registryCount || 0)), hint: customSkillText },
      ];

      // 统计卡走 shadcn Card 结构：卡壳样式来自 .jk-kb-card，数值排版沿用 .jk-kb-stat-*。
      const stats = h('div', { className: 'jk-kb-stats' },
        cards.map((card) => Card({
          key: card.id,
          className: 'jk-kb-stat',
          'data-jk-kb-stat': card.id,
        },
          CardHeader(null,
            CardDescription({ className: 'jk-kb-stat-label' }, card.label),
            truncatedBadge
          ),
          h('span', { className: 'jk-kb-stat-value' }, card.value),
          h('span', { className: 'jk-kb-stat-hint' }, card.hint)
        ))
      );

      // 总空态：空内容用大框呈现（居中空文档图标 + 引导文案），下方最近入库区整体收起。
      const isEmpty = counts.notes === 0 && data.recent.length === 0;
      const emptyBox = isEmpty
        ? h('div', { className: 'jk-kb-empty jk-kb-empty-center', 'data-jk-kb-dashboard-empty': 'true' },
            EmptyDocIcon(),
            h('p', { className: 'jk-kb-empty-text' }, '快来放第一篇文档吧')
          )
        : null;

      const recentBlock = isEmpty
        ? null
        : h('section', { className: 'jk-kb-block', 'data-jk-kb-block': 'recent' },
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
                Button({
                  type: 'button',
                  variant: 'outline',
                  size: 'sm',
                  className: 'jk-kb-recent-copy',
                  'data-jk-kb-recent-copy': item.relPath || item.key,
                  disabled: !item.relPath,
                  onClick: () => copyToClipboard(item.relPath),
                }, '复制路径')
              ))
            )
          : h('p', { className: 'jk-kb-hint', 'data-jk-kb-recent-empty': 'true' }, '还没有内容')
      );

      // 运行状态块已整体迁到「使用信息」页（UsageView），仪表盘不再渲染。
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
          : h('div', { className: 'jk-kb-empty jk-kb-empty-center jk-kb-empty-maintain', 'data-jk-kb-maintain-empty': 'true' },
              EmptyDocIcon(),
              h('p', { className: 'jk-kb-empty-text' }, '现在还是空的呢：）')
            )
      );

      return h('div', { className: 'jk-kb-dash', 'data-jk-kb-dashboard': 'true', 'data-jk-kb-dashboard-phase': 'ready' },
        header,
        stats,
        emptyBox,
        h('div', { className: 'jk-kb-dash-columns' }, recentBlock, maintainBlock)
      );
    }

    // ───────────────────────────── 使用信息（运行状态，数据同 GET /dashboard） ─────────────────────────────
    function UsagePage() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const [reload, setReload] = React.useState(0);
      // 环境体检：从任务管理页迁来（进页面体检一次 + 手动重新检查，不并入 dashboard 加载）。
      const [preflight, setPreflight] = React.useState({ phase: 'idle', report: null, error: null, expanded: false });
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };

      // 体检一次：进页面执行 + 手动按钮，绝不并入 dashboard 的 reload 链（没有第二条定时器链）。
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

      React.useEffect(function () {
        let alive = true;
        aliveRef.current = true;
        setState((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchDashboard().then((result) => {
          if (!alive) return;
          const norm = normalizeDashboardResponse(result);
          setState(norm.ok === true
            ? { phase: 'ready', data: norm.data, error: null }
            : { phase: 'error', data: null, error: norm.error });
        });
        checkPreflight();
        return function () { alive = false; aliveRef.current = false; };
      }, [reload]);

      return UsageView({
        phase: state.phase,
        data: state.data,
        error: state.error,
        onRefresh: () => setReload(reload + 1),
        onRetry: () => setReload(reload + 1),
        preflight: preflight,
        onRecheck: checkPreflight,
        onTogglePreflight: () => setPreflight((prev) => Object.assign({}, prev, { expanded: prev.expanded !== true })),
      });
    }

    /**
     * 使用信息视图：仪表盘迁来的「运行状态」信息（根目录/模式/vault/最近 run/
     * 工具注册/子代理等）+ 任务管理页迁来的「环境体检」，纯展示便于单测。
     * phase 走 loading / error / ready；体检行与 dashboard 数据互不依赖。
     */
    function UsageView(props) {
      const p = props || {};
      const phase = p.phase || 'loading';
      const data = p.data && typeof p.data === 'object' ? p.data : null;
      const error = p.error && typeof p.error === 'object' ? p.error : null;

      const header = h('div', { className: 'jk-kb-dash-head' },
        h('div', null,
          h('h2', { className: 'jk-kb-section-title' }, '使用信息')
        ),
        Button({
          variant: 'outline',
          size: 'sm',
          type: 'button',
          'data-jk-kb-usage-refresh': 'true',
          disabled: phase === 'loading',
          onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
        }, phase === 'loading' ? '加载中…' : '刷新')
      );

      // ── 环境体检（自任务管理页迁来）：行 + 错误提示 + 展开明细，任何 phase 都渲染 ──
      const preflight = p.preflight && typeof p.preflight === 'object'
        ? p.preflight
        : { phase: 'idle', report: null, error: null, expanded: false };
      const pf = preflight.report ? presentPreflight(preflight.report) : null;
      const pfPhase = preflight.phase || 'idle';
      const pfTone = pfPhase === 'loading'
        ? 'loading'
        : (pfPhase === 'error' ? 'unavailable' : (pf ? pf.level : 'idle'));
      const pfText = pfPhase === 'loading'
        ? '体检中…'
        : (pfPhase === 'error' ? '体检不可用' : (pf ? pf.label : '—'));

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
          ? Button({
              variant: 'outline',
              'data-jk-kb-preflight-toggle': 'true',
              'aria-expanded': preflight.expanded === true,
              onClick: typeof p.onTogglePreflight === 'function' ? p.onTogglePreflight : undefined,
            }, preflight.expanded === true ? '收起' : '展开')
          : null,
        h('div', { className: 'jk-kb-preflight-actions' },
          Button({
            variant: 'outline',
            'data-jk-kb-preflight-recheck': 'true',
            disabled: pfPhase === 'loading',
            onClick: typeof p.onRecheck === 'function' ? p.onRecheck : undefined,
          }, pfPhase === 'loading' ? '检查中…' : '重新检查')
        )
      );

      const preflightError = pfPhase === 'error' && preflight.error
        ? Alert({
            variant: 'destructive',
            'data-jk-kb-preflight-error': (preflight.error && preflight.error.code) || 'host-unreachable',
          }, '体检不可用：' + ((preflight.error && preflight.error.message) || '宿主服务未连接'))
        : null;

      // 体检结果卡片走 shadcn Card 结构：CardHeader（标题 + 错误码 Badge）→ CardDescription（元信息）→ CardContent（Alert 明细 + 建议）。
      const preflightCard = pf && preflight.expanded === true
        ? Card({
            className: 'jk-kb-preflight-card',
            'data-jk-kb-preflight-card': pf.level,
          },
            CardHeader(null,
              CardTitle(null, '体检结果'),
              pf.code
                ? Badge({
                    variant: 'outline',
                    className: 'jk-kb-preflight-code',
                    'data-jk-kb-preflight-code': pf.code,
                  }, pf.code)
                : null
            ),
            CardDescription(null,
              h('span', { 'data-jk-kb-preflight-counts': 'true' }, pf.countsText),
              ' · 剩余 ',
              h('span', { 'data-jk-kb-preflight-free': 'true' }, pf.freeText),
              ' · 耗时 ',
              h('span', { 'data-jk-kb-preflight-elapsed': 'true' }, pf.elapsedText)
            ),
            CardContent(null,
              pf.checks.length > 0
                ? h('div', { className: 'jk-kb-preflight-checks', 'data-jk-kb-preflight-checks': 'true' },
                    pf.checks.map((check) => Alert({
                      key: check.key,
                      variant: check.level,
                      className: 'jk-kb-check-' + check.level,
                      'data-jk-kb-check': check.id || check.key,
                      'data-jk-kb-check-level': check.level,
                    },
                      AlertTitle(null, check.title),
                      AlertDescription(null,
                        h('p', { className: 'jk-kb-check-detail' }, check.detail),
                        check.fix
                          ? h('p', { className: 'jk-kb-check-fix', 'data-jk-kb-check-fix': check.id || check.key }, '修复：' + check.fix)
                          : null
                      )))
                  )
                : h('p', { className: 'jk-kb-hint', 'data-jk-kb-preflight-empty': 'true' }, '宿主未返回体检明细。'),
              pf.advice
                ? h('p', { className: 'jk-kb-check-fix', 'data-jk-kb-preflight-advice': pf.code }, pf.advice)
                : null
            )
          )
        : null;

      if (phase !== 'ready' || !data) {
        return h('div', { className: 'jk-kb-dash', 'data-jk-kb-usage': 'true', 'data-jk-kb-usage-phase': phase },
          header,
          preflightRow,
          preflightError,
          preflightCard,
          phase === 'error'
            ? h('div', { className: 'jk-kb-error', 'data-jk-kb-usage-error': 'true' },
                h('h3', { className: 'jk-kb-placeholder-title' }, '使用信息不可用'),
                h('p', { className: 'jk-kb-hint' }, '无法读取运行状态（' + HOST_DASHBOARD_PATH + '）。'),
                error
                  ? h('p', { className: 'jk-kb-note' }, '详情：' + (error.code || 'unknown') + ' ' + (error.message || ''))
                  : null,
                Button({
                  variant: 'outline',
                  size: 'sm',
                  type: 'button',
                  'data-jk-kb-usage-retry': 'true',
                  onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
                }, '重试')
              )
            : null,
          phase === 'loading'
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-usage-loading': 'true' }, '正在读取运行状态…')
            : null
        );
      }

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

      return h('div', { className: 'jk-kb-dash', 'data-jk-kb-usage': 'true', 'data-jk-kb-usage-phase': 'ready' },
        header,
        preflightRow,
        preflightError,
        preflightCard,
        runtimeBlock
      );
    }

    // ───────────────────────────── 文件管理（文件树 / 目录列表 / 文件预览） ─────────────────────────────
    /**
     * FilesPage —— 文件管理容器：左树导航（懒加载目录）+ 中栏当前目录列表 + 右栏按格式预览。
     * tree 是「目录 → 子文件夹列表」的缓存（只存已加载层），expanded 记录树展开态；
     * 点击文件夹 = 切换 currentDir 并加载，点击文件 = 拉预览（text/image/binary 分支）。
     */
    function FilesPage() {
      const [list, setList] = React.useState({ phase: 'loading', data: null, error: null });
      const [tree, setTree] = React.useState({ '': [] });
      const [expanded, setExpanded] = React.useState({ '': true });
      const [currentDir, setCurrentDir] = React.useState('');
      const [preview, setPreview] = React.useState({ phase: 'idle', path: '', data: null, error: null });

      // 加载一个目录：中栏列表 + 左树子文件夹缓存 + 展开标记，一次请求全部就绪。
      async function loadDir(dir, silent) {
        const rel = typeof dir === 'string' ? dir : '';
        if (silent !== true) setList({ phase: 'loading', data: null, error: null });
        const result = await fetchFiles(rel);
        const norm = normalizeFilesResponse(result);
        if (norm.ok !== true) {
          setList({ phase: 'error', data: null, error: norm.error });
          return;
        }
        setList({ phase: 'ready', data: norm.data, error: null });
        setTree((prev) => Object.assign({}, prev, { [rel]: norm.data.folders.map((folder) => folder.name) }));
        setExpanded((prev) => Object.assign({}, prev, { [rel]: true }));
      }

      React.useEffect(function () {
        loadDir(currentDir);
      }, [currentDir]);

      /** 树节点点击：已是当前目录就切走（折叠语义），否则导航进去。 */
      function onOpenDir(dir) {
        if (dir === currentDir && expanded[dir] === true) {
          setExpanded((prev) => Object.assign({}, prev, { [dir]: false }));
          return;
        }
        setCurrentDir(dir);
      }

      /** 树箭头点击：只展开/收起，不切换当前目录。 */
      function onToggleDir(dir) {
        if (tree[dir] === undefined) {
          loadDir(dir, true);
          return;
        }
        setExpanded((prev) => Object.assign({}, prev, { [dir]: prev[dir] !== true }));
      }

      /** 中栏面包屑「上一级」：root 时禁用。 */
      function onGoUp() {
        if (!currentDir) return;
        const parts = currentDir.split('/');
        parts.pop();
        setCurrentDir(parts.join('/'));
      }

      /** 点击文件：右栏预览（加载失败降级为错误卡）。 */
      async function onOpenFile(relPath) {
        const rel = typeof relPath === 'string' ? relPath : '';
        if (!rel) return;
        setPreview({ phase: 'loading', path: rel, data: null, error: null });
        const result = await fetchFileEntry(rel);
        const norm = normalizeFileResponse(result);
        if (norm.ok !== true) {
          setPreview({ phase: 'error', path: rel, data: null, error: norm.error });
          return;
        }
        setPreview({ phase: 'ready', path: rel, data: norm.data, error: null });
      }

      return FilesView({
        list: list,
        tree: tree,
        expanded: expanded,
        currentDir: currentDir,
        preview: preview,
        onOpenDir: onOpenDir,
        onToggleDir: onToggleDir,
        onGoUp: onGoUp,
        onOpenFile: onOpenFile,
        onRefresh: () => loadDir(currentDir),
      });
    }

    /**
     * FilesView —— 文件管理三栏纯展示：左树（递归渲染已加载目录）+ 中栏（当前目录
     * 文件夹/文件列表）+ 右栏预览（text → pre，image → img，binary/too-large → 元信息提示）。
     */
    function FilesView(props) {
      const p = props || {};
      const list = p.list && typeof p.list === 'object' ? p.list : { phase: 'loading', data: null, error: null };
      const tree = p.tree && typeof p.tree === 'object' ? p.tree : { '': [] };
      const expanded = p.expanded && typeof p.expanded === 'object' ? p.expanded : { '': true };
      const currentDir = typeof p.currentDir === 'string' ? p.currentDir : '';
      const preview = p.preview && typeof p.preview === 'object' ? p.preview : { phase: 'idle', path: '', data: null, error: null };
      const data = list.data;

      // 递归渲染左树：dir（相对路径）下的已加载子文件夹；根节点 label「根目录」。
      function renderTreeDir(dir, name, depth) {
        const isOpen = expanded[dir] === true;
        const children = Array.isArray(tree[dir]) ? tree[dir] : [];
        const isCurrent = dir === currentDir;
        return h('li', {
          key: 'tree-' + (dir || 'root'),
          className: 'jk-kb-file-tree-item',
          'data-jk-kb-file-tree-dir': dir || 'root',
        },
          h('div', {
            className: 'jk-kb-file-tree-row' + (isCurrent ? ' jk-kb-file-tree-row-active' : ''),
            style: { paddingLeft: (depth * 14 + 8) + 'px' },
          },
            children.length > 0
              ? h('button', {
                  type: 'button',
                  className: 'jk-kb-file-tree-caret' + (isOpen ? ' jk-kb-file-tree-caret-open' : ''),
                  'data-jk-kb-file-tree-caret': dir || 'root',
                  'aria-label': (isOpen ? '收起' : '展开') + ' ' + (name || '根目录'),
                  onClick: () => (typeof p.onToggleDir === 'function' ? p.onToggleDir(dir) : undefined),
                }, '▸')
              : h('span', { className: 'jk-kb-file-tree-caret jk-kb-file-tree-caret-leaf' }, '·'),
            h('button', {
              type: 'button',
              className: 'jk-kb-file-tree-label',
              'data-jk-kb-file-tree-label': dir || 'root',
              'aria-current': isCurrent ? 'true' : undefined,
              title: dir || '根目录',
              onClick: () => (typeof p.onOpenDir === 'function' ? p.onOpenDir(dir) : undefined),
            }, name || '根目录')
          ),
          isOpen && children.length > 0
            ? h('ul', { className: 'jk-kb-file-tree-children' },
                children.map((childName) => renderTreeDir(
                  dir ? dir + '/' + childName : childName,
                  childName,
                  depth + 1
                )))
            : null
        );
      }

      const treePane = h('nav', { className: 'jk-kb-files-pane jk-kb-file-tree', 'aria-label': '目录树', 'data-jk-kb-file-tree': 'true' },
        h('ul', { className: 'jk-kb-file-tree-list' }, renderTreeDir('', '', 0))
      );

      // 中栏：面包屑 + 刷新 + 条目列表（文件夹在前，文件点击触发预览）。
      const listHeader = h('div', { className: 'jk-kb-files-list-head' },
        h('span', { className: 'jk-kb-files-crumb', 'data-jk-kb-files-crumb': 'true' },
          currentDir ? '/' + currentDir : '/'),
        h('div', { className: 'jk-kb-files-list-actions' },
          Button({
            variant: 'outline',
            size: 'sm',
            'data-jk-kb-files-up': 'true',
            disabled: !currentDir || list.phase === 'loading',
            onClick: typeof p.onGoUp === 'function' ? p.onGoUp : undefined,
          }, '上一级'),
          Button({
            variant: 'outline',
            size: 'sm',
            'data-jk-kb-files-refresh': 'true',
            disabled: list.phase === 'loading',
            onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
          }, list.phase === 'loading' ? '加载中…' : '刷新')
        )
      );

      let listBody;
      if (list.phase === 'loading') {
        listBody = h('p', { className: 'jk-kb-hint', 'data-jk-kb-files-loading': 'true' }, '正在读取目录…');
      } else if (list.phase === 'error') {
        const error = list.error || {};
        listBody = h('div', { className: 'jk-kb-error', 'data-jk-kb-files-error': (error.code || 'host-unreachable') },
          h('h3', { className: 'jk-kb-placeholder-title' }, '目录读取失败'),
          h('p', { className: 'jk-kb-hint' }, (error.code || 'unknown') + ' ' + (error.message || ''))
        );
      } else if (!data || (data.folders.length === 0 && data.files.length === 0)) {
        listBody = h('div', { className: 'jk-kb-empty jk-kb-empty-center', 'data-jk-kb-files-empty': 'true' },
          EmptyDocIcon(),
          h('p', { className: 'jk-kb-empty-text' }, '这个目录是空的')
        );
      } else {
        listBody = h('ul', { className: 'jk-kb-files-list' },
          data.folders.map((folder) => h('li', { key: 'd-' + folder.key, className: 'jk-kb-file-entry' },
            h('button', {
              type: 'button',
              className: 'jk-kb-file-entry-btn',
              'data-jk-kb-file-entry': 'dir',
              'data-jk-kb-file-entry-name': folder.name,
              onClick: () => (typeof p.onOpenDir === 'function'
                ? p.onOpenDir(currentDir ? currentDir + '/' + folder.name : folder.name)
                : undefined),
            },
              h('span', { className: 'jk-kb-file-entry-icon jk-kb-file-entry-icon-dir' }, '📁'),
              h('span', { className: 'jk-kb-file-entry-name' }, folder.name),
              h('span', { className: 'jk-kb-file-entry-meta' }, folder.mtimeText)
            )
          )),
          data.files.map((file) => h('li', { key: 'f-' + file.key, className: 'jk-kb-file-entry' },
            h('button', {
              type: 'button',
              className: 'jk-kb-file-entry-btn',
              'data-jk-kb-file-entry': 'file',
              'data-jk-kb-file-entry-name': file.name,
              onClick: () => (typeof p.onOpenFile === 'function'
                ? p.onOpenFile(currentDir ? currentDir + '/' + file.name : file.name)
                : undefined),
            },
              h('span', { className: 'jk-kb-file-entry-icon jk-kb-file-entry-icon-file' }, '📄'),
              h('span', { className: 'jk-kb-file-entry-name' }, file.name),
              h('span', { className: 'jk-kb-file-entry-meta' }, file.sizeText + ' · ' + file.mtimeText)
            )
          ))
        );
      }

      const listPane = h('section', { className: 'jk-kb-files-pane jk-kb-files-list-pane', 'aria-label': '当前目录', 'data-jk-kb-files-list': 'true' },
        listHeader,
        listBody
      );

      // 右栏预览：idle 占位 / loading / error / ready 按 kind 分支。
      let previewBody;
      if (preview.phase === 'idle') {
        previewBody = h('div', { className: 'jk-kb-empty jk-kb-empty-center', 'data-jk-kb-file-preview-idle': 'true' },
          EmptyDocIcon(),
          h('p', { className: 'jk-kb-empty-text' }, '点击文件查看预览')
        );
      } else if (preview.phase === 'loading') {
        previewBody = h('p', { className: 'jk-kb-hint', 'data-jk-kb-file-preview-loading': 'true' }, '正在读取文件…');
      } else if (preview.phase === 'error') {
        const pvError = preview.error || {};
        previewBody = h('div', { className: 'jk-kb-error', 'data-jk-kb-file-preview-error': (pvError.code || 'host-unreachable') },
          h('h3', { className: 'jk-kb-placeholder-title' }, '文件读取失败'),
          h('p', { className: 'jk-kb-hint' }, (pvError.code || 'unknown') + ' ' + (pvError.message || ''))
        );
      } else {
        const file = preview.data;
        const metaRow = h('p', { className: 'jk-kb-file-preview-meta', 'data-jk-kb-file-preview-meta': 'true' },
          file.name + ' · ' + file.sizeText + ' · ' + file.mtimeText
        );
        if (file.kind === 'text') {
          previewBody = h('div', { className: 'jk-kb-file-preview-body' },
            metaRow,
            h('pre', { className: 'jk-kb-file-preview-text', 'data-jk-kb-file-preview-text': 'true' }, file.text)
          );
        } else if (file.kind === 'image') {
          previewBody = h('div', { className: 'jk-kb-file-preview-body' },
            metaRow,
            h('img', {
              className: 'jk-kb-file-preview-image',
              'data-jk-kb-file-preview-image': 'true',
              src: file.dataUrl,
              alt: file.name,
            })
          );
        } else if (file.kind === 'too-large') {
          previewBody = h('div', { className: 'jk-kb-file-preview-body' },
            metaRow,
            h('p', { className: 'jk-kb-hint', 'data-jk-kb-file-preview-toolarge': 'true' }, '文件超过 2MB 文本预览上限，暂不支持在线查看。')
          );
        } else {
          previewBody = h('div', { className: 'jk-kb-file-preview-body' },
            metaRow,
            h('p', { className: 'jk-kb-hint', 'data-jk-kb-file-preview-binary': 'true' }, '该格式暂不支持预览，仅显示文件信息。')
          );
        }
      }

      const previewPane = h('section', { className: 'jk-kb-files-pane jk-kb-file-preview', 'aria-label': '文件预览', 'data-jk-kb-file-preview': 'true' },
        previewBody
      );

      return h('div', { className: 'jk-kb-files', 'data-jk-kb-files': 'true', 'data-jk-kb-files-phase': list.phase },
        treePane,
        listPane,
        previewPane
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
      return Card({ className: 'jk-kb-placeholder', 'data-jk-kb-placeholder': id },
        CardTitle({ className: 'jk-kb-placeholder-title' }, label),
        CardDescription({ className: 'jk-kb-hint' }, description)
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
          ? Button({
              variant: 'outline',
              size: 'sm',
              className: 'jk-kb-more',
              'data-jk-kb-more': view.moreState,
              'aria-expanded': view.expanded,
              onClick: onToggle || undefined,
            }, view.moreLabel)
          : null
      );
    }

    // 菜单导航：按 rootStatus 过滤（no-root 只显示仪表盘），结构仍由 MENUS 驱动。
    // ───────────────────────── shadcn/ui Sidebar 结构组件（项目内手写移植） ─────────────────────────
    // 结构对齐官方 Sidebar：Header（品牌）/ Content（可滚动的分组内容）/ Footer（底部区）。
    // 全部薄壳工厂：签名 (props, ...children)，默认标记合并进 props 后透传给 createElement。
    function makeSidebarPart(tag, className, marker) {
      return function (props) {
        const rest = props && typeof props === 'object' ? props : {};
        const children = [];
        for (let i = 1; i < arguments.length; i += 1) {
          if (arguments[i] !== null && arguments[i] !== undefined) children.push(arguments[i]);
        }
        if (rest.children !== null && rest.children !== undefined) children.push(rest.children);
        const attrs = Object.assign({ [marker]: 'true' }, rest);
        attrs.className = cn(className, rest.className);
        delete attrs.children;
        return h(tag, attrs, children.length === 1 ? children[0] : children);
      };
    }

    const SidebarHeader = makeSidebarPart('div', 'jk-kb-sidebar-header', 'data-jk-kb-sidebar-header');
    const SidebarContent = makeSidebarPart('div', 'jk-kb-sidebar-content', 'data-jk-kb-sidebar-content');
    const SidebarFooter = makeSidebarPart('div', 'jk-kb-sidebar-footer', 'data-jk-kb-sidebar-footer');
    const SidebarGroup = makeSidebarPart('section', 'jk-kb-sidebar-group', 'data-jk-kb-sidebar-group');
    const SidebarGroupLabel = makeSidebarPart('div', 'jk-kb-sidebar-group-label', 'data-jk-kb-sidebar-group-label');

    // shadcn/ui Table 结构组件（项目内手写移植）：语义化 table/thead/tbody/tr/th/td 薄壳，
    // 复用 Sidebar 的薄壳工厂；任务列表用它渲染，行可点击（role=button + tabIndex）。
    const Table = makeSidebarPart('table', 'jk-kb-table', 'data-jk-kb-table');
    const TableHeader = makeSidebarPart('thead', 'jk-kb-table-header', 'data-jk-kb-table-header');
    const TableBody = makeSidebarPart('tbody', 'jk-kb-table-body', 'data-jk-kb-table-body');
    const TableRow = makeSidebarPart('tr', 'jk-kb-table-row', 'data-jk-kb-table-row');
    const TableHead = makeSidebarPart('th', 'jk-kb-table-head', 'data-jk-kb-table-head');
    const TableCell = makeSidebarPart('td', 'jk-kb-table-cell', 'data-jk-kb-table-cell');

    // 菜单按钮：active → data-active（shadcn 同款标记），icon + 文字双列。
    function SidebarMenuButton(props) {
      const rest = props && typeof props === 'object' ? props : {};
      const active = rest.active === true;
      const children = [];
      for (let i = 1; i < arguments.length; i += 1) {
        if (arguments[i] !== null && arguments[i] !== undefined) children.push(arguments[i]);
      }
      if (rest.children !== null && rest.children !== undefined) children.push(rest.children);
      const attrs = {
        type: 'button',
        className: cn('jk-kb-sidebar-menu-button', active ? 'jk-kb-sidebar-menu-button-active' : null, rest.className),
        'data-active': active ? 'true' : 'false',
      };
      Object.keys(rest).forEach(function (key) {
        if (key !== 'children' && key !== 'active' && key !== 'className') attrs[key] = rest[key];
      });
      return h('button', attrs, children.length === 1 ? children[0] : children);
    }

    // 数字时钟（footer 占位）：秒级跳动；时间来源本地 Date，不依赖宿主。
    // 项目源级约束禁用 setInterval：这里用 setTimeout 链（now 变化 → effect 重排下一秒）。
    function formatClockText(now) {
      const date = now instanceof Date ? now : new Date(now);
      const pad = function (value) { return String(value).padStart(2, '0'); };
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    function SidebarClock(props) {
      const [now, setNow] = React.useState(new Date());
      React.useEffect(function () {
        const timer = setTimeout(function () { setNow(new Date()); }, 1000);
        return function () { clearTimeout(timer); };
      }, [now]);
      return h('div', {
        className: 'jk-kb-sidebar-clock',
        'data-jk-kb-sidebar-clock': 'true',
        role: 'timer',
        'aria-live': 'off',
      }, formatClockText(now));
    }

    // 左栏菜单：shadcn SidebarMenu 形态（icon + label），数据驱动、顺序即展示顺序。
    // collapsed=true（icon 折叠模式）：只渲染图标列，label 转为 title/aria-label 提示。
    function MenusNav(props) {
      const p = props || {};
      const collapsed = p.collapsed === true;
      const menus = visibleMenus(p.rootStatus);
      const activeId = typeof p.activeId === 'string' && menus.some((menu) => menu.id === p.activeId)
        ? p.activeId
        : (menus[0] && menus[0].id);
      return SidebarGroup({
        'aria-label': '知识库菜单',
        'data-jk-kb-menu-group': 'true',
        'data-collapsed': collapsed ? 'true' : 'false',
      },
        h('ul', { className: 'jk-kb-sidebar-menu', role: 'list' },
          menus.map((menu) => h('li', { key: menu.id, className: 'jk-kb-sidebar-menu-item' },
            SidebarMenuButton({
              active: menu.id === activeId,
              'data-jk-kb-menu': menu.id,
              'aria-current': menu.id === activeId ? 'page' : 'false',
              title: menu.label,
              'aria-label': menu.label,
              onClick: () => { if (typeof p.onSelect === 'function') p.onSelect(menu.id); },
            },
              menu.icon
                ? menu.icon({ width: 16, height: 16 })
                : null,
              collapsed
                ? null
                : h('span', { className: 'jk-kb-sidebar-menu-text' }, menu.label)
            )))
        )
      );
    }

    // 侧栏执行任务：消费面板共享的 /runs feed（不单独发请求）。
    function SidebarTasks(props) {
      const p = props || {};
      const feed = p.feed && typeof p.feed === 'object' ? p.feed : { phase: 'idle', runs: [], error: null };
      if (feed.phase === 'loading' || feed.phase === 'idle') return TaskListSkeleton();
      if (feed.phase === 'error') {
        return SidebarGroup({ 'data-jk-kb-sidebar-tasks': 'error', 'aria-label': '执行任务' },
          SidebarGroupLabel(null, '执行任务'),
          h('p', { className: 'jk-kb-hint', 'data-jk-kb-sidebar-tasks-error': 'true' }, '任务列表暂不可用'),
          Button({
            variant: 'outline',
            'data-jk-kb-sidebar-tasks-retry': 'true',
            onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
          }, '重试')
        );
      }
      const runs = Array.isArray(feed.runs) ? feed.runs : [];
      if (runs.length === 0) {
        return SidebarGroup({ 'data-jk-kb-sidebar-tasks': 'empty', 'aria-label': '执行任务' },
          SidebarGroupLabel(null, '执行任务'),
          h('div', { className: 'jk-kb-empty-tasks', 'data-jk-kb-sidebar-tasks-empty': 'true' },
            EmptyDocIcon({ className: 'jk-kb-empty-icon-sm' }),
            h('p', { className: 'jk-kb-empty-text' }, '暂无任务')
          )
        );
      }
      const view = buildTasksView(runs, 3, p.expanded === true);
      return SidebarGroup({ 'data-jk-kb-sidebar-tasks': 'ready', 'aria-label': '执行任务' },
        SidebarGroupLabel(null, '执行任务'),
        h('ul', { className: 'jk-kb-sidebar-task-list' },
          view.items.map((item) => {
            const run = presentRun(item);
            return h('li', {
              key: run.id || item.id,
              className: 'jk-kb-sidebar-task',
              'data-jk-kb-sidebar-task': run.id,
              'data-jk-kb-sidebar-task-status': run.status,
              role: 'button',
              tabIndex: 0,
              onClick: () => { if (typeof p.onSelectRun === 'function') p.onSelectRun(run.id); },
            },
              h('div', { className: 'jk-kb-sidebar-task-main' },
                h('span', { className: 'jk-kb-task-name', title: run.title }, run.title),
                h('span', { className: 'jk-kb-sidebar-task-time', 'data-jk-kb-sidebar-task-time': 'true' },
                  formatRelativeTime(item.startedAt))
              ),
              h('span', { className: 'jk-kb-sidebar-task-meta' },
                run.status === 'running'
                  ? h('span', { className: 'jk-kb-task-heartbeat', 'aria-hidden': 'true' })
                  : null,
                h('span', { className: 'jk-kb-sidebar-task-status-label' }, run.statusLabel)
              )
            );
          })
        ),
        view.hasMore
          ? Button({
              variant: 'outline',
              size: 'sm',
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
      return SidebarGroup({ 'data-jk-kb-skeleton': 'tasks', 'aria-label': '执行任务' },
        SidebarGroupLabel(null, '执行任务'),
        h('ul', { className: 'jk-kb-skel-tasks' },
          [0, 1, 2].map((index) => h('li', {
            key: 'skel-task-' + index,
            className: 'jk-kb-skel-task',
            'data-jk-kb-skeleton-row': String(index),
          },
            Skeleton({ kind: 'dot' }),
            Skeleton({ kind: 'bar' })
          ))
        )
      );
    }

    // ───────────────────────────── 任务看板（总视图） ─────────────────────────────
    // 容器：唯一的数据入口是 GET /runs（全量刷新，不做本地累积）。轮询由 running 驱动。
    function RunsBoardPage(props) {
      const p = props || {};
      const [state, setState] = React.useState(() => seedRunsPageState(p.seedFeed));
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

      // 建库前体检 gate 专用：只取归一化结果，不落 UI 状态（体检展示已迁至「使用信息」页）。
      async function runPreflightCheck() {
        const result = await fetchPreflight();
        return normalizePreflightResponse(result);
      }

      // 技能目录只取一次（失败只影响下拉，不影响页面）。
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
        loadSkillRegistryForRisk();
        return function () { aliveRef.current = false; };
      }, [p.reloadKey]);

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
          setState((prev) => reduceRunsPage(prev, {
            type: 'notice',
            notice: { kind: 'error', text: ((outcome && outcome.message) || '新建技能失败') + '（体检明细见「使用信息」页）' },
          }));
          return;
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
          setState((prev) => reduceRunsPage(prev, {
            type: 'notice',
            notice: { kind: 'error', text: ((outcome && outcome.message) || '整理启动失败') + '（体检明细见「使用信息」页）' },
          }));
          return;
        }
        setState((prev) => reduceRunsPage(prev, {
          type: 'notice',
          notice: { kind: 'error', text: (outcome && outcome.message) || '整理启动失败' },
        }));
      }

      usePollingEffect(refresh, shouldPollRunsPage(state));

      async function onRunKind(kind) {
        // 建库第一次点击：先跑 preflight，error 直接拦下（不发 POST），warn 放行。
        // 体检明细展示在「使用信息」页，拦截时用 notice 指路。
        if (kind === 'bootstrap' && state.confirm !== 'bootstrap') {
          if (inflightRef.current) return;
          inflightRef.current = true;
          let gate = null;
          try {
            gate = await beginBootstrap({ checkPreflight: runPreflightCheck });
          } finally {
            inflightRef.current = false;
          }
          if (!aliveRef.current) return;
          if (gate && gate.proceed !== true) {
            setState((prev) => reduceRunsPage(prev, {
              type: 'notice',
              notice: { kind: 'error', text: '环境体检未通过：请到「使用信息」页面查看体检明细，处理后再开始建库。' },
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
        // 422 等失败带 checks 时：notice 引导去「使用信息」页看体检明细（宿主 message 优先）。
        if (outcome && Array.isArray(outcome.checks) && outcome.checks.length > 0) {
          setState((prev) => reduceRunsPage(prev, {
            type: 'notice',
            notice: { kind: 'error', text: ((outcome && outcome.message) || '请求失败') + '（体检明细见「使用信息」页）' },
          }));
          return;
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

      const actions = h('div', { className: 'jk-kb-run-actions' },
        RUN_KINDS.map((kind) => Button({
          key: kind.id,
          variant: kind.id === 'bootstrap' ? 'default' : 'outline',
          'data-jk-kb-run-action': kind.id,
          disabled: busy,
          onClick: () => { if (typeof p.onRunKind === 'function') p.onRunKind(kind.id); },
        }, kind.action)),
        Button({
          key: 'maintain',
          variant: 'outline',
          'data-jk-kb-maintain-open': 'true',
          disabled: busy,
          onClick: typeof p.onMaintainOpen === 'function' ? p.onMaintainOpen : undefined,
        }, '整理'),
        Button({
          key: 'skill-create',
          variant: 'outline',
          'data-jk-kb-skill-create-open': 'true',
          disabled: busy,
          onClick: typeof p.onSkillCreateOpen === 'function' ? p.onSkillCreateOpen : undefined,
        }, '新建技能')
      );

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
                    Checkbox({
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
              Button({
                variant: 'default',
                className: 'jk-kb-guide-cta',
                'data-jk-kb-skill-submit': 'true',
                disabled: !skillCanSubmit,
                onClick: typeof p.onSkillSubmit === 'function' ? p.onSkillSubmit : undefined,
              }, p.skillBusy === true ? '提交中…' : '创建技能'),
              Button({
                variant: 'outline',
                'data-jk-kb-skill-cancel': 'true',
                onClick: typeof p.onSkillCreateClose === 'function' ? p.onSkillCreateClose : undefined,
              }, '取消')
            )
          )
        : null;

      const maintainConfirmBox = maintainConfirming
        ? ConfirmDialog({
            'data-jk-kb-maintain-confirm': 'true',
            title: '确认开始整理？',
            description: '整理是只读扫描，不会移动或删除任何文件。',
            yesProps: {
              'data-jk-kb-maintain-confirm-yes': 'true',
              disabled: busy,
              label: busy ? '启动中…' : '确认整理',
              onClick: typeof p.onMaintainConfirm === 'function' ? p.onMaintainConfirm : undefined,
            },
            noProps: {
              'data-jk-kb-maintain-confirm-no': 'true',
              disabled: busy,
              onClick: typeof p.onMaintainCancel === 'function' ? p.onMaintainCancel : undefined,
            },
          })
        : null;

      const confirmBox = confirming
        ? ConfirmDialog({
            'data-jk-kb-confirm': 'bootstrap',
            title: '确认开始建库？',
            description: '建库会向知识库根目录写入 ' + VAULT_TOP_LEVEL_COUNT
              + ' 个顶层目录与 _说明.md。已有的同名目录不会被删除；本次不启用 force，不会覆盖已有的 _说明.md。',
            yesProps: {
              'data-jk-kb-confirm-yes': 'true',
              disabled: busy,
              label: busy ? '启动中…' : '确认开始建库',
              onClick: typeof p.onConfirm === 'function' ? p.onConfirm : undefined,
            },
            noProps: {
              'data-jk-kb-confirm-no': 'true',
              disabled: busy,
              onClick: typeof p.onCancelConfirm === 'function' ? p.onCancelConfirm : undefined,
            },
          })
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
            Button({
              variant: 'outline',
              'data-jk-kb-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const emptyBox = h('div', { className: 'jk-kb-empty jk-kb-empty-center', 'data-jk-kb-runs-empty': 'true' },
        EmptyDocIcon(),
        h('p', { className: 'jk-kb-empty-text' }, '暂无任务')
      );

      const headerRow = TableHeader(null,
        TableRow({ className: 'jk-kb-run-header' },
          TableHead(null, '标题'),
          TableHead(null, '类型'),
          TableHead(null, '状态'),
          TableHead(null, '步骤'),
          TableHead(null, '开始时间'),
          TableHead(null, '耗时'),
          TableHead(null, 'Token'),
          TableHead(null, '心跳'),
          TableHead(null, '预算'),
          TableHead(null, '')
        )
      );

      const list = Table({ className: 'jk-kb-run-table', 'data-jk-kb-run-table': 'true' },
        headerRow,
        TableBody(null,
          runs.map((run) => TableRow({
            key: run.id,
            'data-jk-kb-run': run.id,
            'data-jk-kb-run-status': run.status,
            role: 'button',
            tabIndex: 0,
            onClick: () => { if (typeof p.onOpenRun === 'function') p.onOpenRun(run.id); },
          },
            TableCell({ className: 'jk-kb-run-cell jk-kb-run-title', title: run.title }, run.title),
            TableCell({ className: 'jk-kb-run-cell' }, run.kindLabel),
            TableCell({ className: 'jk-kb-run-cell' },
              h('div', { className: 'jk-kb-run-status-cell' },
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
              )
            ),
            TableCell({ className: 'jk-kb-run-cell', title: run.progressText }, run.progressText),
            TableCell({ className: 'jk-kb-run-cell jk-kb-run-time' }, run.startedText),
            TableCell({ className: 'jk-kb-run-cell' }, run.durationText),
            TableCell({
              className: 'jk-kb-run-cell jk-kb-token' + (run.usageText === '无 agent' ? ' jk-kb-token-degraded' : ''),
              'data-jk-kb-token': run.id,
              'data-jk-kb-usage-source': run.usageSource || undefined,
              title: run.usageText === '无 agent' ? '无 agent 降级，未消耗 token' : '输入 / 输出 token',
            }, run.usageText),
            TableCell({ className: 'jk-kb-run-cell' },
              h('div', { className: 'jk-kb-run-heartbeat' },
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
              )
            ),
            TableCell({
              className: 'jk-kb-run-cell jk-kb-budget' + (run.budgetOver ? ' jk-kb-budget-over' : ''),
              'data-jk-kb-budget': run.id,
              'data-jk-kb-budget-over': run.budgetOver ? 'true' : undefined,
              title: '已用 / 总预算',
            }, run.budgetText),
            run.hasDegraded
              ? TableCell({ className: 'jk-kb-run-cell' },
                  h('span', {
                    className: 'jk-kb-degraded',
                    'data-jk-kb-run-degraded': run.id,
                    title: run.degraded,
                    'aria-label': '无 agent 降级：' + run.degraded,
                  }, '无 agent 降级')
                )
              : TableCell({ className: 'jk-kb-run-cell' }, '')
          ))
        )
      );

      return h('div', { className: 'jk-kb-runs', 'data-jk-kb-runs': phase },
        h('div', { className: 'jk-kb-runs-head' },
          h('div', null,
            h('h2', { className: 'jk-kb-section-title' }, '任务')
          ),
          actions
        ),
        maintainConfirmBox,
        skillFormBox,
        confirmBox,
        notice
          ? Alert({
              variant: notice.kind,
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
              Button({
                variant: 'outline',
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
              step.artifacts.map((artifact) => Button({
                key: artifact.key,
                variant: 'outline',
                size: 'sm',
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

      const backButton = Button({
        variant: 'outline',
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
            Button({
              variant: 'outline',
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
                  ? Button({
                      variant: 'destructive',
                      'data-jk-kb-cancel': 'true',
                      disabled: busy,
                      onClick: typeof p.onCancel === 'function' ? p.onCancel : undefined,
                    }, busy ? '中止中…' : '中止')
                  : null
              )
            ),
            topNotice
              ? Alert({
                  variant: 'warning',
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
                ? Alert({
                    variant: recoverNotice.kind,
                    'data-jk-kb-recover-notice': recoverNotice.kind,
                    'aria-live': 'polite',
                  }, recoverNotice.text)
                : null,
              h('div', { className: 'jk-kb-recover-actions' },
                recoverActions.map((action) => {
                  const highlighted = recoverSuggested === action.id
                    || (recoverSuggested === '' && recoveryDecision && recoveryDecision.action === action.id);
                  return Button({
                    key: action.id,
                    variant: action.id === 'abandon' ? 'destructive' : 'outline',
                    // suggested 高亮作为附加类保留，测试按 contains 断言。
                    className: highlighted ? 'jk-kb-btn-suggested' : null,
                    'data-jk-kb-recover-action': action.id,
                    'data-jk-kb-recover-enabled': action.enabled ? 'true' : 'false',
                    'data-jk-kb-suggested': highlighted ? 'true' : undefined,
                    disabled: !action.enabled || recoverBusy,
                    onClick: () => { if (typeof p.onRecoverRequest === 'function') p.onRecoverRequest(action.id); },
                  }, action.label);
                })
              ),
              recoverPending
                ? ConfirmDialog({
                    'data-jk-kb-recover-confirm': recoverPending,
                    role: 'group',
                    title: '确认「' + recoverActionLabel(recoverPending) + '」？',
                    description: recoverConfirmText(recoverPending),
                    yesProps: {
                      'data-jk-kb-recover-confirm-yes': 'true',
                      disabled: recoverBusy,
                      label: recoverBusy ? '提交中…' : '确认' + recoverActionLabel(recoverPending),
                      onClick: typeof p.onRecoverConfirm === 'function' ? p.onRecoverConfirm : undefined,
                    },
                    noProps: {
                      'data-jk-kb-recover-confirm-no': 'true',
                      disabled: recoverBusy,
                      onClick: typeof p.onRecoverCancel === 'function' ? p.onRecoverCancel : undefined,
                    },
                  })
                : null
            )
          )
        : null;

      return h('div', { className: 'jk-kb-run-detail-page', 'data-jk-kb-run-page': phase },
        h('div', { className: 'jk-kb-detail-head' }, backButton),
        notice
          ? Alert({
              variant: notice.kind,
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
    // cardsHidden=true 时主页面专家页不渲染卡片区（卡片统一在设置页管理）。
    function ExpertsPage(props) {
      const cardsHidden = !!(props && typeof props === 'object' && props.cardsHidden === true);
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const [status, setStatus] = React.useState('active');
      // 主页面专家页的标签页（全部/其他）；设置页不使用。
      const [panelTab, setPanelTab] = React.useState('all');
      // 立即使用：进入执行对话的专家 id（null = 未进入对话，显示专家区域）。
      const [useExpertId, setUseExpertId] = React.useState(null);
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

      /**
       * 解绑专家的悬空技能：提交剩余 skillIds（PATCH 局部更新），成功后刷新列表；
       * 失败提示可读原因。与 submitForm 共用 busyRef 防重复提交。
       */
      async function unbindSkill(expert, skillId) {
        if (!expert || typeof expert !== 'object' || !expert.id || busyRef.current) return;
        const current = Array.isArray(expert.skillIds) ? expert.skillIds.map(String) : [];
        const remaining = current.filter((id) => id !== String(skillId));
        if (remaining.length === current.length) return;
        busyRef.current = true;
        const outcome = await unbindExpertSkillRequest(expert.id, remaining);
        busyRef.current = false;
        if (!aliveRef.current) return;
        const plan = planExpertWriteResult('update', outcome);
        setWriteNotice(plan.notice);
        if (plan.refresh) setReload(reload + 1);
      }

      /**
       * 恢复归档专家：POST restore，成功后切回 active 视图并刷新列表。
       */
      async function restoreExpert(expert) {
        if (!expert || typeof expert !== 'object' || !expert.id || busyRef.current) return;
        busyRef.current = true;
        const outcome = await restoreExpertRequest(expert.id);
        busyRef.current = false;
        if (!aliveRef.current) return;
        const plan = planExpertWriteResult('restore', outcome);
        setWriteNotice(plan.notice);
        if (plan.refresh) {
          if (plan.nextStatus) setStatus(plan.nextStatus);
          setReload(reload + 1);
        }
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
        cardsHidden: cardsHidden,
        panelTab: panelTab,
        status: status,
        experts: experts,
        skills: skills,
        form: form,
        archive: archive,
        writeNotice: writeNotice,
        // 立即使用：进入/退出执行对话（退出时顺带刷新专家卡片统计）。
        useExpertId: useExpertId,
        chatExpert: useExpertId
          ? (Array.isArray(experts.list) ? experts.list : []).filter((item) => item.id === useExpertId)[0] || null
          : null,
        onUseExpert: (expert) => setUseExpertId(expert && expert.id ? expert.id : null),
        onChatBack: () => { setUseExpertId(null); setReload(reload + 1); },
        onPanelTab: (tab) => setPanelTab(tab === 'other' ? 'other' : 'all'),
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
      const skillMetaMap = expertSkillMetaMap(groups);
      const form = p.form && typeof p.form === 'object'
        ? p.form
        : { open: false, mode: 'create', id: '', fields: expertToForm(null), search: '', notice: null };
      const fields = form.fields && typeof form.fields === 'object' ? form.fields : expertToForm(null);
      const validation = validateExpertForm(fields);
      const filteredGroups = filterSkillGroups(groups, form.search);
      const archive = p.archive && typeof p.archive === 'object' ? p.archive : { target: null, confirmed: false, busy: false, notice: null };
      const writeNotice = p.writeNotice && p.writeNotice.kind ? p.writeNotice : null;

      // 立即使用：收起整个专家区域，切换到 DSH 风格的执行对话（输入框在下方，执行过程原样显示）。
      if (p.chatExpert && typeof p.chatExpert === 'object') {
        return h(ExpertChatPage, {
          key: 'chat-' + (p.chatExpert.id || ''),
          expert: p.chatExpert,
          // 只把该专家绑定的技能带进对话（供加号浮层选择）。
          skillGroups: filterSkillGroupsByIds(groups, p.chatExpert.skillIds),
          onBack: typeof p.onChatBack === 'function' ? p.onChatBack : undefined,
        });
      }

      const header = h('div', { className: 'jk-kb-experts-head' },
        h('div', null,
          h('h2', { className: 'jk-kb-section-title' }, '业务专家'),
          h('blockquote', { className: 'jk-kb-blockquote' }, '专家 = 一组技能 + 一段职责说明，入柜时可以指定由谁处理。')
        ),
        h('div', { className: 'jk-kb-experts-actions' },
          Button({
            variant: 'outline',
            'data-jk-kb-experts-status': status === 'active' ? 'archived' : 'active',
            onClick: typeof p.onToggleStatus === 'function' ? p.onToggleStatus : undefined,
          }, status === 'active' ? '查看归档' : '查看活跃'),
          Button({
            variant: 'outline',
            'data-jk-kb-experts-refresh': 'true',
            onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
          }, '刷新'),
          Button({
            variant: 'default',
            className: 'jk-kb-guide-cta',
            'data-jk-kb-expert-new': 'true',
            onClick: typeof p.onNew === 'function' ? p.onNew : undefined,
          }, '新建专家')
        )
      );

      const errorBox = experts.phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-experts-error': 'true' },
            h('h3', { className: 'jk-kb-placeholder-title' }, '专家列表不可用'),
            h('p', { className: 'jk-kb-hint' }, '无法读取专家列表（' + HOST_EXPERTS_PATH + '）。'),
            experts.error
              ? h('p', { className: 'jk-kb-note' }, '详情：' + (experts.error.code || 'unknown') + ' ' + (experts.error.message || ''))
              : null,
            Button({
              variant: 'outline',
              'data-jk-kb-experts-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const emptyText = status === 'active' ? EXPERT_EMPTY_TEXT : '还没有归档专家。';
      // 专家卡片栅格：设置页与主页面（全部/其他标签下）共用同款卡片渲染；useMode=true 时（主页面「全部」）编辑按钮换成「立即使用」。
      const renderExpertGrid = (excerptList, useMode) => h('div', { className: 'jk-kb-expert-grid', 'data-jk-kb-experts-list': 'true' },
        excerptList.map((expert) => {
          const skillMetas = (expert.skillIds || []).map((id) =>
            skillMetaMap[id] || { name: nameMap[id] || id, purpose: '' });
          return h('article', {
            key: expert.key,
            className: 'jk-kb-expert-card',
            'data-jk-kb-expert': expert.id,
          },
            h('div', { className: 'jk-kb-expert-card-head' },
              h('h3', { className: 'jk-kb-expert-name', 'data-jk-kb-expert-name': expert.id }, expert.name),
              h('span', { className: 'jk-kb-expert-domain', 'data-jk-kb-expert-domain': expert.id }, expert.domain),
              h('div', { className: 'jk-kb-expert-card-actions' },
                useMode === true
                  ? Button({
                      variant: 'outline',
                      'data-jk-kb-expert-use': expert.id,
                      onClick: () => { if (typeof p.onUseExpert === 'function') p.onUseExpert(expert); },
                    }, '立即使用')
                  : Button({
                      variant: 'outline',
                      'data-jk-kb-expert-edit': expert.id,
                      onClick: () => { if (typeof p.onEdit === 'function') p.onEdit(expert); },
                    }, '编辑'),
                status !== 'active'
                  ? Button({
                      variant: 'outline',
                      'data-jk-kb-expert-restore': expert.id,
                      onClick: () => { if (typeof p.onRestore === 'function') p.onRestore(expert); },
                    }, '恢复')
                  : null
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
              }, '技能：' + (expert.skillIds || []).length),
              h('span', {
                className: 'jk-kb-expert-signal',
                'data-jk-kb-expert-signal': expert.id,
                tabIndex: 0,
                'aria-label': '查看绑定的技能明细',
              },
                SignalIcon({ width: 14, height: 14 }),
                h('span', {
                  className: 'jk-kb-expert-signal-popover',
                  'data-jk-kb-expert-signal-popover': expert.id,
                  role: 'tooltip',
                },
                  skillMetas.length > 0
                    ? skillMetas.map((meta, index) => h('span', {
                        key: expert.id + ':signal:' + index,
                        className: 'jk-kb-expert-signal-item',
                        'data-jk-kb-expert-signal-item': meta.name,
                      },
                        h('span', { className: 'jk-kb-expert-signal-item-name' }, meta.name),
                        h('span', { className: 'jk-kb-expert-signal-item-purpose' }, meta.purpose || '暂无介绍')
                      ))
                    : h('span', { className: 'jk-kb-expert-signal-item', 'data-jk-kb-expert-signal-empty': 'true' }, '未绑定技能')
                )
              ),
              h('span', { className: 'jk-kb-expert-meta-divider', 'aria-hidden': 'true' }),
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
                    Button({
                      variant: 'outline',
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
      );
      // 主页面（cardsHidden）：全部/其他 标签页 + 卡片；「其他」= 领域未填或填「其他」的专家。
      const activePanelTab = p.panelTab === 'other' ? 'other' : 'all';
      const otherList = list.filter((expert) => !expert.domain || String(expert.domain) === '其他');
      const panelTabList = activePanelTab === 'other' ? otherList : list;
      const cards = p.cardsHidden === true
        ? (experts.phase === 'ready'
            ? h('div', { className: 'jk-kb-expert-tabs', 'data-jk-kb-expert-tabs': 'true' },
                TabsList(null,
                  TabsTrigger({
                    active: activePanelTab === 'all',
                    'data-jk-kb-expert-tab': 'all',
                    onClick: () => { if (typeof p.onPanelTab === 'function') p.onPanelTab('all'); },
                  }, '全部'),
                  TabsTrigger({
                    active: activePanelTab === 'other',
                    'data-jk-kb-expert-tab': 'other',
                    onClick: () => { if (typeof p.onPanelTab === 'function') p.onPanelTab('other'); },
                  }, '其他')
                ),
                panelTabList.length === 0
                  ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-experts-empty': 'true' },
                      activePanelTab === 'other' ? '「其他」分类下还没有专家。' : emptyText)
                  : renderExpertGrid(panelTabList, activePanelTab === 'all')
              )
            : null)
        : (experts.phase === 'ready'
            ? (list.length === 0
                ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-experts-empty': 'true' }, emptyText)
                : renderExpertGrid(list))
            : null);

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
            Checkbox({
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
              ? Alert({
                  variant: form.notice.kind,
                  'data-jk-kb-expert-form-notice': form.notice.kind,
                }, form.notice.text)
              : null,
            h('div', { className: 'jk-kb-curate-actions' },
              Button({
                variant: 'default',
                className: 'jk-kb-guide-cta',
                'data-jk-kb-expert-submit': 'true',
                disabled: validation.ok !== true || form.busy === true,
                onClick: typeof p.onSubmit === 'function' ? p.onSubmit : undefined,
              }, form.busy === true ? '提交中…' : (form.mode === 'edit' ? '保存修改' : '创建专家')),
              Button({
                variant: 'outline',
                'data-jk-kb-expert-cancel': 'true',
                onClick: typeof p.onCloseForm === 'function' ? p.onCloseForm : undefined,
              }, '取消')
            )
          )
        : null;

      const archiveTarget = archive.target && typeof archive.target === 'object' ? archive.target : null;
      const archiveDialog = archiveTarget
        ? ConfirmDialog({
            'data-jk-kb-expert-archive-confirm': archiveTarget.id,
            title: '确认归档「' + archiveTarget.name + '」？',
            description: '归档不会删除数据，只把状态改成 archived；之后可用「查看归档」（?status=archived）查看。',
            yesProps: {
              'data-jk-kb-expert-archive-yes': 'true',
              disabled: archive.confirmed !== true || archive.busy === true,
              label: archive.busy === true ? '归档中…' : '确认归档',
              onClick: typeof p.onArchiveSubmit === 'function' ? p.onArchiveSubmit : undefined,
            },
            noProps: {
              'data-jk-kb-expert-archive-no': 'true',
              onClick: typeof p.onArchiveClose === 'function' ? p.onArchiveClose : undefined,
            },
          },
            archive.notice && archive.notice.kind
              ? Alert({
                  variant: archive.notice.kind,
                  'data-jk-kb-expert-archive-notice': archive.notice.kind,
                }, archive.notice.text)
              : null,
            h('label', { className: 'jk-kb-ack' },
              Checkbox({
                                'data-jk-kb-expert-archive-ack': 'true',
                checked: archive.confirmed === true,
                onChange: (event) => {
                  if (typeof p.onArchiveConfirm === 'function') {
                    p.onArchiveConfirm(event && event.target ? !!event.target.checked : false);
                  }
                },
              }),
              h('span', { className: 'jk-kb-ack-text' }, '我已确认')
            ))
        : null;

      return h('div', { className: 'jk-kb-experts', 'data-jk-kb-experts': status },
        header,
        writeNotice
          ? Alert({
              variant: writeNotice.kind,
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

    // ───────────────────────────── 专家对话（立即使用，DSH 风格执行过程） ─────────────────────────────
    // 快捷选项：点击即把预设文本填入输入框并收起选项区（整个会话只选一次）。
    const CHAT_PRESETS = [
      { id: 'interview', label: '整理一段访谈记录', text: '请把这段访谈记录整理成知识卡片：\n\n' },
      { id: 'note', label: '整理一篇技术笔记', text: '请把这篇技术笔记整理成知识卡片：\n\n' },
      { id: 'minutes', label: '整理一份会议纪要', text: '请把这份会议纪要整理成知识卡片：\n\n' },
    ];

    function ExpertChatPage(props) {
      const p = props || {};
      const expert = p.expert && typeof p.expert === 'object' ? p.expert : null;
      const skillGroups = Array.isArray(p.skillGroups) ? p.skillGroups : [];
      const [entries, setEntries] = React.useState([]);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      // 技能选择：加号浮层开关 + 已选技能（空 = 让 agent 自动判定）。
      const [skillMenuOpen, setSkillMenuOpen] = React.useState(false);
      const [selectedSkillId, setSelectedSkillId] = React.useState('');
      // 快捷选项是否已被选走（选过即折叠隐藏）。
      const [presetPicked, setPresetPicked] = React.useState(false);
      const aliveRef = React.useRef ? React.useRef(true) : { current: true };
      const seqRef = React.useRef ? React.useRef(0) : { current: 0 };
      // 语音输入：复用 DSH 语音输入 Bundle 的本地转写（remote.speech → 宿主 SenseVoice）。
      // speechSupported = 语音桥可用；录音状态机：idle → requesting → recording → transcribing → idle/feedback。
      const [speechSupported, setSpeechSupported] = React.useState(function () { return !!getSpeechApi(); });
      const [listening, setListening] = React.useState(false);
      const [speechPhase, setSpeechPhase] = React.useState('idle');
      const [speechMessage, setSpeechMessage] = React.useState('');
      const recorderRef = React.useRef ? React.useRef(null) : { current: null };
      const catalogRef = React.useRef ? React.useRef(null) : { current: null };
      const speechTimerRef = React.useRef ? React.useRef(null) : { current: null };

      // 语音桥可用性跟随 remote.speech 挂载/卸载变化（用户启停语音输入 Bundle）。
      React.useEffect(function () {
        setSpeechSupported(!!getSpeechApi());
        return subscribeSpeech(function (available) { setSpeechSupported(available === true); });
      }, []);

      // 语音反馈提示（错误/提示文案），4s 后自动回到 idle。
      function speechFeedback(text) {
        setSpeechPhase('feedback');
        setSpeechMessage(typeof text === 'string' && text ? text : '语音输入出现问题，请重试');
      }

      React.useEffect(function () {
        if (speechPhase !== 'feedback') return;
        const timer = setTimeout(function () {
          if (aliveRef.current) setSpeechPhase('idle');
        }, 4000);
        return function () { clearTimeout(timer); };
      }, [speechPhase]);

      // 结束录音并转写：录音 → 16kHz PCM16 WAV → base64 → remote.speech.transcribe → 文本追加进草稿。
      async function finishListening() {
        const recorder = recorderRef.current;
        if (!recorder) return;
        recorderRef.current = null;
        if (speechTimerRef.current) { clearTimeout(speechTimerRef.current); speechTimerRef.current = null; }
        const catalog = catalogRef.current || {};
        setListening(false);
        setSpeechPhase('transcribing');
        try {
          const wav = await recorder.stop(typeof catalog.maxDurationSeconds === 'number' ? catalog.maxDurationSeconds : 60);
          if (!aliveRef.current) return;
          const api = getSpeechApi();
          if (!api) { speechFeedback('语音输入已断开，请重试'); return; }
          if (typeof catalog.maxAudioBytes === 'number' && wav.byteLength > catalog.maxAudioBytes) {
            speechFeedback('录音太长，请分段口述');
            return;
          }
          const selection = catalog.selection || {};
          const result = await api.transcribe({
            audioBase64: speechWavToBase64(wav),
            providerId: selection.providerId,
            language: selection.language,
          });
          if (!aliveRef.current) return;
          if (!result || result.ok !== true) {
            speechFeedback('语音识别失败' + (result && result.error && result.error.message ? '：' + result.error.message : '，请重试'));
            return;
          }
          const text = result.value && typeof result.value.text === 'string' ? result.value.text.trim() : '';
          if (!text) { speechFeedback('没有识别到内容，请再试一次'); return; }
          setDraft(function (prev) { return (typeof prev === 'string' && prev ? prev : '') + text; });
          setSpeechPhase('idle');
        } catch (err) {
          speechFeedback(describeRecorderError(err));
        }
      }

      // 开始语音：校验语音服务与模型就绪 → 请求麦克风 → 进入录音态（到最长时长自动结束转写）。
      async function startListening() {
        if (listening || busy || recorderRef.current) return;
        const api = getSpeechApi();
        if (!api) { speechFeedback('语音输入不可用，请在 DSH 插件管理中启用「语音输入」'); return; }
        setSpeechPhase('requesting');
        setSpeechMessage('');
        const recorder = createSpeechRecorder();
        try {
          const catalogResult = await api.catalog();
          if (!aliveRef.current) return;
          if (!catalogResult || catalogResult.ok !== true) {
            speechFeedback('语音服务不可用，请确认 DSH「语音输入」已启用');
            return;
          }
          const catalog = catalogResult.value || {};
          const selection = catalog.selection || {};
          const provider = (Array.isArray(catalog.providers) ? catalog.providers : [])
            .filter(function (item) { return item && item.id === selection.providerId; })[0];
          const phase = provider && provider.preparation ? provider.preparation.phase : '';
          if (phase !== 'ready' && phase !== 'standby' && phase !== 'waking') {
            speechFeedback('语音识别未就绪，请在 DSH「语音输入」中完成模型准备');
            return;
          }
          await recorder.start();
          if (!aliveRef.current) { recorder.dispose(); return; }
          catalogRef.current = catalog;
          recorderRef.current = recorder;
          setListening(true);
          setSpeechPhase('recording');
          const limit = typeof catalog.maxDurationSeconds === 'number' && catalog.maxDurationSeconds > 0
            ? catalog.maxDurationSeconds : 60;
          speechTimerRef.current = setTimeout(function () { finishListening(); }, limit * 1000);
        } catch (err) {
          recorder.dispose();
          speechFeedback(describeRecorderError(err));
        }
      }

      // 丢弃录音：只释放麦克风，不转写（发送消息 / 切换场景时使用）。
      function cancelListening() {
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (speechTimerRef.current) { clearTimeout(speechTimerRef.current); speechTimerRef.current = null; }
        catalogRef.current = null;
        setListening(false);
        setSpeechPhase('idle');
        setSpeechMessage('');
        if (recorder) { try { recorder.dispose(); } catch (err) { /* 已释放 */ } }
      }

      React.useEffect(function () {
        aliveRef.current = true;
        return function () {
          aliveRef.current = false;
          // 卸载时释放麦克风与定时器，避免录音会话悬挂。
          const recorder = recorderRef.current;
          recorderRef.current = null;
          if (speechTimerRef.current) { clearTimeout(speechTimerRef.current); speechTimerRef.current = null; }
          if (recorder) { try { recorder.dispose(); } catch (err) { /* 已释放 */ } }
        };
      }, []);

      // 拉取单条 run 详情：完成态回写条目（步骤时间线 + 汇总）。
      async function refreshEntry(runId) {
        const result = await fetchRunDetail(runId);
        if (!aliveRef.current || !result || result.ok !== true) return;
        const detail = presentRunDetail(result);
        setEntries(function (prev) {
          return prev.map(function (entry) {
            if (entry.runId !== runId) return entry;
            const nextPhase = detail.run.status === 'running' ? 'running' : (detail.run.status === 'failed' ? 'failed' : 'done');
            return Object.assign({}, entry, { detail: detail, phase: nextPhase });
          });
        });
      }

      // 发送：把输入文本作为 curate run 绑定该专家入柜（选了技能就一并指定）；未起跑直接标失败。
      async function send() {
        const text = draft.trim();
        if (!text || busy || !expert || !expert.id) return;
        // 录音中直接发送：丢弃录音（不转写），避免麦克风悬挂。
        cancelListening();
        setBusy(true);
        setDraft('');
        const outcome = await startCurateRequest({ text: text, expertId: expert.id, skillId: selectedSkillId });
        if (!aliveRef.current) return;
        seqRef.current += 1;
        const entryKey = 'chat-' + seqRef.current;
        setEntries(function (prev) {
          return prev.concat([outcome.started === true
            ? { key: entryKey, text: text, runId: outcome.result.runId, phase: 'running', detail: null, error: null }
            : { key: entryKey, text: text, runId: null, phase: 'failed', detail: null, error: outcome.message || 'run 启动失败' }]);
        });
        if (outcome.started === true) await refreshEntry(outcome.result.runId);
        if (!aliveRef.current) return;
        setBusy(false);
      }

      // 执行中有 run 就持续拉详情（内部自管定时与清理，无 run 时挂起）。
      const hasRunning = entries.some(function (entry) { return entry.phase === 'running'; });
      usePollingEffect(function () {
        entries.forEach(function (entry) {
          if (entry.phase === 'running' && entry.runId) refreshEntry(entry.runId);
        });
      }, hasRunning);

      return ExpertChatView({
        expert: expert,
        entries: entries,
        draft: draft,
        busy: busy,
        skillGroups: skillGroups,
        skillMenuOpen: skillMenuOpen,
        selectedSkillId: selectedSkillId,
        speechSupported: speechSupported,
        listening: listening,
        speechPhase: speechPhase,
        speechMessage: speechMessage,
        onToggleListening: function () { if (listening === true) finishListening(); else startListening(); },
        onToggleSkillMenu: function () { setSkillMenuOpen(function (prev) { return prev !== true; }); },
        // 选中即收起浮层；空 id 表示「自动判定」（清空选择）。
        onPickSkill: function (id) {
          setSelectedSkillId(typeof id === 'string' && id ? id : '');
          setSkillMenuOpen(false);
        },
        onRemoveSkill: function () { setSelectedSkillId(''); },
        // 快捷选项：仅在还没发过消息且没选过时展示。
        showPresets: entries.length === 0 && presetPicked !== true,
        presets: CHAT_PRESETS,
        onPickPreset: function (option) {
          setDraft(option && typeof option.text === 'string' ? option.text : '');
          setPresetPicked(true);
        },
        onDraft: function (value) { setDraft(typeof value === 'string' ? value : ''); },
        onSend: send,
        onBack: typeof p.onBack === 'function' ? p.onBack : undefined,
      });
    }

    // 专家对话展示层：上方原样呈现执行步骤时间线，下方输入框（回车发送）。
    // composer 工具行：圆形加号展开「该专家绑定的技能」选择浮层，选中后以标签形式挂在输入框上。
    function ExpertChatView(props) {
      const p = props || {};
      const expert = p.expert && typeof p.expert === 'object' ? p.expert : {};
      const entries = Array.isArray(p.entries) ? p.entries : [];
      const busy = p.busy === true;
      const draft = typeof p.draft === 'string' ? p.draft : '';
      const canSend = draft.trim().length > 0 && !busy;
      const skillGroups = Array.isArray(p.skillGroups)
        ? p.skillGroups.filter((group) => group && Array.isArray(group.skills) && group.skills.length > 0)
        : [];
      const selectedSkillId = typeof p.selectedSkillId === 'string' ? p.selectedSkillId : '';
      const skillMenuOpen = p.skillMenuOpen === true;
      // 语音状态机展示态：idle 不渲染任何提示，其余阶段显示对应文案（feedback 显示错误信息）。
      const speechPhase = typeof p.speechPhase === 'string' ? p.speechPhase : 'idle';
      // 选中技能展示：优先取目录里的名称，目录缺失时兜底显示 id 本身。
      const selectedSkill = selectedSkillId
        ? (function () {
            const hit = skillGroups
              .reduce((all, group) => all.concat(group.skills), [])
              .filter((skill) => skill && skill.id === selectedSkillId)[0];
            return hit
              ? { id: selectedSkillId, name: hit.label || hit.name || selectedSkillId }
              : { id: selectedSkillId, name: selectedSkillId };
          })()
        : null;
      const menuSkills = skillGroups.map((group) => ({
        key: group.key,
        label: group.label,
        skills: group.skills.map((skill) => ({ id: skill.id, name: skill.label || skill.name || skill.id })),
      }));
      const skillMenu = skillMenuOpen
        ? h('div', { className: 'jk-kb-skill-menu', 'data-jk-kb-skill-menu': 'true', role: 'listbox', 'aria-label': '选择技能' },
            h('button', {
              type: 'button',
              role: 'option',
              className: 'jk-kb-skill-menu-item',
              'data-jk-kb-skill-option': '',
              'data-state': selectedSkillId ? 'unchecked' : 'checked',
              'aria-selected': !selectedSkillId,
              onClick: function () { if (typeof p.onPickSkill === 'function') p.onPickSkill(''); },
            },
              h('span', { className: 'jk-kb-skill-menu-name' }, '自动判定'),
              h('span', { className: 'jk-kb-skill-menu-id' }, '不指定技能')),
            menuSkills.length === 0
              ? h('p', { className: 'jk-kb-skill-menu-empty', 'data-jk-kb-skill-menu-empty': 'true' }, '该专家暂未绑定技能')
              : menuSkills.map((group) => h('div', { key: group.key, className: 'jk-kb-skill-menu-group', 'data-jk-kb-skill-menu-group': group.key },
                  h('p', { className: 'jk-kb-skill-menu-group-title' }, group.label),
                  group.skills.map((skill) => h('button', {
                    key: skill.id,
                    type: 'button',
                    role: 'option',
                    className: 'jk-kb-skill-menu-item',
                    'data-jk-kb-skill-option': skill.id,
                    'data-state': skill.id === selectedSkillId ? 'checked' : 'unchecked',
                    'aria-selected': skill.id === selectedSkillId,
                    onClick: function () { if (typeof p.onPickSkill === 'function') p.onPickSkill(skill.id); },
                  },
                    h('span', { className: 'jk-kb-skill-menu-name' }, skill.name),
                    h('span', { className: 'jk-kb-skill-menu-id' }, skill.id),
                    skill.id === selectedSkillId
                      ? h('svg', {
                          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
                          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
                        }, h('path', { d: 'M20 6L9 17l-5-5' }))
                      : null))))
          )
        : null;

      return h('section', { className: 'jk-kb-chat', 'data-jk-kb-chat': 'true' },
        h('header', { className: 'jk-kb-chat-head' },
          h('div', { className: 'jk-kb-chat-title' },
            h('h2', { className: 'jk-kb-chat-name', 'data-jk-kb-chat-expert': expert.id || '' }, expert.name || '专家对话'),
            h('span', { className: 'jk-kb-chat-domain' }, expert.domain || '')),
          h('div', { className: 'jk-kb-chat-back' },
            Button({
              variant: 'outline',
              'data-jk-kb-chat-back': 'true',
              onClick: typeof p.onBack === 'function' ? p.onBack : undefined,
            }, '← 返回专家列表'))
        ),
        h('div', { className: 'jk-kb-chat-body', 'data-jk-kb-chat-body': 'true' },
          p.showPresets === true
            ? RadioGroup({ 'aria-label': '快捷选项', 'data-jk-kb-chat-presets': 'true' },
                (Array.isArray(p.presets) ? p.presets : []).map(function (option) {
                  return RadioItem({
                    key: option.id,
                    'data-jk-kb-chat-preset': option.id,
                    onClick: function () {
                      if (typeof p.onPickPreset === 'function') p.onPickPreset(option);
                    },
                  }, option.label);
                }))
            : entries.map(function (entry) {
                const detail = entry.detail;
                const runStatus = detail ? detail.run.status : 'running';
                return h('div', { key: entry.key, className: 'jk-kb-chat-entry', 'data-jk-kb-chat-entry': entry.key },
                  h('div', { className: 'jk-kb-chat-user', 'data-jk-kb-chat-user': entry.key }, entry.text),
                  entry.phase === 'failed' && !detail
                    ? Alert({ variant: 'destructive', 'data-jk-kb-chat-error': entry.key }, entry.error || 'run 启动失败')
                    : h('div', { className: 'jk-kb-chat-run', 'data-jk-kb-chat-run': entry.runId || entry.key },
                        h('div', { className: 'jk-kb-chat-run-head' },
                          h('span', { className: 'jk-kb-chat-run-kind' }, (detail ? detail.run.kindLabel : runKindLabel('curate'))),
                          h('span', { className: 'jk-kb-status jk-kb-status-' + runStatus },
                            detail ? detail.run.statusLabel : '执行中…'),
                          detail && detail.run.durationText
                            ? h('span', { className: 'jk-kb-chat-run-duration' }, detail.run.durationText)
                            : null),
                        detail && Array.isArray(detail.steps) && detail.steps.length > 0
                          ? h('ol', { className: 'jk-kb-steps' }, detail.steps.map(function (step) { return renderTimelineStep(step); }))
                          : h('p', { className: 'jk-kb-hint' }, '执行中…'),
                        detail && detail.run.status !== 'running' && detail.run.summary
                          ? h('p', { className: 'jk-kb-chat-summary', 'data-jk-kb-chat-summary': entry.key }, detail.run.summary)
                          : null));
              })
        ),
        h('div', { className: 'jk-kb-chat-composer', 'data-jk-kb-chat-input': 'true' },
          selectedSkill
            ? h('div', { className: 'jk-kb-chat-tags', 'data-jk-kb-chat-skill-tags': 'true' },
                h('span', {
                  className: 'jk-kb-badge jk-kb-badge-secondary jk-kb-chat-tag',
                  'data-jk-kb-chat-skill-tag': selectedSkill.id,
                  title: '本次入柜将指定技能 ' + selectedSkill.id,
                },
                  h('span', { className: 'jk-kb-chat-tag-name' }, '技能：' + selectedSkill.name),
                  h('button', {
                    type: 'button',
                    className: 'jk-kb-chat-tag-x',
                    'aria-label': '移除技能',
                    'data-jk-kb-chat-skill-remove': 'true',
                    onClick: function () { if (typeof p.onRemoveSkill === 'function') p.onRemoveSkill(); },
                  },
                    h('svg', {
                      viewBox: '0 0 24 24', width: 10, height: 10, fill: 'none',
                      stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', 'aria-hidden': 'true',
                    }, h('path', { d: 'M6 6l12 12M18 6L6 18' })))))
            : null,
          Textarea({
            className: 'jk-kb-chat-draft',
            'data-jk-kb-chat-draft': 'true',
            placeholder: '把要整理的文本发给「' + (expert.name || '专家') + '」，回车发送、Shift+回车换行',
            rows: 5,
            value: draft,
            disabled: busy,
            onChange: function (event) {
              if (typeof p.onDraft === 'function') p.onDraft(event && event.target ? event.target.value : '');
            },
            onKeyDown: function (event) {
              if (event && event.key === 'Enter' && !event.shiftKey && canSend && typeof p.onSend === 'function') {
                event.preventDefault();
                p.onSend();
              }
            },
          }),
          h('div', { className: 'jk-kb-chat-composer-row' },
            Button({
              variant: 'ghost',
              className: cn('jk-kb-chat-plus', skillMenuOpen ? 'jk-kb-chat-plus-open' : null),
              'data-jk-kb-chat-plus': 'true',
              'aria-label': '选择技能',
              'aria-expanded': skillMenuOpen,
              title: '选择本次入柜使用的技能',
              disabled: busy,
              onClick: function () { if (typeof p.onToggleSkillMenu === 'function') p.onToggleSkillMenu(); },
            },
              h('svg', {
                viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
                stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true',
              }, h('path', { d: 'M12 5v14M5 12h14' }))),
            Badge({
              variant: 'secondary',
              className: 'jk-kb-chat-binding',
              'data-jk-kb-chat-binding': 'true',
              title: '本次入柜绑定的专家',
            }, '绑定专家：' + (expert.name || '—') + ' · ' + ((expert.skillIds || []).length) + ' 项技能'),
            h('div', { className: 'jk-kb-chat-send-slot' },
              p.speechSupported === true && speechPhase !== 'idle'
                ? h('span', {
                    className: 'jk-kb-chat-speech-status',
                    'data-jk-kb-chat-speech-status': speechPhase,
                    role: 'status',
                  }, speechPhase === 'feedback'
                    ? (typeof p.speechMessage === 'string' && p.speechMessage ? p.speechMessage : '语音输入出现问题')
                    : (speechPhase === 'transcribing' ? '正在转文字…' : (speechPhase === 'recording' ? '正在聆听…' : '正在开启麦克风…')))
                : null,
              p.speechSupported === true
                ? Button({
                    variant: 'ghost',
                    className: cn('jk-kb-chat-mic', p.listening === true ? 'jk-kb-chat-mic-on' : null),
                    'data-jk-kb-chat-mic': 'true',
                    'aria-label': p.listening === true ? '停止语音输入' : '语音输入',
                    'aria-pressed': p.listening === true,
                    title: p.listening === true ? '停止并转文字' : '语音输入（口述自动转文字）',
                    disabled: busy,
                    onClick: function () { if (typeof p.onToggleListening === 'function') p.onToggleListening(); },
                  },
                    p.listening === true
                      // 录音中：麦克风换成实心停止方块，配合主色呼吸动画明确「点击结束」。
                      ? h('svg', {
                          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': 'true',
                        }, h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, 'data-jk-kb-chat-mic-stop-icon': 'true' }))
                      : h('svg', {
                          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
                          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
                        }, h('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }),
                           h('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
                           h('path', { d: 'M12 19v3' })))
                : null,
              Button({
                variant: 'default',
                className: 'jk-kb-chat-send-round',
                'data-jk-kb-chat-send': 'true',
                'aria-label': '发送',
                disabled: !canSend,
                onClick: typeof p.onSend === 'function' ? p.onSend : undefined,
              },
                h('svg', {
                  viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
                  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
                }, h('path', { d: 'M12 19V5' }), h('path', { d: 'M5 12l7-7 7 7' })))),
              skillMenu)));
    }

    // ───────────────────────────── doctor 界面（体检 / 修复） ─────────────────────────────
    function TasksPageHeader(props) {
      const p = props || {};
      return h('div', { className: 'jk-kb-tasks-head-row' },
        TasksViewSwitch({ viewMode: p.viewMode, onChange: p.onChange }),
        Button({
          variant: 'default',
          className: 'jk-kb-doctor-launch',
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
        Button({
          variant: 'outline',
          'data-jk-kb-doctor-refresh': 'true',
          disabled: phase === 'loading',
          onClick: typeof p.onRefresh === 'function' ? p.onRefresh : undefined,
        }, phase === 'loading' ? '检查中…' : '重新体检'),
        Button({
          variant: 'outline',
          'data-jk-kb-doctor-close': 'true',
          onClick: typeof p.onClose === 'function' ? p.onClose : undefined,
        }, '关闭')
      );

      const errorBox = phase === 'error'
        ? h('div', { className: 'jk-kb-error', 'data-jk-kb-doctor-error': 'true' },
            h('p', { className: 'jk-kb-hint' }, '体检接口不可用：' + ((error && error.message) || '宿主服务未连接')),
            Button({
              variant: 'outline',
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
          ? Checkbox({
                            'data-jk-kb-doctor-checkbox': check.repairId,
              checked: selected.indexOf(check.repairId) >= 0,
              onChange: () => { if (typeof p.onToggleCheck === 'function') p.onToggleCheck(check.repairId); },
            })
          : null,
        h('div', { className: 'jk-kb-doctor-check-body' },
          h('p', { className: 'jk-kb-doctor-check-title' }, check.id + ' · ' + check.title),
          h('p', { className: 'jk-kb-doctor-check-detail' }, check.detail),
          check.id === 'CFG-01'
            ? Button({
                variant: 'outline',
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
            Button({
              variant: 'outline',
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
            Button({
              variant: 'outline',
              'data-jk-kb-doctor-go-tasks': 'true',
              onClick: typeof p.onGoTasks === 'function' ? p.onGoTasks : undefined,
            }, '去任务列表')
          )
        : null;

      const noticeBar = notice
        ? Alert({
            variant: notice.kind,
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
            Button({
              variant: 'default',
              className: 'jk-kb-guide-cta',
              'data-jk-kb-doctor-confirm': 'true',
              disabled: busy,
              onClick: typeof p.onConfirm === 'function' ? p.onConfirm : undefined,
            }, busy ? '修复中…' : '确认修复')
          )
        : null;

      const resultSection = p.view === 'result' && result
        ? h('div', { className: 'jk-kb-doctor-result', 'data-jk-kb-doctor-result': 'true' },
            result.auditError
              ? Alert({ variant: 'warning', 'data-jk-kb-doctor-audit': 'true' },
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
          Button({
            variant: 'outline',
            'data-jk-kb-doctor-select-all': 'true',
            onClick: typeof p.onSelectAll === 'function' ? p.onSelectAll : undefined,
          }, '全选可修项'),
          Button({
            variant: 'outline',
            'data-jk-kb-doctor-preview': 'true',
            disabled: busy || selected.length === 0,
            onClick: typeof p.onPreview === 'function' ? p.onPreview : undefined,
          }, busy ? '处理中…' : '预览修复'),
          Button({
            variant: 'outline',
            'data-jk-kb-doctor-close-footer': 'true',
            onClick: typeof p.onClose === 'function' ? p.onClose : undefined,
          }, '关闭')
        )
      );
    }

    // ───────────────────────────── 任务管理：列表 / 日历双视图 ─────────────────────────────
    function TasksViewSwitch(props) {
      const p = props || {};
      const mode = p.viewMode === 'calendar' ? 'calendar' : 'list';
      return h('div', { className: 'jk-kb-view-switch', 'data-jk-kb-view-switch': 'true' },
        TabsList(null,
          [['list', '列表'], ['calendar', '日历']].map((entry) => TabsTrigger({
            key: entry[0],
            active: mode === entry[0],
            'data-jk-kb-view-tab': entry[0],
            'aria-pressed': mode === entry[0],
            onClick: () => { if (typeof p.onChange === 'function') p.onChange(entry[0]); },
          }, entry[1]))));
    }

    // ───────────────────────────── 技能视图（分类导航 + 技能列表，行可展开明细） ─────────────────────────────
    function SkillViewPage() {
      const [state, setState] = React.useState({ phase: 'loading', groups: [], count: 0, error: null });
      const [reload, setReload] = React.useState(0);
      const [expandedId, setExpandedId] = React.useState('');
      const [selectedRole, setSelectedRole] = React.useState('');

      React.useEffect(function () {
        let alive = true;
        setState((prev) => Object.assign({}, prev, { phase: 'loading' }));
        fetchSkills().then((result) => {
          if (!alive) return;
          const norm = normalizeSkillsResponse(result);
          setState(norm.ok === true
            ? { phase: 'ready', groups: norm.groups, count: norm.count, error: null }
            : { phase: 'error', groups: [], count: 0, error: norm.error });
        });
        return function () { alive = false; };
      }, [reload]);

      return SkillViewView({
        skills: state,
        expandedId: expandedId,
        selectedRole: selectedRole,
        onToggleSkill: (id) => setExpandedId(expandedId === id ? '' : id),
        onSelectRole: (role) => {
          // 切分类收起展开明细：旧分类的展开行在新分类下无意义。
          setExpandedId('');
          setSelectedRole(String(role || ''));
        },
        onRetry: () => setReload(reload + 1),
      });
    }

    function SkillViewView(props) {
      const p = props || {};
      const skills = p.skills && typeof p.skills === 'object'
        ? p.skills
        : { phase: 'loading', groups: [], count: 0, error: null };
      const groups = Array.isArray(skills.groups) ? skills.groups : [];
      const total = typeof skills.count === 'number' ? skills.count : 0;
      const expandedId = typeof p.expandedId === 'string' ? p.expandedId : '';
      // 选中分类在数据里不存在（脏状态 / 重载后分类消失）时回落「全部」。
      const rawRole = typeof p.selectedRole === 'string' ? p.selectedRole : '';
      const activeRole = rawRole === '' || groups.some((group) => group.key === rawRole) ? rawRole : '';
      // 右栏分组：全部 → 逐组带标题；具体分类 → 仅该组（标题冗余，不渲染）。
      const visibleGroups = activeRole === '' ? groups : groups.filter((group) => group.key === activeRole);

      // 单个技能行（点击展开 / 收起明细）。
      const renderSkillItem = (skill) => {
        const open = expandedId === skill.id;
        return h('li', {
          key: skill.id,
          className: 'jk-kb-skill-desc-item',
          'data-jk-kb-skill-desc': skill.id,
          'data-open': open ? 'true' : 'false',
        },
          h('div', {
            className: 'jk-kb-skill-desc-row',
            'data-jk-kb-skill-row': skill.id,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => { if (typeof p.onToggleSkill === 'function') p.onToggleSkill(skill.id); },
            onKeyDown: (e) => {
              if (e && (e.key === 'Enter' || e.key === ' ') && typeof e.preventDefault === 'function') {
                e.preventDefault();
                if (typeof p.onToggleSkill === 'function') p.onToggleSkill(skill.id);
              }
            },
          },
            h('span', { className: 'jk-kb-skill-desc-name' }, skill.label),
            h('span', { className: 'jk-kb-skill-desc-purpose' }, skill.purpose || '—'),
            h('span', { className: 'jk-kb-skill-desc-chevron', 'aria-hidden': 'true' },
              ChevronDownIcon({ width: 14, height: 14 }))
          ),
          open
            ? h('div', { className: 'jk-kb-skill-desc-detail', 'data-jk-kb-skill-detail': skill.id },
                h('div', { className: 'jk-kb-skill-desc-detail-grid' },
                  h('div', { className: 'jk-kb-skill-desc-field' },
                    h('span', { className: 'jk-kb-skill-desc-field-label' }, '技能 ID'),
                    h('span', { className: 'jk-kb-skill-desc-field-value' }, skill.id)),
                  h('div', { className: 'jk-kb-skill-desc-field' },
                    h('span', { className: 'jk-kb-skill-desc-field-label' }, '岗位'),
                    h('span', { className: 'jk-kb-skill-desc-field-value' }, skill.profession || skill.role)),
                  h('div', { className: 'jk-kb-skill-desc-field' },
                    h('span', { className: 'jk-kb-skill-desc-field-label' }, '阶段'),
                    h('span', { className: 'jk-kb-skill-desc-field-value' }, skill.stage || '—')),
                  h('div', { className: 'jk-kb-skill-desc-field' },
                    h('span', { className: 'jk-kb-skill-desc-field-label' }, '产出目录'),
                    h('span', { className: 'jk-kb-skill-desc-field-value' }, skill.outputDir || '—')),
                  h('div', { className: 'jk-kb-skill-desc-field' },
                    h('span', { className: 'jk-kb-skill-desc-field-label' }, 'ID 前缀'),
                    h('span', { className: 'jk-kb-skill-desc-field-value' }, skill.idPrefix || '—')),
                  h('div', { className: 'jk-kb-skill-desc-field' },
                    h('span', { className: 'jk-kb-skill-desc-field-label' }, '说明'),
                    h('span', { className: 'jk-kb-skill-desc-field-value' }, skill.purpose || '—'))
                ))
            : null);
      };

      // 分类导航项：全部 + 各岗位，纵向一个一个。
      const renderRoleItem = (roleKey, label, count) => {
        const active = activeRole === roleKey;
        return h('button', {
          key: roleKey === '' ? 'all' : roleKey,
          type: 'button',
          className: 'jk-kb-skill-role-item',
          'data-jk-kb-skill-role': roleKey === '' ? 'all' : roleKey,
          'data-active': active ? 'true' : 'false',
          'aria-pressed': active,
          onClick: () => { if (typeof p.onSelectRole === 'function') p.onSelectRole(roleKey); },
        },
          h('span', { className: 'jk-kb-skill-role-name' }, label),
          h('span', { className: 'jk-kb-skill-role-count' }, count));
      };

      return h('div', { className: 'jk-kb-skill-view', 'data-jk-kb-skill-view': 'true' },
        h('section', { className: 'jk-kb-skill-registry', 'data-jk-kb-skill-registry': skills.phase },
          h('div', { className: 'jk-kb-reports-head' },
            h('h3', { className: 'jk-kb-section-title' }, '技能说明（' + total + '）')
          ),
          skills.phase === 'error'
            ? h('div', { className: 'jk-kb-error', 'data-jk-kb-skill-registry-error': 'true' },
                h('h3', { className: 'jk-kb-placeholder-title' }, '技能库不可用'),
                h('p', { className: 'jk-kb-hint' }, '无法读取技能目录（' + HOST_SKILLS_PATH + '）。'),
                skills.error
                  ? h('p', { className: 'jk-kb-note' }, '详情：' + (skills.error.code || 'unknown') + ' ' + (skills.error.message || ''))
                  : null,
                Button({
                  variant: 'outline',
                  'data-jk-kb-skill-registry-retry': 'true',
                  onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
                }, '重试')
              )
            : null,
          skills.phase === 'loading'
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-registry-loading': 'true' }, '正在读取技能目录…')
            : null,
          skills.phase === 'ready' && groups.length === 0
            ? h('p', { className: 'jk-kb-hint', 'data-jk-kb-skill-registry-empty': 'true' }, '暂无技能')
            : null,
          skills.phase === 'ready' && groups.length > 0
            ? h('div', { className: 'jk-kb-skill-layout', 'data-jk-kb-skill-layout': 'true' },
                // 左栏：分类导航（纵向，全部 + 各岗位，选中品牌蓝）。
                h('div', { className: 'jk-kb-skill-roles', 'data-jk-kb-skill-roles': 'true', role: 'list' },
                  renderRoleItem('', '全部', total),
                  groups.map((group) => renderRoleItem(group.key, group.label, group.skills.length))),
                // 右栏：当前分类的技能列表（保留行展开明细）。
                h('div', { className: 'jk-kb-skill-list', 'data-jk-kb-skill-list': 'true' },
                  visibleGroups.map((group) => h('div', {
                    key: group.key,
                    className: 'jk-kb-skill-desc-group',
                    'data-jk-kb-skill-desc-group': group.key,
                  },
                    activeRole === ''
                      ? h('p', { className: 'jk-kb-skill-desc-group-title' }, group.label)
                      : null,
                    h('ul', { className: 'jk-kb-skill-desc-list' },
                      group.skills.map(renderSkillItem)))))
              )
            : null
        )
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
        Button({
          variant: 'outline',
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
            Button({
              variant: 'outline',
              'data-jk-kb-reports-retry': 'true',
              onClick: typeof p.onRetry === 'function' ? p.onRetry : undefined,
            }, '重试')
          )
        : null;

      const archiveIsDir = !!archiveTarget && (archiveTarget.ruleId === 'M06' || archiveTarget.kind === 'dir');
      const archiveDialog = archiveTarget
        ? ConfirmDialog({
            className: 'jk-kb-archive-confirm',
            'data-jk-kb-archive-confirm': 'true',
            'data-jk-kb-archive-kind': archiveIsDir ? 'dir' : 'file',
            title: archiveIsDir ? '确认归档整个目录？' : '确认归档？',
            description: archiveIsDir
              ? '归档会移动整个目录到 12_归档与历史，目录内文件与结构保持不变；不会删除内容。'
              : '归档会移动文件到 12_归档与历史，四要素会写进文件头；不会删除内容。',
            yesProps: {
              'data-jk-kb-archive-submit': 'true',
              disabled: !archiveConfirmed || archiveBusy,
              label: archiveBusy ? '提交中…' : '确认归档',
              onClick: typeof p.onArchiveSubmit === 'function' ? p.onArchiveSubmit : undefined,
            },
            noProps: {
              'data-jk-kb-archive-cancel': 'true',
              onClick: typeof p.onArchiveClose === 'function' ? p.onArchiveClose : undefined,
            },
          },
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
              Checkbox({
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
              ? Alert({
                  variant: archiveNotice.kind,
                  'data-jk-kb-archive-notice': archiveNotice.kind,
                  'aria-live': 'polite',
                }, archiveNotice.text)
              : null)
        : null;

      const list = phase === 'ready'
        ? (reports.length === 0
            ? h('div', { className: 'jk-kb-empty jk-kb-empty-center', 'data-jk-kb-reports-empty': 'true' },
                EmptyDocIcon(),
                h('p', { className: 'jk-kb-empty-text' }, '暂无报告')
              )
            : Table({ className: 'jk-kb-report-table', 'data-jk-kb-reports': 'true' },
                TableHeader(null,
                  TableRow(null,
                    TableHead(null, '期间'),
                    TableHead(null, '摘要'),
                    TableHead(null, '生成时间'),
                    TableHead(null, '操作')
                  )
                ),
                TableBody(null,
                  reports.map((report) => {
                    const expanded = expandedId === report.id;
                    const groups = expanded ? groupReportFindings(report.findings) : [];
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
                                    ? Button({
                                        variant: 'outline',
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
                    return [
                      TableRow({
                        key: report.id,
                        'data-jk-kb-report': report.id,
                        'aria-expanded': expanded,
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => { if (typeof p.onToggleReport === 'function') p.onToggleReport(report.id); },
                      },
                        TableCell({ className: 'jk-kb-report-period', 'data-jk-kb-report-period': report.id }, report.period),
                        TableCell({ className: 'jk-kb-run-cell jk-kb-report-summary', 'data-jk-kb-report-summary': report.id, title: report.summary }, report.summary),
                        TableCell({ className: 'jk-kb-report-time', 'data-jk-kb-report-created': report.id }, report.createdAtText),
                        TableCell(null,
                          h('div', { className: 'jk-kb-report-actions' },
                            Button({
                              variant: 'outline',
                              'data-jk-kb-report-open': report.id,
                              disabled: !report.path,
                              onClick: (event) => {
                                if (event && event.stopPropagation) event.stopPropagation();
                                if (typeof p.onOpenPath === 'function') p.onOpenPath(report.path);
                              },
                            }, '打开'),
                            Button({
                              variant: 'outline',
                              'data-jk-kb-report-copy': report.id,
                              disabled: !report.path,
                              onClick: (event) => {
                                if (event && event.stopPropagation) event.stopPropagation();
                                if (typeof p.onCopyPath === 'function') p.onCopyPath(report.path);
                              },
                            }, '复制路径')
                          )
                        )
                      ),
                      expanded
                        ? TableRow({ key: report.id + '-findings', className: 'jk-kb-report-detail-row' },
                            TableCell({ colSpan: 4, className: 'jk-kb-report-detail-cell' }, findingsBlock))
                        : null
                    ];
                  })
                )
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
          : h(RunsBoardPage, {
              onOpenRun: p.onOpenRun,
              reloadKey: runsReloadKey,
              seedFeed: p.seedFeed,
              onFeed: p.onFeed,
            }),
        h(ReportsPanel, {
          onArchived: () => setRunsReloadKey(runsReloadKey + 1),
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
        // 关键：按当前 mode 转换数据。loading 期间 data 还是上一次的另一视图数据，
        // 不分流会让年视图拿到无 months 的月数据而崩溃（整页被 React 卸载清空）。
        calendar: calendar.data
          ? (mode === 'year' ? presentLedgerYear(calendar.data) : presentLedgerMonth(calendar.data))
          : null,
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
        Button({ variant: 'outline', size: 'icon', 'data-jk-kb-cal-prev': 'true', onClick: p.onPrev }, '‹'),
        h('span', { className: 'jk-kb-cal-label', 'data-jk-kb-cal-label': 'true' }, label),
        Button({ variant: 'outline', size: 'icon', 'data-jk-kb-cal-next': 'true', onClick: p.onNext }, '›'),
        Button({
          variant: 'outline',
          'data-jk-kb-cal-mode': mode === 'month' ? 'year' : 'month',
          onClick: p.onToggleMode,
        }, mode === 'month' ? '年' : '月'),
        Button({
          variant: 'outline',
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
            Button({
              variant: 'outline',
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
            // 兜底：mode 与数据视图不匹配（如 loading 期跨视图复用旧数据）时降级为空年数据（12 格 0 值）
            (Array.isArray(calendar.months) ? calendar.months : presentLedgerYear(null).months).map((entry) => h('button', {
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
                      Button({
                        variant: 'outline',
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
          NavigationMenu({ 'data-jk-kb-topnav': 'true', label: '主页面导航' },
            NavigationMenuList(null,
              NavigationMenuItem(null,
                NavigationMenuLink({
                  active: true,
                  href: '#',
                  'data-jk-kb-nav': 'knowledge-base',
                  onClick: (e) => {
                    // 当前就在知识库面板：点击回到仪表盘首屏。
                    if (e && typeof e.preventDefault === 'function') e.preventDefault();
                    setSelectedRunId('');
                    dispatch({ type: 'select', id: DASHBOARD_ID });
                  },
                }, '知识库')
              ),
              NavigationMenuItem(null,
                NavigationMenuLink({
                  href: DOCS_URL,
                  target: '_blank',
                  rel: 'noreferrer',
                  'data-jk-kb-nav': 'docs',
                }, '文档')
              )
            )
          )
        ),
        h('div', { className: 'jk-kb-panel-body' },
          // shadcn/ui Sidebar 结构：Header（品牌 + 折叠开关）→ Content（菜单组 + 执行任务组）→ Footer（数字时钟占位）。
          // data-collapsed 驱动 icon 折叠模式：窄列只留品牌图标与菜单图标，任务组/时钟/文字全部隐藏。
          h('aside', {
            className: 'jk-kb-sidebar',
            'data-jk-kb-sidebar': 'true',
            'data-collapsed': uiState.sidebarCollapsed ? 'true' : 'false',
          },
            SidebarHeader(null,
              h('div', { className: 'jk-kb-sidebar-brand', 'data-jk-kb-sidebar-brand': 'true' },
                h('span', { className: 'jk-kb-sidebar-brand-logo', 'data-jk-kb-sidebar-logo': 'true' },
                  BrandLogoMark({ width: 18, height: 18 })),
                h('span', { className: 'jk-kb-sidebar-brand-name', 'data-jk-kb-sidebar-brand-name': 'true' }, PLUGIN_NAME)
              ),
              Button({
                variant: 'ghost',
                size: 'icon',
                className: 'jk-kb-sidebar-toggle',
                'data-jk-kb-sidebar-toggle': 'true',
                'aria-expanded': uiState.sidebarCollapsed ? 'false' : 'true',
                title: uiState.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏',
                onClick: () => dispatch({ type: 'toggleSidebar' }),
              }, PanelLeftIcon({ width: 16, height: 16 }))
            ),
            SidebarContent(null,
              MenusNav({
                rootStatus: menuRootStatus,
                activeId: activeMenu.id,
                collapsed: uiState.sidebarCollapsed,
                onSelect: (menuId) => {
                  // 切菜单一律回到列表页：切走再回来不该停在上次的详情。
                  setSelectedRunId('');
                  dispatch({ type: 'select', id: menuId });
                },
              }),
              // 折叠态窄列放不下任务列表，只保留菜单图标列。
              uiState.sidebarCollapsed
                ? null
                : (menuRootStatus === 'no-root'
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
                    }))
            ),
            // 折叠态隐藏时钟（8 字符时间放不进窄列）。
            uiState.sidebarCollapsed ? null : SidebarFooter(null, h(SidebarClock, null))
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

      // 语音输入桥：动态注入 remote.speech（DSH「语音输入 Bundle」挂载后生效）。
      setupSpeechBridge(ctx);

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
      FILES_ID: FILES_ID,
      TASKS_ID: TASKS_ID,
      SKILLS_ID: SKILLS_ID,
      USAGE_ID: USAGE_ID,
      POLL_INTERVAL_MS: POLL_INTERVAL_MS,
      SETTINGS_STYLE: SETTINGS_STYLE,
      PANEL_STYLE: PANEL_STYLE,
      TOKEN_CSS: TOKEN_CSS,
      COMPONENT_CSS: COMPONENT_CSS,
      cn: cn,
      Button: Button,
      Badge: Badge,
      Card: Card,
      CardHeader: CardHeader,
      CardTitle: CardTitle,
      CardDescription: CardDescription,
      CardContent: CardContent,
      CardFooter: CardFooter,
      Input: Input,
      Label: Label,
      Separator: Separator,
      Skeleton: Skeleton,
      ConfirmDialog: ConfirmDialog,
      Alert: Alert,
      AlertTitle: AlertTitle,
      AlertDescription: AlertDescription,
      Checkbox: Checkbox,
      Switch: Switch,
      RadioGroup: RadioGroup,
      RadioItem: RadioItem,
      TabsList: TabsList,
      TabsTrigger: TabsTrigger,
      NavigationMenu: NavigationMenu,
      NavigationMenuList: NavigationMenuList,
      NavigationMenuItem: NavigationMenuItem,
      NavigationMenuLink: NavigationMenuLink,
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
      HOST_FILES_PATH: HOST_FILES_PATH,
      HOST_FILE_PATH: HOST_FILE_PATH,
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
      // 语音输入（DSH remote.speech 桥）
      getSpeechApi: getSpeechApi,
      subscribeSpeech: subscribeSpeech,
      setupSpeechBridge: setupSpeechBridge,
      speechEncodeWav: speechEncodeWav,
      speechWavToBase64: speechWavToBase64,
      describeRecorderError: describeRecorderError,
      createSpeechRecorder: createSpeechRecorder,
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
      formatFileSize: formatFileSize,
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
      startCurateRequest: startCurateRequest,
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
      FILE_PREVIEW_KINDS: FILE_PREVIEW_KINDS,
      fetchFiles: fetchFiles,
      fetchFileEntry: fetchFileEntry,
      presentFilesEntry: presentFilesEntry,
      presentFiles: presentFiles,
      normalizeFilesResponse: normalizeFilesResponse,
      presentFilePreview: presentFilePreview,
      normalizeFileResponse: normalizeFileResponse,
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
      PanelLeftIcon: PanelLeftIcon,
      ChevronDownIcon: ChevronDownIcon,
      SidebarHeader: SidebarHeader,
      SidebarContent: SidebarContent,
      SidebarFooter: SidebarFooter,
      SidebarGroup: SidebarGroup,
      SidebarGroupLabel: SidebarGroupLabel,
      SidebarMenuButton: SidebarMenuButton,
      Table: Table,
      TableHeader: TableHeader,
      TableBody: TableBody,
      TableRow: TableRow,
      TableHead: TableHead,
      TableCell: TableCell,
      SidebarClock: SidebarClock,
      formatClockText: formatClockText,
      BrandLogoMark: BrandLogoMark,
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
      UsagePage: UsagePage,
      UsageView: UsageView,
      FilesPage: FilesPage,
      FilesView: FilesView,
      EmptyDocIcon: EmptyDocIcon,
      PlaceholderPage: PlaceholderPage,
      TaskList: TaskList,
      RunsBoardPage: RunsBoardPage,
      RunsBoardView: RunsBoardView,
      RunDetailPage: RunDetailPage,
      RunDetailView: RunDetailView,
      ExpertsPage: ExpertsPage,
      ExpertsView: ExpertsView,
      ExpertChatPage: ExpertChatPage,
      ExpertChatView: ExpertChatView,
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
