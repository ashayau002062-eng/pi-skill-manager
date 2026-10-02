import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yauzl from 'yauzl';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';
import { lockfile } from '../pi-adapter.mjs';
const text = (name, body = '正文。') => `---\nname: ${name}\ndescription: 测试\n---\n\n${body}\n`;
function fixture(t) {
  const home = process.env.HOME;
  // Keep explicit project fixtures away from the real home .agents ancestor.
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-organizing-'));
  process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const add = (name, body, base = path.join(agentDir, 'skills')) => write(path.join(base, name, 'SKILL.md'), text(name, body));
  const m = new SkillManager({ agentDir, cwd, project: true });
  return { root, agentDir, cwd, write, add, m };
}
async function prepare(m, name) {
  const snapshot = await m.list(); const row = snapshot.skills.find((r) => r.name === name);
  const relative = path.relative(path.dirname(m.agentDir), fs.realpathSync(row.path));
  assert(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'write tests must never target real personal Skills');
  return { snapshot, row, detail: await m.detail(row.id) };
}
async function remove(m, name) { const p = await prepare(m, name); return m.delete(p.row.id, p.detail.revision, name, p.detail.deletion.token); }
async function zipEntries(buffer) {
  const zip = await yauzl.fromBufferPromise(buffer);
  try { const entries = []; for await (const e of zip.eachEntry()) { const chunks = []; if (!e.fileName.endsWith('/')) { const stream = await zip.openReadStreamPromise(e); for await (const c of stream) chunks.push(c); } entries.push({ path: e.fileName, data: Buffer.concat(chunks) }); } return entries; }
  finally { zip.close(); }
}
test('回收站恢复完整目录含隐藏内容，原配置／收藏／分组沿用且不覆盖兄弟 Skill', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); f.add('beta'); const bin = Buffer.from([0, 255, 128]);
  f.write(path.join(path.dirname(file), '.git/config'), 'hidden'); f.write(path.join(path.dirname(file), 'node_modules/keep.js'), 'never run'); f.write(path.join(path.dirname(file), 'assets/中文.bin'), bin); fs.mkdirSync(path.join(path.dirname(file), 'empty'));
  const settings = f.write(f.m.settingsPath('global'), '{"untouched":42}'); let p = await prepare(f.m, 'alpha');
  await f.m.favorite(p.row.id, true); p = await prepare(f.m, 'alpha'); await f.m.organize(p.row.id, '写作', ['中文'], p.snapshot.preferencesRevision);
  const preferences = fs.readFileSync(f.m.preferencesPath); const config = fs.readFileSync(settings); const deleted = await remove(f.m, 'alpha');
  const trash = await f.m.deleted(); assert.equal(trash.items.length, 1); assert.equal(trash.items[0].allowed, true);
  const result = await f.m.undelete(trash.items[0].id, trash.items[0].token);
  assert.equal(result.restored, true); assert.equal(result.warning, null); assert.equal(result.item.favorite, true); assert.equal(result.item.group, '写作');
  assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), 'assets/中文.bin')), bin);
  assert(fs.statSync(path.join(path.dirname(file), 'empty')).isDirectory()); assert.equal(fs.readFileSync(path.join(path.dirname(file), '.git/config'), 'utf8'), 'hidden'); assert.equal(fs.readFileSync(path.join(path.dirname(file), 'node_modules/keep.js'), 'utf8'), 'never run');
  assert.deepEqual(fs.readFileSync(settings), config); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), preferences); assert(fs.existsSync(deleted.record)); assert.equal((await f.m.deleted()).items.length, 0);
  await assert.rejects(f.m.undelete(trash.items[0].id, trash.items[0].token), /不存在/);
});
test('已有原位置（含空目录）、同名其他 Skill、旧 token 均拒绝恢复', async (t) => {
  const f = fixture(t); f.add('alpha'); const deleted = await remove(f.m, 'alpha'); const item = (await f.m.deleted()).items[0];
  await assert.rejects(f.m.undelete(item.id, 'stale'), /改变/);
  fs.mkdirSync(JSON.parse(fs.readFileSync(deleted.record)).originalPath); let current = (await f.m.deleted()).items[0]; assert.equal(current.allowed, false); await assert.rejects(f.m.undelete(current.id, current.token), /覆盖/);
  fs.rmdirSync(current.originalPath); f.add('alpha', undefined, path.join(f.root, '.agents/skills')); current = (await f.m.deleted()).items[0]; assert.equal(current.allowed, false); await assert.rejects(f.m.undelete(current.id, current.token), /同名/); assert(fs.existsSync(deleted.archivedTo));
});
test('独立 Markdown 精准恢复；链接竞争不覆盖外来同名文件，原归档保留', async (t) => {
  const f = fixture(t); const file = f.write(path.join(f.agentDir, 'skills/single.md'), text('single')); f.add('other');
  const deleted = await remove(f.m, 'single'); const item = (await f.m.deleted()).items[0]; const originalLink = fs.linkSync;
  fs.linkSync = (source, target, ...args) => { f.write(target, 'foreign'); return originalLink(source, target, ...args); };
  try { await assert.rejects(f.m.undelete(item.id, item.token), /EEXIST/); } finally { fs.linkSync = originalLink; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'foreign'); assert.equal(fs.readFileSync(deleted.archivedTo, 'utf8'), text('single')); fs.unlinkSync(file);
  const fresh = (await f.m.deleted()).items[0]; const result = await f.m.undelete(fresh.id, fresh.token); assert.equal(result.restored, true); assert.equal(fs.readFileSync(file, 'utf8'), text('single')); assert(fs.existsSync(path.join(f.agentDir, 'skills/other/SKILL.md')));
});
test('篡改删除记录越界、备份位置不匹配、正文变化、归档 junction 均拒绝', async (t) => {
  const f = fixture(t); f.add('alpha'); const deleted = await remove(f.m, 'alpha'); const original = fs.readFileSync(deleted.record, 'utf8'); const parsed = JSON.parse(original);
  for (const changes of [{ originalPath: path.join(f.root, 'outside/alpha') }, { archivedTo: path.join(f.root, 'outside') }, { originalPath: path.join(f.agentDir, 'skills/SKILL.md'), directorySkill: false }]) {
    f.write(deleted.record, JSON.stringify({ ...parsed, ...changes })); const result = await f.m.deleted(); assert.equal(result.items.length, 0); assert(result.diagnostics.length); }
  f.write(deleted.record, original); f.write(path.join(deleted.archivedTo, 'SKILL.md'), text('alpha', 'changed')); assert.equal((await f.m.deleted()).items.length, 0); f.write(path.join(deleted.archivedTo, 'SKILL.md'), text('alpha'));
  const renamed = deleted.archivedTo + '-real'; fs.renameSync(deleted.archivedTo, renamed);
  try { fs.symlinkSync(renamed, deleted.archivedTo, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { t.diagnostic('junction creation denied'); return; } throw e; }
  assert.equal((await f.m.deleted()).items.length, 0); assert(fs.existsSync(path.join(renamed, 'SKILL.md')));
});
test('项目备份只在显式项目视图出现；移动失败不误报，移动后刷新／锁清理失败明确已恢复', async (t) => {
  const f = fixture(t); f.add('project-one', undefined, path.join(f.cwd, '.pi/skills')); const deleted = await remove(f.m, 'project-one');
  assert.equal((await new SkillManager({ agentDir: f.agentDir, cwd: f.cwd }).deleted()).items.length, 0); let item = (await f.m.deleted()).items[0];
  const rename = fs.renameSync; fs.renameSync = () => { throw Error('move failure'); }; try { await assert.rejects(f.m.undelete(item.id, item.token), /move failure/); } finally { fs.renameSync = rename; } assert(fs.existsSync(deleted.archivedTo));
  const originalLock = lockfile.lockSync; lockfile.lockSync = (...args) => { const release = originalLock(...args); return () => { release(); throw Error('release failure'); }; };
  const list = f.m.list.bind(f.m); let calls = 0; f.m.list = async () => { if (++calls > 1) throw Error('refresh failure'); return list(); };
  try { const result = await f.m.undelete(item.id, item.token); assert.equal(result.restored, true); assert.match(result.warning, /已恢复/); assert(fs.existsSync(result.path)); } finally { lockfile.lockSync = originalLock; }
});
test('分组标签跨实例持久化；偏好旧版兼容、未知字段保留；不改原文和 Pi 配置／胜者', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const config = f.write(f.m.settingsPath('global'), '{"other":42}'); let p = await prepare(f.m, 'alpha');
  f.write(f.m.preferencesPath, JSON.stringify({ version: 1, favorites: [p.row.id], future: 'keep' })); p = await prepare(f.m, 'alpha');
  await f.m.organize(p.row.id, '编剧', ['中文', '剧情', '中文'], p.snapshot.preferencesRevision);
  const next = await new SkillManager({ agentDir: f.agentDir, cwd: f.cwd }).list(); const row = next.skills[0]; assert.equal(row.group, '编剧'); assert.deepEqual(row.tags, ['中文', '剧情']); assert.equal(row.favorite, true); assert.equal(row.effective, true);
  assert.equal(JSON.parse(fs.readFileSync(f.m.preferencesPath)).future, 'keep'); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert.equal(fs.readFileSync(config, 'utf8'), '{"other":42}');
  await assert.rejects(f.m.organize(row.id, 'old', [], p.snapshot.preferencesRevision), /其他窗口/);
});
test('分组／标签字段限额与坏偏好拒写；新建已发布时偏好坏了仍报告创建成功', async (t) => {
  const f = fixture(t); f.add('alpha'); const p = await prepare(f.m, 'alpha');
  for (const [group, tags] of [['x'.repeat(61), []], ['ok', ['x'.repeat(33)]], ['ok', Array(21).fill('x')], ['ok', ['line\nfeed']], ['ok', {}]]) await assert.rejects(f.m.organize(p.row.id, group, tags, p.snapshot.preferencesRevision));
  f.write(f.m.preferencesPath, '{bad'); await assert.rejects(f.m.organize(p.row.id, '', [], p.snapshot.preferencesRevision), /收藏配置/);
  const created = await f.m.create(text('created')); assert.equal(created.created, true); assert.match(created.warning, /添加时间未记录/); assert.equal(fs.readFileSync(f.m.preferencesPath, 'utf8'), '{bad'); assert(fs.existsSync(created.path));
});
test('最近添加时间在编辑后保持，最近修改反映文件 mtime；列出不自动写偏好', async (t) => {
  const f = fixture(t); f.add('alpha'); let p = await prepare(f.m, 'alpha'); assert(!fs.existsSync(f.m.preferencesPath)); assert(Number.isFinite(p.row.modifiedAt)); assert(p.row.addedAt > 0);
  const originalAdded = p.row.addedAt; await f.m.save(p.row.id, text('alpha', 'edited'), p.detail.revision); p = await prepare(f.m, 'alpha'); assert.equal(p.row.addedAt, originalAdded);
  assert.equal(p.row.modifiedAt, fs.statSync(p.row.path).mtimeMs);
  const created = await f.m.create(text('new-one')); const addedAt = created.item.addedAt; const after = await f.m.save(created.item.id, text('new-one', 'more'), created.detail.revision); assert.equal(after.snapshot.skills.find((r) => r.id === created.item.id).addedAt, addedAt);
});
test('正文全文搜索中文／大小写／失效 YAML；只读且不查附件，返回原文片段', async (t) => {
  const f = fixture(t); const file = f.add('alpha', '独有的正文词汇 <script>never()</script> HelloWORLD'); f.add('beta', '其他'); f.write(path.join(path.dirname(file), 'references/secret.txt'), '附件私有词');
  f.write(path.join(f.agentDir, 'skills/broken/SKILL.md'), '---\nname: broken\ndescription: bad: yaml\n---\n独有的正文词汇');
  const result = await f.m.search('独有的正文词汇'); assert.equal(result.hits.length, 2); assert(result.hits.some((r) => r.excerpt.includes('<script>'))); assert.equal((await f.m.search('helloworld')).hits.length, 1); assert.equal((await f.m.search('附件私有词')).hits.length, 0);
  assert(!fs.existsSync(f.m.preferencesPath)); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha', '独有的正文词汇 <script>never()</script> HelloWORLD')); await assert.rejects(f.m.search('x'.repeat(201)), /200/);
});
test('正文搜索遇超大文件明确返回跳过，不默默当成无匹配', async (t) => {
  const f = fixture(t); f.add('alpha', 'needle'); f.add('large', 'needle'.repeat(200000)); const result = await f.m.search('needle'); assert.equal(result.hits.length, 1); assert.equal(result.skipped.length, 1); assert.match(result.warning, /未检索/);
});
test('草稿与历史备份差异展示只读；旧 revision／越界备份／超限拒绝，CRLF 正文规范化', async (t) => {
  const f = fixture(t); const file = f.add('alpha', 'old'); let p = await prepare(f.m, 'alpha'); const draft = text('alpha', 'new <script>never()</script>');
  const result = await f.m.compare(p.row.id, { content: draft, revision: p.detail.revision }); assert.equal(result.changed, true); assert(result.patch.hunks[0].lines.includes('-old')); assert(result.patch.hunks[0].lines.includes('+new <script>never()</script>')); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha', 'old')); assert(!fs.existsSync(f.m.preferencesPath));
  const newline = await f.m.compare(p.row.id, { content: p.detail.content.replaceAll('\n', '\r\n'), revision: p.detail.revision }); assert.equal(newline.newlineOnly, true); assert.equal(newline.patch.hunks.length, 0);
  await f.m.save(p.row.id, draft, p.detail.revision); p = await prepare(f.m, 'alpha'); const before = fs.readFileSync(file);
  const history = await f.m.compare(p.row.id, { backup: p.detail.backups[0], revision: p.detail.revision }); assert(history.patch.hunks.length); assert.deepEqual(fs.readFileSync(file), before);
  await assert.rejects(f.m.compare(p.row.id, { content: 'anything', revision: 'stale' }), /修改/); await assert.rejects(f.m.compare(p.row.id, { backup: '../../settings.json', revision: p.detail.revision }), /备份名称/); await assert.rejects(f.m.compare(p.row.id, { content: 'x'.repeat(1024 * 1024 + 1), revision: p.detail.revision }), /1 MiB/);
});
test('批量 ZIP 子目录隔离同名 Skill、二进制和空文件保留，不含绝对路径／配置／.git／node_modules', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); f.add('alpha', 'project variant', path.join(f.cwd, '.pi/skills')); f.write(path.join(path.dirname(file), 'assets/中文.bin'), Buffer.from([0, 255])); f.write(path.join(path.dirname(file), '.git/config'), 'not included'); f.write(path.join(path.dirname(file), 'node_modules/no.js'), 'not included'); f.write(path.join(f.agentDir, 'skills/single.md'), text('single')); f.write(path.join(f.agentDir, 'skills/private.json'), 'not included');
  const rows = (await f.m.list()).skills; const result = await f.m.exportSelected(rows.map((r) => ({ id: r.id, revision: r.contentRevision }))); const entries = await zipEntries(result.data);
  const manifest = JSON.parse(entries.find((e) => e.path === 'skill-manager-bundle.json').data); assert.equal(manifest.items.length, 3); assert.equal(new Set(manifest.items.map((i) => i.directory)).size, 3); assert.equal(manifest.items.filter((i) => i.name === 'alpha').length, 2);
  assert.deepEqual(entries.find((e) => e.path.endsWith('assets/中文.bin')).data, Buffer.from([0, 255])); assert(entries.every((e) => !/\.git|node_modules|private\.json/.test(e.path))); assert(!JSON.stringify(manifest).includes(f.root));
  assert.equal(entries.filter((e) => e.path.endsWith('SKILL.md')).length, 3); assert(!fs.existsSync(f.m.preferencesPath)); await assert.rejects(f.m.importZip(result.data), /一个 Skill/);
});
test('批量 ZIP 标识、数量、旧 revision、附件 junction、合计数量上限都拒绝不返回残缺下载', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const row = (await f.m.list()).skills[0]; const item = { id: row.id, revision: row.contentRevision };
  for (const items of [[], Array(51).fill(item), [item, item], [{ id: '0'.repeat(64), revision: row.contentRevision }], [{ ...item, revision: 'stale' }]]) await assert.rejects(f.m.exportSelected(items));
  const outside = f.write(path.join(f.root, 'outside/keep.txt'), 'untouched'); const link = path.join(path.dirname(file), 'linked');
  try { fs.symlinkSync(path.dirname(outside), link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { t.diagnostic('junction permission denied'); return; } throw e; }
  await assert.rejects(f.m.exportSelected([item]), /链接|junction/); assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched'); fs.unlinkSync(link);
  for (let i = 0; i < 998; i++) f.write(path.join(path.dirname(file), `file-${i}`), ''); await assert.rejects(f.m.exportSelected([item]), /1000/);
});
test('六项新接口同源保护、只按标识读写；GET 搜索和回收站不修改个人文件', async (t) => {
  const f = fixture(t); f.add('alpha', 'needle'); const p = await prepare(f.m, 'alpha'); const deleted = await remove(f.m, 'alpha'); const trashItem = (await f.m.deleted()).items[0]; f.add('beta', 'needle'); const beta = await prepare(f.m, 'beta');
  const server = createServer(f.m); await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); const base = `http://127.0.0.1:${server.address().port}`;
  for (const url of ['/api/undelete', '/api/export-selected', `/api/skills/${beta.row.id}/compare`, `/api/skills/${beta.row.id}/organize`]) assert.equal((await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/deleted')).status, 200); assert.equal((await (await fetch(base + '/api/search?q=needle')).json()).hits.length, 1);
  const headers = { Origin: base, 'X-Skill-Manager': '1', 'Content-Type': 'application/json' };
  const response = await fetch(base + '/api/undelete', { method: 'POST', headers, body: JSON.stringify({ id: trashItem.id, token: trashItem.token, path: 'C:/Windows' }) }); assert.equal(response.status, 200); assert.equal((await response.json()).restored, true); assert(!fs.existsSync(deleted.archivedTo)); assert(fs.existsSync(p.row.path));
  const compare = await fetch(base + `/api/skills/${beta.row.id}/compare`, { method: 'POST', headers, body: JSON.stringify({ content: text('beta', 'new'), revision: beta.detail.revision }) }); assert.equal(compare.status, 200); assert((await compare.json()).changed);
  const archive = await fetch(base + '/api/export-selected', { method: 'POST', headers, body: JSON.stringify({ items: [{ id: beta.row.id, revision: beta.row.contentRevision }] }) }); assert.equal(archive.headers.get('content-type'), 'application/zip'); assert.equal(archive.status, 200);
});
test('目录恢复并发创建空目录不覆盖（Windows rename／POSIX 独占预留），外来内容保留', async (t) => {
  const f = fixture(t); f.add('alpha'); const deleted = await remove(f.m, 'alpha'); const item = (await f.m.deleted()).items[0];
  const method = process.platform === 'win32' ? 'renameSync' : 'mkdirSync'; const original = fs[method]; let foreign;
  fs[method] = (...args) => {
    const target = method === 'renameSync' ? args[1] : args[0];
    if (target === item.originalPath) {
      if (method === 'mkdirSync') original(target);
      else fs.mkdirSync(target);
      foreign = fs.lstatSync(target);
    }
    return original(...args);
  };
  try { await assert.rejects(f.m.undelete(item.id, item.token)); } finally { fs[method] = original; }
  assert(foreign); assert.equal(fs.lstatSync(item.originalPath).ino, foreign.ino); assert.deepEqual(fs.readdirSync(item.originalPath), []); assert(fs.existsSync(deleted.archivedTo));
});
test('历史比较拒绝备份目录 junction；巨量差异显式降级而不改原文件', async (t) => {
  const f = fixture(t); const file = f.add('alpha', Array.from({ length: 1600 }, (_, i) => `old-${i}`).join('\n')); let p = await prepare(f.m, 'alpha');
  const largeDiff = await f.m.compare(p.row.id, { content: text('alpha', Array.from({ length: 1600 }, (_, i) => `new-${i}`).join('\n')), revision: p.detail.revision }); assert.equal(largeDiff.limited, true); assert.equal(largeDiff.patch, null);
  await f.m.save(p.row.id, text('alpha', 'changed'), p.detail.revision); p = await prepare(f.m, 'alpha'); const target = p.detail.backupDir; const moved = path.join(f.root, 'outside-backups'); fs.renameSync(target, moved);
  try { fs.symlinkSync(moved, target, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { t.diagnostic('junction permission denied'); return; } throw e; }
  await assert.rejects(f.m.compare(p.row.id, { backup: p.detail.backups[0], revision: p.detail.revision }), /链接/); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha', 'changed'));
});
test('批量备份合计大小超过预算时整体拒绝，单项文件均在自身限额内', async (t) => {
  const f = fixture(t);
  for (const name of ['alpha', 'beta']) { const file = f.add(name); for (const suffix of ['one', 'two']) { const fd = fs.openSync(path.join(path.dirname(file), suffix + '.bin'), 'w'); fs.ftruncateSync(fd, 14 * 1024 * 1024); fs.closeSync(fd); } }
  const rows = (await f.m.list()).skills; await assert.rejects(f.m.exportSelected(rows.map((row) => ({ id: row.id, revision: row.contentRevision }))), /50 MiB/);
});
