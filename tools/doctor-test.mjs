#!/usr/bin/env node
/**
 * doctor 测试：node:test 直接运行。
 * 全部在 os.tmpdir() 下造临时知识库，结束清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { diagnose, repair } from '../host/engine/index.js';
import { bootstrap } from '../host/engine/index.js';
import { quarantineRoot } from '../host/doctor/quarantine.js';

const NOW = '2026-10-17T12:00:00';

async function tmpRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jkkb-doctor-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function bootVault(t) {
  const root = await tmpRoot(t);
  await bootstrap({ root, mode: 'asset' });
  return root;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function snapshot(root) {
  const map = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(abs); continue; }
      const st = await fs.stat(abs);
      const rel = path.relative(root, abs);
      map.set(rel, { size: st.size, mtimeMs: st.mtimeMs, hash: crypto.createHash('sha1').update(await fs.readFile(abs)).digest('hex') });
    }
  }
  await walk(root);
  return map;
}

async function snapshotAll(root) {
  const map = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      const st = await fs.stat(abs);
      if (ent.isDirectory()) {
        map.set(rel, { type: 'dir', mtimeMs: st.mtimeMs });
        await walk(abs);
      } else {
        map.set(rel, {
          type: 'file',
          size: st.size,
          mtimeMs: st.mtimeMs,
          hash: crypto.createHash('sha1').update(await fs.readFile(abs)).digest('hex'),
        });
      }
    }
  }
  await walk(root);
  return map;
}

async function assertNoLastReport(root) {
  assert.equal(await exists(path.join(root, '.jkkb', 'doctor', 'last.json')), false, '.jkkb/doctor/last.json 不应由引擎写入');
}

async function countFiles(root) {
  let n = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) await walk(path.join(dir, ent.name));
      else n += 1;
    }
  }
  await walk(root);
  return n;
}

function check(report, id) {
  return report.checks.find((c) => c.id === id);
}

function findRepair(result, repairId) {
  return result.applied.find((a) => a.repairId === repairId);
}

async function allRepairIds() {
  const { REPAIRS } = await import('../host/doctor/index.js');
  return REPAIRS.map((r) => r.repairId);
}

async function repairOnce(root, ids, opts = {}) {
  return repair({ root, now: NOW, repairIds: ids, ...opts });
}

// ───────────────────────────── 基础 / config ─────────────────────────────

test('1. diagnose 返回完整结构（22 checks + summary）', async (t) => {
  const root = await bootVault(t);
  const r = await diagnose({ root, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.root, root);
  assert.ok(!Number.isNaN(Date.parse(r.generatedAt)));
  assert.equal(r.checks.length, 22);
  assert.equal(r.summary.total, 22);
  assert.equal(r.summary.ok + r.summary.warn + r.summary.error + r.summary.blocked, 22);
  for (const c of r.checks) {
    assert.ok(['ok', 'warn', 'error', 'blocked'].includes(c.level));
    assert.equal(typeof c.title, 'string');
    assert.equal(typeof c.detail, 'string');
  }
  await assertNoLastReport(root);
});

test('2. CFG-01：未配置根目录 → blocked', async (t) => {
  const dir = await tmpRoot(t);
  const r = await diagnose({ root: null, now: NOW, deps: { settingsPath: path.join(dir, 'settings.json') } });
  assert.equal(check(r, 'CFG-01').level, 'blocked');
  assert.equal(check(r, 'ROOT-01').level, 'blocked');
  assert.equal(r.summary.blocked >= 4, true);
});

test('3. CFG-02 + R-CFG-01：坏配置 → 隔离并重建（保留 root）', async (t) => {
  const root = await bootVault(t);
  const settings = path.join(await tmpRoot(t), 'settings.json');
  await writeText(settings, `{"root": ${JSON.stringify(root)}, "broken": `);
  let r = await diagnose({ root, now: NOW, deps: { settingsPath: settings } });
  assert.equal(check(r, 'CFG-02').level, 'error');
  const out = await repairOnce(root, ['R-CFG-01'], { deps: { settingsPath: settings } });
  assert.equal(findRepair(out, 'R-CFG-01').status, 'applied');
  assert.ok(await exists(settings));
  const rebuilt = JSON.parse(await fs.readFile(settings, 'utf8'));
  assert.equal(rebuilt.root, root);
  assert.ok(rebuilt.rootConfirmedAt);
  const broken = (await fs.readdir(path.dirname(settings))).filter((n) => n.includes('.broken-'));
  assert.equal(broken.length, 1, '损坏配置应保留为 .broken-*');
  r = await diagnose({ root, now: NOW, deps: { settingsPath: settings } });
  assert.equal(check(r, 'CFG-02').level, 'ok');
});

test('4. R-CFG-01 幂等', async (t) => {
  const root = await bootVault(t);
  const settings = path.join(await tmpRoot(t), 'settings.json');
  await writeText(settings, 'not json');
  await repairOnce(root, ['R-CFG-01'], { deps: { settingsPath: settings } });
  const first = await fs.stat(settings);
  const second = await repairOnce(root, ['R-CFG-01'], { deps: { settingsPath: settings } });
  assert.equal(findRepair(second, 'R-CFG-01').status, 'skipped');
  assert.equal((await fs.stat(settings)).mtimeMs, first.mtimeMs);
});

test('5. ROOT-01：根目录不存在 → blocked', async (t) => {
  const dir = await tmpRoot(t);
  const r = await diagnose({ root: path.join(dir, 'nope'), now: NOW });
  assert.equal(check(r, 'ROOT-01').level, 'blocked');
  assert.equal(check(r, 'DIR-01').level, 'blocked');
});

// ───────────────────────────── dirs / sys / index ─────────────────────────────

test('6. DIR-01 + R-DIR-01：只补缺失目录，已有目录不动', async (t) => {
  const root = await bootVault(t);
  const keep = path.join(root, '03_研究与洞察', '_说明.md');
  const keepStat = await fs.stat(keep);
  await fs.rm(path.join(root, '07_素材与组件'), { recursive: true, force: true });
  await fs.rm(path.join(root, '11_岗位技能库'), { recursive: true, force: true });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'DIR-01').level, 'error');
  const out = await repairOnce(root, ['R-DIR-01']);
  assert.equal(findRepair(out, 'R-DIR-01').status, 'applied');
  assert.ok(await exists(path.join(root, '07_素材与组件')));
  assert.ok(await exists(path.join(root, '11_岗位技能库')));
  assert.equal((await fs.stat(keep)).mtimeMs, keepStat.mtimeMs);
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'DIR-01').level, 'ok');
});

test('7. R-DIR-01 幂等', async (t) => {
  const root = await bootVault(t);
  await fs.rm(path.join(root, '12_归档与历史'), { recursive: true, force: true });
  await repairOnce(root, ['R-DIR-01']);
  const second = await repairOnce(root, ['R-DIR-01']);
  assert.equal(findRepair(second, 'R-DIR-01').status, 'skipped');
});

test('8. SYS-01 + R-SYS-01：空首页被重建，非空文件不覆盖', async (t) => {
  const root = await bootVault(t);
  const moc = path.join(root, '00_系统与索引', '00_知识库首页.md');
  const mapPage = path.join(root, '00_系统与索引', '01_全局知识地图.md');
  const mapStat = await fs.stat(mapPage);
  await fs.writeFile(moc, '', 'utf8');
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'SYS-01').level, 'error');
  const out = await repairOnce(root, ['R-SYS-01']);
  assert.equal(findRepair(out, 'R-SYS-01').status, 'applied');
  assert.ok((await fs.readFile(moc, 'utf8')).includes('# 知识库首页'));
  assert.equal((await fs.stat(mapPage)).mtimeMs, mapStat.mtimeMs);
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'SYS-01').level, 'ok');
});

test('9. R-SYS-01 幂等', async (t) => {
  const root = await bootVault(t);
  const moc = path.join(root, '00_系统与索引', '00_知识库首页.md');
  await fs.writeFile(moc, '', 'utf8');
  await repairOnce(root, ['R-SYS-01']);
  const stat = await fs.stat(moc);
  const second = await repairOnce(root, ['R-SYS-01']);
  assert.equal(findRepair(second, 'R-SYS-01').status, 'skipped');
  assert.equal((await fs.stat(moc)).mtimeMs, stat.mtimeMs);
});

test('10. IDX-01 + R-IDX-01：索引缺失重建', async (t) => {
  const root = await bootVault(t);
  await fs.rm(path.join(root, '00_系统与索引', '05_索引'), { recursive: true, force: true });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'IDX-01').level, 'error');
  const out = await repairOnce(root, ['R-IDX-01']);
  assert.equal(findRepair(out, 'R-IDX-01').status, 'applied');
  assert.ok(await exists(path.join(root, '00_系统与索引', '05_索引', '笔记索引.md')));
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'IDX-01').level, 'ok');
});

test('11. R-IDX-01 幂等', async (t) => {
  const root = await bootVault(t);
  await repairOnce(root, ['R-IDX-01']);
  const first = await fs.stat(path.join(root, '00_系统与索引', '05_索引', '笔记索引.md'));
  const second = await repairOnce(root, ['R-IDX-01']);
  assert.equal(findRepair(second, 'R-IDX-01').status, 'skipped');
  assert.equal((await fs.stat(path.join(root, '00_系统与索引', '05_索引', '笔记索引.md'))).mtimeMs, first.mtimeMs);
});

// ───────────────────────────── store ─────────────────────────────

test('12. STORE-01 + R-STORE-01：损坏文件隔离到 quarantine 并重建', async (t) => {
  const root = await bootVault(t);
  const bad = path.join(root, '.jkkb', 'store', 'skills', 'SK001.json');
  await writeText(bad, '{ broken json');
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'STORE-01').level, 'error');
  const out = await repairOnce(root, ['R-STORE-01']);
  const applied = findRepair(out, 'R-STORE-01');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.movedTo.length, 1);
  const moved = applied.movedTo[0];
  assert.ok(moved.startsWith(quarantineRoot(root)), moved);
  assert.ok(moved.endsWith(path.join('skills', 'SK001.json')));
  assert.equal(await exists(moved), true);
  assert.equal(await exists(bad), true, '原位置应重建为空结构');
  JSON.parse(await fs.readFile(bad, 'utf8'));
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'STORE-01').level, 'ok');
});

test('13. R-STORE-01 幂等', async (t) => {
  const root = await bootVault(t);
  const bad = path.join(root, '.jkkb', 'store', 'cards', 'C1.json');
  await writeText(bad, 'nope');
  await repairOnce(root, ['R-STORE-01']);
  const second = await repairOnce(root, ['R-STORE-01']);
  assert.equal(findRepair(second, 'R-STORE-01').status, 'skipped');
  assert.equal((await fs.readdir(path.join(root, '.jkkb', 'quarantine'))).length, 1);
});

test('14. STORE-02 + R-STORE-02：缺登记补上；孤儿记录标 missing 不删除', async (t) => {
  const root = await bootVault(t);
  const dir = path.join(root, '.jkkb', 'store', 'cards');
  await writeJson(path.join(dir, 'CARD-001.json'), { id: 'CARD-001', schemaVersion: 1 });
  await writeJson(path.join(dir, 'index.json'), { version: 1, ids: ['GHOST-001'], updatedAt: 'x' });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'STORE-02').level, 'error');
  const out = await repairOnce(root, ['R-STORE-02']);
  assert.equal(findRepair(out, 'R-STORE-02').status, 'applied');
  const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.ok(index.ids.includes('CARD-001'));
  assert.ok(index.ids.includes('GHOST-001'), '孤儿记录保留在索引里');
  assert.deepEqual(index.missing, ['GHOST-001']);
  assert.equal(await exists(path.join(dir, 'CARD-001.json')), true, '不得删除实体');
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'STORE-02').level, 'ok');
});

test('15. R-STORE-02 幂等', async (t) => {
  const root = await bootVault(t);
  const dir = path.join(root, '.jkkb', 'store', 'reports');
  await writeJson(path.join(dir, 'RPT-1.json'), { id: 'RPT-1' });
  await writeJson(path.join(dir, 'index.json'), { version: 1, ids: [] });
  await repairOnce(root, ['R-STORE-02']);
  const stat = await fs.stat(path.join(dir, 'index.json'));
  const second = await repairOnce(root, ['R-STORE-02']);
  assert.equal(findRepair(second, 'R-STORE-02').status, 'skipped');
  assert.equal((await fs.stat(path.join(dir, 'index.json'))).mtimeMs, stat.mtimeMs);
});

test('16. STORE-03 + R-STORE-03：计数器只升不降', async (t) => {
  const root = await bootVault(t);
  const dir = path.join(root, '.jkkb', 'store', 'numbering');
  await writeJson(path.join(dir, 'registry.json'), { schemaVersion: 1, counters: { K: 0 }, updatedAt: 'x' });
  await writeJson(path.join(root, '.jkkb', 'store', 'cards', 'K-2026-005.json'), { id: 'K-2026-005' });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'STORE-03').level, 'error');
  const out = await repairOnce(root, ['R-STORE-03']);
  assert.equal(findRepair(out, 'R-STORE-03').status, 'applied');
  const reg = JSON.parse(await fs.readFile(path.join(dir, 'registry.json'), 'utf8'));
  assert.ok(reg.counters.K >= 5);
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'STORE-03').level, 'ok');
});

test('17. R-STORE-03 幂等', async (t) => {
  const root = await bootVault(t);
  await writeJson(path.join(root, '.jkkb', 'store', 'numbering', 'registry.json'), { schemaVersion: 1, counters: {}, updatedAt: 'x' });
  await writeJson(path.join(root, '.jkkb', 'store', 'cards', 'S-2026-009.json'), { id: 'S-2026-009' });
  await repairOnce(root, ['R-STORE-03']);
  const stat = await fs.stat(path.join(root, '.jkkb', 'store', 'numbering', 'registry.json'));
  const second = await repairOnce(root, ['R-STORE-03']);
  assert.equal(findRepair(second, 'R-STORE-03').status, 'skipped');
  assert.equal((await fs.stat(path.join(root, '.jkkb', 'store', 'numbering', 'registry.json'))).mtimeMs, stat.mtimeMs);
});

// ───────────────────────────── runs ─────────────────────────────

async function writeRun(root, id, extra = {}) {
  const dir = path.join(root, '.jkkb', 'runs', id);
  await writeJson(path.join(dir, 'run.json'), {
    id, kind: 'curate', title: id, status: 'failed', startedAt: NOW, endedAt: NOW, root, ...extra,
  });
  return dir;
}

test('18. RUN-01 + R-RUN-01：坏 run.json 隔离并重建 abandoned', async (t) => {
  const root = await bootVault(t);
  const dir = await writeRun(root, 'run-bad');
  await writeText(path.join(dir, 'run.json'), '{ broken');
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-01').level, 'error');
  const out = await repairOnce(root, ['R-RUN-01']);
  const applied = findRepair(out, 'R-RUN-01');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.movedTo.length, 1);
  const rebuilt = JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8'));
  assert.equal(rebuilt.status, 'abandoned');
  assert.equal(rebuilt.id, 'run-bad');
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-01').level, 'ok');
});

test('19. R-RUN-01 幂等', async (t) => {
  const root = await bootVault(t);
  const dir = await writeRun(root, 'run-bad2');
  await writeText(path.join(dir, 'run.json'), 'x');
  await repairOnce(root, ['R-RUN-01']);
  const stat = await fs.stat(path.join(dir, 'run.json'));
  const second = await repairOnce(root, ['R-RUN-01']);
  assert.equal(findRepair(second, 'R-RUN-01').status, 'skipped');
  assert.equal((await fs.stat(path.join(dir, 'run.json'))).mtimeMs, stat.mtimeMs);
});

test('20. RUN-02 + R-RUN-02：心跳超期 running → abandoned；新鲜 running 直接 RUN_IN_PROGRESS 且不写盘', async (t) => {
  const root = await bootVault(t);
  const stale = await writeRun(root, 'run-stale', {
    status: 'running', heartbeatAt: new Date(Date.parse(NOW) - 10 * 60 * 1000).toISOString(), heartbeatBy: 'engine',
  });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-02').level, 'error');
  const out = await repairOnce(root, ['R-RUN-02']);
  assert.equal(findRepair(out, 'R-RUN-02').status, 'applied');
  const fixed = JSON.parse(await fs.readFile(path.join(stale, 'run.json'), 'utf8'));
  assert.equal(fixed.status, 'abandoned');
  assert.equal(fixed.endReason, 'doctor');
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-02').level, 'ok');

  const fresh = await writeRun(root, 'run-fresh', { status: 'running', heartbeatAt: NOW, heartbeatBy: 'engine' });
  const before = await snapshot(root);
  await assert.rejects(
    () => repairOnce(root, ['R-RUN-02']),
    (err) => {
      assert.equal(err.code, 'RUN_IN_PROGRESS');
      assert.deepEqual(err.runs, ['run-fresh']);
      return true;
    },
  );
  const after = await snapshot(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, snap] of before) assert.deepEqual(after.get(rel), snap, `${rel} 被改动`);
  assert.equal(await exists(path.join(fresh, 'run.json')), true);
});

test('21. R-RUN-02 幂等', async (t) => {
  const root = await bootVault(t);
  await writeRun(root, 'run-stale2', { status: 'running', heartbeatAt: new Date(Date.parse(NOW) - 10 * 60 * 1000).toISOString() });
  await repairOnce(root, ['R-RUN-02']);
  const second = await repairOnce(root, ['R-RUN-02']);
  assert.equal(findRepair(second, 'R-RUN-02').status, 'skipped');
});

test('22. RUN-03 + R-RUN-03：无活跃 run 的残留锁被隔离释放', async (t) => {
  const root = await bootVault(t);
  const lock = path.join(root, '.jkkb', 'lock.json');
  await writeJson(lock, { runId: 'ghost-run', pid: 1, createdAt: NOW, heartbeatAt: NOW });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-03').level, 'error');
  const out = await repairOnce(root, ['R-RUN-03']);
  const applied = findRepair(out, 'R-RUN-03');
  assert.equal(applied.status, 'applied');
  assert.ok(applied.movedTo[0].startsWith(quarantineRoot(root)));
  assert.equal(await exists(lock), false);
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-03').level, 'ok');
});

test('23. R-RUN-03 幂等', async (t) => {
  const root = await bootVault(t);
  await writeJson(path.join(root, '.jkkb', 'lock.json'), { runId: 'ghost2', createdAt: NOW });
  await repairOnce(root, ['R-RUN-03']);
  const second = await repairOnce(root, ['R-RUN-03']);
  assert.equal(findRepair(second, 'R-RUN-03').status, 'skipped');
});

test('24. RUN-04 + R-RUN-04：损坏 checkpoint 被隔离', async (t) => {
  const root = await bootVault(t);
  const dir = await writeRun(root, 'run-cp');
  await writeText(path.join(dir, 'checkpoint.json'), 'not json');
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-04').level, 'error');
  const out = await repairOnce(root, ['R-RUN-04']);
  const applied = findRepair(out, 'R-RUN-04');
  assert.equal(applied.status, 'applied');
  assert.ok(applied.movedTo[0].endsWith(path.join('run-cp', 'checkpoint.json')));
  assert.equal(await exists(path.join(dir, 'checkpoint.json')), false);
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-04').level, 'ok');
});

test('25. R-RUN-04 幂等', async (t) => {
  const root = await bootVault(t);
  const dir = await writeRun(root, 'run-cp2');
  await writeText(path.join(dir, 'checkpoint.json'), '{');
  await repairOnce(root, ['R-RUN-04']);
  const second = await repairOnce(root, ['R-RUN-04']);
  assert.equal(findRepair(second, 'R-RUN-04').status, 'skipped');
});

test('26. RUN-05 + R-RUN-05：损坏的滚动归档索引被重建', async (t) => {
  const root = await bootVault(t);
  const archive = path.join(root, '.jkkb', 'runs', 'archive', 'index.json');
  await writeText(archive, 'broken');
  await writeRun(root, 'old-run', { status: 'completed' });
  let r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-05').level, 'error');
  const out = await repairOnce(root, ['R-RUN-05']);
  assert.equal(findRepair(out, 'R-RUN-05').status, 'applied');
  const rebuilt = JSON.parse(await fs.readFile(archive, 'utf8'));
  assert.equal(rebuilt.version, 1);
  assert.ok(rebuilt.runs.some((x) => x.id === 'old-run'));
  r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'RUN-05').level, 'ok');
});

test('27. R-RUN-05 幂等', async (t) => {
  const root = await bootVault(t);
  const archive = path.join(root, '.jkkb', 'runs', 'archive', 'index.json');
  await writeText(archive, 'broken');
  await repairOnce(root, ['R-RUN-05']);
  const stat = await fs.stat(archive);
  const second = await repairOnce(root, ['R-RUN-05']);
  assert.equal(findRepair(second, 'R-RUN-05').status, 'skipped');
  assert.equal((await fs.stat(archive)).mtimeMs, stat.mtimeMs);
});

// ───────────────────────────── registries ─────────────────────────────

const REG_CASES = [
  { ns: 'cards', checkId: 'REG-01', repairId: 'R-REG-01', file: 'CARD-001.json' },
  { ns: 'skills', checkId: 'REG-02', repairId: 'R-REG-02', file: 'SK001.json' },
  { ns: 'reports', checkId: 'REG-03', repairId: 'R-REG-03', file: 'RPT-001.json' },
  { ns: 'experts', checkId: 'REG-04', repairId: 'R-REG-04', file: 'EXP-001.json' },
];

for (const c of REG_CASES) {
  test(`REG ${c.ns}：缺登记修复 + 幂等`, async (t) => {
    const root = await bootVault(t);
    const dir = path.join(root, '.jkkb', 'store', c.ns);
    await writeJson(path.join(dir, c.file), { id: c.file.replace('.json', '') });
    await writeJson(path.join(dir, 'index.json'), { version: 1, ids: [] });
    let r = await diagnose({ root, now: NOW });
    assert.equal(check(r, c.checkId).level, 'error');
    const out = await repairOnce(root, [c.repairId]);
    assert.equal(findRepair(out, c.repairId).status, 'applied');
    const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.ok(index.ids.includes(c.file.replace('.json', '')));
    r = await diagnose({ root, now: NOW });
    assert.equal(check(r, c.checkId).level, 'ok');
    const second = await repairOnce(root, [c.repairId]);
    assert.equal(findRepair(second, c.repairId).status, 'skipped');
  });
}

// ───────────────────────────── 诊断免疫 / 降级 / 只读保证 ─────────────────────────────

test('32. 单个 check 抛错 → 降级为 warn/CHECK_FAILED，其余照常', async (t) => {
  const root = await bootVault(t);
  const r = await diagnose({ root, now: NOW, deps: { failCheckId: 'DIR-01' } });
  const failed = check(r, 'DIR-01');
  assert.equal(failed.level, 'warn');
  assert.equal(failed.code, 'CHECK_FAILED');
  assert.ok(r.checks.length === 22);
  assert.ok(r.summary.warn >= 1);
  assert.equal(r.ok, true);
});

test('33. store 文件损坏时诊断仍返回完整 checks', async (t) => {
  const root = await bootVault(t);
  await writeText(path.join(root, '.jkkb', 'store', 'skills', 'a.json'), 'x');
  await writeText(path.join(root, '.jkkb', 'store', 'skills', 'index.json'), 'y');
  await writeText(path.join(root, '.jkkb', 'store', 'numbering', 'registry.json'), 'z');
  const r = await diagnose({ root, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 22);
  assert.equal(check(r, 'STORE-01').level, 'error');
  // registry 损坏由 STORE-01 覆盖；STORE-03 不做猜测，允许 ok/warn/error 但诊断不能崩
  assert.ok(['ok', 'warn', 'error'].includes(check(r, 'STORE-03').level));
});

test('34. dryRun：planned 完整、applied 为空、磁盘不变', async (t) => {
  const root = await bootVault(t);
  await fs.rm(path.join(root, '07_素材与组件'), { recursive: true, force: true });
  await writeText(path.join(root, '.jkkb', 'store', 'skills', 'bad.json'), '{');
  const ids = await allRepairIds();
  const before = await snapshot(root);
  const out = await repair({ root, now: NOW, repairIds: ids, dryRun: true });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.applied, []);
  assert.ok(out.planned.length >= 2);
  for (const p of out.planned) {
    assert.ok(p.repairId && p.checkId && p.action);
    assert.ok(Array.isArray(p.targets));
    assert.ok(['low', 'medium'].includes(p.risk));
  }
  const after = await snapshot(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, snap] of before) assert.deepEqual(after.get(rel), snap, `${rel} 被改动`);
  await assertNoLastReport(root);
});

test('35. 隔离路径：损坏文件移到 .jkkb/quarantine/<ts>/<原相对路径>，原位置消失', async (t) => {
  const root = await bootVault(t);
  const bad = path.join(root, '.jkkb', 'store', 'experts', 'EXP-9.json');
  await writeText(bad, 'bad json');
  const out = await repairOnce(root, ['R-STORE-01']);
  const moved = findRepair(out, 'R-STORE-01').movedTo[0];
  const rel = path.relative(quarantineRoot(root), moved);
  assert.match(rel, /^\d{8}-\d{6}\//);
  assert.ok(rel.endsWith(path.join('experts', 'EXP-9.json')));
  assert.equal(await exists(moved), true);
  assert.equal(await exists(bad), true, '原位置重建为空结构');
});

test('36. 绝不删除：完整修复后根目录文件数只增不减', async (t) => {
  const root = await bootVault(t);
  await writeText(path.join(root, '.jkkb', 'store', 'cards', 'bad.json'), '{');
  await writeText(path.join(root, '.jkkb', 'lock.json'), '{');
  await fs.rm(path.join(root, '07_素材与组件'), { recursive: true, force: true });
  const before = await countFiles(root);
  await repair({ root, now: NOW, repairIds: await allRepairIds() });
  const after = await countFiles(root);
  assert.ok(after >= before, `修复后文件数 ${after} < ${before}`);
});

test('37. 不碰用户笔记：修复前后 md 内容哈希与 mtime 不变（派生索引除外）', async (t) => {
  const root = await bootVault(t);
  const note = path.join(root, '06_知识与模型', 'user-note.md');
  await writeText(note, '---\ntitle: 用户笔记\n---\n\n正文不可改\n');
  await fs.rm(path.join(root, '07_素材与组件'), { recursive: true, force: true });
  await writeText(path.join(root, '.jkkb', 'store', 'skills', 'x.json'), '{');
  const before = await snapshot(root);
  await repair({ root, now: NOW, repairIds: await allRepairIds() });
  const after = await snapshot(root);
  const noteRel = path.relative(root, note);
  assert.deepEqual(after.get(noteRel), before.get(noteRel), '用户笔记被改动');
});

test('38. DUP-01：重复编号只告警不修', async (t) => {
  const root = await bootVault(t);
  await writeJson(path.join(root, '.jkkb', 'store', 'cards', 'a.json'), { id: 'DUP-1' });
  await writeJson(path.join(root, '.jkkb', 'store', 'reports', 'b.json'), { id: 'DUP-1' });
  const r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'DUP-01').level, 'warn');
  assert.ok(check(r, 'DUP-01').detail.includes('DUP-1'));
});

test('39. QUAR-01：隔离区有未处理项 → warn，列出最近条目', async (t) => {
  const root = await bootVault(t);
  await writeText(path.join(quarantineRoot(root), '20261017-120000', 'x.json'), '{}');
  const r = await diagnose({ root, now: NOW });
  assert.equal(check(r, 'QUAR-01').level, 'warn');
  assert.ok(check(r, 'QUAR-01').detail.includes('x.json'));
});

test('40. repair 未知 repairId 抛 UNKNOWN_REPAIR', async (t) => {
  const root = await bootVault(t);
  await assert.rejects(
    () => repairOnce(root, ['R-NOPE']),
    (err) => err.code === 'UNKNOWN_REPAIR',
  );
});

test('41. diagnose 零写入：前后整棵树（含目录与 .jkkb/doctor）mtime 快照完全一致', async (t) => {
  const root = await bootVault(t);
  const before = await snapshotAll(root);
  await diagnose({ root, now: NOW });
  const after = await snapshotAll(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, snap] of before) assert.deepEqual(after.get(rel), snap, `${rel} 被改动`);
  assert.equal(await exists(path.join(root, '.jkkb', 'doctor')), false, 'diagnose 不应创建 .jkkb/doctor');
});

test('42. repair 不写 last.json（dryRun 与真实修复都不写，宿主审计独占）', async (t) => {
  const root = await bootVault(t);
  await fs.rm(path.join(root, '07_素材与组件'), { recursive: true, force: true });

  const dry = await repair({ root, now: NOW, repairIds: ['R-DIR-01'], dryRun: true });
  assert.equal(dry.planned.length, 1);
  assert.deepEqual(dry.applied, []);
  await assertNoLastReport(root);

  const real = await repair({ root, now: NOW, repairIds: ['R-DIR-01'] });
  assert.equal(findRepair(real, 'R-DIR-01').status, 'applied');
  assert.ok(await exists(path.join(root, '07_素材与组件')));
  await assertNoLastReport(root);
  assert.equal(await exists(path.join(root, '.jkkb', 'doctor')), false, 'repair 不应创建 .jkkb/doctor');
});
