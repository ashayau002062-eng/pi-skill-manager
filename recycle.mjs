import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeRelative, readBounded } from './bundles.mjs';
import { AppError } from './errors.mjs';

const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs];
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function plain(file, directory) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || key(fs.realpathSync(file)) !== key(file)) throw new AppError('回收站路径是链接或不再是普通文件／目录，拒绝操作。', 409);
  return stat;
}
export function readDeletionRecord(root, archiveRoot, container) {
  plain(path.dirname(root), true);
  plain(archiveRoot, true);
  plain(container, true);
  const recordPath = path.join(container, 'deletion-record.json');
  const recordStat = plain(recordPath, false);
  if (recordStat.size > 64 * 1024) throw new AppError('删除记录过大。');
  const raw = readBounded(recordPath, 64 * 1024).toString('utf8');
  let record;
  try { record = JSON.parse(raw); } catch { throw new AppError('删除记录损坏。'); }
  if (record.version !== 1 || typeof record.directorySkill !== 'boolean' || typeof record.name !== 'string' || !record.name || record.name.length > 200 || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || typeof record.originalPath !== 'string' || typeof record.archivedTo !== 'string' || !/^[a-f0-9]{64}$/.test(record.skillRevision)) throw new AppError('删除记录格式无效。');
  const leaf = path.basename(record.originalPath);
  safeRelative(leaf);
  if (key(path.dirname(record.originalPath)) !== key(root) || (!record.directorySkill && (!/\.md$/i.test(leaf) || leaf.toLowerCase() === 'skill.md'))) throw new AppError('删除记录的原位置不在允许的直属 Skill 范围内。');
  const archivedTo = path.join(container, leaf);
  if (key(record.archivedTo) !== key(archivedTo)) throw new AppError('删除记录的备份位置不匹配。');
  return { record, raw, archivedTo, recordPath, leaf };
}
function recordAt(root, archiveRoot, container) {
  const { record, raw, archivedTo, recordPath, leaf } = readDeletionRecord(root, archiveRoot, container);
  // Missing payloads are old restored records or interrupted deletions, not active trash.
  if (!exists(archivedTo)) return null;
  const stat = plain(archivedTo, record.directorySkill);
  const skillFile = record.directorySkill ? path.join(archivedTo, 'SKILL.md') : archivedTo;
  const skillStat = plain(skillFile, false);
  if (skillStat.size > 1024 * 1024) throw new AppError('备份正文超过 1 MiB，请手动恢复。');
  const skillData = readBounded(skillFile, 1024 * 1024);
  const contentHash = hash(skillData.toString('utf8'));
  if (contentHash !== record.skillRevision) throw new AppError('备份正文已改变，请核对后手动恢复。');
  const id = hash(key(container));
  const token = hash(JSON.stringify([raw, stamp(stat), stamp(skillStat), hash(skillData)]));
  return { id, token, name: record.name, at: record.at, originalPath: path.join(root, leaf), archivedTo, directorySkill: record.directorySkill, recordPath, root, container };
}
// Enumerate only this manager's standard roots. Records and paths remain untrusted.
export function listDeleted(roots, rows = [], protectedRoots = []) {
  const items = [];
  const diagnostics = [];
  const seen = new Set();
  let count = 0;
  for (const root of roots) {
    const archiveRoot = path.join(path.dirname(root), 'skill-manager-deleted');
    if (seen.has(key(archiveRoot))) continue;
    seen.add(key(archiveRoot));
    if (!exists(archiveRoot)) continue;
    try {
      plain(archiveRoot, true);
      for (const entry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
        if (!uuid.test(entry.name)) continue;
        if (++count > 1000) { diagnostics.push({ path: archiveRoot, message: '回收站最多显示 1000 条记录，请手动检查剩余目录。' }); break; }
        const container = path.join(archiveRoot, entry.name);
        try {
          const item = recordAt(root, archiveRoot, container);
          if (!item) continue;
          let reason = '';
          if (!exists(root)) reason = '原 skills 根目录已不存在，请先手动恢复根目录。';
          else { try { plain(root, true); } catch (e) { reason = e.message; } }
          if (exists(item.originalPath)) reason = '原位置已有文件或目录，不会覆盖。';
          else if (rows.some((row) => row.name === item.name)) reason = '当前已有同名 Skill，请先处理名称冲突。';
          if (protectedRoots.some((pkg) => { const r = path.relative(key(pkg), key(item.originalPath)); return !r || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); })) reason = '原位置当前属于扩展包，不能恢复。';
          items.push({ ...item, allowed: !reason, reason });
        } catch (e) { diagnostics.push({ path: container, message: e.message }); }
      }
    } catch (e) { diagnostics.push({ path: archiveRoot, message: e.message }); }
  }
  return { items: items.sort((a, b) => b.at.localeCompare(a.at)), diagnostics };
}
export function restoreDeleted(item, lockfile) {
  if (!item.allowed) throw new AppError(item.reason, 409);
  // Share the container lock with permanent cleanup, including across web instances.
  const releases = [];
  try {
    releases.push(lockfile.lockSync(item.container, { realpath: false, stale: 600000 }));
    releases.push(lockfile.lockSync(item.archivedTo, { realpath: false }));
  } catch (e) {
    for (const unlock of releases.toReversed()) { try { unlock(); } catch (cleanup) { console.error(cleanup); } }
    throw e;
  }
  const release = () => {
    const errors = [];
    for (const unlock of releases.toReversed()) { try { unlock(); } catch (e) { errors.push(e.message); } }
    if (errors.length) throw new Error(errors.join('；'));
  };
  let restored = false;
  let warning = null;
  let reservation;
  try {
    const fresh = recordAt(item.root, path.dirname(item.container), item.container);
    if (!fresh || fresh.token !== item.token) throw new AppError('备份已改变，请刷新回收站后再恢复。', 409);
    plain(item.root, true);
    if (exists(item.originalPath)) throw new AppError('原位置已存在，不会覆盖。', 409);
    if (exists(item.originalPath + '.lock') || (item.directorySkill && exists(path.join(item.archivedTo, 'SKILL.md.lock')))) throw new AppError('原位置或备份正在被其他程序操作，请稍后再试。', 409);
    // Same-volume move of ALL contents, no traversal/execution, no permanent cleanup.
    // Cooperating web operations are serialized. Non-cooperating OS races are not a sandbox.
    if (item.directorySkill) {
      // Windows refuses an existing destination directory. POSIX would replace an
      // empty foreign directory: reserve our own empty destination exclusively first.
      if (process.platform !== 'win32') {
        fs.mkdirSync(item.originalPath, { mode: 0o700 });
        reservation = fs.lstatSync(item.originalPath);
      }
      fs.renameSync(item.archivedTo, item.originalPath);
      restored = true;
    } else {
      // Exclusive hardlink publication prevents replacing a concurrently created file.
      const owned = fs.lstatSync(item.archivedTo);
      fs.linkSync(item.archivedTo, item.originalPath);
      restored = true;
      try {
        const current = fs.lstatSync(item.archivedTo);
        if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('归档文件被外部替换，保留并请手动检查');
        fs.unlinkSync(item.archivedTo);
      } catch (e) { warning = `文件已恢复，但归档副本未清理：${e.message}`; }
    }
  } finally {
    if (!restored && reservation) {
      try {
        const current = fs.lstatSync(item.originalPath);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === reservation.dev && current.ino === reservation.ino) fs.rmdirSync(item.originalPath); // never erase foreign contents
      } catch (e) { if (e.code !== 'ENOENT') console.error(`恢复未完成，原位置暂存目录保留供检查：${e.message}`); }
    }
    try { release(); } catch (e) { if (!restored) console.error(e); else warning = [warning, `文件已恢复，但锁清理失败：${e.message}`].filter(Boolean).join(' '); }
  }
  return { restored: true, name: item.name, path: item.originalPath, warning };
}
