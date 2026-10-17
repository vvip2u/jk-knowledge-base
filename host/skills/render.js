/**
 * 技能渲染（纯函数，无 I/O、无时间戳、无随机数）。
 *
 * 输出只依赖入参 -> 同输入必得同输出，便于单测与缓存。
 * 提示词里的 INTERNAL_SKILLS_ONLY 固定标识串是给宿主/测试的可执行断言：
 * 内容生成类能力只从知识库内部 SKILL 找，禁止检索外部 DSH 技能目录。
 */
export const INTERNAL_SKILLS_ONLY = 'INTERNAL_SKILLS_ONLY';

const STAGE_LABELS = {
  capture: '捕获入库',
  research: '研究加工',
  hypothesis: '提出假设',
  verify: '验证取证',
  distill: '沉淀知识',
  apply: '应用交付',
  review: '复盘迭代',
};

const CONFIDENCE_RULE_LINE = '置信度只能取「高 / 中 / 低」；低档必须填 conf_why，且 status 不得为 active；升档必须有新证据编号。';

/** UI 列表一行摘要（单行、限长 120）。 */
export function renderSkillBrief(skill) {
  if (!skill || typeof skill !== 'object') return '';
  const raw = [
    skill.name,
    `${skill.profession}/${STAGE_LABELS[skill.stage] || skill.stage}`,
    skill.outputDir,
    skill.idPrefix,
    skill.purpose,
  ].filter(Boolean).join('｜');
  return raw.length <= 120 ? raw : `${raw.slice(0, 119)}…`;
}

/**
 * 给 agent 的提示词片段。
 * @param {object} skill 目录条目
 * @param {string} [inputHint] 用户这次给的输入提示（可为空）
 */
export function renderSkillPrompt(skill, inputHint = '') {
  if (!skill || typeof skill !== 'object') {
    throw new TypeError('renderSkillPrompt 需要一条技能定义');
  }
  const stage = STAGE_LABELS[skill.stage] || skill.stage;
  const hint = typeof inputHint === 'string' && inputHint.trim() ? inputHint.trim() : '（未提供，先向用户确认输入材料）';
  const questions = Array.isArray(skill.questions) ? skill.questions : [];
  const fields = Array.isArray(skill.requiredFields) ? skill.requiredFields : [];
  const template = skill.template || '（无模板：按下方输出结构自由组织，但必须保留 frontmatter 必填字段）';

  return [
    `[${INTERNAL_SKILLS_ONLY}] 只使用 JK知识库内置技能目录：不得检索外部技能，也不得调用 ~/.dsh/skills、~/.agents/skills、~/.workbuddy/skills 或任何外部技能市场。`,
    '',
    `# 任务：${skill.name}（${skill.profession} · ${stage}）`,
    `用途：${skill.purpose}`,
    `本次输入：${hint}`,
    '',
    '## 先问清 / 先提取的信息',
    ...(questions.length ? questions.map((q, i) => `${i + 1}. ${q}`) : ['1. （技能未提供问题清单，先确认输入与目标）']),
    '',
    '## 必填元数据（缺一不可）',
    `frontmatter 至少包含：${fields.join('、')}；另加 l1 / l2 / l3 三层标签与 confidence 相关字段。`,
    '取值约束：status ∈ draft/review/active/deprecated；confidentiality ∈ public/internal/restricted/confidential。',
    '',
    '## 输出结构',
    `按模板 ${template} 的段落组织；产出形态：${skill.outputHints}`,
    '正文必须自包含：不写「如上文所述」「同上」，每个结论都写清主语、条件与验证方式。',
    '',
    '## 置信度规则',
    CONFIDENCE_RULE_LINE,
    '',
    '## 落位与编号',
    `- 落位目录：${skill.outputDir}/（写入前先确认目录存在；不覆盖任何已存在文件）`,
    `- 编号前缀：${skill.idPrefix}（格式 ${skill.idPrefix}-<四位年>-<三位序号>，全库唯一、不回收）`,
    '- 文件名：对象-动作-结果.md，不用空格，禁用 \\ / : * ? " < > |',
    '',
    '## 禁止事项',
    '- 不得把生成内容写进 00_系统与索引（系统层由建库引擎负责）；01/02 只用于 capture 阶段入柜。',
    '- 不得改写已有笔记；需要修订时新建版本并保留原编号。',
    '- 不得检索外部技能或外部知识库来补齐内容。',
  ].join('\n');
}
