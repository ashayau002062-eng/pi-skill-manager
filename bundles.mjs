import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { AppError } from './errors.mjs';

export const MAX_FILES = 1000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_BYTES = 52 * 1024 * 1024;
const ignored = new Set(['.git', 'node_modules']);
export function safeRelative(name) {
  if (typeof name !== 'string' || name.length > 512 || name.split('/').length > 32 || !name || name.includes('\\')) throw new AppError('文件路径过长、过深或不安全。');
  for (const segment of name.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) throw new AppError(`不安全或 Windows 不支持的路径：${name}`);
  }
  return name;
}
// Validate the complete manifest before any target directory is created.
export function validateFiles(files, requireSkill = true) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new AppError(`最多支持 ${MAX_FILES} 个文件/目录。`);
  const paths = new Map();
  const spellings = new Map();
  let total = 0;
  for (const file of files) {
    safeRelative(file.path);
    const segments = file.path.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const spelling = segments.slice(0, i).join('/');
      const folded = spelling.normalize('NFC').toLowerCase();
      if (spellings.has(folded) && spellings.get(folded) !== spelling) throw new AppError(`大小写或 Unicode 冲突的目录/路径：${file.path}`);
      spellings.set(folded, spelling);
    }
    const normalized = file.path.normalize('NFC').toLowerCase();
    if (paths.has(normalized)) throw new AppError(`重复或大小写冲突的路径：${file.path}`);
    paths.set(normalized, file.data === null ? 'directory' : 'file');
    if (file.data !== null && !Buffer.isBuffer(file.data)) throw new AppError('文件数据无效。');
    if (file.data?.length > MAX_FILE_BYTES) throw new AppError('单文件不能超过 20 MiB。');
    total += file.data?.length || 0;
    if (total > MAX_TOTAL_BYTES) throw new AppError('文件总大小不能超过 50 MiB。');
  }
  for (const [name] of paths) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.get(parts.join('/')) === 'file') throw new AppError('文件与目录的路径冲突。');
    }
  }
  if (requireSkill && !files.some((file) => file.path === 'SKILL.md' && Buffer.isBuffer(file.data))) throw new AppError('需要一个根目录 SKILL.md。');
  return files;
}
export function readBounded(file, maxBytes = MAX_FILE_BYTES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new AppError(`仅支持普通文件，单文件不能超过 ${maxBytes / 1024 / 1024} MiB。`);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw new AppError('读取期间文件改变，请重试。', 409);
      offset += read;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw new AppError('读取期间文件改变，请重试。', 409);
    return data;
  } finally { fs.closeSync(fd); }
}
export function collectFiles(skillFile) {
  if (fs.lstatSync(skillFile).isSymbolicLink()) throw new AppError('不打包符号链接 Skill。');
  // Standalone Markdown Skills do NOT inherit all unrelated files in their parent.
  if (path.basename(skillFile) !== 'SKILL.md') return validateFiles([{ path: 'SKILL.md', data: readBounded(skillFile) }]);
  const root = path.dirname(skillFile);
  if (fs.lstatSync(root).isSymbolicLink()) throw new AppError('不打包符号链接或 junction 目录。');
  const canonical = fs.realpathSync(root);
  const files = [];
  let total = 0;
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name.toLowerCase())) continue;
      const relative = safeRelative(prefix + entry.name);
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new AppError(`不打包符号链接或 junction：${relative}`);
      const real = fs.realpathSync(file);
      const within = path.relative(canonical, real);
      if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) throw new AppError('文件越出 Skill 目录，未打包。');
      if (files.length >= MAX_FILES) throw new AppError(`最多支持 ${MAX_FILES} 个文件/目录。`);
      if (stat.isDirectory()) {
        files.push({ path: relative, data: null });
        walk(file, relative + '/');
      } else if (stat.isFile()) {
        if (total + stat.size > MAX_TOTAL_BYTES) throw new AppError('文件总大小不能超过 50 MiB。');
        const data = readBounded(file);
        total += data.length;
        if (total > MAX_TOTAL_BYTES) throw new AppError('文件总大小不能超过 50 MiB。');
        files.push({ path: relative, data });
      } else throw new AppError(`不打包特殊文件：${relative}`);
    }
  }
  walk(root);
  return validateFiles(files);
}
export async function encodeZip(files, requireSkill = true) {
  validateFiles(files, requireSkill);
  const zip = new yazl.ZipFile();
  const result = new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    zip.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_ZIP_BYTES) {
        zip.outputStream.destroy(new AppError('ZIP 不能超过 52 MiB。'));
      } else chunks.push(chunk);
    });
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  try {
    for (const file of files) {
      if (file.data === null) zip.addEmptyDirectory(file.path + '/', { mode: 0o40700 });
      else zip.addBuffer(file.data, file.path, { mode: 0o100600 });
    }
    zip.end();
  } catch (error) { zip.outputStream.destroy(error); }
  return result;
}
export async function decodeZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP_BYTES) throw new AppError('ZIP 不能超过 52 MiB。');
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount > MAX_FILES) throw new AppError(`最多支持 ${MAX_FILES} 个文件/目录。`);
    const files = [];
    let declared = 0;
    let actual = 0;
    for await (const entry of zip.eachEntry()) {
      const isDirectory = entry.fileName.endsWith('/');
      const name = safeRelative(isDirectory ? entry.fileName.slice(0, -1) : entry.fileName);
      const type = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((type && type !== 0x8000 && type !== 0x4000) || (type === 0x4000 && !isDirectory) || (type === 0x8000 && isDirectory) || (entry.generalPurposeBitFlag & 1)) throw new AppError('不接受链接、特殊文件或加密 ZIP。');
      if (entry.uncompressedSize > MAX_FILE_BYTES) throw new AppError('ZIP 内单文件不能超过 20 MiB。');
      declared += entry.uncompressedSize;
      if (declared > MAX_TOTAL_BYTES) throw new AppError('ZIP 解压后总大小不能超过 50 MiB。');
      if (isDirectory) {
        if (entry.uncompressedSize !== 0) throw new AppError('ZIP 目录包含异常数据。');
        files.push({ path: name, data: null });
        continue;
      }
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let bytes = 0;
      let checksum = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        actual += chunk.length;
        if (bytes > MAX_FILE_BYTES || actual > MAX_TOTAL_BYTES) throw new AppError('ZIP 实际解压大小超过限制。');
        checksum = crc32(chunk, checksum);
        chunks.push(chunk);
      }
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw new AppError('ZIP 文件大小或 CRC 校验失败。');
      files.push({ path: name, data: Buffer.concat(chunks) });
    }
    const candidates = files.filter((file) => file.data !== null && file.path.split('/').at(-1) === 'SKILL.md');
    const depth = Math.min(...candidates.map((file) => file.path.split('/').length));
    const roots = candidates.filter((file) => file.path.split('/').length === depth);
    if (roots.length !== 1) throw new AppError('ZIP 需要包含一个 Skill，可直接放 SKILL.md 或外包一层文件夹。');
    const prefix = roots[0].path.slice(0, -'SKILL.md'.length);
    const normalized = [];
    for (const file of files) {
      if (file.data === null && prefix.startsWith(file.path + '/')) continue;
      if (!file.path.startsWith(prefix)) throw new AppError('ZIP 含有 Skill 目录之外的文件或多个 Skill。');
      normalized.push({ ...file, path: file.path.slice(prefix.length) });
    }
    return validateFiles(normalized);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`无法读取 ZIP：${error.message}`);
  } finally { zip?.close(); }
}
export function skillText(files) {
  const file = files.find((item) => item.path === 'SKILL.md');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.data); }
  catch { throw new AppError('SKILL.md 必须是 UTF-8 文本。'); }
}
