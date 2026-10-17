/**
 * 入柜引擎（curate）：把一份内容按技能定义写成知识库里的正式卡片。
 *
 * 分工：
 * - 引擎只做「校验 → 渲染 → 落盘」，**不读计数器、不加锁**；id 由宿主注入（nextId）；
 * - 技能定义只读引用 host/skills/catalog.js（不复制、不检索外部技能目录）；
 * - 写入统一走 assertWritable + assertPathLength + 原子替换。
 *
 * onStep key 序列：validate → allocate → render → write → record。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError } from './errors.js';
import { assertWritable } from './guard.js';
import { assertPathLength, ensureDir, safeJoin, sanitizeRelPath, sanitizeSegment, today, writeAtomic } from './paths.js';
import { readTemplateSource } from './presets.js';
import { byId } from '../skills/catalog.js';
import { parseFrontmatter, stripBom } from './scan.js';

export const CURATE_VERSION = 1;
export const CURATE_CODES = Object.freeze({
  UNKNOWN_SKILL: 'UNKNOWN_SKILL',
  CONFIDENCE_REQUIRED: 'CONFIDENCE_REQUIRED',
  TAGS_REQUIRED: 'TAGS_REQUIRED',
  TITLE_INVALID: 'TITLE_INVALID',
  BODY_REQUIRED: 'BODY_REQUIRED',
  NEXT_ID_REQUIRED: 'NEXT_ID_REQUIRED',
  ID_CONFLICT: 'ID_CONFLICT',
  OUTPUT_DIR_FORBIDDEN: 'OUTPUT_DIR_FORBIDDEN',
});

const CONFIDENCE_LEVELS = ['高', '中', '低'];
const TITLE_MAX = 120;
const SLUG_MAX = 40;

function yamlString(value) {
  return `"${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

/** slug 只经 sanitizeSegment：空白折叠成 -，再按 40 字符截断。 */
function slugify(title) {
  const base = sanitizeSegment(String(title).trim().replace(/\s+/g, '-'));
  const cut = Array.from(base).slice(0, SLUG_MAX).join('');
  return sanitizeSegment(cut) || 'card';
}

function asDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return today(input);
  if (typeof input === 'string' && input.trim()) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return today(d);
  }
  return today(new Date());
}

const TITLE_PLACEHOLDER_RE = /〈待填：[^〉]*〉|@@[A-Z0-9_]+@@/g;

/**
 * 统一生成真实一级标题：`# <id> · <title>`。
 * 模板的首个一级标题只用来定位（有则整行替换、无则补一行），**绝不沿用模板里的占位编号**
 * （如 `# R-2026-001 · 资料主题`），否则落盘卡片会出现与 frontmatter 不一致的假编号。
 * 标题行里的 〈待填：…〉 / @@KEY@@ 占位一并清掉；正文不受影响。
 */
export function renderHeading(id, title) {
  const clean = (v) => String(v == null ? '' : v).replace(TITLE_PLACEHOLDER_RE, '').trim();
  return `# ${clean(id)} · ${clean(title)}`;
}

const MISSING_LINE = '> ⚠ 本节未填写';

function normalizeHeadingName(text) {
  return String(text || '').normalize('NFKC').replace(/[\s\u3000]+/g, '').toLowerCase();
}

/** 模板的二级标题与提示文字。 */
export function parseTemplateSections(templateText) {
  const sections = [];
  let cur = null;
  for (const line of String(templateText || '').split(/\r?\n/)) {
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      cur = { heading: h2[1].trim(), hint: [] };
      sections.push(cur);
      continue;
    }
    if (/^#\s+/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) cur.hint.push(line);
  }
  return sections.map((x) => ({ heading: x.heading, hint: x.hint.join('\n').trim() }));
}

function parseAgentSections(bodyText) {
  const sections = [];
  const preamble = [];
  let cur = null;
  for (const line of String(bodyText || '').split(/\r?\n/)) {
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      cur = { heading: h2[1].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  return {
    sections: sections.map((x) => ({ heading: x.heading, content: x.lines.join('\n').trim() })),
    preamble: preamble.join('\n').trim(),
  };
}

/**
 * 按模板骨架组卡：匹配到的节用 agent 内容；缺的节只写「本节未填写」，绝不编造；
 * 多余的节追加到末尾的「## 补充」。返回 { text, warnings:[{code:'SECTION_MISSING',section,message}] }。
 */
export function renderSkeleton(templateText, bodyText) {
  const tplSections = parseTemplateSections(templateText);
  const agent = parseAgentSections(bodyText);
  const warnings = [];
  const blocks = [];
  const agentMap = new Map();
  for (const sec of agent.sections) {
    const key = normalizeHeadingName(sec.heading);
    if (!agentMap.has(key)) agentMap.set(key, { ...sec });
    else agentMap.get(key).content += `\n\n${sec.content}`;
  }

  if (!tplSections.length) {
    const text = String(bodyText || '').trim();
    if (!text) warnings.push({ code: 'SECTION_MISSING', section: '正文', message: '模板没有二级标题，正文也为空' });
    return { text: `## 正文\n\n${text || MISSING_LINE}`, warnings };
  }

  if (agent.sections.length === 0) {
    // 没有二级标题：整段进第一个内容节，其余节标缺
    tplSections.forEach((sec, i) => {
      const content = i === 0 ? String(bodyText || '').trim() : '';
      if (i === 0 && content) {
        blocks.push(`## ${sec.heading}\n\n${content}`);
      } else {
        blocks.push(`## ${sec.heading}\n\n${MISSING_LINE}`);
        warnings.push({ code: 'SECTION_MISSING', section: sec.heading, message: `模板节「${sec.heading}」未填写` });
      }
    });
    return { text: blocks.join('\n\n'), warnings };
  }

  for (const sec of tplSections) {
    const key = normalizeHeadingName(sec.heading);
    const hit = agentMap.get(key);
    if (hit && hit.content) {
      blocks.push(`## ${sec.heading}\n\n${hit.content}`);
      agentMap.delete(key);
    } else {
      blocks.push(`## ${sec.heading}\n\n${MISSING_LINE}`);
      warnings.push({ code: 'SECTION_MISSING', section: sec.heading, message: `模板节「${sec.heading}」未填写` });
      if (hit) agentMap.delete(key);
    }
  }

  const extras = [...agentMap.values()];
  if (extras.length) {
    const extraLines = ['## 补充'];
    for (const x of extras) extraLines.push('', `### ${x.heading}`, '', x.content || MISSING_LINE);
    blocks.push(extraLines.join('\n').trim());
  }
  if (agent.preamble) blocks.unshift(agent.preamble);
  return { text: blocks.join('\n\n'), warnings };
}

/** 同标题卡片（入柜是新增语义，重复只提示不拦截）。 */
async function findSameTitle(dirAbs, title, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  let seen = 0;
  for (const ent of entries) {
    const abs = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.')) continue;
      const found = await findSameTitle(abs, title, depth + 1);
      if (found) return found;
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith('.md') || seen >= 500) continue;
    seen += 1;
    try {
      const text = stripBom(await fs.readFile(abs, 'utf8')).slice(0, 4000);
      if ((parseFrontmatter(text).title || '').trim() === title) return abs;
    } catch {
      /* 读不了的笔记跳过 */
    }
  }
  return null;
}

function renderCard({ skill, id, title, sections, tags, confidence, confWhy, source, date, heading }) {
  const lines = [
    '---',
    `id: ${id}`,
    `title: ${yamlString(title)}`,
    `date: ${date}`,
    `tags: [${tags.map(yamlString).join(', ')}]`,
    `confidence: ${confidence}`,
    `conf_why: ${yamlString(confWhy || '')}`,
    `source: ${yamlString(source || '')}`,
    `skill: ${skill.id}`,
    'schema_version: 1',
    '---',
    '',
    heading,
    '',
    sections.trim(),
    '',
  ];
  return lines.join('\n');
}

/**
 * @param {{root:string, skillId:string, title:string, body:string, tags:string[],
 *          confidence:'高'|'中'|'低', confWhy?:string, source?:string,
 *          nextId:string|number, now?:Date|string, onStep?:Function}} args
 */
export async function curate({
  root,
  skillId,
  title,
  body,
  tags,
  confidence,
  confWhy = '',
  source = '',
  nextId,
  now,
  onStep = null,
  templateText = null,
} = {}) {
  const warnings = [];
  const emit = (key, status, detail) => {
    if (typeof onStep !== 'function') return;
    try {
      onStep({ key, step: key, status, detail });
    } catch {
      /* 上层回调异常不影响入柜 */
    }
  };
  const fail = (code, message, detail) => {
    emit('validate', 'error', message);
    throw new EngineError(code, message, detail);
  };
  const T = CURATE_CODES;

  // validate
  emit('validate', 'start', '校验入柜参数');
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('INVALID_ROOT', 'root 必须是已存在的绝对路径');
  }
  const skill = byId.get(String(skillId || ''));
  if (!skill) fail(T.UNKNOWN_SKILL, `未知技能：${JSON.stringify(skillId)}（只能取自内置技能目录）`);
  if (skill.outputDir === '00_系统与索引') fail(T.OUTPUT_DIR_FORBIDDEN, `技能 ${skill.id} 不允许写入系统层`);
  const cleanTitle = String(title == null ? '' : title).trim();
  if (!cleanTitle) fail(T.TITLE_INVALID, 'title 必填');
  if (Array.from(cleanTitle).length > TITLE_MAX) fail(T.TITLE_INVALID, `title 超过 ${TITLE_MAX} 字符`);
  const cleanBody = String(body == null ? '' : body);
  if (!cleanBody.trim()) fail(T.BODY_REQUIRED, 'body 必填且不能为空');
  if (!Array.isArray(tags) || tags.length === 0 || tags.some((t) => typeof t !== 'string' || !t.trim())) {
    fail(T.TAGS_REQUIRED, 'tags 必须是非空字符串数组（至少 1 个）');
  }
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    fail(T.CONFIDENCE_REQUIRED, `confidence 只能是 高/中/低，收到：${JSON.stringify(confidence)}`);
  }
  if (confidence === '低' && String(confWhy || '').trim().length < 4) {
    fail(T.CONFIDENCE_REQUIRED, '低置信度必须填写 confWhy（至少 4 个字符）');
  }
  // 宿主可传已分配好的 id，也可传一个分配函数（持锁时调用 allocate）。
  const resolvedId = typeof nextId === 'function' ? nextId() : nextId;
  if (resolvedId == null || String(resolvedId).trim() === '') fail(T.NEXT_ID_REQUIRED, 'nextId 必须由宿主注入');
  const id = String(resolvedId).trim();
  const date = asDate(now);
  emit('validate', 'ok', `skill=${skill.id} id=${id}`);

  // allocate（引擎不读计数器；这一步只是消费宿主已分配的 id）
  emit('allocate', 'ok', `使用宿主注入的编号 ${id}`);

  // render
  emit('render', 'start', '渲染 frontmatter 与正文');
  const tpl = templateText != null
    ? String(templateText)
    : skill.template ? await readTemplateSource(skill.template) : null;
  const heading = renderHeading(id, cleanTitle);
  const skeleton = renderSkeleton(tpl, cleanBody);
  for (const w of skeleton.warnings) warnings.push(w);
  const content = renderCard({ skill, id, title: cleanTitle, sections: skeleton.text, tags, confidence, confWhy, source, date, heading });
  emit('render', 'ok', `${content.length} 字符，缺省 ${skeleton.warnings.length} 节`);

  // write
  emit('write', 'start', `${skill.outputDir}/`);
  const rootAbs = path.resolve(String(root));
  const rel = sanitizeRelPath(path.join(skill.outputDir, `${id}-${slugify(cleanTitle)}.md`));
  assertPathLength(rootAbs, rel);
  const target = safeJoin(rootAbs, rel);
  const dirAbs = path.join(rootAbs, skill.outputDir);
  const same = await findSameTitle(dirAbs, cleanTitle);
  if (same) warnings.push({ code: 'DUPLICATE_TITLE', path: same, message: `库里已有同标题卡片：${same}` });
  await ensureDir(rootAbs, dirAbs);
  await assertWritable(rootAbs, target);
  let outcome;
  try {
    outcome = await writeAtomic(target, content, { force: false, root: rootAbs });
  } catch (err) {
    emit('write', 'error', err && err.message ? err.message : String(err));
    throw err;
  }
  if (outcome === 'skipped') {
    emit('write', 'error', `目标已存在：${target}`);
    throw new EngineError(T.ID_CONFLICT, `目标文件已存在，编号可能被复用：${target}`);
  }
  emit('write', 'ok', target);

  // record（引擎只上报；cardsRepo 由宿主写）
  emit('record', 'start', '上报卡片记录');
  emit('record', 'ok', `id=${id} ${target}`);

  return {
    ok: true,
    id,
    path: target,
    relPath: rel,
    skill: {
      id: skill.id,
      name: skill.name,
      stage: skill.stage,
      outputDir: skill.outputDir,
      template: skill.template,
      idPrefix: skill.idPrefix,
    },
    confidence,
    warnings,
  };
}
