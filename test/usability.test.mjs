import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';
import { lockfile } from '../pi-adapter.mjs';
import { PURGE_ONE_CONFIRMATION } from '../purge.mjs';
import { listAttachments } from '../attachments.mjs';
const text = name => `---\nname: ${name}\ndescription: fixture\n---\n正文\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-usability-'));
  const home = process.env.HOME; process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const add = name => write(path.join(agentDir, 'skills', name, 'SKILL.md'), text(name));
  return { root, agentDir, cwd, write, add, m: new SkillManager({ agentDir, cwd, project: true }) };
}
async function prepare(f, name) {
  const snapshot = await f.m.list(); const row = snapshot.skills.find(row => row.name === name);
  const relative = path.relative(f.root, fs.realpathSync(row.path)); assert(!relative.startsWith('..') && !path.isAbsolute(relative));
  return { snapshot, row, detail: await f.m.detail(row.id) };
}
async function remove(f, name) { const p = await prepare(f, name); return f.m.delete(p.row.id, p.detail.revision, name, p.detail.deletion.token); }
const change = (m, ids, revision, fields = {}) => m.batchOrganize(ids, { groupMode: 'keep', group: '', tagMode: 'add', tags: ['新增'], preferencesRevision: revision, ...fields });
test('附件目录树只读，保留中文/BOM/CRLF，脚本与HTML仅文本；不读.git/modules', async t => {
  const f = fixture(t); const file = f.add('alpha'); const body = '\uFEFF<script>throw Error("never execute")</script>\r\n中文\r\n';
  f.write(path.join(path.dirname(file), 'references/中文.md'), body); f.write(path.join(path.dirname(file), 'scripts/a.js'), 'throw Error("never execute")'); f.write(path.join(path.dirname(file), '.git/config'), 'secret'); f.write(path.join(path.dirname(file), 'node_modules/a.js'), 'secret');
  const p = await prepare(f, 'alpha'); const listing = await f.m.attachments(p.row.id); assert.deepEqual(listing.items.map(i => i.path), ['references', 'references/中文.md', 'scripts', 'scripts/a.js']);
  const item = listing.items.find(i => i.path.endsWith('.md')); const result = await f.m.attachment(p.row.id, item.path, item.revision); assert.equal(result.text, body); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert(!fs.existsSync(f.m.preferencesPath));
});
test('附件二进制/非UTF8/大文件只给元数据，文本旧版本拒绝，无任意绝对/相对越界读取', async t => {
  const f = fixture(t); const file = f.add('alpha'); for (const [name, body] of [['binary.bin', Buffer.from([0, 255])], ['large.txt', Buffer.alloc(1024 * 1024 + 1)], ['a.txt', 'before']]) f.write(path.join(path.dirname(file), name), body);
  const p = await prepare(f, 'alpha'); const listing = await f.m.attachments(p.row.id);
  for (const name of ['binary.bin', 'large.txt']) { const item = listing.items.find(i => i.path === name); const result = await f.m.attachment(p.row.id, name, item.revision); assert.equal(result.text, null); assert(result.reason); }
  const item = listing.items.find(i => i.path === 'a.txt'); f.write(path.join(path.dirname(file), 'a.txt'), 'changed'); await assert.rejects(f.m.attachment(p.row.id, item.path, item.revision), /已改变/);
  for (const relative of ['../settings.json', f.m.settingsPath('global'), 'C:/Windows/win.ini', '.git/config', 'references/../../secret', 'a.txt:stream']) await assert.rejects(f.m.attachment(p.row.id, relative, item.revision));
});
test('附件junction与链接Skill拒绝，独立MD不会浏览共享父目录', async t => {
  const f = fixture(t); const file = f.add('alpha'); const outside = path.join(f.root, 'outside'); f.write(path.join(outside, 'secret.txt'), 'secret'); fs.symlinkSync(outside, path.join(path.dirname(file), 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const p = await prepare(f, 'alpha'); const listing = await f.m.attachments(p.row.id); assert.equal(listing.items.length, 0); assert(listing.diagnostics.length); await assert.rejects(f.m.attachment(p.row.id, 'link/secret.txt', 'bad'));
  f.write(path.join(f.agentDir, 'skills/single.md'), text('single')); const single = await prepare(f, 'single'); const empty = await f.m.attachments(single.row.id); assert.equal(empty.items.length, 0); assert.match(empty.warning, /独立/); await assert.rejects(f.m.attachment(single.row.id, 'alpha/SKILL.md', p.detail.revision), /独立/);
});
test('附件根目录junction拒绝，不读取实际目标目录的文件', async t => {
  const f = fixture(t); const file = f.add('alpha'); const original = path.dirname(file); const moved = original + '-real'; fs.renameSync(original, moved); fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => listAttachments(file), /链接/); assert.equal(fs.readFileSync(path.join(moved, 'SKILL.md'), 'utf8'), text('alpha'));
});
test('附件列出后打开前的竞态改动由第二次版本检查拒绝（lstat注入）', async t => {
  const f = fixture(t); const file = f.add('alpha'); const asset = f.write(path.join(path.dirname(file), 'a.txt'), 'before'); const p = await prepare(f, 'alpha'); const item = (await f.m.attachments(p.row.id)).items[0]; const original = fs.lstatSync; let calls = 0;
  fs.lstatSync = (file, ...args) => { if (file === asset && ++calls === 3) fs.writeFileSync(asset, 'changed'); return original(file, ...args); };
  try { await assert.rejects(f.m.attachment(p.row.id, item.path, item.revision), /打开前改变/); } finally { fs.lstatSync = original; }
});
test('附件流式枚举限2000/显示1000，规模注入不执行脚本或写文件', async t => {
  const f = fixture(t); const file = f.add('alpha'); const p = await prepare(f, 'alpha'); const original = fs.opendirSync; let reads = 0;
  fs.opendirSync = (dir, ...args) => dir === path.dirname(file) ? { readSync: () => ({ name: `missing-${reads++}` }), closeSync: () => {} } : original(dir, ...args);
  try { const result = await f.m.attachments(p.row.id); assert.equal(reads, 2001); assert(result.diagnostics.length <= 51); assert(result.diagnostics.some(i => i.message.includes('2000'))); } finally { fs.opendirSync = original; }
  assert(fs.existsSync(file));
});
test('附件枚举恰好2000项跳过非空子目录时显式警告，诊断满额亦不隐去顶层提示', async t => {
  const f = fixture(t); const file = f.add('alpha'); const folder = path.join(path.dirname(file), 'a-folder'); f.write(path.join(folder, 'visible.txt'), 'content'); const p = await prepare(f, 'alpha'); const original = fs.opendirSync; let reads = 0; let childReads = 0;
  fs.opendirSync = (dir, ...args) => dir === path.dirname(file) ? { readSync: () => reads < 2000 ? { name: reads++ === 0 ? 'a-folder' : `z-missing-${reads}` } : null, closeSync: () => {} } : (childReads++, original(dir, ...args));
  try { const result = await f.m.attachments(p.row.id); assert.equal(reads, 2000); assert.equal(childReads, 0); assert(result.items.some(i => i.path === 'a-folder' && i.directory)); assert(result.diagnostics.some(i => i.path === 'a-folder' && /不能视为空目录/.test(i.message))); assert(result.truncated); assert.match(result.warning, /不能将空树/); assert(result.diagnostics.length <= 51); } finally { fs.opendirSync = original; }
  assert.equal(fs.readFileSync(path.join(folder, 'visible.txt'), 'utf8'), 'content');
});
test('备注版1偏好兼容，多行原样、未知字段和收藏保留，重启持久，不改Skill/Pi', async t => {
  const f = fixture(t); const file = f.add('alpha'); const config = f.write(f.m.settingsPath('global'), '{"other":42}'); let p = await prepare(f, 'alpha'); f.write(f.m.preferencesPath, JSON.stringify({ version: 1, favorites: [p.row.id], future: 42 })); p = await prepare(f, 'alpha');
  const result = await f.m.note(p.row.id, '用途\n<script>not html</script>\t尾', p.snapshot.preferencesRevision); assert.equal(result.saved, true); assert.equal(result.warning, null);
  const next = await new SkillManager({ agentDir: f.agentDir, cwd: f.cwd }).list(); const row = next.skills.find(r => r.id === p.row.id); assert.equal(row.note, '用途\n<script>not html</script>\t尾'); assert(row.favorite); assert.equal(JSON.parse(fs.readFileSync(f.m.preferencesPath)).future, 42);
  assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert.equal(fs.readFileSync(config, 'utf8'), '{"other":42}');
  await f.m.note(row.id, '', next.preferencesRevision); assert.equal((await f.m.list()).skills.find(r => r.id === row.id).note, '');
});
test('备注/偏好旧revision、控制字符、限额及损坏已有notes拒写且不覆盖', async t => {
  const f = fixture(t); f.add('alpha'); const p = await prepare(f, 'alpha');
  for (const value of ['x'.repeat(10001), 'nul\0', 'escape\x1b', null]) await assert.rejects(f.m.note(p.row.id, value, p.snapshot.preferencesRevision));
  await f.m.note(p.row.id, 'saved', p.snapshot.preferencesRevision); const before = fs.readFileSync(f.m.preferencesPath); await assert.rejects(f.m.note(p.row.id, 'stale', p.snapshot.preferencesRevision), /其他窗口/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
  f.write(f.m.preferencesPath, JSON.stringify({ version: 1, favorites: [], notes: { [p.row.id]: {} } })); const bad = fs.readFileSync(f.m.preferencesPath); const snapshot = await f.m.list(); assert(snapshot.preferencesError); await assert.rejects(f.m.note(p.row.id, 'new', snapshot.preferencesRevision), /收藏配置/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), bad);
});
test('批量统一分组/追加/移除/替换标签，独立保留备注/收藏/未知成员；一次整批原子写入', async t => {
  const f = fixture(t); f.add('alpha'); f.add('beta'); let p = await prepare(f, 'alpha'); await f.m.note(p.row.id, 'keep note', p.snapshot.preferencesRevision); p = await prepare(f, 'alpha'); await f.m.organize(p.row.id, 'old', ['已有'], p.snapshot.preferencesRevision);
  let s = await f.m.list(); const ids = s.skills.map(r => r.id); let result = await change(f.m, ids, s.preferencesRevision, { groupMode: 'set', group: '统一' }); assert.equal(result.count, 2); assert(result.snapshot.skills.every(r => r.group === '统一')); assert.equal(result.snapshot.skills.find(r => r.name === 'alpha').note, 'keep note');
  s = result.snapshot; result = await change(f.m, ids, s.preferencesRevision, { tagMode: 'remove', tags: ['已有'] }); assert(result.snapshot.skills.every(r => !r.tags.includes('已有')));
  s = result.snapshot; result = await change(f.m, ids, s.preferencesRevision, { tagMode: 'replace', tags: [], groupMode: 'set', group: '' }); assert(result.snapshot.skills.every(r => r.tags.length === 0 && !r.group));
});
test('批量任一无效/重复/消失/过多选择、错误模式/字段或标签超限整批拒绝', async t => {
  const f = fixture(t); f.add('alpha'); f.add('beta'); const p = await prepare(f, 'alpha'); await f.m.organize(p.row.id, '原分组', Array.from({ length: 20 }, (_, i) => `tag${i}`), p.snapshot.preferencesRevision); const s = await f.m.list(); const ids = s.skills.map(r => r.id); const before = fs.readFileSync(f.m.preferencesPath);
  for (const selection of [[], [ids[0], ids[0]], [...ids, '0'.repeat(64)], Array(101).fill(ids[0])]) await assert.rejects(change(f.m, selection, s.preferencesRevision));
  for (const fields of [{ groupMode: 'bad' }, { tagMode: 'bad' }, { group: 'x'.repeat(61) }, { tags: ['x'.repeat(33)] }, { tagMode: 'keep' }]) await assert.rejects(change(f.m, ids, s.preferencesRevision, fields));
  await assert.rejects(change(f.m, ids, s.preferencesRevision), /整批未保存/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('批量旧偏好版本拒写，其他窗口备注未丢失；保存后刷新/锁清理失败明确已保存', async t => {
  const f = fixture(t); f.add('alpha'); const p = await prepare(f, 'alpha'); await f.m.note(p.row.id, 'other window', p.snapshot.preferencesRevision); await assert.rejects(change(f.m, [p.row.id], p.snapshot.preferencesRevision), /其他窗口/);
  const s = await f.m.list(); const originalLock = lockfile.lockSync; lockfile.lockSync = (...args) => { const release = originalLock(...args); return () => { release(); throw Error('release failure'); }; };
  const list = f.m.list.bind(f.m); let calls = 0; f.m.list = async () => { if (++calls > 1) throw Error('refresh failure'); return list(); };
  try { const result = await change(f.m, [p.row.id], s.preferencesRevision); assert.equal(result.saved, true); assert.match(result.warning, /已保存/); assert.equal(result.snapshot, null); assert.equal(JSON.parse(fs.readFileSync(f.m.preferencesPath)).notes[p.row.id], 'other window'); } finally { lockfile.lockSync = originalLock; }
});
test('2MiB偏好写入限额拒绝，不丢失未知字段', async t => {
  const f = fixture(t); f.add('alpha'); let p = await prepare(f, 'alpha'); f.write(f.m.preferencesPath, JSON.stringify({ version: 1, favorites: [], future: 'x'.repeat(2 * 1024 * 1024) })); p = await prepare(f, 'alpha'); const before = fs.readFileSync(f.m.preferencesPath);
  await assert.rejects(f.m.note(p.row.id, 'new', p.snapshot.preferencesRevision), /2 MiB/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('单条永久删除只删除选定备份，其他备份/原位/偏好完整不变', async t => {
  const f = fixture(t); f.add('alpha'); f.add('beta'); const a = await remove(f, 'alpha'); const b = await remove(f, 'beta'); const items = (await f.m.deleted()).items; const item = items.find(i => i.name === 'alpha'); const preview = await f.m.purgeOnePreview(item.id); assert.equal(preview.items.length, 1); assert.equal(preview.targetId, item.id); assert.equal(preview.confirmation, PURGE_ONE_CONFIRMATION);
  const result = await f.m.purgeOne(item.id, preview.token, preview.confirmation); assert.equal(result.deleted.length, 1); assert(!fs.existsSync(a.record)); assert(fs.existsSync(b.record)); assert.equal(fs.readFileSync(path.join(b.archivedTo, 'SKILL.md'), 'utf8'), text('beta'));
});
test('单条缺失ID不退化为清空；其他ID/全清token/旧版本/错确认拒绝', async t => {
  const f = fixture(t); f.add('alpha'); f.add('beta'); const a = await remove(f, 'alpha'); const b = await remove(f, 'beta'); const items = (await f.m.deleted()).items; const alpha = items.find(i => i.name === 'alpha'); const beta = items.find(i => i.name === 'beta'); const one = await f.m.purgeOnePreview(alpha.id); const all = await f.m.purgePreview();
  for (const id of [undefined, null, '', 'bad', '0'.repeat(64)]) { await assert.rejects(f.m.purgeOnePreview(id)); await assert.rejects(f.m.purgeOne(id, one.token, one.confirmation)); }
  await assert.rejects(f.m.purgeOne(beta.id, one.token, one.confirmation), /已改变/); await assert.rejects(f.m.purgeOne(alpha.id, all.token, one.confirmation), /已改变/); await assert.rejects(f.m.purgeTrash(one.token, all.confirmation), /已改变/); await assert.rejects(f.m.purgeOne(alpha.id, one.token, all.confirmation), /确认/);
  f.write(path.join(a.archivedTo, 'new.txt'), 'changed'); await assert.rejects(f.m.purgeOne(alpha.id, one.token, one.confirmation), /已改变/); assert(fs.existsSync(a.record) && fs.existsSync(b.record));
});
test('单条永久删除已恢复残留记录不伤原文件；无关合法备份变化不扩大选择', async t => {
  const f = fixture(t); const file = f.add('alpha'); f.add('beta'); const a = await remove(f, 'alpha'); const b = await remove(f, 'beta'); const item = (await f.m.deleted()).items.find(i => i.name === 'alpha'); await f.m.undelete(item.id, item.token); const preview = await f.m.purgeOnePreview(item.id); assert.equal(preview.items[0].active, false);
  f.write(path.join(b.archivedTo, 'new.txt'), 'foreign'); await f.m.purgeOne(item.id, preview.token, preview.confirmation); assert(!fs.existsSync(a.record)); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert(fs.existsSync(path.join(b.archivedTo, 'new.txt')));
});
test('新API同源/字段/路径守卫，附件GET返回JSON而非可执行HTML', async t => {
  const f = fixture(t); const file = f.add('alpha'); f.write(path.join(path.dirname(file), 'a.html'), '<script>bad()</script>'); const p = await prepare(f, 'alpha'); const server = createServer(f.m); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); const base = `http://127.0.0.1:${server.address().port}`;
  for (const url of ['/api/batch-organize', `/api/skills/${p.row.id}/note`, '/api/deleted/purge-one']) { const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403); }
  const listing = await (await fetch(`${base}/api/skills/${p.row.id}/attachments`)).json(); const item = listing.items.find(i => i.path === 'a.html'); const response = await fetch(`${base}/api/skills/${p.row.id}/attachment?${new URLSearchParams({ path: item.path, revision: item.revision })}`); assert.match(response.headers.get('content-type'), /application\/json/); assert.equal((await response.json()).text, '<script>bad()</script>');
  assert.equal((await fetch(base + '/api/deleted/purge-one-preview')).status, 400);
  const headers = { 'Content-Type': 'application/json', Origin: base, 'X-Skill-Manager': '1' }; const saved = await fetch(`${base}/api/skills/${p.row.id}/note`, { method: 'POST', headers, body: JSON.stringify({ note: 'HTTP', preferencesRevision: p.snapshot.preferencesRevision, path: f.root }) }); assert.equal(saved.status, 200); assert.equal((await saved.json()).saved, true); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha'));
});
