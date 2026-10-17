/**
 * JK知识库 建库引擎（纯 JS，零依赖）。
 *
 * 门面只做四件事：投影预设、编排落盘、体检、索引；不碰 trace、不碰 HTTP、不碰配置。
 * 上层（host/routes.js、host/root-policy.js、client 仪表盘）只依赖本文件导出的五个函数。
 */
import { bootstrap as runBootstrap } from './scaffold.js';
import { verify as runVerify } from './verify.js';
import { inspect as runInspect, reindex as runReindex } from './indexer.js';
import { getMode, projectDirs } from './presets.js';
import { fingerprintArtifacts, resolveRoot } from './paths.js';
import { EngineError } from './errors.js';
import { PATH_GUARD_VERSION } from './guard.js';
import { preflight as runPreflight } from './preflight.js';
import { curate as runCurate } from './curate.js';
import { maintain as runMaintain } from './maintain.js';
import { archiveSkillPage as runArchiveSkillPage, renderSkillPage as runRenderSkillPage } from './skillpage.js';
import { archiveItems as runArchiveItems, listRecentNotes as runListRecentNotes } from './archive.js';

export { EngineError };

export const ENGINE_VERSION = '1.0.0';
export { PATH_GUARD_VERSION };
export { fingerprintArtifacts };

// doctor 引擎（diagnose / repair）由引擎门面统一转出，宿主只依赖这一处。
export { diagnose, repair } from '../doctor/index.js';

/**
 * 只读预览：某个模式会建出哪些顶层目录。不写盘、不要求 root 已存在。
 * @param {{root?: string, mode?: 'asset'|'topic'}} args
 */
export async function planDirs({ root = null, mode = 'asset' } = {}) {
  const cfg = await getMode(mode);
  let resolved = null;
  if (typeof root === 'string' && root.trim() !== '') {
    resolved = await resolveRoot(root, { mustExist: false });
  }
  return { mode, root: resolved, dirs: projectDirs(cfg.core) };
}

/**
 * 建库：13 个顶层目录 + 每个目录 _说明.md + 5 份规范 + 10 个模板 + 首页 MOC + .jkkb/vault.json。
 * 幂等：已存在文件默认不动，缺失才补；force:true 才覆盖。
 */
export async function bootstrap({ root, mode = 'asset', force = false, onStep = null, shouldAbort = null } = {}) {
  return runBootstrap({ root, mode, force, onStep, shouldAbort });
}

/** 体检：只读。返回 { ok, checked, errors[], warnings[], infos[], counts, summary }。 */
export async function verify({ root, shouldAbort = null } = {}) {
  return runVerify({ root, shouldAbort });
}

/** 重建索引：写 05_索引 下两份索引页并刷新首页目录地图；不改用户笔记。 */
export async function reindex({ root, onStep = null, shouldAbort = null } = {}) {
  return runReindex({ root, onStep, shouldAbort });
}

/**
 * 入柜：按内置技能定义把一份内容写成正式卡片（id 由宿主注入，引擎不读计数器）。
 * 返回 { ok, id, path, skill, confidence, warnings[] }。
 */
export async function curate(args = {}) {
  return runCurate(args);
}

/**
 * 归档执行：把指定文件移入 12_归档与历史/03_归档笔记/（保留层级），先写后删。
 * 返回 { ok, archivedAt, moved[], failed[], archiveDir }。
 */
export async function archiveItems(args = {}) {
  return runArchiveItems(args);
}

/** 仪表盘用：最近修改的 10 篇笔记（只读，跳过系统索引页与隐藏目录）。 */
export async function listRecentNotes(args = {}) {
  return runListRecentNotes(args);
}

/** SKILL 页面渲染（纯函数）：返回 { relPath, content }。 */
export function renderSkillPage(args = {}) {
  return runRenderSkillPage(args);
}

/** SKILL 历史版本归档：写到 12_归档与历史/03_历史版本/，返回 { archivedPath, relPath, content }。 */
export async function archiveSkillPage(args = {}) {
  return runArchiveSkillPage(args);
}

/**
 * 整理规则扫描（只读）：M01 收件箱超期 / M03 低置信度未验证 / M04 溯源断链 / M08 缺置信度。
 * 只产 findings，没有任何移动或删除文件的代码路径。
 */
export async function maintain(args = {}) {
  return runMaintain(args);
}

/**
 * 开跑前预检：root 可用性、路径守卫、文件数上限、vault.json、磁盘空间、可写性探针。
 * 返回 { ok, code, checks[], counts:{files,notes,limit,truncated}, freeBytes, elapsedMs }。
 */
export async function preflight(args = {}) {
  return runPreflight(args);
}

/** 轻量概览：给仪表盘用，只读、限深限量、不抛「目录不存在」。 */
export async function inspect({ root } = {}) {
  return runInspect({ root });
}
