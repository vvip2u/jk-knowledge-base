/**
 * 目录预设的读取与投影。
 * 真源是 assets/engine/directory-presets.json（从 SKILL 的 assets/directory-presets.json
 * 原样搬运，未改一个字节）；引擎只读它，不在代码里另抄一份目录清单。
 */
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EngineError, CODES } from './errors.js';

export const MODES = ['asset', 'topic'];
export const DEFAULT_MODE = 'asset';
export const PRESET_FILE = new URL('../../assets/engine/directory-presets.json', import.meta.url);
export const TEMPLATE_DIR = new URL('../../assets/engine/templates/', import.meta.url);

/** 引擎要搬进库里的 10 个模板：SKILL 原始文件名 → 库内文件名。 */
export const TEMPLATE_FILES = [
  { file: 'tpl-source-card.md', as: '资料卡模板.md' },
  { file: 'tpl-research-report.md', as: '研究报告模板.md' },
  { file: 'tpl-hypothesis-card.md', as: '假设卡模板.md' },
  { file: 'tpl-experiment-log.md', as: '实验记录模板.md' },
  { file: 'tpl-knowledge-card.md', as: '知识卡模板.md' },
  { file: 'tpl-decision-log.md', as: '决策记录模板.md' },
  { file: 'tpl-retro.md', as: '复盘模板.md' },
  { file: 'tpl-atom-card.md', as: '原子卡片模板.md' },
  { file: 'tpl-dir-readme.md', as: '目录说明模板.md' },
  { file: 'tpl-moc-home.md', as: '知识库首页模板.md' },
];

/** 系统文件里固定的 DOC 编号槽位，保证 bootstrap 每次生成的编号完全一致。 */
export const DOC_SLOTS = { dirBase: 1, specs: 21, moc: 30, extraIndex: 31, templatesReadme: 40 };

let cached = null;

export async function loadPresets() {
  if (cached) return cached;
  let raw;
  try {
    raw = await fs.readFile(fileURLToPath(PRESET_FILE), 'utf8');
  } catch {
    throw new EngineError(CODES.ASSETS_MISSING, '缺少目录预设 assets/engine/directory-presets.json');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EngineError(CODES.ASSETS_MISSING, '目录预设不是合法 JSON', String(err && err.message));
  }
  if (!parsed || typeof parsed.modes !== 'object') {
    throw new EngineError(CODES.ASSETS_MISSING, '目录预设缺少 modes 段');
  }
  cached = parsed;
  return cached;
}

export async function readTemplateSource(file) {
  try {
    return await fs.readFile(fileURLToPath(new URL(file, TEMPLATE_DIR)), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 取某个模式的完整配置：顶层目录、系统层落点、索引目录。
 */
export async function getMode(mode = DEFAULT_MODE) {
  if (!MODES.includes(mode)) {
    throw new EngineError(CODES.MODE_INVALID, `mode 只能是 ${MODES.join(' / ')}，收到：${mode}`);
  }
  const presets = await loadPresets();
  const cfg = presets.modes[mode];
  if (!cfg || !Array.isArray(cfg.core)) {
    throw new EngineError(CODES.ASSETS_MISSING, `目录预设里没有 mode=${mode} 的定义`);
  }
  const sys = cfg.system_layer || {};
  const indexDir = sys.index_dir || '';
  return {
    mode,
    label: cfg.label || mode,
    core: cfg.core,
    systemLayer: sys,
    indexDir,
    moc: sys.moc || 'MOC-知识库首页.md',
    specsDir: sys.specs_into || indexDir,
    templatesDir: sys.templates_into || '',
    indexInto: indexDir ? `${indexDir}/05_索引` : '05_索引',
    specNames: Array.isArray(sys.specs) && sys.specs.length
      ? sys.specs
      : ['元数据规范.md', '标签体系.md', '原子化笔记标准.md', '编号与溯源链.md', '置信度标准.md'],
    extraIndex: Array.isArray(sys.extra_index) ? sys.extra_index : [],
  };
}

/** 把预设的 core 投影成 planDirs 承诺的返回形状。 */
export function projectDirs(core) {
  return core.map((d) => ({
    name: d.path,
    role: d.role || '',
    purpose: d.content || '',
    subdirs: (d.children || []).map((c) => c.path),
  }));
}

/** 目录说明里的「相关目录」字段：其余一级目录。 */
export function siblingList(core, self) {
  const others = core.filter((d) => d.path !== self).map((d) => d.path);
  return others.length ? others.map((n) => `\`${n}/\``).join('、') : '（无）';
}

export function docId(year, slot) {
  return `DOC-SYS-${year}-${String(slot).padStart(3, '0')}`;
}
