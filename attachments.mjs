import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeRelative, readBounded } from './bundles.mjs';
import { AppError } from './errors.mjs';
const key = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const hash = data => createHash('sha256').update(data).digest('hex');
const stamp = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
const ignored = new Set(['.git', 'node_modules']);
function ordinary(file, directory) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || key(fs.realpathSync(file)) !== key(file)) throw new AppError('附件路径含链接／junction 或非普通文件，拒绝读取。', 409);
  return stat;
}
function rootOf(skillFile) {
  ordinary(skillFile, false);
  if (path.basename(skillFile) !== 'SKILL.md') return null;
  const root = path.dirname(skillFile); ordinary(root, true); return root;
}
function scopedFile(root, relative) {
  safeRelative(relative);
  let file = root;
  for (const [index, part] of relative.split('/').entries()) {
    if (ignored.has(part.toLowerCase())) throw new AppError('不浏览 .git 或 node_modules。', 403);
    file = path.join(file, part);
    ordinary(file, index < relative.split('/').length - 1);
  }
  return file;
}
export function listAttachments(skillFile) {
  const root = rootOf(skillFile);
  if (!root) return { items: [], diagnostics: [], warning: '独立 Markdown 只管理自身，不浏览同目录的无关文件。' };
  const items = []; const diagnostics = []; let reads = 0; let omitted = 0; let truncated = false;
  const warn = (relative, message) => { if (diagnostics.length < 50) diagnostics.push({ path: relative, message }); else omitted++; };
  const limit = (relative, message) => { truncated = true; warn(relative, message); };
  function walk(directory, prefix = '') {
    ordinary(directory, true);
    const handle = fs.opendirSync(directory);
    const names = [];
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (++reads > 2000) { limit(prefix, '目录枚举达到 2000 项，剩余附件未显示。'); break; }
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    for (const name of names.sort()) {
      if (ignored.has(name.toLowerCase()) || (!prefix && name === 'SKILL.md')) continue;
      if (items.length >= 1000) { limit(prefix, '最多显示 1000 个附件文件／目录，剩余内容未显示。'); break; }
      const relative = prefix + name;
      try {
        safeRelative(relative);
        const file = path.join(directory, name); const stat = fs.lstatSync(file); const directoryEntry = stat.isDirectory();
        ordinary(file, directoryEntry);
        items.push({ path: relative, directory: directoryEntry, bytes: directoryEntry ? 0 : stat.size, revision: hash(JSON.stringify([relative, stamp(stat)])) });
        if (directoryEntry) {
          if (reads >= 2000) limit(relative, '目录枚举达到 2000 项，未浏览此目录内部；不能视为空目录。');
          else walk(file, relative + '/');
        }
      } catch (e) { warn(relative, e.message); }
    }
  }
  walk(root);
  if (omitted) diagnostics.push({ path: '', message: `另有 ${omitted} 条警告未逐项展示。` });
  return { items, diagnostics, truncated, warning: (truncated ? '部分附件因枚举／展示限额未显示；不能将空树视为没有内容。' : '') + '只读浏览；不执行脚本，不渲染 HTML／SVG，不加载外链。跳过 .git 与 node_modules；文本预览限 1 MiB。' };
}
export function readAttachment(skillFile, relative, expected) {
  const root = rootOf(skillFile);
  if (!root) throw new AppError('独立 Markdown 没有受管理的附件目录。', 403);
  const listing = listAttachments(skillFile);
  const item = listing.items.find(item => item.path === relative && !item.directory);
  if (!item) throw new AppError('附件未列出或不在当前 Skill 的安全范围内。', 404);
  if (typeof expected !== 'string' || item.revision !== expected) throw new AppError('附件已改变，请刷新附件列表后重新打开。', 409);
  const file = scopedFile(root, relative); const before = ordinary(file, false);
  if (hash(JSON.stringify([relative, stamp(before)])) !== expected) throw new AppError('附件在打开前改变，请刷新后重新选择。', 409);
  const metadata = { path: relative, bytes: before.size, revision: item.revision };
  if (before.size > 1024 * 1024) return { ...metadata, text: null, reason: '超过 1 MiB，只展示文件信息。' };
  const data = readBounded(file, 1024 * 1024);
  scopedFile(root, relative);
  if (JSON.stringify(stamp(ordinary(file, false))) !== JSON.stringify(stamp(before))) throw new AppError('读取期间附件改变，请刷新。', 409);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { return { ...metadata, text: null, reason: '不是有效 UTF-8 文本，只展示文件信息。' }; }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return { ...metadata, text: null, reason: '二进制或含非文本控制字符，只展示文件信息。' };
  return { ...metadata, text, reason: null };
}
