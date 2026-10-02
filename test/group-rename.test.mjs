import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';
import { lockfile } from '../pi-adapter.mjs';
const text = name => `---\r\nname: ${name}\r\ndescription: fixture\r\nextra: keep\r\n---\r\n正文\r\n`;
const filters = group => ({ query: '原分组 literal query', body: true, status: 'enabled', group, tag: 't:标签', notes: 'present', sort: 'modified', futureFilter: 42 });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-group-rename-')); const home = process.env.HOME; process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const files = ['alpha', 'beta', 'gamma'].map(name => write(path.join(agentDir, 'skills', name, 'SKILL.md'), text(name))); files.push(write(path.join(agentDir, 'skills/alpha/assets/private.bin'), Buffer.from([0, 255, 13])));
  const m = new SkillManager({ agentDir, cwd, project: true });
  files.push(write(m.settingsPath('global'), '{"unrelated":42}')); files.push(write(m.settingsPath('project'), '{"projectExtra":true}'));
  return { root, m, files, write };
}
async function seed(f) {
  const s = await f.m.list(); assert.equal(s.skills.length, 3); assert(s.skills.every(row => path.relative(f.root, row.path) && !path.relative(f.root, row.path).startsWith('..')));
  const ids = Object.fromEntries(s.skills.map(row => [row.name, row.id])); const orphan = 'f'.repeat(64);
  const value = { version: 1, favorites: [ids.alpha, ids.alpha], raw: { opaqueStoredField: 'keep even when its name is raw' }, future: { untouched: ['yes'] }, organization: { [ids.alpha]: { group: '原分组', tags: ['标签', '标签'], extra: 1 }, [ids.beta]: { group: '原分组', extra: 2 }, [ids.gamma]: { group: '另组', tags: ['别的'], future: 3 }, [orphan]: { group: '原分组', tags: ['暂未发现'], future: { keep: true } } }, notes: { [ids.alpha]: '备注\n\t保留', [orphan]: '旧备注' }, added: { [ids.alpha]: 1790000000000 }, views: [{ id: randomUUID(), name: '原视图名称不改', filters: filters('g:原分组'), futureView: 99 }, { id: randomUUID(), name: '其他视图', filters: filters('g:另组') }] };
  f.write(f.m.preferencesPath, JSON.stringify(value)); return { value, ids, orphan, revision: (await f.m.list()).preferencesRevision };
}
const raw = f => JSON.parse(fs.readFileSync(f.m.preferencesPath, 'utf8'));
test('只读快照列出全部已存分组包括纯孤立组，去重保持精确名称且不把仅视图引用当作组', async t => {
  const f = fixture(t); const group = ' 暂未发现组 '; const value = { version: 1, favorites: [], organization: { ['f'.repeat(64)]: { group }, ['e'.repeat(64)]: { group }, ['d'.repeat(64)]: { group: '   ' }, ['c'.repeat(64)]: {} }, views: [{ id: randomUUID(), name: '空组视图', filters: filters('g:仅视图引用') }] };
  f.write(f.m.preferencesPath, JSON.stringify(value)); const before = fs.readFileSync(f.m.preferencesPath); const snapshot = await f.m.list();
  assert.deepEqual(snapshot.organizationGroups, [group]); assert(snapshot.skills.every(row => !row.group)); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
  f.write(f.m.preferencesPath, '{broken'); const damaged = await f.m.list(); assert(damaged.preferencesError); assert.deepEqual(damaged.organizationGroups, []); assert.equal(fs.readFileSync(f.m.preferencesPath, 'utf8'), '{broken');
});
test('分组改名只改精确名称及视图引用，成员/所有未知字段/重复收藏/可选字段结构保持，原文附件Pi配置不变', async t => {
  const f = fixture(t); const p = await seed(f); const before = f.files.map(file => fs.readFileSync(file)); const state = await f.m.list();
  const result = await f.m.renameGroup('原分组', '  新分组  ', p.revision); assert.equal(result.saved, true); assert.equal(result.count, 3); assert.equal(result.viewCount, 1); assert.equal(result.from, '原分组'); assert.equal(result.to, '新分组'); assert.equal(result.warning, null);
  const expected = structuredClone(p.value); for (const item of Object.values(expected.organization)) if (item.group === '原分组') item.group = '新分组'; expected.views[0].filters.group = 'g:新分组'; assert.deepEqual(raw(f), expected);
  for (const [i, file] of f.files.entries()) assert.deepEqual(fs.readFileSync(file), before[i]); assert.deepEqual(result.snapshot.skills.map(row => [row.id, row.enabled, row.effective]), state.skills.map(row => [row.id, row.enabled, row.effective]));
  assert.equal((await new SkillManager({ agentDir: f.m.agentDir, cwd: f.m.cwd, project: true }).list()).skills.find(row => row.name === 'alpha').group, '新分组');
});
test('暂未发现记录同组改名，不依赖已发现文件，移回原位置后继续使用新名称', async t => {
  const f = fixture(t); const p = await seed(f); const betaFile = f.files[1]; fs.unlinkSync(betaFile); const result = await f.m.renameGroup('原分组', '改名后', p.revision); assert.equal(result.count, 3); assert.equal(raw(f).organization[p.ids.beta].group, '改名后'); f.write(betaFile, text('beta')); assert.equal((await f.m.list()).skills.find(row => row.id === p.ids.beta).group, '改名后');
});
test('同名目的分组含孤立记录亦拒绝；未匹配视图的目的名称引用也不被偷偷扩大匹配', async t => {
  const f = fixture(t); const p = await seed(f); const before = fs.readFileSync(f.m.preferencesPath); await assert.rejects(f.m.renameGroup('原分组', '另组', p.revision), /不会合并/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
  const value = raw(f); value.organization['e'.repeat(64)] = { group: '孤立目标' }; value.views.push({ id: randomUUID(), name: '空结果视图', filters: filters('g:空目标') }); f.write(f.m.preferencesPath, JSON.stringify(value)); const revision = (await f.m.list()).preferencesRevision;
  for (const name of ['孤立目标', '空目标']) await assert.rejects(f.m.renameGroup('原分组', name, revision), /不会合并/); assert.deepEqual(raw(f), value);
});
test('空/长/控制符/非字符串/未改变/不存在名称拒绝，不把未分组整体改名', async t => {
  const f = fixture(t); const p = await seed(f); const before = fs.readFileSync(f.m.preferencesPath);
  for (const name of ['', '   ', null, [], 'x'.repeat(61), '换\n行', '制\0符', '原分组', ' 原分组 ']) await assert.rejects(f.m.renameGroup('原分组', name, p.revision));
  for (const from of ['', null, 'missing', 'x'.repeat(61), '坏\t名']) await assert.rejects(f.m.renameGroup(from, 'new', p.revision)); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('源名称精确匹配，允许旧名称包含首尾空格；新名称只 trim 不改其他相似名称', async t => {
  const f = fixture(t); const p = await seed(f); const value = raw(f); value.organization[p.ids.beta].group = ' 原分组 '; f.write(f.m.preferencesPath, JSON.stringify(value)); const result = await f.m.renameGroup(' 原分组 ', '<img src=x>', (await f.m.list()).preferencesRevision); assert.equal(result.count, 1); assert.equal(result.viewCount, 0); assert.equal(raw(f).organization[p.ids.alpha].group, '原分组'); assert.equal(raw(f).organization[p.ids.beta].group, '<img src=x>');
});
test('缺失或过期偏好版本拒写，其他窗口备注不会丢失', async t => {
  const f = fixture(t); const p = await seed(f); await f.m.note(p.ids.gamma, '其他窗口', p.revision); const before = fs.readFileSync(f.m.preferencesPath);
  for (const revision of [undefined, null, p.revision, 'bad']) await assert.rejects(f.m.renameGroup('原分组', '新', revision), /其他窗口/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
});
test('加锁写入前并发更改再次核验版本；不存在跨窗口覆盖', async t => {
  const f = fixture(t); const p = await seed(f); const original = f.m.writeLocked.bind(f.m); let raced;
  f.m.writeLocked = (...args) => { const value = raw(f); value.future.raced = true; raced = JSON.stringify(value); f.write(f.m.preferencesPath, raced); return original(...args); };
  await assert.rejects(f.m.renameGroup('原分组', '新', p.revision), /其他窗口|修改/); assert.equal(fs.readFileSync(f.m.preferencesPath, 'utf8'), raced);
});
test('坏偏好不覆盖；2 MiB 新写上限与正在使用的锁保持原值', async t => {
  const f = fixture(t); const p = await seed(f); const value = raw(f); value.future.huge = 'x'.repeat(2 * 1024 * 1024); f.write(f.m.preferencesPath, JSON.stringify(value)); const before = fs.readFileSync(f.m.preferencesPath); await assert.rejects(f.m.renameGroup('原分组', '新', (await f.m.list()).preferencesRevision), /2 MiB/); assert.deepEqual(fs.readFileSync(f.m.preferencesPath), before);
  f.write(f.m.preferencesPath, JSON.stringify(p.value)); const release = lockfile.lockSync(f.m.preferencesPath, { realpath: false, retries: 0 }); try { await assert.rejects(f.m.renameGroup('原分组', '新', p.revision), /文件正被其他程序修改/); } finally { release(); }
  for (const bytes of ['{broken', JSON.stringify({ ...p.value, views: [{ bad: true }] })]) { f.write(f.m.preferencesPath, bytes); await assert.rejects(f.m.renameGroup('原分组', '新', p.revision), /收藏配置/); assert.equal(fs.readFileSync(f.m.preferencesPath, 'utf8'), bytes); }
});
test('备份原偏好只一份；保存后解锁或刷新故障仍明确已改名，不误导重复保存', async t => {
  const f = fixture(t); const p = await seed(f); const original = lockfile.lockSync;
  lockfile.lockSync = (...args) => { const unlock = original(...args); return () => { unlock(); throw new Error('fixture unlock failure'); }; };
  f.m.list = async () => { throw new Error('fixture refresh failure'); };
  try { const result = await f.m.renameGroup('原分组', '已保存', p.revision); assert(result.saved); assert.equal(result.snapshot, null); assert.match(result.warning, /已保存.*unlock failure.*刷新失败/s); assert.equal(raw(f).organization[p.ids.alpha].group, '已保存'); assert.equal(raw(f).views[0].filters.group, 'g:已保存'); const backups = fs.readdirSync(f.m.backupDir, { recursive: true }).filter(name => name.endsWith('.bak')); assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.m.backupDir, backups[0]), 'utf8')), p.value); } finally { lockfile.lockSync = original; }
});
test('旧版缺省 views/notes/added 不被顺带填入；正文为坏 YAML 也只更改偏好名称', async t => {
  const f = fixture(t); const p = await seed(f); const value = { version: 1, favorites: [p.ids.alpha, p.ids.alpha], organization: { [p.ids.alpha]: { group: '原分组', future: 42 } }, future: 'keep' }; f.write(f.m.preferencesPath, JSON.stringify(value)); const revision = (await f.m.list()).preferencesRevision; f.write(f.files[0], 'invalid Skill body'); const result = await f.m.renameGroup('原分组', '新名称', revision); assert(result.saved); value.organization[p.ids.alpha].group = '新名称'; assert.deepEqual(raw(f), value); assert.equal(fs.readFileSync(f.files[0], 'utf8'), 'invalid Skill body');
});
test('HTTP 同源保护与仅名称/版本接口，无任意路径读写；完整改名通过现有序列化入口', async t => {
  const f = fixture(t); const p = await seed(f); const server = createServer(f.m); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); }); const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/groups/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { 'Content-Type': 'application/json', Origin: base, 'X-Skill-Manager': '1' }; assert.equal((await fetch(`${base}/api/groups/rename`, { method: 'POST', headers, body: JSON.stringify({ from: '原分组', name: '新' }) })).status, 409);
  const response = await fetch(`${base}/api/groups/rename`, { method: 'POST', headers, body: JSON.stringify({ from: '原分组', name: 'HTTP', preferencesRevision: p.revision, path: path.join(f.root, 'never-created'), ids: ['x'] }) }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.saved, true); assert.equal(result.count, 3); assert(!fs.existsSync(path.join(f.root, 'never-created'))); assert.equal(raw(f).organization[p.ids.alpha].group, 'HTTP');
});
