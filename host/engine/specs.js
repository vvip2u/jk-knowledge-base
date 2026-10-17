/**
 * 五份规范页的取内容逻辑：正文来自 assets/engine/specs/*.md，
 * frontmatter 在这里统一生成（保证每份都满足五维底座、编号不撞车）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EngineError, CODES } from './errors.js';
import { DOC_SLOTS, docId } from './presets.js';

const SPEC_DIR = new URL('../../assets/engine/specs/', import.meta.url);

/** 规范文件的顺序、标题、一句话入口说明。 */
export const SPEC_META = {
  '元数据规范.md': { title: '元数据规范', desc: '每篇笔记的 frontmatter 该填什么（五维底座 + 行业扩展字段）' },
  '标签体系.md': { title: '标签体系', desc: '三层标签怎么打，哪些词能用' },
  '原子化笔记标准.md': { title: '原子化笔记标准', desc: '一张卡片写多长、必须包含哪五段' },
  '编号与溯源链.md': { title: '编号与溯源链', desc: '编号前缀 R/S/H/E/K/D/RT/P 与七步流转主链' },
  '置信度标准.md': { title: '置信度标准', desc: '高/中/低怎么判，与 status 怎么联动' },
};

export async function readSpecBody(name) {
  try {
    return await readFile(fileURLToPath(new URL(name, SPEC_DIR)), 'utf8');
  } catch {
    throw new EngineError(CODES.ASSETS_MISSING, `缺少规范正文资源：assets/engine/specs/${name}`);
  }
}

/** 规范页的 frontmatter：系统文档，来源写死为建库规范源。 */
export function specFrontmatter({ name, index, date, year }) {
  const title = (SPEC_META[name] || {}).title || name.replace(/\.md$/, '');
  const slot = DOC_SLOTS.specs + index - 1;
  return [
    '---',
    `id: ${docId(year, slot)}`,
    `title: ${title}`,
    'author: JK知识库',
    'owner: 待定',
    `created: ${date}`,
    `updated: ${date}`,
    'status: active',
    'review: 180d',
    'confidentiality: internal',
    'rbac: []',
    'source: "JK知识库 references/04-metadata-standards.md"',
    'relations: ["知识库首页"]',
    'project: ""',
    'ref_hypothesis: ""',
    'ref_experiment: ""',
    'version: v1.0',
    'confidence: 高',
    'conf_src: ["references/04-metadata-standards.md"]',
    'conf_why: ""',
    'l1: 系统/规范',
    'l2: []',
    'l3: [SOP手册]',
    '---',
    '',
  ].join('\n');
}

/** MOC 里的标签词表（基线值；schema.tags 为空时用它）。 */
export const BASELINE_TAGS = {
  l1: ['系统/规范', '资料/一手', '研究/行业', '思考/假设', '验证/实验', '知识/卡片', '复盘/决策'],
  l2: ['销售经理', '实施顾问', '内容运营', '突发事故应急', '新员工入职培训'],
  l3: ['SOP手册', '避坑指南', '交付模板', '售前', '交付中', '维护期'],
};

/** MOC 里的粒度速查。 */
export const ATOM_RULE = '单张原子卡片 **300–800 字**（人工阅读粒度）；RAG 切片 **256–512 Token**，重叠 **12%**。\n'
  + '容器五段：问题定义 / 前提条件 / 行动步骤 / 预期结果与验证 / 异常处置。';
