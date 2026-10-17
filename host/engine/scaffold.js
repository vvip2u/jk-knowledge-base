/**
 * bootstrap：在已存在的绝对目录里落出一整套知识库底座。
 *
 * 幂等：已存在的文件默认原样保留（用户改过的 _说明.md 不会被覆盖），
 *       只有缺失才补；force:true 才整体覆盖。
 * 安全：所有写入都经 safeJoin 校验仍在 root 之内。
 * 溯源：每一步通过 onStep 回调上报，引擎自己绝不写 trace 文件。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError, CODES, throwIfAborted } from './errors.js';
import { assertPathLength, ensureDir, nowIso, readTextOrNull, resolveRoot, safeJoin, sanitizeRelPath, sanitizeSegment, today, writeAtomic } from './paths.js';
import { pathKey } from './guard.js';
import { DOC_SLOTS, TEMPLATE_FILES, getMode, loadPresets, projectDirs, readTemplateSource } from './presets.js';
import { readSpecBody, specFrontmatter } from './specs.js';
import { humanizeTemplatePlaceholders, renderDirReadme, renderExtraIndex, renderMoc, renderTemplatesReadme } from './render.js';

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function seqBase() {
  return { R: 0, S: 0, H: 0, E: 0, K: 0, D: 0, RT: 0, P: 0, SK: 0, DOC: DOC_SLOTS.templatesReadme };
}

export async function bootstrap({ root, mode = 'asset', force = false, onStep = null, shouldAbort = null } = {}) {
  if (onStep !== null && typeof onStep !== 'function') {
    throw new EngineError(CODES.INVALID_ROOT, 'onStep 必须是函数或 null');
  }
  if (shouldAbort !== null && typeof shouldAbort !== 'function') {
    throw new EngineError(CODES.INVALID_ROOT, 'shouldAbort 必须是函数或 null');
  }
  const emit = (step, status, detail, extra = null) => {
    if (!onStep) return;
    try {
      onStep(extra ? { ...extra, step, status, detail } : { step, status, detail });
    } catch {
      /* 上层回调自己出错，不影响建库 */
    }
  };

  const gate = (step) => {
    try {
      throwIfAborted(shouldAbort);
    } catch (err) {
      emit(step, 'error', err && err.message ? err.message : String(err));
      throw err;
    }
  };

  const result = { root: '', mode, created: [], skipped: [], conflicts: [], warnings: [] };
  try {
    gate('validate');
    emit('validate', 'start', '校验根目录');
    const abs = await resolveRoot(root);
    result.root = abs;
    const cfg = await getMode(mode);
    const presets = await loadPresets();
    const date = today();
    const year = date.slice(0, 4);

    const vaultRel = path.join('.jkkb', 'vault.json');
    const vaultAbs = safeJoin(abs, vaultRel);
    const vaultRaw = await readTextOrNull(vaultAbs);
    let existing = null;
    if (vaultRaw !== null) {
      try {
        existing = JSON.parse(vaultRaw);
      } catch {
        if (!force) {
          throw new EngineError(CODES.VAULT_INVALID, `已有 .jkkb/vault.json 无法解析，拒绝覆盖（如需重建请传 force:true）`);
        }
      }
      if (existing && existing.mode && existing.mode !== mode && !force) {
        throw new EngineError(CODES.MODE_CONFLICT, `库已存在且 mode=${existing.mode}，与本次 mode=${mode} 冲突（如需切换请传 force:true）`);
      }
    }
    emit('validate', 'ok', abs, { key: 'validate' });

    const seenKeys = new Map();
    const put = async (rel, content) => {
      const safeRel = sanitizeRelPath(rel);
      assertPathLength(abs, safeRel);
      const target = safeJoin(abs, safeRel);
      const key = pathKey(target);
      if (seenKeys.has(key)) {
        result.conflicts.push(safeRel);
        result.warnings.push(
          `路径大小写冲突（${process.platform} 下不区分大小写）：${safeRel} 与 ${seenKeys.get(key)}`,
        );
        return target;
      }
      seenKeys.set(key, safeRel);
      const st = await statOrNull(target);
      if (st && st.isDirectory()) {
        result.conflicts.push(safeRel);
        result.warnings.push(`路径被同名目录占用，跳过：${safeRel}`);
        return target;
      }
      const outcome = await writeAtomic(target, content, { force, root: abs });
      if (outcome === 'skipped') result.skipped.push(safeRel);
      else result.created.push(safeRel);
      return target;
    };

    // 1) 13 个顶层目录 + 每个目录的 _说明.md
    emit('dirs', 'start', `${cfg.core.length} 个顶层目录`);
    const readmeTpl = await readTemplateSource('tpl-dir-readme.md');
    const dirArtifacts = [];
    for (let i = 0; i < cfg.core.length; i += 1) {
      gate('dir');
      const entry = cfg.core[i];
      const dirName = sanitizeSegment(entry.path);
      const dirAbs = safeJoin(abs, dirName);
      assertPathLength(abs, dirName);
      await ensureDir(abs, dirAbs);
      const content = renderDirReadme({ entry, index: i + 1, date, year, core: cfg.core, template: readmeTpl });
      const readmeAbs = await put(path.join(dirName, '_说明.md'), content);
      dirArtifacts.push(readmeAbs);
      emit('dir', 'ok', entry.path, { artifacts: [readmeAbs] });
    }
    emit('dirs', 'ok', `${result.created.length} 个文件已写入`, { key: 'dirs', artifacts: dirArtifacts });

    // 2) 五份规范
    gate('specs');
    emit('specs', 'start', cfg.specsDir);
    const specArtifacts = [];
    for (let i = 0; i < cfg.specNames.length; i += 1) {
      const name = cfg.specNames[i];
      const body = await readSpecBody(name);
      const head = specFrontmatter({ name, index: i + 1, date, year });
      specArtifacts.push(await put(path.join(cfg.specsDir, name), `${head}${body}`));
    }
    emit('specs', 'ok', `${cfg.specNames.length} 份`, { key: 'specs', artifacts: specArtifacts });

    // 3) 10 个模板
    gate('templates');
    emit('templates', 'start', cfg.templatesDir);
    const tplArtifacts = [];
    for (const item of TEMPLATE_FILES) {
      const src = await readTemplateSource(item.file);
      if (src === null) {
        result.warnings.push(`模板源缺失：assets/engine/templates/${item.file}`);
        continue;
      }
      const content = item.file === 'tpl-dir-readme.md' || item.file === 'tpl-moc-home.md'
        ? humanizeTemplatePlaceholders(src)
        : src;
      tplArtifacts.push(await put(path.join(cfg.templatesDir, item.as), content));
    }
    tplArtifacts.push(await put(path.join(cfg.templatesDir, '_说明.md'), renderTemplatesReadme(path.basename(cfg.templatesDir))));
    emit('templates', 'ok', `${TEMPLATE_FILES.length} 个模板`, { key: 'templates', artifacts: tplArtifacts });

    // 4) 系统索引页（知识地图 / 目录规则 / 溯源索引 / 命名 / 维护）
    gate('index');
    emit('index', 'start', cfg.indexDir);
    const indexArtifacts = [];
    for (const item of cfg.extraIndex) {
      const body = renderExtraIndex(item.kind, { cfg, core: cfg.core, presets, date });
      indexArtifacts.push(await put(path.join(cfg.indexDir, item.as), body));
    }
    emit('index', 'ok', `${cfg.extraIndex.length} 份索引页`, { key: 'index', artifacts: indexArtifacts });

    // 5) 首页 MOC
    gate('moc');
    emit('moc', 'start', cfg.moc);
    const moc = renderMoc({ mode, cfg, core: cfg.core, root: abs, date, status: 'scaffolded' });
    const mocAbs = await put(cfg.moc, moc);
    emit('moc', 'ok', cfg.moc, { key: 'moc', artifacts: [mocAbs] });

    // 6) 契约文件（最后写：前面的步骤失败时不留下半成品契约）
    gate('contract');
    emit('contract', 'start', vaultRel);
    if (vaultRaw !== null && !force) {
      result.skipped.push(vaultRel);
      emit('contract', 'skip', '已存在，保持原样', { key: 'contract', artifacts: [vaultAbs] });
    } else {
      const createdAt = existing && (existing.createdAt || existing.created_at) ? (existing.createdAt || existing.created_at) : nowIso();
      const stamp = nowIso();
      const dirs = projectDirs(cfg.core);
      const vault = {
        version: '1.0',
        mode,
        createdAt,
        updatedAt: stamp,
        created_at: createdAt,
        updated_at: stamp,
        root: abs,
        status: 'scaffolded',
        depth: 2,
        idPrefix: 'DOC',
        dirs,
        directories: dirs,
        system: {
          indexDir: cfg.indexDir,
          moc: cfg.moc,
          specsDir: cfg.specsDir,
          templatesDir: cfg.templatesDir,
          indexInto: cfg.indexInto,
        },
        seq: seqBase(),
        notes: { pending: [], degraded: [] },
      };
      assertPathLength(abs, vaultRel);
      await ensureDir(abs, path.dirname(vaultAbs));
      await writeAtomic(vaultAbs, `${JSON.stringify(vault, null, 2)}\n`, { force: true, root: abs });
      result.created.push(vaultRel);
      emit('contract', 'ok', 'vault.json 已写入', { key: 'contract', artifacts: [vaultAbs] });
    }

    emit('done', 'ok', `created=${result.created.length} skipped=${result.skipped.length}`);
    return result;
  } catch (err) {
    emit('done', 'error', err && err.message ? err.message : String(err));
    throw err;
  }
}
