import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';
import { DefaultPackageManager, lockfile } from '../pi-adapter.mjs';
const text = (name, extra = '') => `---\nname: ${name}\ndescription: fixture\n${extra}---\n正文\n`;
const filters = fields => ({ query: '', body: false, status: 'all', group: '', tag: '', sort: 'favorite', notes: 'all', ...fields });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-workspace-')); const home = process.env.HOME; process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  const add = (name, base = path.join(agentDir, 'skills'), extra = '') => write(path.join(base, name, 'SKILL.md'), text(name, extra));
  return { root, cwd, agentDir, write, add, m: new SkillManager({ agentDir, cwd, project: true }) };
}
async function row(f, name) { const s = await f.m.list(); const r = s.skills.find(r => r.name === name); const rel = path.relative(f.root, fs.realpathSync(r.path)); assert(!rel.startsWith('..') && !path.isAbsolute(rel)); return { s, r }; }
async function decorated(f) {
  const a = f.add('alpha'); const b = f.add('beta'); const settings = f.write(f.m.settingsPath('global'), '{"untouched":"credentials-not-exported"}'); let p = await row(f, 'alpha'); await f.m.note(p.r.id, '私密\n备注', p.s.preferencesRevision); p = await row(f, 'alpha'); await f.m.organize(p.r.id, '写作', ['原标签'], p.s.preferencesRevision); await f.m.favorite(p.r.id, true); p = await row(f, 'alpha'); await f.m.saveView(null, '常用', filters({ query: 'alpha', status: 'enabled', notes: 'present' }), p.s.preferencesRevision); return { a, b, settings, id: p.r.id };
}
test('诊断复用原生exact/glob过滤，-优先于+，GET不改原文／设置', async t => {
  const f = fixture(t); const file = f.add('alpha'); const settings = f.write(f.m.settingsPath('global'), JSON.stringify({ skills: [path.dirname(file), `+${file}`, `-${file}`], other: 42 })); const before = fs.readFileSync(settings); const p = await row(f, 'alpha'); const d = await f.m.loadingDiagnostics(p.r.id); assert.equal(d.enabled, false); assert.equal(d.evidence.confirmed, true); assert.equal(d.evidence.decisive, `-${file}`); assert.equal(d.evidence.rules.length, 2); assert.deepEqual(d.evidence.rules.map(r => r.index), [1, 2]); assert.match(d.warning, /不是运行中/); assert.deepEqual(fs.readFileSync(settings), before); assert.equal(fs.readFileSync(file, 'utf8'), text('alpha')); assert(!fs.existsSync(f.m.preferencesPath));
});
test('诊断同名胜者来自有效集合；坏YAML不伪称同名，manual与命令发现关闭不等于资源关闭', async t => {
  const f = fixture(t); f.add('alpha'); f.add('alpha', path.join(f.cwd, '.pi/skills')); f.add('manual', undefined, 'disable-model-invocation: true\n'); f.write(path.join(f.agentDir, 'skills/broken/SKILL.md'), '---\nname: [bad\n---\n'); f.write(f.m.settingsPath('global'), '{"enableSkillCommands":false}'); const s = await f.m.list(); const loser = s.skills.find(r => r.valid && r.enabled && !r.effective); const d = await f.m.loadingDiagnostics(loser.id); assert(d.winner); assert.equal(s.skills.find(r => r.path === d.winner.path).effective, true);
  const manual = s.skills.find(r => r.name === 'manual'); const md = await f.m.loadingDiagnostics(manual.id); assert(md.enabled && md.effective && md.manualOnly); assert(md.messages.some(s => s.includes('disable-model-invocation'))); assert(md.messages.some(s => s.includes('命令发现')));
  const bad = s.skills.find(r => !r.valid); const bd = await f.m.loadingDiagnostics(bad.id); assert(!bd.winner); assert(bd.diagnostics.length); assert(bd.messages.some(s => s.includes('未接受')));
});
test('包skills空数组及包含规则的诊断、autoload:false项目delta使用原生语义', async t => {
  const f = fixture(t); const pkg = path.join(f.root, 'package'); f.add('alpha', path.join(pkg, 'skills')); f.add('beta', path.join(pkg, 'skills')); f.write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', pi: { skills: ['skills'] } })); f.write(f.m.settingsPath('global'), JSON.stringify({ packages: [{ source: pkg, skills: [] }] })); let p = await row(f, 'alpha'); let d = await f.m.loadingDiagnostics(p.r.id); assert.equal(d.enabled, false); assert.match(d.evidence.note, /skills: \[\]/);
  f.write(f.m.settingsPath('global'), JSON.stringify({ packages: [{ source: pkg, skills: ['skills/alpha'] }] })); p = await row(f, 'beta'); d = await f.m.loadingDiagnostics(p.r.id); assert(!d.enabled); assert(d.evidence.confirmed); assert.match(d.evidence.note, /包含规则/);
  f.write(f.m.settingsPath('global'), JSON.stringify({ packages: [pkg] })); f.write(f.m.settingsPath('project'), JSON.stringify({ packages: [{ source: pkg, autoload: false, skills: ['-skills/alpha', '+skills/alpha'] }] })); p = await row(f, 'alpha'); d = await f.m.loadingDiagnostics(p.r.id); assert(d.enabled); assert.equal(d.evidence.mode, 'delta'); assert(d.evidence.confirmed); assert.equal(d.evidence.decisive, '+skills/alpha');
});
test('重复项目包身份同状态不同规则/别名不误确认旧来源，重复全局声明也保守提示', async t => {
  const f = fixture(t); const pkg = path.join(f.root, 'package'); f.add('alpha', path.join(pkg, 'skills')); f.add('beta', path.join(pkg, 'skills')); f.write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', pi: { skills: ['skills'] } }));
  for (const source of [pkg, path.relative(path.join(f.cwd, '.pi'), pkg)]) {
    f.write(f.m.settingsPath('project'), JSON.stringify({ packages: [{ source: pkg, skills: ['!skills/alpha'] }, { source, skills: ['skills/beta'] }] })); const p = await row(f, 'alpha'); const d = await f.m.loadingDiagnostics(p.r.id);
    assert.equal(d.enabled, false); assert.equal(d.evidence.confirmed, false); assert.equal(d.evidence.decisive, null); assert.equal(d.evidence.rules.length, 0); assert.match(d.evidence.note, /重复包身份/); assert(!d.evidence.note.includes('!skills/alpha'));
  }
  f.write(f.m.settingsPath('project'), '{}'); f.write(f.m.settingsPath('global'), JSON.stringify({ packages: [{ source: pkg, skills: ['!skills/alpha'] }, { source: pkg, skills: ['skills/beta'] }] })); const p = await row(f, 'alpha'); const d = await f.m.loadingDiagnostics(p.r.id); assert(!d.enabled); assert(!d.evidence.confirmed); assert.equal(d.evidence.decisive, null);
});
test('详细过滤接口不兼容或超200规则时保留原生结果并明确不确认', async t => {
  const f = fixture(t); const file = f.add('alpha'); const p = await row(f, 'alpha'); const original = DefaultPackageManager.prototype.applyPackageDeltaFilter; DefaultPackageManager.prototype.applyPackageDeltaFilter = undefined;
  try { const d = await f.m.loadingDiagnostics(p.r.id); assert(d.enabled); assert(!d.evidence.confirmed); assert.match(d.evidence.note, /无法确认/); } finally { DefaultPackageManager.prototype.applyPackageDeltaFilter = original; }
  f.write(f.m.settingsPath('global'), JSON.stringify({ skills: Array.from({ length: 201 }, () => `+${file}`) })); const d = await f.m.loadingDiagnostics(p.r.id); assert(d.enabled); assert(!d.evidence.confirmed); assert.match(d.evidence.note, /200/); assert.equal(d.evidence.rules.length, 0);
});
test('整理备份包含四项与视图及未发现ID，不导出凭证／正文／added/未知字段，GET不写偏好', async t => {
  const f = fixture(t); f.add('empty'); const empty = await f.m.organizationExport(); assert.equal(empty.items.length, 0); assert(!fs.existsSync(f.m.preferencesPath)); const p = await decorated(f); const raw = JSON.parse(fs.readFileSync(f.m.preferencesPath)); raw.future = 42; raw.notes['a'.repeat(64)] = '未发现备注'; raw.added[p.id] = 42; f.write(f.m.preferencesPath, JSON.stringify(raw)); const before = fs.readFileSync(f.m.preferencesPath); const document = await f.m.organizationExport(); assert.equal(document.items.length, 2); assert.equal(document.views.length, 1); assert(document.items.some(i => i.path === null)); assert(!JSON.stringify(document).includes('credentials-not-exported')); assert(!Object.hasOwn(document, 'added') && !Object.hasOwn(document, 'future')); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('合并只补空字段并追加收藏/标签，覆盖仅限匹配项，unknown/added/兄弟与Skill/Pi原文不动', async t => {
  const f = fixture(t); const p = await decorated(f); const document = await f.m.organizationExport(); document.items[0].favorite = false; document.items[0].group = '导入'; document.items[0].tags = ['新标签']; document.items[0].note = '新备注'; const raw = JSON.parse(fs.readFileSync(f.m.preferencesPath)); raw.future = { x: 42 }; raw.organization[p.id].future = 7; raw.added[p.id] = 123; f.write(f.m.preferencesPath, JSON.stringify(raw)); const source = fs.readFileSync(p.a); const config = fs.readFileSync(p.settings);
  let preview = await f.m.organizationPreview(document, 'merge'); assert.equal(preview.changed, 1); assert.equal(preview.items[0].after.group, '写作'); assert.equal(preview.items[0].after.note, '私密\n备注'); assert.equal(preview.items[0].after.favorite, true); await f.m.organizationImport(document, 'merge', preview.token);
  preview = await f.m.organizationPreview(document, 'replace'); assert.equal(preview.items[0].after.note, '新备注'); await f.m.organizationImport(document, 'replace', preview.token); const current = f.m.preferences(); assert.equal(current.organization[p.id].group, '导入'); assert.equal(current.organization[p.id].future, 7); assert.equal(current.added[p.id], 123); assert.deepEqual(current.future, { x: 42 }); assert(!current.favorites.includes(p.id)); assert.deepEqual(fs.readFileSync(p.a), source); assert.deepEqual(fs.readFileSync(p.settings), config); assert.equal(fs.readFileSync(p.b, 'utf8'), text('beta'));
});
test('未匹配ID只跳过，忽略导入路径/同名，不创建文件或跨范围应用，无变更不可提交', async t => {
  const f = fixture(t); await decorated(f); const document = await f.m.organizationExport(); document.items[0].id = '0'.repeat(64); document.items[0].path = path.join(f.root, 'never-created'); document.views = []; const before = fs.readFileSync(f.m.preferencesPath); const preview = await f.m.organizationPreview(document, 'replace'); assert.equal(preview.skipped, 1); assert.equal(preview.changed, 0); await assert.rejects(f.m.organizationImport(document, 'replace', preview.token), /没有可保存/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before); assert(!fs.existsSync(document.items[0].path));
});
test('导入旧token：偏好、目标身份、模式或备份内容改变全部拒写', async t => {
  const f = fixture(t); const p = await decorated(f); const document = await f.m.organizationExport(); document.items[0].note = 'new'; const preview = await f.m.organizationPreview(document, 'replace'); await assert.rejects(f.m.organizationImport(document, 'merge', preview.token), /已改变/); const changed = structuredClone(document); changed.items[0].note = 'tampered'; await assert.rejects(f.m.organizationImport(changed, 'replace', preview.token), /已改变/);
  f.write(p.a, text('renamed')); await assert.rejects(f.m.organizationImport(document, 'replace', preview.token), /已改变/); f.write(p.a, text('alpha')); const now = await f.m.list(); await f.m.note(p.id, 'other-window', now.preferencesRevision); const before = fs.readFileSync(f.m.preferencesPath); await assert.rejects(f.m.organizationImport(document, 'replace', preview.token), /已改变/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('整批拒绝坏schema/重复ID/备注控制符/视图/版本/1MiB与合并标签超额，不覆盖已有偏好', async t => {
  const f = fixture(t); const p = await decorated(f); const document = await f.m.organizationExport(); const before = fs.readFileSync(f.m.preferencesPath);
  for (const modify of [d => { d.version = 2; }, d => { d.items.push(d.items[0]); }, d => { d.items[0].note = '\0'; }, d => { d.items[0].favorite = 'true'; }, d => { d.views[0].filters.status = 'bad'; }, d => { d.items[0].note = 'x'.repeat(10001); }, d => { d.future = 'x'.repeat(1024 * 1024); }]) { const bad = structuredClone(document); modify(bad); await assert.rejects(f.m.organizationPreview(bad, 'merge')); }
  const now = await f.m.list(); await f.m.organize(p.id, 'old', Array.from({ length: 20 }, (_, i) => `tag${i}`), now.preferencesRevision); await assert.rejects(f.m.organizationPreview(document, 'merge'), /整批未保存/); assert.equal(f.m.preferences().notes[p.id], '私密\n备注'); assert(before.length > 0);
});
test('常用视图版1兼容、创建/更新/删除/重启持久，全部过滤字段保留，Skill加载不变', async t => {
  const f = fixture(t); f.add('alpha'); let p = await row(f, 'alpha'); f.write(f.m.preferencesPath, JSON.stringify({ version: 1, favorites: [], future: 42 })); p = await row(f, 'alpha'); const saved = await f.m.saveView(null, '写作', filters({ query: '<script>', body: true, status: 'enabled', group: 'g:写作', tag: 't:中文', notes: 'present', sort: 'modified' }), p.s.preferencesRevision); assert.equal(saved.snapshot.skills[0].enabled, p.r.enabled); let s = await new SkillManager({ agentDir: f.agentDir, cwd: f.cwd }).list(); assert.equal(s.views[0].filters.body, true); assert.equal(s.views[0].filters.group, 'g:写作'); assert.equal(f.m.preferences().future, 42);
  const updated = await f.m.saveView(saved.viewId, '改名', filters(), s.preferencesRevision); assert.equal(updated.snapshot.views.length, 1); await f.m.deleteView(saved.viewId, updated.snapshot.preferencesRevision); s = await f.m.list(); assert.equal(s.views.length, 0);
});
test('视图旧版本/不存在/重复名/错误字段/控制字符/30个上限与坏已有views不覆盖', async t => {
  const f = fixture(t); f.add('alpha'); const p = await row(f, 'alpha'); const saved = await f.m.saveView(null, 'one', filters(), p.s.preferencesRevision);
  await assert.rejects(f.m.saveView(null, 'two', filters(), p.s.preferencesRevision), /其他窗口/); await assert.rejects(f.m.saveView(null, 'one', filters(), saved.snapshot.preferencesRevision), /同名/); await assert.rejects(f.m.saveView(randomUUID(), 'two', filters(), saved.snapshot.preferencesRevision), /不存在/);
  for (const invalid of [{ notes: 'bad' }, { body: 'false' }, { group: 'x' }, { query: 'x'.repeat(201) }]) await assert.rejects(f.m.saveView(null, 'two', filters(invalid), saved.snapshot.preferencesRevision)); await assert.rejects(f.m.saveView(null, 'bad\n', filters(), saved.snapshot.preferencesRevision));
  const raw = f.m.preferences(); const { raw: _raw, ...value } = raw; value.views = Array.from({ length: 30 }, (_, i) => ({ id: randomUUID(), name: `view${i}`, filters: filters() })); f.write(f.m.preferencesPath, JSON.stringify(value)); const s = await f.m.list(); await assert.rejects(f.m.saveView(null, 'overflow', filters(), s.preferencesRevision), /30/); value.views[0].filters.sort = 'bad'; f.write(f.m.preferencesPath, JSON.stringify(value)); const bytes = fs.readFileSync(f.m.preferencesPath); assert((await f.m.list()).preferencesError); await assert.rejects(f.m.saveView(null, 'nooverwrite', filters(), s.preferencesRevision), /收藏配置/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), bytes);
});
test('视图导入同ID合并保留/覆盖更新；同名不同ID跳过；未知视图字段保持', async t => {
  const f = fixture(t); await decorated(f); const document = await f.m.organizationExport(); document.items = []; document.views[0].filters.query = 'new'; let p = await f.m.organizationPreview(document, 'merge'); assert.equal(p.changed, 0); p = await f.m.organizationPreview(document, 'replace'); assert.equal(p.changed, 1); assert.equal(p.views[0].before.filters.query, 'alpha'); assert.equal(p.views[0].after.filters.query, 'new'); await f.m.organizationImport(document, 'replace', p.token); assert.equal(f.m.preferences().views[0].filters.query, 'new'); document.views[0].id = randomUUID(); p = await f.m.organizationPreview(document, 'replace'); assert.equal(p.changed, 0); assert.match(p.views[0].reason, /同名/);
});
test('导入/视图保存完成后unlock与刷新失败仍已保存回执，2MiB偏好新写限额', async t => {
  const f = fixture(t); f.add('alpha'); const p = await row(f, 'alpha'); const original = lockfile.lockSync; lockfile.lockSync = (...args) => { const release = original(...args); return () => { release(); throw new Error('unlock fault'); }; }; f.m.list = async () => { throw new Error('GET fault'); };
  try { const result = await f.m.saveView(null, 'saved', filters(), p.s.preferencesRevision); assert(result.saved); assert.equal(result.snapshot, null); assert.match(result.warning, /已保存/); assert.equal(f.m.preferences().views.length, 1); } finally { lockfile.lockSync = original; }
  const prefs = f.m.preferences(); const { raw: _raw, ...value } = prefs; value.future = 'x'.repeat(2 * 1024 * 1024); f.write(f.m.preferencesPath, JSON.stringify(value)); const before = fs.readFileSync(f.m.preferencesPath); await assert.rejects(f.m.saveView(null, 'huge', filters(), (await new SkillManager({ agentDir: f.agentDir, cwd: f.cwd }).list()).preferencesRevision), /2 MiB/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('新API同源写入限制、只读诊断/真实JSON下载与预览不写入', async t => {
  const f = fixture(t); await decorated(f); const p = await row(f, 'alpha'); const before = fs.readFileSync(f.m.preferencesPath); const server = createServer(f.m); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); const base = `http://127.0.0.1:${server.address().port}`;
  for (const url of ['/api/organization/preview', '/api/organization/import', '/api/views/save', '/api/views/delete']) assert.equal((await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const response = await fetch(base + '/api/organization/export'); assert.match(response.headers.get('content-disposition'), /organization.json/); const document = await response.json(); assert.equal((await fetch(`${base}/api/skills/${p.r.id}/diagnostics`)).status, 200); const preview = await fetch(base + '/api/organization/preview', { method: 'POST', headers: { Origin: base, 'X-Skill-Manager': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ document, mode: 'replace' }) }); assert.equal(preview.status, 200); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
