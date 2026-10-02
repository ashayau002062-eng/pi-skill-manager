import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SkillManager, AppError } from './manager.mjs';
import { defaultAgentDir } from './pi-adapter.mjs';
import { MAX_ZIP_BYTES } from './bundles.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
async function rawBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new AppError('请求过大。', 413); }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new AppError('请求过大。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new AppError('只接受 JSON。', 415);
  const raw = await rawBody(req, 2 * 1024 * 1024);
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch { throw new AppError('无效 JSON。'); }
}
export async function systemOpenFolder(folder) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise((resolve, reject) => {
    // Hiding explorer.exe also hides its folder window; desktop windows must stay visible.
    const target = process.platform === 'win32' ? path.win32.normalize(folder) : folder;
    const child = spawn(command, [target], { shell: false, windowsHide: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', resolve);
  });
}
export function createServer(manager, { openFolder = systemOpenFolder } = {}) {
  // Serialize operations, including refresh, so one response cannot invalidate another operation's registry.
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const host = `127.0.0.1:${req.socket.localPort}`;
      const origin = `http://${host}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('拒绝非本机页面请求。', 403);
      const url = new URL(req.url, origin);
      if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-skill-manager'] !== '1')) throw new AppError('缺少同源操作标识。', 403);
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const content = await fs.readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': type });
        res.end(content);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        send(200, await serial(() => manager.list())); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/skills') {
        const data = await body(req);
        send(201, await serial(() => manager.create(data.content, data.scope))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/import') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/zip') throw new AppError('只接受 ZIP。', 415);
        const data = await rawBody(req, MAX_ZIP_BYTES);
        send(201, await serial(() => manager.importZip(data, url.searchParams.get('scope') || 'global', url.searchParams.get('name') || ''))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        send(200, await serial(() => manager.search(url.searchParams.get('q') || ''))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/deleted') {
        send(200, await serial(() => manager.deleted())); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/deleted/purge-preview') {
        send(200, await serial(() => manager.purgePreview())); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/deleted/purge') {
        const data = await body(req);
        send(200, await serial(() => manager.purgeTrash(data.token, data.confirmation))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/deleted/purge-one-preview') {
        send(200, await serial(() => manager.purgeOnePreview(url.searchParams.get('id')))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/deleted/purge-one') {
        const data = await body(req);
        send(200, await serial(() => manager.purgeOne(data.id, data.token, data.confirmation))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/organization/export') {
        const document = await serial(() => manager.organizationExport());
        res.setHeader('Content-Disposition', 'attachment; filename="skill-manager-organization.json"'); send(200, document); return;
      }
      if (req.method === 'POST' && ['/api/organization/preview', '/api/organization/import', '/api/views/save', '/api/views/delete', '/api/groups/rename'].includes(url.pathname)) {
        const data = await body(req);
        const work = { '/api/organization/preview': () => manager.organizationPreview(data.document, data.mode), '/api/organization/import': () => manager.organizationImport(data.document, data.mode, data.token), '/api/views/save': () => manager.saveView(data.id, data.name, data.filters, data.preferencesRevision), '/api/views/delete': () => manager.deleteView(data.id, data.preferencesRevision), '/api/groups/rename': () => manager.renameGroup(data.from, data.name, data.preferencesRevision) };
        send(200, await serial(work[url.pathname])); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/batch-organize') {
        const data = await body(req);
        send(200, await serial(() => manager.batchOrganize(data.ids, data))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/undelete') {
        const data = await body(req);
        send(200, await serial(() => manager.undelete(data.id, data.token))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/export-selected') {
        const data = await body(req);
        const result = await serial(() => manager.exportSelected(data.items));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${result.name}"`, 'Content-Length': result.data.length });
        res.end(result.data); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/batch-toggle') {
        const data = await body(req);
        send(200, await serial(() => manager.batchToggle(data.items, data.enabled))); return;
      }
      const match = /^\/api\/skills\/([a-f0-9]{64})(?:\/(toggle|save|restore|duplicate|favorite|open-folder|export|delete|organize|compare|note|attachments|attachment|diagnostics))?$/.exec(url.pathname);
      if (req.method === 'GET' && match?.[2] === 'export') {
        const result = await serial(() => manager.exportZip(match[1]));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${result.name}"`, 'Content-Length': result.data.length });
        res.end(result.data); return;
      }
      if (req.method === 'GET' && match?.[2] === 'diagnostics') {
        send(200, await serial(() => manager.loadingDiagnostics(match[1]))); return;
      }
      if (req.method === 'GET' && match?.[2] === 'attachments') {
        send(200, await serial(() => manager.attachments(match[1]))); return;
      }
      if (req.method === 'GET' && match?.[2] === 'attachment') {
        send(200, await serial(() => manager.attachment(match[1], url.searchParams.get('path'), url.searchParams.get('revision')))); return;
      }
      if (req.method === 'GET' && match && !match[2]) {
        send(200, await serial(() => manager.detail(match[1]))); return;
      }
      if (req.method === 'POST' && match && match[2]) {
        const data = await body(req);
        const operations = {
          toggle: () => manager.toggle(match[1], data.enabled, data.configRevision),
          save: () => manager.save(match[1], data.content, data.revision),
          restore: () => manager.restore(match[1], data.name, data.revision),
          duplicate: () => manager.duplicate(match[1], data.name, data.scope, data.revision),
          favorite: () => manager.favorite(match[1], data.favorite),
          organize: () => manager.organize(match[1], data.group, data.tags, data.preferencesRevision),
          note: () => manager.note(match[1], data.note, data.preferencesRevision),
          compare: () => manager.compare(match[1], data),
          delete: () => manager.delete(match[1], data.revision, data.confirmation, data.deleteToken),
          'open-folder': async () => { const folder = await manager.folder(match[1]); await openFolder(folder); return { requested: true, path: folder }; },
        };
        if (!operations[match[2]]) throw new AppError('接口不存在。', 404);
        send(match[2] === 'duplicate' ? 201 : 200, await serial(operations[match[2]])); return;
      }
      throw new AppError('页面或接口不存在。', 404);
    } catch (error) {
      if (error instanceof AppError) send(error.status, { error: error.message });
      else {
        console.error(error);
        send(500, { error: '操作失败，未确认完成。请查看启动窗口中的错误信息。' });
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
    return args[index + 1];
  };
  try {
    const port = Number(option('--port', '3470'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间。');
    const projectPath = option('--project', null);
    const cwd = projectPath ? path.resolve(projectPath) : process.cwd();
    const cwdStat = await fs.stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error('项目目录不存在。');
    const manager = new SkillManager({ agentDir: option('--agent-dir', defaultAgentDir), cwd, project: Boolean(projectPath) });
    const initial = await manager.list();
    const server = createServer(manager);
    server.on('error', (error) => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Pi Skill 管理器：http://127.0.0.1:${port}`);
      console.log(`${projectPath ? `项目视图：${cwd}（Pi 中仍需自行信任该项目）` : '个人全局视图'}，发现 ${initial.skills.length} 个 Skill。`);
      console.log('只监听本机。关闭此窗口或按 Ctrl+C 停止。修改后在 Pi 执行 /reload。');
      if (args.includes('--open')) {
        const url = `http://127.0.0.1:${port}`;
        let child;
        if (process.platform === 'win32') child = spawn('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
        else child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
        child.on('error', () => console.error(`浏览器未能自动打开，请手动访问 ${url}`));
      }
    });
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { console.error(`启动失败：${error.message}`); process.exitCode = 1; }
}
