import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SkillManager } from '../manager.mjs';
import { lockfile } from '../pi-adapter.mjs';
import { createServer } from '../server.mjs';
import { PURGE_CONFIRMATION } from '../purge.mjs';
const text = (name) => `---\nname: ${name}\ndescription: fixture\n---\n正文\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-purge-'));
  const home = process.env.HOME; process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  const add = (name, base = path.join(agentDir, 'skills')) => write(path.join(base, name, 'SKILL.md'), text(name));
  return { root, cwd, agentDir, write, add, m: new SkillManager({ agentDir, cwd, project: true }) };
}
async function remove(f, name) {
  const row = (await f.m.list()).skills.find((row) => row.name === name);
  const relative = path.relative(f.root, fs.realpathSync(row.path)); assert(!relative.startsWith('..') && !path.isAbsolute(relative));
  const detail = await f.m.detail(row.id); return f.m.delete(row.id, detail.revision, name, detail.deletion.token);
}
const purge = async (m) => m.purgeTrash((await m.purgePreview()).token, PURGE_CONFIRMATION);
test('永久清空含附件/隐藏/git/modules/空目录与独立MD；不动原文件、偏好、配置与回收站根', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); f.add('keep');
  for (const name of ['.git/config', 'node_modules/a.js', '附件/中文.bin']) f.write(path.join(path.dirname(file), name), Buffer.from([0, 255]));
  fs.mkdirSync(path.join(path.dirname(file), 'empty')); f.write(path.join(f.agentDir, 'skills/single.md'), text('single'));
  const config = f.write(path.join(f.agentDir, 'settings.json'), '{"untouched":42}'); const prefs = f.write(f.m.preferencesPath, '{"version":1,"favorites":[],"future":42}');
  const a = await remove(f, 'alpha'); const b = await remove(f, 'single'); const preview = await f.m.purgePreview(); assert.equal(preview.items.length, 2); assert(!('candidates' in preview)); assert(preview.items.every(i => !Array.isArray(i.entries)));
  const result = await f.m.purgeTrash(preview.token, PURGE_CONFIRMATION); assert.equal(result.deleted.length, 2); assert.equal(result.failures.length, 0); assert.equal(result.warning, null);
  assert(!fs.existsSync(path.dirname(a.record))); assert(!fs.existsSync(path.dirname(b.record))); assert(fs.existsSync(path.dirname(path.dirname(a.record)))); assert.equal(fs.readFileSync(path.join(f.agentDir, 'skills/keep/SKILL.md'), 'utf8'), text('keep'));
  assert.equal(fs.readFileSync(config, 'utf8'), '{"untouched":42}'); assert.equal(fs.readFileSync(prefs, 'utf8'), '{"version":1,"favorites":[],"future":42}'); assert.equal((await f.m.purgePreview()).items.length, 0);
});
test('已恢复归档仅清理残留记录，恢复的文件完全不变；改过正文的合法备份也可永久删除', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const a = await remove(f, 'alpha'); const item = (await f.m.deleted()).items[0]; await f.m.undelete(item.id, item.token);
  let preview = await f.m.purgePreview(); assert.equal(preview.items[0].active, false); await purge(f.m); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert(!fs.existsSync(a.record));
  const b = await remove(f, 'alpha'); f.write(path.join(b.archivedTo, 'SKILL.md'), 'invalid changed body'); assert.equal((await f.m.deleted()).items.length, 0); preview = await f.m.purgePreview(); assert.equal(preview.items.length, 1); await purge(f.m); assert(!fs.existsSync(b.archivedTo));
});
test('已恢复但归档清理失败的独立MD硬链接，清空只移除归档名称不破坏原文件', async (t) => {
  const f = fixture(t); const file = f.write(path.join(f.agentDir, 'skills/single.md'), text('single')); const a = await remove(f, 'single'); const item = (await f.m.deleted()).items[0]; const original = fs.unlinkSync;
  fs.unlinkSync = (file, ...args) => { if (file === a.archivedTo) throw Error('cleanup failure'); return original(file, ...args); };
  try { const result = await f.m.undelete(item.id, item.token); assert.match(result.warning, /归档副本未清理/); } finally { fs.unlinkSync = original; }
  assert.equal(fs.statSync(file).ino, fs.statSync(a.archivedTo).ino); const result = await purge(f.m); assert.equal(result.deleted.length, 1); assert.equal(fs.readFileSync(file, 'utf8'), text('single')); assert(!fs.existsSync(a.record));
});
test('错误确认、旧token、预览后新建归档或修改附件都在删除前拒绝', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); let p = await f.m.purgePreview();
  await assert.rejects(f.m.purgeTrash(p.token, '清空'), /确认文字/); await assert.rejects(f.m.purgeTrash('bad', PURGE_CONFIRMATION), /未开始删除/); assert(fs.existsSync(a.archivedTo));
  f.write(path.join(a.archivedTo, 'new.bin'), 'new'); await assert.rejects(f.m.purgeTrash(p.token, PURGE_CONFIRMATION), /已改变/); assert(fs.existsSync(a.record));
  p = await f.m.purgePreview(); f.add('beta'); const b = await remove(f, 'beta'); await assert.rejects(f.m.purgeTrash(p.token, PURGE_CONFIRMATION), /已改变/); assert(fs.existsSync(a.archivedTo) && fs.existsSync(b.archivedTo));
});
test('坏记录、越界/位置篡改、非UUID文件与未知顶层内容都保留，只清理合法归档', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const root = path.dirname(path.dirname(a.record));
  f.write(path.join(root, 'unknown.txt'), 'keep'); f.write(path.join(root, randomUUID(), 'deletion-record.json'), '{bad');
  const valid = JSON.parse(fs.readFileSync(a.record));
  for (const change of [{ originalPath: path.join(f.root, 'outside/alpha') }, { archivedTo: path.join(f.root, 'outside') }]) { const dir = path.join(root, randomUUID()); f.write(path.join(dir, 'deletion-record.json'), JSON.stringify({ ...valid, ...change })); }
  f.add('beta'); const b = await remove(f, 'beta'); f.write(path.join(path.dirname(b.record), 'foreign.txt'), 'keep');
  const p = await f.m.purgePreview(); assert.equal(p.items.length, 1); assert.equal(p.diagnostics.length, 5); const result = await purge(f.m); assert.equal(result.deleted.length, 1); assert(fs.existsSync(b.archivedTo)); assert.equal(fs.readFileSync(path.join(root, 'unknown.txt'), 'utf8'), 'keep');
});
test('嵌套junction、归档容器junction及回收站根junction均拒绝，不删除目标内容', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const outside = path.join(f.root, 'outside'); f.write(path.join(outside, 'keep.txt'), 'keep');
  const junction = path.join(a.archivedTo, 'linked'); fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal((await f.m.purgePreview()).items.length, 0); await purge(f.m); assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep'); fs.unlinkSync(junction);
  const container = path.dirname(a.record); const moved = container + '-real'; fs.renameSync(container, moved); fs.symlinkSync(moved, container, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal((await f.m.purgePreview()).items.length, 0); assert(fs.existsSync(path.join(moved, 'alpha/SKILL.md'))); fs.unlinkSync(container); fs.renameSync(moved, container);
  const root = path.dirname(container); fs.renameSync(root, root + '-real'); fs.symlinkSync(root + '-real', root, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal((await f.m.purgePreview()).items.length, 0); assert(fs.existsSync(path.join(root + '-real', path.basename(container), 'alpha/SKILL.md')));
});
test('其他实例的恢复/容器锁阻止清空；获取锁后备份变动预检拒绝所有删除', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const p = await f.m.purgePreview(); const release = lockfile.lockSync(path.dirname(a.record), { realpath: false });
  try { await assert.rejects(f.m.purgeTrash(p.token, PURGE_CONFIRMATION), /改变/); const item = (await f.m.deleted()).items[0]; await assert.rejects(f.m.undelete(item.id, item.token), (e) => e.code === 'ELOCKED'); } finally { release(); }
  const fresh = await f.m.purgePreview(); const original = lockfile.lockSync; lockfile.lockSync = (...args) => { const unlock = original(...args); f.write(path.join(a.archivedTo, 'new'), 'foreign'); return unlock; };
  try { await assert.rejects(f.m.purgeTrash(fresh.token, PURGE_CONFIRMATION), /未开始删除/); } finally { lockfile.lockSync = original; } assert(fs.existsSync(a.record)); assert(fs.existsSync(path.join(a.archivedTo, 'SKILL.md')));
});
test('清理中新增文件不会被扫掉；部分删除诚实回执并保留记录，不回滚不自动重试', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); f.write(path.join(path.dirname(file), 'asset.dat'), 'fixture'); const a = await remove(f, 'alpha'); const original = fs.unlinkSync;
  fs.unlinkSync = (file, ...args) => { const result = original(file, ...args); if (file.endsWith('asset.dat')) f.write(path.join(a.archivedTo, 'new-foreign.txt'), 'foreign'); return result; };
  let result; try { result = await purge(f.m); } finally { fs.unlinkSync = original; }
  assert.equal(result.deleted.length, 0); assert.equal(result.failures.length, 1); assert(result.removedEntries > 0); assert.match(result.warning, /部分文件且无法撤销/); assert.equal(fs.readFileSync(path.join(a.archivedTo, 'new-foreign.txt'), 'utf8'), 'foreign'); assert(fs.existsSync(a.record));
});
test('完成后的锁清理故障仍返回永久清理已执行', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const original = lockfile.lockSync; lockfile.lockSync = (...args) => { const release = original(...args); return () => { release(); throw Error('release failure'); }; };
  try { const result = await purge(f.m); assert.equal(result.deleted.length, 1); assert.match(result.warning, /已执行.*release failure/); assert(!fs.existsSync(a.record)); } finally { lockfile.lockSync = original; }
});
test('显式项目清空不越界到其他作用域；超深目录保留并提示限额', async (t) => {
  const f = fixture(t); f.add('project-one', path.join(f.cwd, '.pi/skills')); const a = await remove(f, 'project-one'); const global = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd }); assert.equal((await global.purgePreview()).items.length, 0); await purge(global); assert(fs.existsSync(a.record));
  f.write(path.join(a.archivedTo, ...Array(65).fill('x'), 'file'), 'keep'); const p = await f.m.purgePreview(); assert.equal(p.items.length, 0); assert.match(p.diagnostics[0].message, /限额/); await purge(f.m); assert(fs.existsSync(a.record));
});
test('单归档扫描项数限额拒绝，不执行删除（流式枚举注入规模，非实际20000文件）', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const original = fs.opendirSync;
  fs.opendirSync = (file, ...args) => file === a.archivedTo ? { readSync: () => ({ name: 'SKILL.md' }), closeSync: () => {} } : original(file, ...args);
  try { const p = await f.m.purgePreview(); assert.equal(p.items.length, 0); assert.match(p.diagnostics[0].message, /20000/); const result = await f.m.purgeTrash(p.token, PURGE_CONFIRMATION); assert.equal(result.deleted.length, 0); } finally { fs.opendirSync = original; }
  assert(fs.existsSync(a.record)); assert(fs.existsSync(path.join(a.archivedTo, 'SKILL.md')));
});
test('大量非UUID根条目流式限2000，诊断限100+汇总，未扫描备份不删除（注入）', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const archiveRoot = path.dirname(path.dirname(a.record)); const original = fs.opendirSync; let reads = 0; let closed = false;
  fs.opendirSync = (file, ...args) => file === archiveRoot ? { readSync: () => ({ name: `unknown-${reads++}.txt` }), closeSync: () => { closed = true; } } : original(file, ...args);
  try { const p = await f.m.purgePreview(); assert.equal(reads, 2001); assert(closed); assert.equal(p.items.length, 0); assert(p.diagnostics.length <= 101); assert(p.diagnostics.some(i => i.message.includes('2000'))); assert(p.diagnostics.some(i => i.message.includes('未逐项展示'))); } finally { fs.opendirSync = original; }
  assert(fs.existsSync(a.record));
});
test('purge与restore容器锁统一600秒，原payload锁阈值不改', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const item = (await f.m.deleted()).items[0]; const original = lockfile.lockSync; const calls = [];
  lockfile.lockSync = (file, options) => { calls.push({ file, options }); return original(file, options); };
  try { await f.m.undelete(item.id, item.token); await purge(f.m); } finally { lockfile.lockSync = original; }
  const containers = calls.filter(i => i.file === path.dirname(a.record)); assert.equal(containers.length, 2); assert(containers.every(i => i.options.stale === 600000)); const payload = calls.find(i => i.file === a.archivedTo); assert.equal(payload.options.stale, undefined);
});
test('30秒删除预算到期返回未完成回执且不继续删除（单调时钟注入）', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const p = await f.m.purgePreview();
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now'); let calls = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => calls++ === 0 ? 0 : 40000 });
  try { const result = await f.m.purgeTrash(p.token, PURGE_CONFIRMATION); assert.equal(result.deleted.length, 0); assert.equal(result.removedEntries, 0); assert.match(result.failures[0].message, /30 秒/); assert(fs.existsSync(a.record)); assert(fs.existsSync(path.join(a.archivedTo, 'SKILL.md'))); }
  finally { if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete performance.now; }
});
test('最终记录unlink前再次检查预算，同步枚举耗时跨截止时保留记录（注入）', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const item = (await f.m.deleted()).items[0]; await f.m.undelete(item.id, item.token); const p = await f.m.purgePreview();
  const original = fs.opendirSync; const descriptor = Object.getOwnPropertyDescriptor(performance, 'now'); let time = 0; let opens = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => time });
  fs.opendirSync = (file, ...args) => { if (file === path.dirname(a.record) && ++opens === 5) time = 40000; return original(file, ...args); };
  // Preview scan opens container twice, locked recheck twice, then final enumeration.
  try { const result = await f.m.purgeTrash(p.token, PURGE_CONFIRMATION); assert.equal(result.deleted.length, 0); assert.equal(result.removedEntries, 0); assert.match(result.failures[0].message, /30 秒/); assert(fs.existsSync(a.record)); }
  finally { fs.opendirSync = original; if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete performance.now; }
});
test('永久清空HTTP需同源标识、完整确认与匹配token；不接受任意路径', async (t) => {
  const f = fixture(t); f.add('alpha'); const a = await remove(f, 'alpha'); const server = createServer(f.m); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); const base = `http://127.0.0.1:${server.address().port}`;
  const p = await (await fetch(base + '/api/deleted/purge-preview')).json(); assert.equal(p.items.length, 1); let response = await fetch(base + '/api/deleted/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: p.token, confirmation: PURGE_CONFIRMATION }) }); assert.equal(response.status, 403);
  response = await fetch(base + '/api/deleted/purge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Skill-Manager': '1' }, body: JSON.stringify({ token: p.token, confirmation: PURGE_CONFIRMATION, path: f.root }) }); assert.equal(response.status, 200); assert.equal((await response.json()).deleted.length, 1); assert(!fs.existsSync(a.record)); assert(fs.existsSync(f.cwd));
});
