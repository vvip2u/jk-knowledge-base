# 知识库内置技能目录（P2）

这 47 条技能是 **jk-knowledge-base 插件自带的内容生成能力**，不是 DSH 技能（Skill），
也**不是**对 `~/.dsh/skills`、`~/.agents/skills`、`~/.workbuddy/skills` 或任何外部技能市场的索引。

- 运行时只读本插件自带目录（代码里的 `SKILLS`，见 `host/skills/catalog.js`）；
- 提示词里固定带 `INTERNAL_SKILLS_ONLY` 标识串，任何"去外部找技能"的实现都会被测试判失败；
- 原始清单 `capture-skills.json` 只作为内容对照，**不是运行时数据源**，本目录的数据结构是重写后的插件自有格式。

## 一条技能长什么样

| 字段 | 含义 |
| --- | --- |
| `id` | `岗位缩写.技能名蛇形`，如 `biz.customer_interview`，全局唯一、稳定（将来 SKILL 注册表的种子） |
| `name` | 中文技能名 |
| `profession` | 10 个岗位之一，或 `common` |
| `stage` | `capture` / `research` / `hypothesis` / `verify` / `distill` / `apply` / `review` |
| `purpose` | 一句话用途 |
| `outputDir` | 目标顶层目录（13 目录之一，只禁止 `00_系统与索引`；capture 默认 `02_原始资料库`，快速收件卡为 `01_收件箱`） |
| `template` | `assets/engine/templates/tpl-*.md` 文件名；无模板时显式为 `null` |
| `idPrefix` | `R` / `S` / `H` / `E` / `D` / `K` / `RT` / `P` / `DOC` / `SK` |
| `requiredFields` | 至少 `title`、`date`、`tags`、`confidence` |
| `confidenceRule` | `{ levels: ['高','中','低'], lowRequiresReason: true }` |
| `questions` | agent 生成内容前必须问清 / 提取的 3–6 个信息点 |
| `outputHints` | 产出长什么样（一句话） |

两种消费方式：

- **agent**：`renderSkillPrompt(skill, inputHint)` 生成提示词片段（任务、必问项、输出结构、置信度、落位、编号、禁止检索外部技能）；
- **引擎**：读取 `outputDir` / `template` / `idPrefix` / `requiredFields` 决定落位、模板与元数据校验。

## 阶段 → 落位映射

| 阶段 | outputDir | 条数 |
| --- | --- | --- |
| capture | `02_原始资料库`（`common.quick_capture` 例外 → `01_收件箱`） | 10 + 1 |
| research | `03_研究与洞察` | 10 |
| hypothesis | `04_思考与假设` | 5 |
| verify | `05_验证与证据` | 2 |
| distill | `06_知识与模型` | 5 |
| apply | `08_作品与成果` 或 `10_决策与复盘`（决策类） | 6 |
| review | `10_决策与复盘` | 8 |

## 新增 / 修改技能流程

1. 在 `host/skills/catalog.js` 的 `ROWS` 末尾追加一行（元组顺序见文件头注释）；
2. 确认 `outputDir` 在 13 目录内且不是 `00_系统与索引`（capture 阶段落 `02_原始资料库`，唯一例外是 `common.quick_capture` 落 `01_收件箱`），`template` 指向 `assets/engine/templates/` 里真实存在的文件（否则写 `null` 并在对应位置说明原因）；
3. 跑 `node tools/skills-test.mjs`（47 条的基础校验、id 唯一、问题数 3–6、渲染约束都在里面）；
4. 涉及目录结构变化时同步更新 `assets/engine/directory-presets.json` 与本 README。

> 将来接入库内 SKILL 注册表时，只把 `SKILLS` 的来源从静态 `ROWS` 换成注册表读取，
> `byId` / `byProfession` / `byStage` / `validateCatalog` / `renderSkillPrompt` 的契约保持不变。
