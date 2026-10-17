/**
 * SKILL 页面渲染与归档（引擎侧，纯函数 + 一次受守卫的写盘）。
 *
 * - renderSkillPage：把一条 SKILL 记录渲染成库内页面（11_岗位技能库/<岗位>/<id>-<slug>.md）；
 * - archiveSkillPage：把旧版本写到 12_归档与历史/03_历史版本/，头部必须含归档四要素。
 *
 * 写盘统一走 assertPathLength + assertWritable + 原子替换；标题一律用真实 id/name，
 * 不沿用任何模板占位。
 */
import path from 'node:path';
import { EngineError } from './errors.js';
import { assertWritable } from './guard.js';
import { assertPathLength, ensureDir, safeJoin, sanitizeRelPath, sanitizeSegment, today, writeAtomic } from './paths.js';

export const SKILLPAGE_VERSION = 1;
export const SKILL_PAGE_ROOT = '11_岗位技能库';
export const SKILL_ARCHIVE_ROOT = path.join('12_归档与历史', '03_历史版本');

function yamlString(value) {
  return `"${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

function asDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return today(input);
  if (typeof input === 'string' && input.trim()) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return today(d);
  }
  return today(new Date());
}

function slugOf(name) {
  const base = sanitizeSegment(String(name).trim().replace(/\s+/g, '-'));
  return sanitizeSegment(Array.from(base).slice(0, 40).join('')) || 'skill';
}

function requireSkill(skill) {
  if (!skill || typeof skill !== 'object') throw new EngineError('INVALID_SKILL', 'skill 必须是对象');
  const id = String(skill.id || '').trim();
  const name = String(skill.name || '').trim();
  if (!id || !name) throw new EngineError('INVALID_SKILL', 'skill.id 与 skill.name 必填');
  const version = String(skill.version || '1.0.0').trim() || '1.0.0';
  (skill.keywords || []).forEach((k) => {
    if (typeof k !== 'string' || !k.trim()) throw new EngineError('INVALID_SKILL', 'keywords 必须是非空字符串数组');
  });
  (skill.fields || []).forEach((f) => {
    if (typeof f !== 'string' || !f.trim()) throw new EngineError('INVALID_SKILL', 'fields 必须是非空字符串数组');
  });
  return {
    id,
    name,
    version,
    profession: String(skill.profession || '通用').trim() || '通用',
    purpose: String(skill.purpose || '').trim(),
    scenario: String(skill.scenario || '').trim(),
    keywords: (skill.keywords || []).map((k) => String(k).trim()),
    fields: (skill.fields || []).map((f) => String(f).trim()),
  };
}

/**
 * @param {{skill:object, now?:Date|string}} args
 * @returns {{relPath:string, content:string, version:string}}
 */
export function renderSkillPage({ skill, now } = {}) {
  const s = requireSkill(skill);
  const date = asDate(now);
  const relPath = sanitizeRelPath(path.join(SKILL_PAGE_ROOT, sanitizeSegment(s.profession), `${s.id}-${slugOf(s.name)}.md`));

  const lines = [
    '---',
    `id: ${s.id}`,
    `name: ${yamlString(s.name)}`,
    `version: ${s.version}`,
    'status: active',
    `keywords: [${s.keywords.map(yamlString).join(', ')}]`,
    `fields: [${s.fields.map(yamlString).join(', ')}]`,
    `created: ${date}`,
    `updated: ${date}`,
    '---',
    '',
    `# ${s.id} · ${s.name}`,
    '',
    '## 用途',
    '',
    s.purpose || '（待补：这条 SKILL 解决什么问题）',
    '',
    '## 适用场景',
    '',
    s.scenario || '（待补：什么时候该用它）',
    '',
    '## 关键词',
    '',
    ...(s.keywords.length ? s.keywords.map((k) => `- ${k}`) : ['- （待补）']),
    '',
    '## 记录字段',
    '',
    ...(s.fields.length ? s.fields.map((f) => `- ${f}`) : ['- （待补）']),
    '',
    '## 调用方式',
    '',
    `在知识库面板或通过 jk_kb_skill_run({ skillId: "${s.id}", task, result, outputs }) 调用；`,
    '产出只允许落在 03–12 业务目录，且不得覆盖已有文件。',
    '',
    '## 变更记录',
    '',
    `- ${date} v${s.version} 创建`,
    '',
  ];
  return { relPath, content: lines.join('\n'), version: s.version };
}

/**
 * 归档旧版本页面到 12_归档与历史/03_历史版本/，头部含归档四要素。
 * @returns {Promise<{archivedPath:string, relPath:string, content:string}>}
 */
export async function archiveSkillPage({ root, skill, reason, nextVersionLink, now } = {}) {
  const s = requireSkill(skill);
  const date = asDate(now);
  const page = renderSkillPage({ skill: s, now });
  const archivedRel = sanitizeRelPath(
    path.join(SKILL_ARCHIVE_ROOT, `${s.id}-${s.version}-${slugOf(s.name)}.md`),
  );
  const original = page.relPath;
  const successor = String(nextVersionLink || '').trim() || '（待补）';
  const why = String(reason || '').trim() || '（未填写归档原因）';

  const content = [
    '---',
    `id: ${s.id}`,
    `name: ${yamlString(s.name)}`,
    `version: ${s.version}`,
    'status: archived',
    `archived_from: ${yamlString(original)}`,
    `archived_at: ${date}`,
    `archived_reason: ${yamlString(why)}`,
    `successor: ${yamlString(successor)}`,
    `created: ${date}`,
    `updated: ${date}`,
    '---',
    '',
    `> 原始位置：${original}`,
    `> 归档时间：${date}`,
    `> 归档原因：${why}`,
    `> 继任版本链接：${successor}`,
    '',
    `# ${s.id} · ${s.name}（v${s.version} 归档）`,
    '',
    '## 用途',
    '',
    s.purpose || '（待补：这条 SKILL 解决什么问题）',
    '',
    '## 归档说明',
    '',
    '本页是历史版本快照，不再维护；新版本见上方「继任版本链接」。',
    '',
  ].join('\n');

  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new EngineError('INVALID_ROOT', 'root 必须是已存在的绝对路径');
  }
  const rootAbs = path.resolve(root);
  assertPathLength(rootAbs, archivedRel);
  const target = safeJoin(rootAbs, archivedRel);
  await ensureDir(rootAbs, path.dirname(target));
  await assertWritable(rootAbs, target);
  await writeAtomic(target, content, { force: false, root: rootAbs });
  return { archivedPath: target, relPath: archivedRel, content };
}
