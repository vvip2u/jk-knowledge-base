# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

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
