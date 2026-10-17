/**
 * JK知识库内置技能目录（P2 重写）。
 *
 * 这里的 47 条技能是**插件自带的「内容生成技能」**，只服务知识库内部流程：
 * agent 用它组织提问与产出，引擎用它决定落位目录 / 模板 / 编号前缀 / 必填元数据。
 * 运行时**不得**检索或调用外部 DSH 技能目录（~/.dsh/skills、~/.agents/skills、
 * ~/.workbuddy/skills）或任何外部技能市场——外部技能与这里是两套东西。
 *
 * 数据结构以本文件为单点真源（不复制原始 capture-skills.json），
 * 将来改成读库内 SKILL 注册表时，替换 SKILLS 的来源即可，其余消费方不用动。
 */
import { TEMPLATE_FILES } from '../engine/presets.js';

export const STAGES = Object.freeze([
  'capture',
  'research',
  'hypothesis',
  'verify',
  'distill',
  'apply',
  'review',
]);

export const PROFESSIONS = Object.freeze([
  '创业与经营',
  '销售与商务',
  '市场与内容',
  '产品经理',
  '研发与技术',
  '设计与创意',
  '咨询与专业服务',
  '教育与培训',
  '投资与研究',
  '职场通用',
  'common',
]);

/** 13 个顶层目录（与建库引擎 presets 一致）。 */
export const OUTPUT_DIRS = Object.freeze([
  '00_系统与索引',
  '01_收件箱',
  '02_原始资料库',
  '03_研究与洞察',
  '04_思考与假设',
  '05_验证与证据',
  '06_知识与模型',
  '07_素材与组件',
  '08_作品与成果',
  '09_项目与运营',
  '10_决策与复盘',
  '11_岗位技能库',
  '12_归档与历史',
]);

/** 生成内容禁止落进系统层（01 收件箱 / 02 原始资料库是 capture 阶段的正当入柜目标）。 */
export const FORBIDDEN_OUTPUT_DIRS = Object.freeze(['00_系统与索引']);

/** capture 阶段的落位：普通资料卡进 02，唯一例外是「快速收件卡」进 01。 */
export const CAPTURE_OUTPUT_DIR = '02_原始资料库';
export const QUICK_CAPTURE_ID = 'common.quick_capture';
export const QUICK_CAPTURE_OUTPUT_DIR = '01_收件箱';

export const ID_PREFIXES = Object.freeze(['R', 'S', 'H', 'E', 'D', 'K', 'RT', 'P', 'DOC', 'SK']);

export const REQUIRED_FIELDS = Object.freeze(['title', 'date', 'tags', 'confidence']);

export const CONFIDENCE_RULE = Object.freeze({
  levels: Object.freeze(['高', '中', '低']),
  lowRequiresReason: true,
});

export const TEMPLATE_NAMES = Object.freeze(TEMPLATE_FILES.map((t) => t.file));

/**
 * 元组顺序：id, name, profession, stage, purpose, outputDir, template, idPrefix, questions, outputHints
 * 用元组是为了让 47 条数据一屏能扫完；导出时统一展开成对象。
 */
const ROWS = [
  // ---------------------------------------------------------------- common（7）
  ['common.quick_capture', '快速收件卡', 'common', 'capture',
    '把刚冒出的想法、文章或消息原样收进素材区，先不判断',
    '01_收件箱', 'tpl-source-card.md', 'DOC',
    ['这条信息来自哪里（链接、对话、文件名）？', '什么时候、以什么方式拿到的？', '为什么现在觉得它有用（conf_why）？', '它可能属于哪个角色目录？'],
    '一张带编号的收件卡：正文保留原文与出处，置信度标低并写明 conf_why。'],

  ['common.data_cleaning', '资料清洗加工', 'common', 'research',
    '把一批原始资料去重、标准化，形成可分析的口径',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['对应哪一批原始资料编号？', '清洗规则与丢弃标准是什么？', '样本范围与分析日期？', '目前已知的主要局限？'],
    '一份加工后的数据集说明：口径、清洗规则、样本范围与局限齐全。'],

  ['common.hypothesis', '通用假设卡', 'common', 'hypothesis',
    '把「我认为 X 会成立」写成可证伪的假设',
    '04_思考与假设', 'tpl-hypothesis-card.md', 'H',
    ['可被推翻的陈述是什么？', '成立需要哪些条件？', '打算用什么方法验证？', '看到什么反面证据就说明它错了？'],
    '一张假设卡：预期结果、成立条件、验证方法、反面证据与上游编号齐全。'],

  ['common.experiment', '通用实验记录', 'common', 'verify',
    '为一条假设设计测试，并如实记录结果与证据',
    '05_验证与证据', 'tpl-experiment-log.md', 'E',
    ['要验证哪条假设编号？', '方案与成功标准是什么？', '实际执行时间、样本与结果？', '这次结论的适用范围与局限？'],
    '实验记录：方案、成功标准、实际结果、证据清单与适用边界。'],

  ['common.knowledge', '通用知识卡', 'common', 'distill',
    '把重复验证过的经验提炼成以后能直接用的方法',
    '06_知识与模型', 'tpl-knowledge-card.md', 'K',
    ['这条认识由哪些实验/复盘编号支撑？', '适用条件与不适用场景是什么？', '已知局限与失效信号？', '和已有知识卡是补充还是冲突？'],
    '一张带适用条件的知识卡，每个结论都能链回证据编号。'],

  ['common.output_archive', '成品归档卡', 'common', 'apply',
    '把已交付或已发布的成品留成正式版本记录',
    '08_作品与成果', 'tpl-atom-card.md', 'DOC',
    ['成品是什么、交付给谁？', '版本号与交付/发布时间？', '验收标准与结果？', '工作草稿与正式版的区别是什么？'],
    '一条作品记录：版本标记、交付对象、时间与验收结果。'],

  ['common.retro', '通用复盘卡', 'common', 'review',
    '一件事告一段落后，对照预期与实际，产出下一轮假设',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['当初的预期与决策编号是什么？', '实际结果与预期差在哪？', '差异来自判断错误还是不可预见因素？', '下一轮要验证的新假设是什么？'],
    '一份复盘：事实对照、归因、教训与下一轮假设编号，不回改历史决策。'],

  // ---------------------------------------------------------------- 创业与经营 biz（4）
  ['biz.customer_interview', '客户访谈入柜', '创业与经营', 'capture',
    '把访谈录音、逐字稿或现场笔记原样归档为可引用的原始资料',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['受访者身份与业务背景？', '采集时间、方式与授权范围？', '录音/逐字稿/截图的原始文件在哪里？', '哪些内容涉及敏感信息、需要脱敏或标密？'],
    '一张资料卡 + 原文附件清单，标注采集信息、授权范围与密级。'],

  ['biz.need_digest', '客户需求提炼', '创业与经营', 'research',
    '从多次访谈中归纳客户需求的频次、强度与场景',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['用了哪些访谈/资料编号？', '需求是在什么场景下被提到的？', '频次与付费意愿的证据是什么？', '哪些需求是客户说的、哪些是实际行为？'],
    '一份需求清单：按场景分组，标注频次、证据编号与可信度。'],

  ['biz.business_model_hypothesis', '商业模型假设卡', '创业与经营', 'hypothesis',
    '把商业模式的某个关键判断写成可验证的假设',
    '04_思考与假设', 'tpl-hypothesis-card.md', 'H',
    ['假设的是价值主张、收入还是成本结构？', '可证伪的陈述与量化指标？', '成立需要的前置条件？', '用哪类实验可以最快证伪？'],
    '一张商业模型假设卡：指标化陈述、前置条件、证伪实验与反面证据。'],

  ['biz.pricing_validation', '定价与需求验证', '创业与经营', 'verify',
    '用真实报价或试用测试客户的价格接受度',
    '05_验证与证据', 'tpl-experiment-log.md', 'E',
    ['验证哪条定价假设？', '报价方案、样本与成功标准？', '客户的实际反应（成交/犹豫/拒绝）？', '样本偏差与结论边界？'],
    '实验记录：报价方案、样本、实际反应与定价结论的适用边界。'],

  // ---------------------------------------------------------------- 销售与商务 sales（4）
  ['sales.call_notes', '客户沟通记录入柜', '销售与商务', 'capture',
    '把电话、拜访、微信沟通的关键内容原样留档',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['客户与联系人是谁、什么角色？', '沟通时间、渠道与原文在哪？', '客户明确说了什么（逐字引用）？', '承诺了哪些下一步？'],
    '一张沟通记录卡：参与人、时间渠道、原话摘录与后续承诺。'],

  ['sales.decision_chain', '决策链与痛点分析', '销售与商务', 'research',
    '梳理客户决策链、关键人诉求与真实痛点',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['涉及哪些角色、谁有一票否决权？', '每个角色的诉求与顾虑？', '痛点现在是怎么被解决的？', '证据来自哪些沟通编号？'],
    '一张决策链地图：角色、影响力、诉求、痛点与证据编号。'],

  ['sales.pitch_playbook', '成交话术沉淀', '销售与商务', 'distill',
    '把有效的异议处理与成交话术提炼成可复用打法',
    '06_知识与模型', 'tpl-knowledge-card.md', 'K',
    ['这套话术在哪些客户身上奏效？', '适用行业、角色与阶段？', '失败或反效果的情况？', '支撑它的成交记录编号？'],
    '一份话术卡：场景、原话模板、适用边界与失败案例。'],

  ['sales.lost_deal_review', '丢单复盘', '销售与商务', 'review',
    '复盘丢单原因，区分判断失误与客观不匹配',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['当初的赢单判断与决策编号？', '丢单发生在哪个环节、客户怎么说的？', '是价格、产品、关系还是时机问题？', '下一单要提前验证什么？'],
    '一份丢单复盘：事实时间线、真实原因、可改进动作与下一轮假设。'],

  // ---------------------------------------------------------------- 市场与内容 mkt（4）
  ['mkt.viral_material', '爆款与竞品素材采集', '市场与内容', 'capture',
    '把爆款内容与竞品素材原样采集，保留数据与出处',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['素材来自哪个平台、哪个账号？', '采集时间与当时的数据（赞藏评）？', '为什么判定它是爆款或重要竞品动作？', '原链接与截图保存在哪里？'],
    '一条素材卡：平台、账号、数据快照、出处与判定理由。'],

  ['mkt.topic_analysis', '选题与表现分析', '市场与内容', 'research',
    '分析选题与内容表现之间的关系，找出可复用的规律',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['样本包含哪些内容、时间范围？', '衡量表现用的指标与口径？', '哪些选题/结构/情绪表现更好？', '混淆因素与样本偏差？'],
    '一份选题分析：样本口径、表现对比、可能规律与偏差说明。'],

  ['mkt.copy_hypothesis', '标题与文案假设卡', '市场与内容', 'hypothesis',
    '把标题或文案的效果判断写成可测试的假设',
    '04_思考与假设', 'tpl-hypothesis-card.md', 'H',
    ['假设针对哪类读者、哪个渠道？', '预期提升的指标与幅度？', '对照组与测试方式？', '什么结果说明假设不成立？'],
    '一张文案假设卡：目标读者、指标预期、A/B 方案与否证条件。'],

  ['mkt.campaign_review', '投放与内容复盘', '市场与内容', 'review',
    '对照投放目标与实际数据，解释差异并产出下一轮假设',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['本次目标、预算与决策编号？', '实际曝光、点击、转化与成本？', '差异主要来自素材、人群还是渠道？', '下一轮要验证什么？'],
    '一份投放复盘：目标 vs 实际、归因、可复用结论与下一轮假设。'],

  // ---------------------------------------------------------------- 产品经理 product（4）
  ['product.feedback_intake', '用户反馈入柜', '产品经理', 'capture',
    '把用户反馈原样归档，保留来源与语境',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['反馈来自哪个用户、哪个渠道？', '发生时间与产品版本？', '用户的原话与操作路径？', '是否涉及数据/隐私需脱敏？'],
    '一条反馈卡：用户画像、版本、原话、复现路径与密级。'],

  ['product.priority_analysis', '需求优先级分析', '产品经理', 'research',
    '综合价值、成本与证据强度，对需求排序',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['候选需求来自哪些反馈编号？', '价值、频次与影响面怎么估？', '实现成本与依赖是什么？', '排序依据与不确定项？'],
    '一份排序表：需求、证据、价值/成本评分与不确定性。'],

  ['product.value_hypothesis', '功能价值假设卡', '产品经理', 'hypothesis',
    '把「这个功能能解决某类问题」写成可验证的假设',
    '04_思考与假设', 'tpl-hypothesis-card.md', 'H',
    ['目标用户与使用场景？', '预期改变的行为指标？', '最小验证方案是什么？', '什么数据说明它没价值？'],
    '一张功能假设卡：场景、行为指标、最小实验与否证条件。'],

  ['product.release_review', '版本上线复盘', '产品经理', 'review',
    '复盘版本上线过程与结果，沉淀流程改进',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['版本目标与范围是什么？', '实际上线时间、缺陷与回滚情况？', '核心指标是否达到预期？', '流程上下一版要改什么？'],
    '一份上线复盘：范围、过程问题、指标结果与流程改进项。'],

  // ---------------------------------------------------------------- 研发与技术 dev（4）
  ['dev.incident_capture', '故障现场记录', '研发与技术', 'capture',
    '故障发生时原样记录现场，避免事后记忆污染',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['发生时间、影响范围与版本？', '报错原文、日志与监控截图在哪？', '当时的操作与变更记录？', '谁在场、谁处理的？'],
    '一条故障现场卡：时间线、报错原文、日志位置与在场人员。'],

  ['dev.root_cause', '根因分析', '研发与技术', 'research',
    '从现象与日志推导根因，区分直接原因与系统性原因',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['依据哪些故障记录与日志编号？', '排除过哪些可能原因、怎么排除的？', '直接原因与系统性原因分别是什么？', '还有哪些未解释的现象？'],
    '一份根因分析：证据链、排除过程、根因结论与遗留疑点。'],

  ['dev.tech_decision', '技术方案决策记录', '研发与技术', 'apply',
    '记录技术选型的备选方案、权衡与最终决定',
    '10_决策与复盘', 'tpl-decision-log.md', 'D',
    ['要解决的技术问题与约束？', '考虑过哪些备选方案？', '权衡维度与权重是什么？', '最终选了哪个、由谁拍板？'],
    '一份决策记录：备选方案对比、权衡依据、最终决定与生效范围。'],

  ['dev.tech_digest', '技术沉淀卡', '研发与技术', 'distill',
    '把排查或实现经验提炼成可复用的技术知识',
    '06_知识与模型', 'tpl-knowledge-card.md', 'K',
    ['这条经验的证据来自哪些故障/实验编号？', '适用技术栈与版本范围？', '不适用或已知失效的场景？', '有没有更简单的替代做法？'],
    '一张技术知识卡：适用栈与版本、操作步骤、坑与替代方案。'],

  // ---------------------------------------------------------------- 设计与创意 design（4）
  ['design.visual_ref', '视觉参考入柜', '设计与创意', 'capture',
    '把视觉参考原样归档，保留来源与使用意图',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['参考来自哪里、作者是谁？', '参考的是配色、排版还是交互？', '授权与可用范围？', '打算用在哪个项目？'],
    '一条参考卡：来源、授权、可取之处与拟用项目。'],

  ['design.visual_analysis', '视觉归因分析', '设计与创意', 'research',
    '拆解优秀视觉作品的构成要素，解释它为什么有效',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['分析样本有哪些参考编号？', '拆解维度（层级、留白、色彩、字体）？', '哪些手法与目标受众匹配？', '哪些只是风格偏好、难以复用？'],
    '一份视觉拆解：要素表、作用解释与可复用/不可复用结论。'],

  ['design.system_digest', '设计规范沉淀', '设计与创意', 'distill',
    '把反复使用的设计决策固化成规范与组件规则',
    '06_知识与模型', 'tpl-knowledge-card.md', 'K',
    ['规范覆盖哪些场景与组件？', '取值依据与反例是什么？', '例外情况怎么处理？', '和现有品牌/设计系统是否冲突？'],
    '一份规范卡：规则、取值、反例与例外处理。'],

  ['design.work_archive', '作品版本归档', '设计与创意', 'apply',
    '把定稿作品按版本归档，保留交付与授权信息',
    '08_作品与成果', 'tpl-atom-card.md', 'DOC',
    ['作品名称、客户与交付时间？', '版本号与修改要点？', '源文件与导出文件在哪？', '授权范围与二次使用限制？'],
    '一条作品记录：版本、交付信息、文件位置与授权范围。'],

  // ---------------------------------------------------------------- 咨询与专业服务 consult（4）
  ['consult.client_research', '客户现状调研入柜', '咨询与专业服务', 'capture',
    '把客户访谈、问卷与现场观察原样归档',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['调研对象、部门与职级？', '调研方式、时间与样本量？', '原始记录（录音/问卷/笔记）在哪？', '哪些信息涉及商业机密？'],
    '一条调研资料卡：对象、方式、样本、原始文件与密级。'],

  ['consult.diagnosis_framework', '问题诊断框架', '咨询与专业服务', 'research',
    '把客户问题拆成结构化假设树，定位关键矛盾',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['问题表象与业务目标分别是什么？', '拆成了哪几层假设？', '每一层有什么证据支持/反驳？', '最关键的待验证分支是哪个？'],
    '一张诊断框架：问题树、证据状态与优先验证分支。'],

  ['consult.deliverable_archive', '交付方案归档', '咨询与专业服务', 'apply',
    '把最终交付方案按版本归档，保留验收与授权信息',
    '08_作品与成果', 'tpl-atom-card.md', 'DOC',
    ['交付对象与范围？', '版本号与关键修改？', '验收标准与客户反馈？', '方案中的方法与数据可否复用？'],
    '一条交付记录：范围、版本、验收结果与可复用资产说明。'],

  ['consult.project_review', '项目结案复盘', '咨询与专业服务', 'review',
    '项目结案时对照目标与结果，沉淀可复用打法',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['项目目标、周期与决策编号？', '实际交付与客户评价？', '偏差来自方案、执行还是客户环境？', '下次同类项目要改什么？'],
    '一份结案复盘：目标 vs 结果、偏差归因、可复用打法与改进项。'],

  // ---------------------------------------------------------------- 教育与培训 edu（4）
  ['edu.learner_feedback', '学员反馈入柜', '教育与培训', 'capture',
    '把学员的反馈、作业与课堂观察原样归档',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['学员背景与学习阶段？', '反馈来自问卷、作业还是课堂观察？', '原话与典型错误是什么？', '是否涉及未成年人/隐私信息？'],
    '一条学员反馈卡：背景、来源、原话/错题与隐私处理说明。'],

  ['edu.learning_analysis', '学习效果分析', '教育与培训', 'research',
    '分析学习数据与反馈，判断教学是否真的有效',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['样本学员、周期与测评口径？', '前后测数据与对照？', '进步集中在哪些知识点？', '哪些结果可能是练习效应或家长干预？'],
    '一份效果分析：口径、前后对比、归因与混杂因素说明。'],

  ['edu.pedagogy_hypothesis', '教学法假设卡', '教育与培训', 'hypothesis',
    '把某种教学方法的有效性写成可测试假设',
    '04_思考与假设', 'tpl-hypothesis-card.md', 'H',
    ['针对哪类学员与知识点？', '预期提升的指标？', '对照班/对照期怎么设？', '什么结果说明方法无效？'],
    '一张教学假设卡：对象、指标、对照设计与否证条件。'],

  ['edu.course_review', '课程迭代复盘', '教育与培训', 'review',
    '一期课程结束后，复盘内容、节奏与交付效果',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['本期课程目标与设计决策？', '完课率、测评与满意度数据？', '哪一讲/哪类练习问题最大？', '下一期具体改哪三件事？'],
    '一份课程复盘：数据结果、问题定位与下一期改动清单。'],

  // ---------------------------------------------------------------- 投资与研究 invest（4）
  ['invest.target_material', '标的资料入柜', '投资与研究', 'capture',
    '把标的公开资料与调研记录原样归档，保留时间戳',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['标的名称、代码与资料来源？', '资料截止时间与版本？', '关键财务/经营数据摘录？', '哪些数字需要交叉核验？'],
    '一条标的资料卡：来源、时间戳、关键数据摘录与待核验项。'],

  ['invest.industry_analysis', '行业与标的研判', '投资与研究', 'research',
    '综合行业数据与标的资料，形成带证据的研判',
    '03_研究与洞察', 'tpl-research-report.md', 'S',
    ['用了哪些资料编号与时间范围？', '行业驱动因素与竞争格局？', '标的的相对位置与风险？', '哪些结论证据不足？'],
    '一份研判报告：驱动因素、竞争格局、标的定位与证据缺口。'],

  ['invest.investment_decision', '投资决策记录', '投资与研究', 'apply',
    '记录投资决策的依据、估值假设与退出条件',
    '10_决策与复盘', 'tpl-decision-log.md', 'D',
    ['决策标的、金额与时间？', '核心估值假设是什么？', '最坏情况与止损条件？', '哪些依据来自外部未核实信息？'],
    '一份决策记录：估值假设、风险/止损、依据编号与不确定性标注。'],

  ['invest.post_invest_review', '投后复盘', '投资与研究', 'review',
    '对照投资假设与实际经营，判断哪些判断被验证',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['当初的决策编号与核心假设？', '实际经营数据与预期差？', '差异来自行业、团队还是估值？', '下一笔投资要修正什么？'],
    '一份投后复盘：假设对照、偏差归因与下一笔的修正规则。'],

  // ---------------------------------------------------------------- 职场通用 work（4）
  ['work.meeting_notes', '会议纪要入柜', '职场通用', 'capture',
    '把会议内容整理成可追溯的纪要与承诺清单',
    '02_原始资料库', 'tpl-source-card.md', 'R',
    ['会议主题、时间与参会人？', '每个议题的结论是什么？', '谁承诺了什么、截止时间？', '哪些是讨论、哪些是决定？'],
    '一份会议纪要：议题、结论、待办（负责人+截止）与决定清单。'],

  ['work.method_digest', '工作方法提炼', '职场通用', 'distill',
    '把重复用到的工作方法固化成可教可复用的步骤',
    '06_知识与模型', 'tpl-knowledge-card.md', 'K',
    ['这套方法在哪些任务上用过？', '关键步骤与判断点是什么？', '适用条件与失效场景？', '有没有更省力的替代？'],
    '一张方法卡：步骤、判断点、适用条件与反例。'],

  ['work.cycle_review', '周期复盘', '职场通用', 'review',
    '按周/月/季复盘目标完成度与时间分配',
    '10_决策与复盘', 'tpl-retro.md', 'RT',
    ['本周期目标与关键结果？', '实际完成度与时间去向？', '偏差来自计划还是执行？', '下周期保留/砍掉/新增什么？'],
    '一份周期复盘：目标 vs 实际、时间分配、经验与下周期计划。'],

  ['work.decision_log', '重要决定记录', '职场通用', 'apply',
    '记录影响较大的决定，保留当时的依据与预期',
    '10_决策与复盘', 'tpl-decision-log.md', 'D',
    ['决定是什么、影响范围多大？', '当时有哪些备选项？', '依据哪些事实/假设？', '预期结果与复查时间？'],
    '一条决策记录：备选项、依据、预期结果与复查时间点。'],
];

export const SKILLS = Object.freeze(ROWS.map((row) => Object.freeze({
  id: row[0],
  name: row[1],
  profession: row[2],
  stage: row[3],
  purpose: row[4],
  outputDir: row[5],
  template: row[6],
  idPrefix: row[7],
  requiredFields: REQUIRED_FIELDS,
  confidenceRule: CONFIDENCE_RULE,
  questions: Object.freeze([...row[8]]),
  outputHints: row[9],
})));

export const byId = new Map(SKILLS.map((s) => [s.id, s]));

export function byProfession(profession) {
  return SKILLS.filter((s) => s.profession === profession);
}

export function byStage(stage) {
  return SKILLS.filter((s) => s.stage === stage);
}

export function listProfessions() {
  return PROFESSIONS.map((p) => ({ profession: p, count: byProfession(p).length }));
}

/**
 * 校验目录数据（默认校验内置 SKILLS；测试可传入坏数据）。
 * @returns {{ ok:boolean, errors:{code:string, skillId?:string, message:string}[] }}
 */
export function validateCatalog(skills = SKILLS) {
  const errors = [];
  const push = (code, message, skillId) => errors.push({ code, message, ...(skillId ? { skillId } : {}) });
  if (!Array.isArray(skills)) {
    push('CATALOG_NOT_ARRAY', '技能目录必须是数组');
    return { ok: false, errors };
  }
  const seen = new Set();
  for (const s of skills) {
    if (!s || typeof s !== 'object') {
      push('SKILL_NOT_OBJECT', '技能条目必须是对象');
      continue;
    }
    const id = typeof s.id === 'string' ? s.id : '';
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(id)) push('ID_FORMAT', `id 格式应为「岗位缩写.蛇形技能名」：${JSON.stringify(s.id)}`, id);
    if (seen.has(id)) push('ID_DUPLICATE', `id 重复：${id}`, id);
    seen.add(id);
    if (typeof s.name !== 'string' || !s.name.trim()) push('NAME_EMPTY', 'name 不能为空', id);
    if (!PROFESSIONS.includes(s.profession)) push('PROFESSION_INVALID', `profession 非法：${JSON.stringify(s.profession)}`, id);
    if (!STAGES.includes(s.stage)) push('STAGE_INVALID', `stage 非法：${JSON.stringify(s.stage)}`, id);
    if (typeof s.purpose !== 'string' || !s.purpose.trim()) push('PURPOSE_EMPTY', 'purpose 不能为空', id);
    if (!OUTPUT_DIRS.includes(s.outputDir)) push('OUTPUT_DIR_INVALID', `outputDir 不在 13 目录内：${JSON.stringify(s.outputDir)}`, id);
    else if (FORBIDDEN_OUTPUT_DIRS.includes(s.outputDir)) push('OUTPUT_DIR_FORBIDDEN', `outputDir 不得是 00_系统与索引：${s.outputDir}`, id);
    if (s.stage === 'capture') {
      const expected = id === QUICK_CAPTURE_ID ? QUICK_CAPTURE_OUTPUT_DIR : CAPTURE_OUTPUT_DIR;
      if (s.outputDir !== expected) {
        push(
          id === QUICK_CAPTURE_ID ? 'QUICK_CAPTURE_DIR_INVALID' : 'CAPTURE_DIR_INVALID',
          `capture 阶段应落 ${expected}，实际 ${JSON.stringify(s.outputDir)}`,
          id,
        );
      }
    }
    if (s.template !== null && !TEMPLATE_NAMES.includes(s.template)) push('TEMPLATE_MISSING', `模板不存在：${JSON.stringify(s.template)}`, id);
    if (!ID_PREFIXES.includes(s.idPrefix)) push('PREFIX_INVALID', `idPrefix 非法：${JSON.stringify(s.idPrefix)}`, id);
    if (!Array.isArray(s.requiredFields)) push('FIELDS_INVALID', 'requiredFields 必须是数组', id);
    else {
      for (const f of REQUIRED_FIELDS) {
        if (!s.requiredFields.includes(f)) push('FIELD_MISSING', `requiredFields 缺 ${f}`, id);
      }
    }
    if (!s.confidenceRule || !Array.isArray(s.confidenceRule.levels)
      || s.confidenceRule.levels.join(',') !== CONFIDENCE_RULE.levels.join(',')
      || s.confidenceRule.lowRequiresReason !== true) {
      push('CONFIDENCE_RULE_INVALID', 'confidenceRule 必须是 {levels:高/中/低, lowRequiresReason:true}', id);
    }
    if (!Array.isArray(s.questions) || s.questions.length < 3 || s.questions.length > 6) {
      push('QUESTIONS_COUNT', `questions 必须是 3-6 条，实际 ${Array.isArray(s.questions) ? s.questions.length : '非数组'}`, id);
    } else if (s.questions.some((q) => typeof q !== 'string' || !q.trim())) {
      push('QUESTIONS_EMPTY', 'questions 不能含空字符串', id);
    }
    if (typeof s.outputHints !== 'string' || !s.outputHints.trim()) push('OUTPUT_HINTS_EMPTY', 'outputHints 不能为空', id);
  }
  return { ok: errors.length === 0, errors };
}
