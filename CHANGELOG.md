# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

## [1.1.1] - 2026-10-23

1.1.0 的补丁版：修复真机白屏与菜单排布回归，继续组件化收尾。

### 修复
- **业务专家页白屏**：补齐 v1.0.0 起缺失的 `unbindSkill`/`restoreExpert` 两个 handler——此前点击任一标签触发渲染错误后 React 18 卸载整棵树，所有页面变空白
- 侧栏「仪表盘 / 业务专家 / 任务管理」恢复纵向三个菜单（上轮 Tabs 迁移误用横向布局）
- `Alert` 旧 kind 归一扩展 `warn` → `warning`

### 变更
- 「体检结果」卡片迁移到 shadcn 结构：`Card` 家族承载卡壳与元信息、错误码改 `Badge`、体检明细行改 `Alert`（按级别映射变体）并新增 `AlertTitle`/`AlertDescription` 子组件
- 设置页（JK知识库）全面组件化：根目录/开关卡壳改 `Card`、宿主状态徽标改 `Badge`（按状态映射变体）、路径输入改 `Input`、校验结果与风险确认改 `Alert`（级别/警告变体）
- 开关重做为标准 shadcn `Switch` 视觉（按钮即轨道 + 滑块，去掉状态文本与外层 pill 边框；圆角/尺寸 `!important` 加固，防宿主按钮样式覆写）
- 主页面「业务专家」全部标签卡片新增「立即使用」：收起专家区域进入 DSH 风格执行对话——空态改为三条快捷选项（`RadioGroup`/`RadioItem` 单选：整理访谈记录/技术笔记/会议纪要），点击即把预设文本填入输入框并收起选项；底部多行输入框（composer 卡片：加号占位钮 + 绑定专家徽标 + 圆形发送钮；回车发送、Shift+回车换行）把文本作为 curate run 绑定该专家入柜，上方按步骤时间线原样呈现执行过程与结果摘要（run 进行中自动轮询，返回时刷新专家统计）；组件层新增 `Textarea`/`RadioGroup`/`RadioItem`
- 业务专家卡片迁至【设置】-【JK知识库】页（「基本信息」模块下方，与基本信息同款 Card 卡片壳）统一管理；主页面保留「业务专家」菜单与页面，卡片区改为「全部 / 其他」标签页（其他 = 领域未填或「其他」的专家）；专家卡片移除「归档」按钮（已归档视图与恢复保留）
- 业务专家页标题下职责说明改为 blockquote 引用样式（左侧主色竖线）
- 新增「使用信息」菜单（任务管理下方）：承接仪表盘迁来的「运行状态」块（根目录/模式/vault/最近 run/工具注册/子代理），仪表盘不再渲染该块
- 仪表盘「最近整理」空态改为居中空文档图标 + 「现在还是空的呢：）」引导框（空态图标抽取为 `EmptyDocIcon` 复用组件）
- 仪表盘：移除标题下「生成于 XXX」行；总空态（无条目且无最近入库）改为居中空文档图标 + 「快来放第一篇文档吧」引导大框，同时收起冗余的最近入库空态区
- 设置页根目录区块标题改为「基本信息」；主页面移除顶部「知识库」大标题行，原说明行改为 shadcn `NavigationMenu` 顶部导航（知识库 / 文档两项，「文档」外链仓库 README）

## [1.1.0] - 2026-10-23

前端渲染层迁移到 shadcn/ui 规范组件体系，观感与宿主主题对齐。

### 新增
- **shadcn 设计令牌桥**：`--background`/`--primary`/`--border`/`--ring`/`--radius` 等 21 个 shadcn 令牌桥接宿主 `--dsw-alias-*` 主题变量，作用域限定插件面板，明暗主题跟随宿主
- **零依赖组件层**：按 shadcn/ui 规范手写 `cn` / `Button`（六变体 × 四尺寸）/ `Badge`（六变体）/ `Card` 家族 / `Input` / `Label` / `Separator` / `Skeleton` / `ConfirmDialog`（AlertDialog 语义）；DSH 单文件契约下不引入 tailwind / radix，类名保持 `jk-kb-` 前缀

### 变更
- 全部视图（仪表盘 / 任务看板 / 任务详情 / 业务专家 / 整理报告 / 技能库 / 台账日历 / 设置区 / 引导页）的动作按钮、徽章、确认框迁移到组件层；5 处内联确认框统一为 `ConfirmDialog`，旧变体类（如 `jk-kb-btn-suggested`）经 variant 透传保持兼容
- 结构性交互元素迁移到组件层语义组件：22 处操作提示 → `Alert`（旧 `error`/`ok` kind 归一为 `destructive`/`success` 变体）、7 处确认勾选 → `Checkbox`、设置区开关 → `Switch`、菜单导航与任务视图切换 → `TabsList`/`TabsTrigger`（保留 data 属性与 aria 契约）
- 「体检结果」卡片迁移到 shadcn 结构：`Card` 家族承载卡壳与元信息、错误码改 `Badge`、体检明细行改 `Alert`（按级别映射变体）并新增 `AlertTitle`/`AlertDescription` 子组件
- 设置页（JK知识库）全面组件化：根目录/开关卡壳改 `Card`、宿主状态徽标改 `Badge`（按状态映射变体）、路径输入改 `Input`、校验结果与风险确认改 `Alert`（级别/警告变体）；开关重做为标准 shadcn `Switch` 视觉（按钮即轨道 + 滑块，去掉状态文本与外层 pill 边框）

### 修复
- 体检（doctor）路由误读真实用户 `settings.json` 导致 CFG-01 在未配置根目录时误报 ok——诊断/修复调用补传 `settingsPath` 依赖
- 仪表盘「本周新增估算」依赖真实当前时间导致的历史数据归零——`presentDashboard` 支持注入 nowValue
- 业务专家页引用未定义的 `unbindSkill` / `restoreExpert`（1.0.0 预存在缺陷）——React 18 渲染错误无边界捕获导致点击任意标签后整个面板白屏；补齐两个 handler，UI 测试新增直调渲染防回归断言

## [1.0.0] - 2026-10-17

首个完整版。宿主 19 个工具、19 条 HTTP 路由，前端 5 个视图，测试 1872 条。

### 新增
- **知识库本体**：13 个顶层目录 + 系统文件（首页 / 索引页 / MOC / 规范页），建库、体检、重建索引、只读概览
- **入柜（curate）**：47 条内置技能目录（10 个职业 × 4 + 7 条通用），模板骨架成型，缺节标 `> ⚠ 本节未填写` 而非伪造；编号自动分配（编号前缀 `DOC`/`SK`/`EXP`），frontmatter 与溯源链
- **整理（maintain）**：M01/M03/M04/M06/M07/M08 六条规则，只读扫描，产出报告（含 `byRule` 与 findings），绝不移动或删除
- **归档（archive）**：文件与**整个目录**都能归档——优先 `rename`（同盘原子），跨盘走「复制 → 校验文件数与总字节 → 删源」；归档后自动在目录首页补四要素（原始位置/时间/原因/继任版本）；损坏或过期产物一律移入 `.jkkb/quarantine/`，**从不删除**
- **业务专家**：`EXP` 编号、绑定技能、提示词片段；入柜时注入专家职责/提示词/绑定技能；产出统计（卡片数/最近使用）、悬空技能检测与一键解绑、归档后可恢复
- **任务溯源**：每次操作一条 run（step / 心跳 / 预算 / token 三态 / 验收门 / checkpoint），卡住可「继续 / 重新开始（先备份）/ 放弃」；台账日历按日聚合
- **doctor（体检修复）**：22 项只读检查 + 16 项修复，诊断对损坏免疫（单 check 失败降级，不中断整体）；修复要求「无进行中 run」+ 预览 + 确认；幂等；`.jkkb/doctor/last.json` 由宿主审计独占写入
- **仪表盘**：`GET /dashboard` 真实数据（条目数/顶层目录分布/最近入库/运行状态/今日 token/最近整理），未配根目录时显示骨架而非假数据
- **设置**：知识库根目录选择 + 每次更新风险提示 + 保存按钮；开关常驻
- **文档布局约定**：随包只带"能照着执行"的动作指南（README / DOCTOR / VERIFY-WINDOWS / CHANGELOG），设计记录不进包、运行时零依赖，由 `tools/pack-check.mjs` 机器校验

### 安全与边界
- 只写授权根目录内，路径守卫单一来源（`assertWritable*`），守卫不可用即 fail-closed
- 引擎绝不删除用户文件；归档是"移动 + 四要素"，doctor 是"补缺 + 隔离"
- 扫描与生成分离：只读扫描零 token，内容生成才走 agent

### 跨平台
- 路径包含判定用 `path.relative`（不用字符串前缀）、win32 `\\?\` / UNC 归一化、`replaceFile` 重试、`sanitizeSegment`、`assertPathLength`（win32 > 240 → `PATH_TOO_LONG`）、BOM/CRLF 容错
- 三平台测试矩阵见 `.github/workflows/test.yml`；Windows 真机清单见 `VERIFY-WINDOWS.md`
