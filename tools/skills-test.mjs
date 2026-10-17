#!/usr/bin/env node
/**
 * 内置技能目录测试：node:test + node:assert/strict，直接运行即可。
 *
 * 重点断言之一：这些技能**只服务知识库内部**。renderSkillPrompt 必须带
 * INTERNAL_SKILLS_ONLY 固定串并明确「不得检索外部技能」，防止运行时去检索
 * ~/.dsh/skills 等外部目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_OUTPUT_DIR,
  CONFIDENCE_RULE,
  FORBIDDEN_OUTPUT_DIRS,
  QUICK_CAPTURE_ID,
  QUICK_CAPTURE_OUTPUT_DIR,
  ID_PREFIXES,
  OUTPUT_DIRS,
  PROFESSIONS,
  REQUIRED_FIELDS,
  SKILLS,
  STAGES,
  TEMPLATE_NAMES,
  byId,
  byProfession,
  byStage,
  listProfessions,
  validateCatalog,
} from '../host/skills/catalog.js';
import { INTERNAL_SKILLS_ONLY, renderSkillBrief, renderSkillPrompt } from '../host/skills/render.js';

const PROFESSION_NAMES = [
  '创业与经营', '销售与商务', '市场与内容', '产品经理', '研发与技术',
  '设计与创意', '咨询与专业服务', '教育与培训', '投资与研究', '职场通用',
];

console.log(`[skills-test] platform=${process.platform} skills=${SKILLS.length}`);

test('1. 47 条技能，id 全局唯一，validateCatalog 通过', () => {
  assert.equal(SKILLS.length, 47);
  const ids = SKILLS.map((s) => s.id);
  assert.equal(new Set(ids).size, 47);
  const r = validateCatalog();
  assert.equal(r.ok, true, JSON.stringify(r.errors.slice(0, 3)));
  assert.deepEqual(r.errors, []);
  assert.equal(byId.size, 47);
  for (const s of SKILLS) {
    assert.equal(byId.get(s.id), s);
    assert.match(s.id, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
  }
});

test('2. 10 个岗位各 4 条 + common 7 条', () => {
  assert.equal(PROFESSIONS.length, 11);
  for (const p of PROFESSION_NAMES) {
    assert.equal(byProfession(p).length, 4, `${p} 应有 4 条`);
  }
  assert.equal(byProfession('common').length, 7);
  assert.deepEqual(byProfession('不存在的岗位'), []);
  const listed = listProfessions();
  assert.equal(listed.length, 11);
  assert.equal(listed.reduce((n, x) => n + x.count, 0), 47);
  assert.deepEqual(listed.filter((x) => x.profession === 'common'), [{ profession: 'common', count: 7 }]);
});

test('3. outputDir 全部在 13 目录内，且没有任何一条落在 00_系统与索引', () => {
  assert.equal(OUTPUT_DIRS.length, 13);
  assert.deepEqual([...FORBIDDEN_OUTPUT_DIRS], ['00_系统与索引']);
  let zero = 0;
  for (const s of SKILLS) {
    assert.ok(OUTPUT_DIRS.includes(s.outputDir), `${s.id} 的 outputDir 非法：${s.outputDir}`);
    if (s.outputDir === '00_系统与索引') zero += 1;
  }
  assert.equal(zero, 0, 'outputDir 为 00_系统与索引 的技能数必须为 0');
});

test('4. idPrefix 都在枚举内（含 DOC / SK）', () => {
  assert.ok(ID_PREFIXES.includes('DOC'));
  assert.ok(ID_PREFIXES.includes('SK'));
  for (const s of SKILLS) {
    assert.ok(ID_PREFIXES.includes(s.idPrefix), `${s.id} 的 idPrefix 非法：${s.idPrefix}`);
  }
});

test('5. requiredFields 覆盖四位必填', () => {
  for (const s of SKILLS) {
    for (const f of ['title', 'date', 'tags', 'confidence']) {
      assert.ok(s.requiredFields.includes(f), `${s.id} 缺 ${f}`);
    }
    assert.equal(s.confidenceRule.levels.join('/'), '高/中/低');
    assert.equal(s.confidenceRule.lowRequiresReason, true);
  }
  assert.deepEqual([...REQUIRED_FIELDS], ['title', 'date', 'tags', 'confidence']);
});

test('6. questions 为 3-6 条且都是非空字符串', () => {
  for (const s of SKILLS) {
    assert.ok(s.questions.length >= 3 && s.questions.length <= 6, `${s.id} 有 ${s.questions.length} 个问题`);
    for (const q of s.questions) {
      assert.equal(typeof q, 'string');
      assert.ok(q.trim().length > 0);
    }
  }
});

test('7. stage 合法，模板存在或显式为 null', () => {
  for (const s of SKILLS) {
    assert.ok(STAGES.includes(s.stage), `${s.id} 的 stage 非法：${s.stage}`);
    if (s.template !== null) {
      assert.ok(TEMPLATE_NAMES.includes(s.template), `${s.id} 的模板不存在：${s.template}`);
      assert.match(s.template, /^tpl-.*\.md$/);
    }
  }
});

test('8. renderSkillPrompt 含 INTERNAL_SKILLS_ONLY 与四类关键约束', () => {
  for (const s of SKILLS) {
    const p = renderSkillPrompt(s, '用户给的一段素材');
    assert.ok(p.includes(INTERNAL_SKILLS_ONLY), `${s.id} 缺内部技能标识串`);
    assert.ok(p.includes('不得检索外部技能'), `${s.id} 缺禁止检索外部技能声明`);
    assert.ok(p.includes(s.outputDir), `${s.id} 缺落位目录`);
    assert.ok(p.includes(s.idPrefix), `${s.id} 缺编号前缀`);
    assert.ok(p.includes('置信度'), `${s.id} 缺置信度规则`);
    assert.ok(p.includes(s.template), `${s.id} 缺模板名`);
    for (const q of s.questions) assert.ok(p.includes(q), `${s.id} 缺问题：${q}`);
    assert.ok(p.includes('用户给的一段素材'));
    // 明确不许去外部目录
    assert.ok(p.includes('~/.dsh/skills'));
  }
});

test('9. renderSkillPrompt 未给输入时有兜底，且不抛错', () => {
  const s = SKILLS[0];
  assert.ok(renderSkillPrompt(s).includes('未提供'));
  assert.throws(() => renderSkillPrompt(null), TypeError);
});

test('10. renderSkillBrief 单行且不超过 120 字', () => {
  for (const s of SKILLS) {
    const b = renderSkillBrief(s);
    assert.equal(typeof b, 'string');
    assert.ok(b.length > 0 && b.length <= 120, `${s.id} 摘要 ${b.length} 字`);
    assert.ok(!b.includes('\n'));
    assert.ok(b.includes(s.name));
    assert.ok(b.includes(s.outputDir));
  }
  assert.equal(renderSkillBrief(null), '');
});

test('11. byProfession / byStage 过滤正确，阶段计数合计 47', () => {
  const expected = {
    capture: 11, research: 10, hypothesis: 5, verify: 2, distill: 5, apply: 6, review: 8,
  };
  let total = 0;
  for (const stage of STAGES) {
    const rows = byStage(stage);
    assert.equal(rows.length, expected[stage], `${stage} 数量不符`);
    assert.ok(rows.every((s) => s.stage === stage));
    total += rows.length;
  }
  assert.equal(total, 47);
  assert.deepEqual(byStage('nope'), []);
});

test('12. outputDir 分布符合阶段映射（08/10 按交付/决策拆分）', () => {
  const counts = {};
  for (const s of SKILLS) counts[s.outputDir] = (counts[s.outputDir] || 0) + 1;
  assert.deepEqual(counts, {
    '01_收件箱': 1,
    '02_原始资料库': 10,
    '03_研究与洞察': 10,
    '04_思考与假设': 5,
    '05_验证与证据': 2,
    '06_知识与模型': 5,
    '08_作品与成果': 3,
    '10_决策与复盘': 11,
  });
});

test('13. validateCatalog 能对坏数据报错（重复 id / 非法目录 / 非法前缀 / 缺字段 / 问题数）', () => {
  const good = SKILLS[0];
  const clones = [good, { ...good }];
  const r1 = validateCatalog(clones);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'ID_DUPLICATE'));

  const badDir = [{ ...good, id: 'x.bad_dir', outputDir: '00_系统与索引' }];
  const r2 = validateCatalog(badDir);
  assert.ok(r2.errors.some((e) => e.code === 'OUTPUT_DIR_FORBIDDEN'));

  const missingDir = [{ ...good, id: 'x.missing_dir', outputDir: '不存在目录' }];
  assert.ok(validateCatalog(missingDir).errors.some((e) => e.code === 'OUTPUT_DIR_INVALID'));

  const badPrefix = [{ ...good, id: 'x.bad_prefix', idPrefix: 'ZZ' }];
  assert.ok(validateCatalog(badPrefix).errors.some((e) => e.code === 'PREFIX_INVALID'));

  const badFields = [{ ...good, id: 'x.bad_fields', requiredFields: ['title'] }];
  assert.ok(validateCatalog(badFields).errors.some((e) => e.code === 'FIELD_MISSING'));

  const badQuestions = [{ ...good, id: 'x.bad_q', questions: ['只有一个'] }];
  assert.ok(validateCatalog(badQuestions).errors.some((e) => e.code === 'QUESTIONS_COUNT'));

  const captureSkill = SKILLS.find((x) => x.stage === 'capture' && x.id !== QUICK_CAPTURE_ID);
  const badCapture = [{ ...captureSkill, id: 'x.capture_bad', outputDir: '03_研究与洞察' }];
  assert.ok(validateCatalog(badCapture).errors.some((e) => e.code === 'CAPTURE_DIR_INVALID'));

  const quick = byId.get(QUICK_CAPTURE_ID);
  const badQuick = [{ ...quick, outputDir: CAPTURE_OUTPUT_DIR }];
  assert.ok(validateCatalog(badQuick).errors.some((e) => e.code === 'QUICK_CAPTURE_DIR_INVALID'));

  assert.equal(validateCatalog('not-array').ok, false);
});

test('14. 渲染是纯函数：同输入同输出，且不改动技能定义', () => {
  const s = SKILLS[5];
  const snapshot = JSON.stringify(s);
  const a = renderSkillPrompt(s, '同一段输入');
  const b = renderSkillPrompt(s, '同一段输入');
  assert.equal(a, b);
  assert.equal(JSON.stringify(s), snapshot);
  assert.notEqual(renderSkillPrompt(s, '另一段输入'), a);
  assert.equal(CONFIDENCE_RULE.levels.join(','), '高,中,低');
});

test('15. capture 阶段落位：快速收件卡进 01，其余 10 条全部进 02', () => {
  const captures = SKILLS.filter((s) => s.stage === 'capture');
  assert.equal(captures.length, 11);

  const quick = byId.get(QUICK_CAPTURE_ID);
  assert.ok(quick, '缺少快速收件卡');
  assert.equal(quick.outputDir, QUICK_CAPTURE_OUTPUT_DIR);
  assert.equal(quick.outputDir, '01_收件箱');

  const others = captures.filter((s) => s.id !== QUICK_CAPTURE_ID);
  assert.equal(others.length, 10);
  for (const s of others) {
    assert.equal(s.outputDir, CAPTURE_OUTPUT_DIR, `${s.id} 应落 ${CAPTURE_OUTPUT_DIR}`);
    assert.equal(s.outputDir, '02_原始资料库');
  }
  // 入柜目标不在禁止名单里
  assert.ok(!FORBIDDEN_OUTPUT_DIRS.includes(CAPTURE_OUTPUT_DIR));
  assert.ok(!FORBIDDEN_OUTPUT_DIRS.includes(QUICK_CAPTURE_OUTPUT_DIR));
});

test('16. DOC 前缀：枚举已加入，且至少一条技能使用', () => {
  assert.ok(ID_PREFIXES.includes('DOC'));
  const docSkills = SKILLS.filter((s) => s.idPrefix === 'DOC');
  assert.ok(docSkills.length >= 1, '至少应有一条 DOC 前缀技能');
  const names = docSkills.map((s) => s.id).sort();
  assert.deepEqual(names, [
    'common.output_archive',
    'common.quick_capture',
    'consult.deliverable_archive',
    'design.work_archive',
  ]);
  // 原始资料卡仍用 R
  assert.equal(byId.get('biz.customer_interview').idPrefix, 'R');
});
