# JK知识库

DSH（DeepSeek Harness）Web GUI 知识库插件。

> **自用声明**：本项目是作者**自用**的小工具，顺手开源给小范围的朋友共用，
> 按 **MIT** 协议授权，你可以自由使用、修改、再分发。

## 功能

在「设置」里新增一个 **JK知识库** 子菜单，页面上放一个「**启动JK知识库**」开关，
用它控制侧边栏入口与知识库主页面是否出现在界面里。

- 设置页的开关叫「启动JK知识库」，**默认关闭**，状态存在浏览器 `localStorage`
  （key `jk-knowledge-base:v1`），刷新 / 重启后保持。
- 打开开关后，主界面侧边栏「**插件**」行的**正下方**多出一行「**知识库**」菜单。
- 关掉开关，该菜单与主区域页面**一起移除**（两条席位注册成对 dispose），
  再打开会重新出现，不会留下重复注册。
- 设置页**右下角**显示插件名 + 版本号：`JK知识库 v1.0.0`。
- 「知识库」主页面分左右两栏：
  - **左栏上部**：菜单列表（首版只有「仪表盘」一条）。菜单是**数组驱动**的，
    将来加条目只改那个数组。
  - **左栏下部**：「执行任务」区，**默认只展示 3 条**；任务超过 3 条时，
    列表下方出现「**更多**」按钮，点它展开全部任务、按钮变成「**收起**」，
    再点回到 3 条。切换左栏菜单会把任务区复位成收起态。
  - **右栏**：当前选中菜单对应的页面。首版实现了「仪表盘」，其余菜单若将来加入，
    会自动落到占位页。
- 仪表盘包含 4 张统计卡（知识条目 / 本周新增 / 待整理 / SKILL 数）、「最近入库」列表、
  「运行状态」块。

> **数据是假的**：全部为**前端占位示例数据**，页面顶部有「示例数据」徽标、仪表盘内还有
> 一条说明段。插件**不读取真实目录、不调用 Python、不联网**，请不要把这些数字当成真实统计。

## 环境要求

| 项 | 值 |
|---|---|
| 插件版本 | **1.0.0**（`client.js` 的 `PLUGIN_VERSION` 与 `package.json` 的 `version` 同一个值） |
| DSH 版本 | `dsh.engines.dsh` 声明 `>=0.2.0-rc.2`（**仅作声明**，宿主不强制校验） |
| 宿主平台 | Web GUI（桌面版与网页版共用同一套渲染层） |
| 运行时依赖 | **无**。浏览器半只 `require('react')`，不 `require` 任何 `@deepseek-ai/*` 包 |
| 构建步骤 | **无**。浏览器半是手写的 ModuleLoader bundle |

## 安装

DSH 的「添加插件」（**设置 → 插件 → 添加插件**）接受四类输入：**包名（可带版本）**、
**Git 地址**、**压缩包**、**本地绝对路径**。

### 方式一：图形界面

1. 把本目录放到本机 —— 直接拷贝、或 `git clone`、或用解压后的压缩包。
2. 打开 DSH → **设置 → 插件 → 添加插件**。
3. 填入下列任意一种，然后点「安装」：
   - 本地目录的绝对路径，例如 `/绝对/路径/jk-knowledge-base`
   - Git 地址，例如 `https://github.com/vvip2u/jk-knowledge-base.git`
   - 你打好的压缩包路径，例如 `/绝对/路径/jk-knowledge-base-1.0.0.tgz`
4. **重启 DSH 图形界面**（bundle 组成只在启动时装配）。

### 方式二：命令行

```bash
# 本地目录，link 安装：改源码即时生效，适合自己开发调试
dsh plugin --profile desktop add link:/绝对/路径/jk-knowledge-base

# 本地目录，拷贝安装：装完与源目录无关
dsh plugin --profile desktop add /绝对/路径/jk-knowledge-base

# Git 仓库
dsh plugin --profile desktop add https://github.com/vvip2u/jk-knowledge-base.git

# 压缩包
dsh plugin --profile desktop add /绝对/路径/jk-knowledge-base-1.0.0.tgz
```

> 图形界面用的 profile 名是 **`desktop`**。装到别的 profile（比如 `web`）当前界面看不到。

装完**重启 DSH 图形界面**，再打开 设置 → 左侧应出现「JK知识库」。

## 使用

1. 打开 **设置 → JK知识库**，把「启动JK知识库」拨到**开**。
2. 侧边栏「插件」正下方出现「**知识库**」，点它进入主页面。
3. 左栏上部选「仪表盘」，右栏显示仪表盘（示例数据）；左栏下部是「执行任务」，
   默认 3 条，超过时下面有「更多」，点开看全部、再点「收起」回到 3 条。
4. 想关掉入口：回到设置页把开关拨回**关**，菜单与页面立即消失。

## 设计约束（有意为之）

- **注册与注销成对**：`sidebar.panellist` 与 `main` 两条注册的 `dispose` 存进数组，
  每次状态变化先全部释放、再按当前状态重建（与 `logo-substitute` 的 `releaseBrands` 同构）。
- **`apply(ctx)` 先防错**：`ctx && ctx.slots && typeof ctx.slots.inject === 'function'
  && typeof ctx.slots.register === 'function'`，否则直接 return，绝不抛异常。
- **`order: 1`**：官方「插件」行是 `order: 0`，本插件用 1 紧贴其下方（与 `first-demo` 取同一个值，
  排序先后见「已知限制」）。
- **视觉**：CSS 是 JS 字符串常量 + 注入 `<style>`，类名统一 `jk-kb-` 前缀，只用
  `var(--dsw-alias-*)` 主题变量，不引外部依赖、不引字体、不写死颜色。
- **宿主半是插件底座**：`index.js` 注册 `jk_kb_*` 工具与 HTTP 路由（设置读写、根目录校验、
  run 编排与溯源）。**刻意不导出 `Config`** —— cordis 的 `resolveConfig` 会读取
  `Config["~standard"].validate`，空对象会直接抛 `TypeError`；本插件也没有宿主侧可配置项。

## 宿主半：设置、路由与运行记录

- **服务依赖（踩过的坑）**：`inject` 只声明 `['webServer', 'connection']`。cordis 对每个 fiber 做
  **严格服务门禁**——直接读任何未声明的服务属性（`ctx.tools` / `ctx.subagents` / `ctx.agents` /
  `ctx.logger`）都会抛 `cannot get property "X" without inject`，整个 `apply` 失败，工具与路由
  一个都不会注册（前端表现为 404，应用本身不崩）。所以其它服务**一律走 `ctx.get(name)`**，
  拿不到返回 `undefined`，交给已有的 no-agent / no-route 降级分支处理。
- **设置**：`~/.dsh/plugin-data/jk-knowledge-base/settings.json`（`root` / `rootConfirmedAt` /
  `rootRiskAck` / `updatedAt`），tmp→rename 原子写，坏 JSON 回落默认值。
- **根目录策略**：拒绝系统目录、家目录本身、`~/.dsh`、`.ssh` / `Keychains` 等敏感段、相对路径、
  不存在路径、文件；对 `~/Documents`、`~/Desktop`、`~/Downloads`、外接卷、非空目录只给警告。
  顶层目录名**不复制**，一律从 `assets/engine/directory-presets.json` 投影。
- **HTTP**（前缀 `/plugins/jk-knowledge-base`，exact 优先、`/runs/*` 用 prefix）：
  | 方法与路径 | 作用 |
  |---|---|
  | `GET /health` | 探活（`version` / `host:true`） |
  | `GET /config` | 读设置 + `discovery`（是否已有 `<root>/.jkkb/vault.json`） |
  | `POST /config/validate` | 根目录策略 + 可写性实测 + 目录概要 |
  | `POST /config` | 保存，**必须 `riskAck === true`**，否则 409 |
  | `GET /runs` | 最近 50 条 run（按 startedAt 倒序） |
  | `GET /runs/:id` | 单个 run + steps |
  | `POST /run` | 起 run；同根目录已有 running → 409 |
  | `POST /runs/:id/cancel` | 尽力取消（abort signal） |
- **运行记录**：`<root>/.jkkb/runs/index.json`、`<runId>/run.json`、`<runId>/steps.jsonl`
  （每行一个 step，按 run 串行追加）。不缓存，直接读文件。
- **编排**：能拿到 model route 且 `ctx.get('subagents')` 可用时，起 `JKKB-ORCH` 子代理按
  bootstrap → verify → reindex 调 `jk_kb_*` 工具；否则**降级**为插件顺序调引擎，
  `run.degraded` 标 `no-route` / `no-agent`，step 的 role 写 `PLUGIN`，绝不静默、也不假装是 agent 干的。
- **工具**：`jk_kb_bootstrap` / `jk_kb_verify` / `jk_kb_reindex` / `jk_kb_inspect` /
  `jk_kb_step` / `jk_kb_run_finish`。动作类工具必须带 `runId`，且校验 run 存在且 `running`；
  每次调用自动追加一条 step。

## 已知限制

- **`order: 1` 与 `first-demo` 相同**：如果两个插件同时安装，二者在「插件」下方的先后
  由 slot 引擎对同 order 的排序决定。**未验证，需安装后确认**；若顺序不理想，改本插件的
  `order` 即可（`first-demo` 不动）。
- **开关是自绘的**：宿主 UI 组件不在允许的 `require` 面内（只能 `require('react')`），
  所以开关是一个 `role="switch"` + `aria-checked` 的按钮，外观按主题变量手写，
  与宿主原生 Switch 不会像素级一致。
- **「更多」是展开 / 收起**：默认按 `TASK_LIMIT`（3 条）截断，展开后展示全部，
  按钮 `data-jk-kb-more` 取值 `more` / `less`；任务不超过 3 条时按钮不出现。
- **数据是占位示例**：不接真实目录 / Python / 网络；将来接入时替换 `STATS` / `RECENT` /
  `RUNTIME` / `TASKS` 四个数组即可。
- 状态存在 `localStorage`，**按机器**保存，不跨机器同步；清空 DSH 的站点数据会丢配置。
- 插件**不支持自动更新**：升级需要先卸载再装新版。

## 故障排查

**装完看不到「JK知识库」** —— 依次检查：

1. 是否**重启了整个图形界面**。只刷新页面不够，bundle 组成在启动时才装配。
2. `~/.dsh/profiles/desktop/package.json` 里是否有**两处**条目，缺一不可：
   - `dependencies` 里有 `"jk-knowledge-base"`
   - `dsh.profile.bundles` 数组里有 `"jk-knowledge-base"` ← **这一处才决定插件是否被加载**
3. 个别环境下 `dsh plugin ... add` 会在写完 npm 侧之后**卡住不返回**，于是 `bundles` 没被写入。
   此时手动把 `"jk-knowledge-base"` 加进 `dsh.profile.bundles` 再重启即可。**改之前先备份该文件。**

**开关打开了但侧边栏没有「知识库」** —— 先确认设置页开关显示「已开启」，再重启界面；
若仍没有，检查控制台是否有 `slots.register` 相关报错。

**开关状态像是没保存** —— 隐私模式下 `localStorage` 可能不可写，此时设置页会提示
「保存失败：浏览器存储不可用，开关未生效」。

## 目录结构

```
jk-knowledge-base/
├── package.json          # 包清单：exports、license、files、dsh.bundle.patch、dsh.client
├── index.js              # 宿主半入口：注册 jk_kb_* 工具 + HTTP 路由
├── host/
│   ├── config.js         # 插件设置（~/.dsh/plugin-data/jk-knowledge-base/settings.json，原子写）
│   ├── root-policy.js    # 根目录校验与风险模型（目录名真源来自 engine/presets）
│   ├── routes.js         # HTTP：health / config / validate / runs / run / cancel
│   ├── trace.js          # 运行记录（<root>/.jkkb/runs/，index.json + run.json + steps.jsonl）
│   ├── orchestrator.js   # 多 agent 编排 + 降级（no-route / no-agent）
│   ├── tools.js          # jk_kb_* 工具（runId 守卫 + 自动 step）
│   └── engine/           # 建库引擎（另一位同事实现，本插件只调用）
├── assets/engine/        # 引擎资产（目录预设、规范、模板）
├── client.js             # 浏览器半（exports "./client"），手写 ModuleLoader bundle
├── cordis.patch.yml      # bundle patch：把插件行插入 profile 的 web 组成
├── README.md
├── LICENSE               # MIT
├── .gitignore
└── tools/
    └── smoke-test.mjs    # 冒烟校验脚本（npm run smoke）
```

## 自检

```bash
node tools/smoke-test.mjs   # 或 npm run smoke
```

纯 node、零依赖、不联网、不写盘：stub `window.__ModuleLoader__` + stub `react` + 假
`ctx.slots` + 假 `localStorage`。覆盖：

- 入口契约（`id` 等于包名、只 `require('react')`、`apply` 是函数、无 `eval` / `new Function`）；
- 清单契约（`version` 与 `PLUGIN_VERSION` 一致、`dsh.client.inject` 四项、无 `dependencies`）；
- 开关默认关闭、读写 round-trip、脏数据回落、存储不可用时的降级；
- 任务截断到 3 条 + 是否有「更多」的判定（含恰好 3 条 / 少于 3 条 / 空数组 / 非数组）；
- 展开 / 收起：折叠 3 条 → 展开全部（`more` → `less`）→ 收起回 3 条；菜单切换复位展开态；
- 菜单数组长度与首项为「仪表盘」；
- 关闭状态不注册 `sidebar.panellist` 与 `main`；打开后两者都在；关闭后两者都被 dispose；
  再打开不产生重复注册；刷新后按已保存状态恢复；
- 设置页 Switch 的文案 / `aria-checked` / 右下角 `JK知识库 v1.0.0`；
- 主页面渲染（菜单数组、默认 3 条任务、更多按钮、4 张统计卡、最近入库、运行状态、示例数据标注、
  占位页）；
- CSS 无硬编码颜色、类名统一 `jk-kb-` 前缀。

全部通过时打印 `SMOKE OK: n/n` 并以 0 退出。

## 免责声明

本插件**不修改 DSH 的任何官方文件**。卸载或关闭开关后，侧边栏与主区域立即恢复原样；
如果你的配置想一并清掉，删掉 `localStorage` 里的 `jk-knowledge-base:v1` 键即可。
所有统计与列表均为占位示例数据，**不代表真实知识库内容**。仅供学习专用。

## 作者

**JakeKim@XingHaoTech** ｜ 微信：**vvip2u**

## 许可

[MIT](LICENSE) © 2026 JakeKim@XingHaoTech

本项目为作者自用工具，按 MIT 协议开源。软件按「原样」提供，不附带任何形式的担保。
