import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';
const text = (name) => `---\nname: ${name}\ndescription: 删除测试\n---\n\n正文。\n`;
function fixture(t) {
  const home = process.env.HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-delete-'));
  process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  const add = (name, base = path.join(agentDir, 'skills')) => write(path.join(base, name, 'SKILL.md'), text(name));
  const m = new SkillManager({ agentDir, cwd });
  return { root, agentDir, cwd, write, add, m };
}
async function prepare(m, name) { const row = (await m.list()).skills.find((item) => item.name === name); const detail = await m.detail(row.id); return { row, detail }; }
const remove = (m, row, detail) => m.delete(row.id, detail.revision, row.name, detail.deletion.token);

test('删除整个目录是可恢复移动，保留二进制、空目录、.git/node_modules及原配置收藏，不影响兄弟 Skill', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); f.add('beta');
  f.write(path.join(path.dirname(file), '.git/config'), 'keep git'); f.write(path.join(path.dirname(file), 'node_modules/a.js'), 'keep dependencies');
  const binary = Buffer.from([0, 255, 128, 13, 10]); f.write(path.join(path.dirname(file), 'assets/图片.bin'), binary); fs.mkdirSync(path.join(path.dirname(file), 'empty'));
  const config = f.write(path.join(f.agentDir, 'settings.json'), '{"untouched":42}');
  let prepared = await prepare(f.m, 'alpha'); await f.m.favorite(prepared.row.id, true);
  const preferences = fs.readFileSync(f.m.preferencesPath); prepared = await prepare(f.m, 'alpha');
  const result = await remove(f.m, prepared.row, prepared.detail);
  assert.equal(result.deleted, true); assert.equal(result.warning, null); assert(!fs.existsSync(path.dirname(file)));
  assert.equal(fs.readFileSync(path.join(result.archivedTo, 'SKILL.md'), 'utf8'), text('alpha'));
  assert.deepEqual(fs.readFileSync(path.join(result.archivedTo, 'assets/图片.bin')), binary);
  assert.equal(fs.readFileSync(path.join(result.archivedTo, '.git/config'), 'utf8'), 'keep git');
  assert.equal(fs.readFileSync(path.join(result.archivedTo, 'node_modules/a.js'), 'utf8'), 'keep dependencies'); assert(fs.statSync(path.join(result.archivedTo, 'empty')).isDirectory());
  assert.equal(fs.readFileSync(config, 'utf8'), '{"untouched":42}'); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), preferences);
  assert.deepEqual(result.snapshot.skills.map((item) => item.name), ['beta']);
  const record = JSON.parse(fs.readFileSync(result.record, 'utf8')); assert.equal(record.originalPath, path.dirname(file)); assert.equal(record.archivedTo, result.archivedTo);
  await assert.rejects(remove(f.m, prepared.row, prepared.detail), /不存在|不再处于/);
  fs.renameSync(result.archivedTo, record.originalPath); const restored = await prepare(f.m, 'alpha'); assert.equal(restored.row.favorite, true);
});
test('独立 Markdown 只移动自己；个人 .agents 和项目 .pi 目录也可删且归档同卷', async (t) => {
  const f = fixture(t); const single = f.write(path.join(f.agentDir, 'skills/single.md'), text('single')); f.add('other');
  let p = await prepare(f.m, 'single'); const result = await remove(f.m, p.row, p.detail); assert(!fs.existsSync(single)); assert.equal(fs.readFileSync(result.archivedTo, 'utf8'), text('single')); assert(fs.existsSync(path.join(f.agentDir, 'skills/other/SKILL.md')));
  f.add('personal', path.join(f.root, '.agents/skills')); p = await prepare(f.m, 'personal'); assert((await remove(f.m, p.row, p.detail)).archivedTo.startsWith(path.join(f.root, '.agents/skill-manager-deleted')));
  f.add('project-one', path.join(f.cwd, '.pi/skills')); const project = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd, project: true }); p = await prepare(project, 'project-one'); assert((await remove(project, p.row, p.detail)).archivedTo.startsWith(path.join(f.cwd, '.pi/skill-manager-deleted')));
});
test('错误确认、旧正文和旧目录 token 均拒绝，无任何归档或删除', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const p = await prepare(f.m, 'alpha');
  await assert.rejects(f.m.delete(p.row.id, p.detail.revision, 'wrong', p.detail.deletion.token), /输入/);
  await assert.rejects(f.m.delete(p.row.id, p.detail.revision, 'alpha', 'bad-token'), /改变/);
  f.write(file, text('alpha') + '外部修改'); await assert.rejects(remove(f.m, p.row, p.detail), /修改/);
  assert(fs.existsSync(file)); assert(!fs.existsSync(p.detail.deletion.archiveRoot));
});
test('扩展包（含本地路径别名）、根目录 SKILL 和自定义位置不能删除', async (t) => {
  const f = fixture(t); const pkg = path.join(f.root, 'pkg'); f.add('packed', path.join(pkg, 'skills')); f.write(path.join(pkg, 'package.json'), JSON.stringify({ pi: { skills: ['./skills'], extensions: [] } }));
  const custom = f.add('custom', path.join(f.root, 'custom')); f.write(path.join(f.agentDir, 'skills/SKILL.md'), text('root-skill'));
  f.write(path.join(f.agentDir, 'settings.json'), JSON.stringify({ packages: [pkg], skills: [custom] }));
  for (const name of ['packed', 'custom', 'root-skill']) { const p = await prepare(f.m, name); assert.equal(p.detail.deletion.allowed, false); await assert.rejects(remove(f.m, p.row, p.detail), /删除|手动/); }
  const local = f.add('local-package'); const packageRoot = path.dirname(local); f.write(path.join(packageRoot, 'package.json'), JSON.stringify({ pi: { skills: ['SKILL.md'], extensions: [] } }));
  f.write(path.join(f.agentDir, 'settings.json'), JSON.stringify({ packages: [packageRoot] })); const p = await prepare(f.m, 'local-package'); assert.equal(p.detail.deletion.allowed, false);
});
test('归档区 junction 和 Skill 根目录链接被拒绝，外部内容不变', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const p = await prepare(f.m, 'alpha');
  const outside = f.write(path.join(f.root, 'outside/keep.txt'), 'keep');
  try { fs.symlinkSync(path.dirname(outside), p.detail.deletion.archiveRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('目录链接权限不足'); return; } throw error; }
  await assert.rejects(remove(f.m, p.row, p.detail), /链接/); assert(fs.existsSync(file)); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});
test('归档记录或移动失败保持原 Skill；成功后的刷新/锁清理失败不伪报未删除', async (t) => {
  const f = fixture(t); f.add('alpha'); let p = await prepare(f.m, 'alpha'); const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated move failure'); };
  try { await assert.rejects(remove(f.m, p.row, p.detail), /move failure/); } finally { fs.renameSync = originalRename; }
  assert(fs.existsSync(p.detail.deletion.target)); assert.deepEqual(fs.readdirSync(p.detail.deletion.archiveRoot), []);
  p = await prepare(f.m, 'alpha'); const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => { if (typeof target === 'number') throw new Error('record failure'); return originalWrite(target, ...args); };
  try { await assert.rejects(remove(f.m, p.row, p.detail), /record failure/); } finally { fs.writeFileSync = originalWrite; }
  assert(fs.existsSync(p.detail.deletion.target)); assert.deepEqual(fs.readdirSync(p.detail.deletion.archiveRoot), []);
  const list = f.m.list.bind(f.m); let calls = 0; f.m.list = async () => { if (++calls > 1) throw new Error('refresh failure'); return list(); };
  const result = await remove(f.m, p.row, p.detail); assert.equal(result.deleted, true); assert.match(result.warning, /请勿重复/); assert(fs.existsSync(result.archivedTo));
});
test('删除经过开关的本地 Skill 后，精准原生规则保留但不阻断列表，锁清理故障仍报告已删除', async (t) => {
  const f = fixture(t); f.add('alpha'); f.add('beta');
  let p = await prepare(f.m, 'alpha'); await f.m.toggle(p.row.id, false, p.row.configRevision);
  p = await prepare(f.m, 'alpha'); await f.m.toggle(p.row.id, true, p.row.configRevision);
  const settings = fs.readFileSync(f.m.settingsPath('global'));
  p = await prepare(f.m, 'alpha');
  const { lockfile } = await import('../pi-adapter.mjs'); const originalLock = lockfile.lockSync;
  lockfile.lockSync = (target, ...args) => { const release = originalLock(target, ...args); if (path.resolve(target) !== path.resolve(p.detail.deletion.target)) return release; return () => { release(); throw new Error('simulated release failure'); }; };
  let result;
  try { result = await remove(f.m, p.row, p.detail); } finally { lockfile.lockSync = originalLock; }
  assert.equal(result.deleted, true); assert.match(result.warning, /锁清理失败/);
  assert.equal(result.snapshot.skills.some((row) => row.name === 'alpha'), false);
  assert.equal(result.snapshot.skills.find((row) => row.name === 'beta').effective, true);
  assert.deepEqual(fs.readFileSync(f.m.settingsPath('global')), settings);
});
test('同一目录包含另一个显式发现的 Skill 时拒绝整目录移动', async (t) => {
  const f = fixture(t); const file = f.add('alpha');
  const nested = f.write(path.join(path.dirname(file), 'references/other.md'), text('nested-other'));
  f.write(f.m.settingsPath('global'), JSON.stringify({ skills: [nested] }));
  const p = await prepare(f.m, 'alpha'); assert.equal(p.detail.deletion.allowed, false);
  await assert.rejects(remove(f.m, p.row, p.detail), /其他已发现/);
  assert(fs.existsSync(nested)); assert(fs.existsSync(file));
});

test('正在编辑的文件锁阻止目录移动；HTTP 删除沿用同源防护和拒绝任意路径', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const p = await prepare(f.m, 'alpha'); fs.mkdirSync(file + '.lock');
  const locked = await prepare(f.m, 'alpha');
  await assert.rejects(remove(f.m, locked.row, locked.detail), /修改/); fs.rmdirSync(file + '.lock');
  const server = createServer(f.m); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`; const url = `${base}/api/skills/${p.row.id}/delete`; const data = JSON.stringify({ revision: p.detail.revision, confirmation: 'alpha', deleteToken: p.detail.deletion.token, path: 'C:/Windows' });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data })).status, 403);
  const headers = { Origin: base, 'X-Skill-Manager': '1', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: data })).status, 403);
  // Reopen details after removing the inner lock (its creation changed the directory token).
  const fresh = await prepare(f.m, 'alpha'); const body = JSON.stringify({ revision: fresh.detail.revision, confirmation: 'alpha', deleteToken: fresh.detail.deletion.token, path: 'C:/Windows' });
  const response = await fetch(url, { method: 'POST', headers, body }); assert.equal(response.status, 200); assert.equal((await response.json()).deleted, true); assert(!fs.existsSync(path.dirname(file)));
});
