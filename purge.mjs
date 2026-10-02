import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readDeletionRecord } from './recycle.mjs';
import { AppError } from './errors.mjs';

export const PURGE_CONFIRMATION = '永久清空回收站';
export const PURGE_ONE_CONFIRMATION = '永久删除此备份';
const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function ordinary(file, directory) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || key(fs.realpathSync(file)) !== key(file)) throw new AppError('包含链接或非普通文件／目录，保留供手动检查。', 409);
  return stat;
}
function boundedNames(file, limit, budget) {
  const directory = fs.opendirSync(file);
  const names = [];
  try {
    while (names.length < limit) {
      const entry = directory.readSync();
      if (!entry) return { names: names.sort(), truncated: false };
      if (budget && budget.readRemaining-- <= 0) throw new AppError('累计枚举达到 100000 项，剩余归档保留。', 409);
      names.push(entry.name);
    }
    const extra = directory.readSync();
    if (extra && budget && budget.readRemaining-- <= 0) throw new AppError('累计枚举达到 100000 项，剩余归档保留。', 409);
    return { names: names.sort(), truncated: Boolean(extra) };
  } finally { directory.closeSync(); }
}
function scan(root, archiveRoot, container, budget = { remaining: 100000, readRemaining: 100000 }) {
  const { record, raw, archivedTo, leaf } = readDeletionRecord(root, archiveRoot, container);
  const children = boundedNames(container, 3, budget);
  if (children.truncated || children.names.some((name) => name !== leaf && name !== 'deletion-record.json')) throw new AppError('归档顶层有未知文件或操作锁，保留供手动检查。', 409);
  const active = exists(archivedTo);
  if (active) ordinary(archivedTo, record.directorySkill);
  const entries = [];
  let bytes = 0;
  function visit(file, relative, depth) {
    if (depth > 64 || entries.length >= 20000 || budget.remaining <= 0) throw new AppError('备份超过扫描限额（单归档 20000 项／64 层，本次累计 100000 项），请手动检查。', 409);
    budget.remaining--;
    const stat = fs.lstatSync(file);
    const directory = stat.isDirectory();
    ordinary(file, directory);
    if (relative.endsWith('.lock')) throw new AppError('备份含操作锁，暂不清空。', 409);
    entries.push({ relative, directory, stamp: stamp(stat) });
    if (directory) {
      const children = boundedNames(file, Math.min(20000 - entries.length, budget.remaining), budget);
      if (children.truncated) throw new AppError('备份超过扫描项数限额（单归档 20000 项，累计 100000 项），剩余归档保留。', 409);
      for (const name of children.names) visit(path.join(file, name), relative ? path.join(relative, name) : name, depth + 1);
    } else {
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes)) throw new AppError('备份大小超出安全统计范围。', 409);
    }
  }
  visit(container, '', 0);
  const token = hash(JSON.stringify([raw, entries]));
  return { id: hash(key(container)), name: record.name, path: container, root, archiveRoot, active, bytes, entries, token };
}
// Only validated UUID containers belonging to standard roots qualify. Never erase a root.
export function previewPurge(roots, selectedId) {
  if (selectedId !== undefined && (typeof selectedId !== 'string' || !/^[a-f0-9]{64}$/.test(selectedId))) throw new AppError('无效单条归档标识。');
  const candidates = [];
  const diagnostics = [];
  let omitted = 0;
  const diagnose = (entry) => { if (diagnostics.length < 100) diagnostics.push(entry); else omitted++; };
  const seen = new Set();
  let count = 0;
  let rootEntries = 2000;
  const budget = { remaining: 100000, readRemaining: 100000 };
  for (const root of roots) {
    const archiveRoot = path.join(path.dirname(root), 'skill-manager-deleted');
    if (seen.has(key(archiveRoot))) continue;
    seen.add(key(archiveRoot));
    if (!exists(archiveRoot)) continue;
    try {
      ordinary(path.dirname(root), true);
      ordinary(archiveRoot, true);
      const enumeration = boundedNames(archiveRoot, rootEntries);
      rootEntries -= enumeration.names.length;
      if (enumeration.truncated) diagnose({ path: archiveRoot, message: '本次根目录流式枚举最多 2000 项，多余内容保留。' });
      for (const name of enumeration.names) {
        if (!uuid.test(name)) { diagnose({ path: path.join(archiveRoot, name), message: '不是本管理器 UUID 归档，保留。' }); continue; }
        if (++count > 1000) { diagnose({ path: archiveRoot, message: '最多检查 1000 个归档，剩余内容保留。' }); break; }
        const container = path.join(archiveRoot, name);
        if (selectedId && hash(key(container)) !== selectedId) continue;
        try {
          if (exists(container + '.lock')) throw new AppError('归档正在被其他程序操作，暂不清空。', 409);
          if (budget.remaining <= 0 || budget.readRemaining <= 0) { diagnose({ path: archiveRoot, message: '本次累计扫描／枚举已达 100000 项，剩余归档保留。' }); break; }
          const item = scan(root, archiveRoot, container, budget);
          candidates.push(item);
        } catch (e) { diagnose({ path: container, message: e.message }); }
      }
    } catch (e) { diagnose({ path: archiveRoot, message: e.message }); }
  }
  if (omitted) diagnostics.push({ path: '', message: `另有 ${omitted} 条警告未逐项展示，相关内容全部保留。` });
  if (selectedId && candidates.length !== 1) throw new AppError('指定备份已不存在、超出枚举范围或不能安全删除，请刷新回收站。', 409);
  const digest = [candidates.map((item) => [item.id, item.token]), diagnostics];
  const token = hash(JSON.stringify(selectedId ? [selectedId, digest] : digest));
  return { token, targetId: selectedId, confirmation: selectedId ? PURGE_ONE_CONFIRMATION : PURGE_CONFIRMATION, items: candidates.map(({ id, name, path, active, bytes, entries }) => ({ id, name, path, active, bytes, entries: entries.length })), diagnostics, candidates };
}
export function publicPurge(plan) {
  return { token: plan.token, targetId: plan.targetId, confirmation: plan.confirmation, items: plan.items, diagnostics: plan.diagnostics };
}
function sameIdentity(file, expected, directory) {
  const stat = ordinary(file, directory);
  if (stat.dev !== expected.stamp[0] || stat.ino !== expected.stamp[1]) throw new AppError('备份路径被替换，已停止清理。', 409);
  return stat;
}
function erase(item, receipt, deadline) {
  const checkTime = () => { if (performance.now() > deadline) throw new AppError('清理达到 30 秒预算，已停止；已删除内容无法撤销。', 409); };
  checkTime();
  const manifest = new Map(item.entries.map((entry) => [entry.relative, entry]));
  function parents(relative) {
    checkTime();
    ordinary(path.dirname(item.root), true);
    ordinary(item.archiveRoot, true);
    sameIdentity(item.path, manifest.get(''), true);
    let parent = path.dirname(relative);
    while (parent !== '.') {
      sameIdentity(path.join(item.path, parent), manifest.get(parent), true);
      parent = path.dirname(parent);
    }
  }
  // No recursive rm: verify every parent and unlink ordinary files only. New files
  // are never swept up; rmdir refuses nonempty directories. Records go LAST.
  const files = item.entries.filter((entry) => !entry.directory && entry.relative !== 'deletion-record.json');
  const dirs = item.entries.filter((entry) => entry.directory && entry.relative).sort((a, b) => b.relative.split(path.sep).length - a.relative.split(path.sep).length);
  for (const entry of files) {
    parents(entry.relative);
    const file = path.join(item.path, entry.relative);
    const stat = sameIdentity(file, entry, false);
    if (JSON.stringify(stamp(stat)) !== JSON.stringify(entry.stamp)) throw new AppError('备份文件在清理期间改变，已停止。', 409);
    checkTime();
    fs.unlinkSync(file); receipt.removedEntries++;
  }
  for (const entry of dirs) {
    parents(entry.relative);
    sameIdentity(path.join(item.path, entry.relative), entry, true);
    checkTime();
    fs.rmdirSync(path.join(item.path, entry.relative)); receipt.removedEntries++;
  }
  parents('deletion-record.json');
  const remaining = boundedNames(item.path, 2);
  if (remaining.truncated || remaining.names.some((name) => name !== 'deletion-record.json')) throw new AppError('清理期间出现新增内容，保留记录与剩余文件。', 409);
  const record = manifest.get('deletion-record.json');
  const recordStat = sameIdentity(path.join(item.path, record.relative), record, false);
  if (JSON.stringify(stamp(recordStat)) !== JSON.stringify(record.stamp)) throw new AppError('删除记录在清理期间改变，已停止。', 409);
  checkTime();
  fs.unlinkSync(path.join(item.path, record.relative)); receipt.removedEntries++;
  checkTime();
  fs.rmdirSync(item.path); receipt.removedEntries++;
}
export function purgeDeleted(roots, token, confirmation, lockfile, selectedId) {
  const expected = selectedId === undefined ? PURGE_CONFIRMATION : PURGE_ONE_CONFIRMATION;
  if (confirmation !== expected) throw new AppError(`请输入完整确认文字「${expected}」。`);
  const plan = previewPurge(roots, selectedId);
  if (typeof token !== 'string' || plan.token !== token) throw new AppError('回收站已改变，请刷新并重新确认；未开始删除。', 409);
  const releases = [];
  const result = { deleted: [], failures: [], diagnostics: plan.diagnostics, removedEntries: 0, warning: null };
  let started = false;
  try {
    // Shared ten-minute stale threshold: sync traversal cannot heartbeat while busy.
    for (const item of plan.candidates) releases.push(lockfile.lockSync(item.path, { realpath: false, stale: 600000 }));
    // All selected candidates must remain unchanged after taking cooperating locks.
    for (const item of plan.candidates) {
      if (scan(item.root, item.archiveRoot, item.path).token !== item.token) throw new AppError('备份已改变，请重新确认；未开始删除。', 409);
    }
    started = true;
    const deadline = performance.now() + 30000;
    for (const item of plan.candidates) {
      try { erase(item, result, deadline); result.deleted.push({ name: item.name, path: item.path }); }
      catch (e) { result.failures.push({ path: item.path, message: e.message }); }
    }
  } finally {
    const warnings = [];
    for (const release of releases.toReversed()) {
      try { release(); } catch (e) {
        if (started) warnings.push(e.message);
        else console.error(`尚未删除，但锁清理失败：${e.message}`);
      }
    }
    if (warnings.length) result.warning = `永久清理已执行，但锁清理失败：${warnings.join('；')}`;
  }
  if (result.failures.length) result.warning = [result.warning, '永久清理未全部完成，可能已删除部分文件且无法撤销。请刷新后检查剩余备份，不要重复提交旧确认。'].filter(Boolean).join(' ');
  return result;
}
