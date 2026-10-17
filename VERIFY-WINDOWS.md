# JK知识库 · Windows 真机验证清单

> 用途：在 Windows 上按顺序跑一遍，把「跨平台只做了模拟」的假设逐条落实。
> 原则：**每一项都写清预期结果**；不符合就按最后一节回报，不要跳过。
> 版本基线（macOS 上已通过）：engine 33/33、smoke 924/924、ui 636/636。

---

## 0. 前置检查

| 检查 | 命令 | 预期 |
|---|---|---|
| Node 版本 | node -v | ≥ 22（命令行测试用你自己的 Node 即可） |
| 插件已链接 | 读 %USERPROFILE%\\.dsh\\profiles\\desktop\\package.json | dependencies 与 bundles 里都有 jk-knowledge-base |
| 目录存在 | dir %USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\jk-knowledge-base | 指向工作区目录的链接或真实目录 |
| 应用已重启 | — | 设置 → JK知识库 不再显示「宿主半未加载」 |

---

## 1. 三套测试（最重要，先跑这个）

在插件目录下执行：

    node tools\\engine-test.mjs
    node tools\\smoke-test.mjs
    node tools\\ui-test.mjs

| 测试 | 预期 |
|---|---|
| engine-test | 首行 [engine-test] platform=win32 arch=x64；# tests 33、# pass 33、# fail 0；允许出现 SKIP（symlink 创建、chmod 两类），SKIP 必须带原因 |
| smoke-test | 首行 [jkkb-smoke] platform=win32；SMOKE OK: 924/924 |
| ui-test | UI TEST OK: 636/636 |

**判据**：fail 必须为 0。SKIP 数量应为 2-4 条；若 SKIP 远超这个数，说明有平台分支写得过宽，需要修。

---

## 2. 路径守卫（保留区）

在设置页把根目录依次填成：

| 输入 | 预期 |
|---|---|
| C:\\Windows\\kb | reject，原因码 root-system |
| C:\\Program Files\\kb | reject，root-system |
| 长路径前缀 + C:\\Windows\\kb | reject（剥离前缀后仍命中保留区） |
| D:\\knowledge\\kb（单盘机器用 C:\\Users\\<你>\\Documents\\kb） | 允许 |

---

## 3. 空格与中文路径

建一个 C:\\Users\\<你>\\Documents\\JK 知识库 测试\\（含空格与中文）作为根目录并建库。

**预期**：建出 13 个顶层目录、每个含 _说明.md、5 份规范、10 个模板、00_系统与索引\\00_知识库首页.md、.jkkb\\vault.json；任务结束状态 completed 且验收徽标「通过」。

---

## 4. 长路径（Windows 特有的坑）

在深目录里建根，使「根路径长度 + 00_系统与索引\\03_标签与元数据字典\\元数据规范.md」超过 240 字符（逐级 mkdir 加长）。

**预期**：建库在写入前失败，错误码 PATH_TOO_LONG，且磁盘上没有留下半成品（根目录应为空）。

---

## 5. 只读目录（ACL）

对一个普通目录右键 → 属性 → 安全 → 去掉当前用户的写入权限，用它作根目录。

**预期**：preflight 报 ROOT_NOT_WRITABLE，detail 带 Windows 的 errno（EPERM 或 EACCES），不创建任何文件。

---

## 6. UNC 网络共享

若有共享目录，形如 双反斜杠 + 主机 + 反斜杠 + 共享 + 反斜杠 + kb。

**预期**：允许保存但给出 warning（原因码 root-network-share，文案含「网络延迟不可控 / 无法校验剩余空间 / 确认已挂载且有写权限」），不阻断。

---

## 7. 文件被占用（Windows 的 rename/unlink 语义）

1. 建库成功后，用记事本打开 .jkkb\\runs\\index.json 并保持打开；
2. 再跑一次建库（会重写 index.json）。

**预期**：要么成功，要么 run 失败但错误是 FILE_BUSY / lock-busy；**不能出现残缺的 index.json**（记事本打开仍应是合法 JSON）。

---

## 8. 界面（新增功能）

| 位置 | 预期 |
|---|---|
| 左栏菜单 | 顺序为 仪表盘 → 业务专家 → 任务管理；业务专家页可新建/编辑/归档/恢复并显示产出统计 |
| 任务管理 → 列表 | 多出「心跳」「预算」「Token」列；Token 三态：in / out、—、无 agent |
| 任务管理 → 日历 | 默认当月；有任务的日期有圆点或数字，失败日期红点；点日期出现当天任务；切年视图 12 格；「刷新」可用；页面不自己刷新 |
| 任务详情 | 「用量」区块显示 input/output/cacheRead/cacheWrite；degraded 任务显示「无 agent 降级，未消耗 token」 |
| 台账文件 | 建库后 <根>\\00_系统与索引\\台账-YYYY-MM.md 存在，内含当天一行记录 |
| 仪表盘 | 四张卡是**真实数字**（不再是示例）：知识条目 = 实际笔记数；最近入库列出你真改过的笔记；运行状态显示根目录 / mode / 最近一次任务 / store 守卫 = ready；「最近整理」显示最近一份报告的命中数 |
| 未配根目录 | 左栏只剩「仪表盘」，执行任务区是 3 条骨架且**没有「更多」**；右栏骨架 + 顶部引导条，点「去设置」跳到设置并高亮根目录 |
| 入柜 | 选业务专家后，技能下拉**只列该专家绑定的技能**；勾「显示全部技能」回到全量；选越界技能有黄字提示但可提交 |
| 整理报告 | M06/M07 条目各有「归档」；目录条目按钮为「归档目录」，确认弹层写明「移动整个目录，结构与内容不变」；确认后目录出现在 `12_归档与历史\03_归档笔记\<原相对路径>`，首页头部有四要素，原位置为空 |
| 业务专家 | 卡片显示「N 张卡片 · 最近使用 …」；归档后在「已归档」里点「恢复」能回到启用列表；悬空技能标黄并有「解绑」 |
| 体检修复 | 任务管理页右上「体检修复」→ 摘要四个数字 → 勾选可修项 → 「预览修复」列出动作与目标路径（**磁盘不变**）→ 「确认修复」→ 结果逐条 + movedTo；修复后自动复检 |
| 隔离区 | 修复后 `<根>\.jkkb\quarantine\<时间戳>\` 下能看到被隔离的坏文件（原相对路径保留），原位置已不存在 |

---

## 9. 崩溃残留（可选但有价值）

建库跑到一半用任务管理器强制结束 DeepSeek Harness，再重开。

**预期**：该 run 变为「已卡住」；详情页三个按钮可用；点「重新开始」会先备份到 .jkkb\\backup\\<时间戳>-<runId后8位>\\，再重跑；旧产物不被覆盖。

---

## 10. 失败时怎么回报（重要）

每个失败项请给齐这五项：

1. 操作步骤（哪条命令 / 哪个界面动作）；
2. 预期与实际（原样贴错误码与文案）；
3. 测试输出首行的 platform=... 以及 fail 的用例名；
4. 相关文件路径与 errno 原文；
5. 若有日志：%USERPROFILE%\\.dsh\\plugin-data\\jk-knowledge-base\\ 下的文件，或界面完整错误文本。

**已知会在 Windows 上 SKIP 的用例**（属于预期，不算失败）：symlink 创建、chmod 制造不可写。

**本机未验证、这次要重点盯的**：replaceFile 的占用重试、statfs 在 NTFS/UNC 的取值、NTFS 保留名与结尾点空格的真实落盘、240 字符边界（LongPathsEnabled）、大小写判重在 NTFS 上的行为、长路径前缀经 realpathSync 后的形态。
