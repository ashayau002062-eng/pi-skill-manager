import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SkillManager, validateSkill } from '../manager.mjs';
import { createServer } from '../server.mjs';

const originalHome = process.env.HOME;
const skill = (name, description = '测试技能') => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  owner: personal\n---\n\n# ${name}\n\n原正文。\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-manager-test-'));
  process.env.HOME = root;
  t.after(() => { process.env.HOME = originalHome; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const settings = (data, project = false) => write(project ? path.join(cwd, '.pi/settings.json') : path.join(agentDir, 'settings.json'), JSON.stringify(data, null, 2));
  const add = (name, content = skill(name), directory = path.join(agentDir, 'skills')) => write(path.join(directory, name, 'SKILL.md'), content);
  const m = new SkillManager({ agentDir, cwd });
  return { root, agentDir, cwd, write, settings, add, m };
}
async function row(m, name) { return (await m.list()).skills.find((s) => s.name === name); }

test('发现默认个人、Agent Skills、独立 Markdown，并显示原生加载状态', async (t) => {
  const f = fixture(t);
  f.add('alpha');
  f.add('beta', skill('beta'), path.join(f.root, '.agents/skills'));
  f.write(path.join(f.agentDir, 'skills/single.md'), skill('single'));
  f.add('manual', skill('manual').replace('metadata:', 'disable-model-invocation: true\nmetadata:'));
  const snapshot = await f.m.list();
  assert.equal(snapshot.skills.length, 4);
  assert(snapshot.skills.every((r) => r.enabled && r.effective));
  assert.equal(snapshot.skills.find((r) => r.name === 'manual').manualOnly, true);
});
test('兼容旧版 skills.customDirectories，列出不迁移原文件，开关保留旧命令设置', async (t) => {
  const f = fixture(t);
  f.add('legacy', skill('legacy'), path.join(f.agentDir, 'extra-skills'));
  const config = f.settings({ skills: { customDirectories: ['./extra-skills'], enableSkillCommands: false }, queueMode: 'all', untouched: 42 });
  const raw = fs.readFileSync(config, 'utf8');
  const r = await row(f.m, 'legacy');
  assert(r && r.effective);
  assert.equal(fs.readFileSync(config, 'utf8'), raw);
  const result = await f.m.toggle(r.id, false, r.configRevision);
  const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert(saved.skills.includes('./extra-skills'));
  assert.equal(saved.enableSkillCommands, false);
  assert.equal(saved.queueMode, 'all');
  assert.equal(saved.untouched, 42);
  assert.equal(result.snapshot.skills.find((s) => s.id === r.id).enabled, false);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), raw);
});
test('项目旧 skills 对象和空 customDirectories 遵循 Pi 的迁移及顶层命令优先级', async (t) => {
  const f = fixture(t);
  f.add('legacy-project', skill('legacy-project'), path.join(f.cwd, '.pi/skills'));
  const config = f.settings({ skills: { customDirectories: [], enableSkillCommands: false }, enableSkillCommands: true }, true);
  const m = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd, project: true });
  const r = await row(m, 'legacy-project');
  const result = await m.toggle(r.id, false, r.configRevision);
  assert.equal(result.snapshot.skills[0].enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).enableSkillCommands, true);
});
test('无效 Skill 仍可查看修复，保存阻止无效 YAML', async (t) => {
  const f = fixture(t);
  const file = f.add('broken', '---\nname: broken\ndescription: text: bad\n---\nbody');
  const r = await row(f.m, 'broken');
  assert.equal(r.valid, false);
  assert.equal(r.effective, false);
  const d = await f.m.detail(r.id);
  await assert.rejects(f.m.save(r.id, d.content, d.revision), /YAML/);
  assert.equal(fs.readFileSync(file, 'utf8'), d.content);
  const fixed = await f.m.save(r.id, skill('broken'), d.revision);
  assert.equal(fixed.snapshot.skills.find((s) => s.id === r.id).valid, true);
});
test('开关只改变 Skill 配置，不搬动文件、不丢其他字段，并生成配置备份', async (t) => {
  const f = fixture(t);
  const file = f.add('alpha');
  const content = fs.readFileSync(file, 'utf8');
  const config = f.settings({ defaultModel: 'unchanged', extensions: ['x'], custom: { x: true } });
  const r = await row(f.m, 'alpha');
  const result = await f.m.toggle(r.id, false, r.configRevision);
  assert.equal(result.snapshot.skills[0].enabled, false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).defaultModel, 'unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup, 'utf8')).custom, { x: true });
  const disabled = await row(f.m, 'alpha');
  const enabled = await f.m.toggle(r.id, true, disabled.configRevision);
  assert.equal(enabled.snapshot.skills[0].effective, true);
});
test('Agent Skills 的相对排除和通配符关闭可以用精准包含覆盖', async (t) => {
  const f = fixture(t);
  f.add('alpha', skill('alpha'), path.join(f.root, '.agents/skills'));
  f.settings({ skills: ['!**/alpha/**', '-skills/alpha'] });
  const r = await row(f.m, 'alpha');
  assert.equal(r.enabled, false);
  const result = await f.m.toggle(r.id, true, r.configRevision);
  assert.equal(result.snapshot.skills[0].enabled, true);
});
test('扩展包开关保留 source、extensions、prompts 和其他 Skill 状态', async (t) => {
  const f = fixture(t);
  const pkg = path.join(f.root, 'package');
  f.add('pack-a', skill('pack-a'), path.join(pkg, 'skills'));
  f.add('pack-b', skill('pack-b'), path.join(pkg, 'skills'));
  f.write(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', pi: { skills: ['./skills'], extensions: [] } }));
  const config = f.settings({ packages: [{ source: pkg, extensions: [], prompts: ['prompts/*.md'] }] });
  const r = await row(f.m, 'pack-a');
  assert.equal(r.package, true);
  const result = await f.m.toggle(r.id, false, r.configRevision);
  assert.equal(result.snapshot.skills.find((s) => s.name === 'pack-a').enabled, false);
  assert.equal(result.snapshot.skills.find((s) => s.name === 'pack-b').enabled, true);
  const saved = JSON.parse(fs.readFileSync(config, 'utf8')).packages[0];
  assert.deepEqual(saved.extensions, []);
  assert.deepEqual(saved.prompts, ['prompts/*.md']);
  const disabled = await row(f.m, 'pack-a');
  await f.m.toggle(r.id, true, disabled.configRevision);
  assert.equal((await row(f.m, 'pack-a')).enabled, true);
});
test('包配置 skills:[] 只开启选中的一个，不误开全部；字符串包也可关闭', async (t) => {
  const f = fixture(t);
  const pkg = path.join(f.root, 'package');
  f.add('pack-a', skill('pack-a'), path.join(pkg, 'skills'));
  f.add('pack-b', skill('pack-b'), path.join(pkg, 'skills'));
  f.settings({ packages: [{ source: pkg, skills: [] }] });
  const r = await row(f.m, 'pack-a');
  assert.equal(r.enabled, false);
  const result = await f.m.toggle(r.id, true, r.configRevision);
  assert.equal(result.snapshot.skills.find((s) => s.name === 'pack-a').enabled, true);
  assert.equal(result.snapshot.skills.find((s) => s.name === 'pack-b').enabled, false);
  const on = await row(f.m, 'pack-a');
  await f.m.toggle(on.id, false, on.configRevision);
  assert.equal((await row(f.m, 'pack-b')).enabled, false);
  f.settings({ packages: [pkg] });
  const stringRow = await row(f.m, 'pack-a');
  await f.m.toggle(stringRow.id, false, stringRow.configRevision);
  assert.equal((await row(f.m, 'pack-b')).enabled, true);
});
test('autoload:false 和项目包过滤增量不破坏全局配置', async (t) => {
  const f = fixture(t);
  const pkg = path.join(f.root, 'package');
  f.add('pack-a', skill('pack-a'), path.join(pkg, 'skills'));
  f.add('pack-b', skill('pack-b'), path.join(pkg, 'skills'));
  const globalFile = f.settings({ packages: [pkg] });
  const globalRaw = fs.readFileSync(globalFile, 'utf8');
  f.settings({ packages: [{ source: pkg, autoload: false, skills: ['-skills/pack-a'] }] }, true);
  const m = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd, project: true });
  const r = await row(m, 'pack-a');
  assert.equal(r.scope, 'project');
  assert.equal(r.enabled, false);
  await m.toggle(r.id, true, r.configRevision);
  assert.equal((await row(m, 'pack-a')).enabled, true);
  assert.equal((await row(m, 'pack-b')).enabled, true);
  assert.equal(fs.readFileSync(globalFile, 'utf8'), globalRaw);
});
test('同名冲突按 Pi 原生优先级显示胜者', async (t) => {
  const f = fixture(t);
  f.add('alpha', skill('same'));
  f.add('beta', skill('same'));
  const rows = (await f.m.list()).skills;
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.effective).length, 1);
  const winner = rows.find((r) => r.effective);
  const result = await f.m.toggle(winner.id, false, winner.configRevision);
  assert.equal(result.snapshot.skills.filter((r) => r.effective).length, 1);
  assert.notEqual(result.snapshot.skills.find((r) => r.effective).id, winner.id);
});
test('保存原文、保留 metadata、恢复备份，并为恢复前文件生成备份', async (t) => {
  const f = fixture(t);
  const file = f.add('alpha');
  const r = await row(f.m, 'alpha');
  const d = await f.m.detail(r.id);
  const content = d.content.replace('原正文。', '编辑后的正文。');
  const saved = await f.m.save(r.id, content, d.revision);
  assert.equal(fs.readFileSync(saved.backup, 'utf8'), d.content);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.match(content, /owner: personal/);
  const result = await f.m.restore(r.id, saved.detail.backups[0], saved.detail.revision);
  assert.equal(fs.readFileSync(file, 'utf8'), d.content);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), content);
  assert.equal(result.detail.backups.length, 2);
});
test('旧编辑版本、旧配置版本都拒绝覆盖外部修改', async (t) => {
  const f = fixture(t);
  const file = f.add('alpha');
  const config = f.settings({ custom: 1 });
  const r = await row(f.m, 'alpha');
  const d = await f.m.detail(r.id);
  fs.writeFileSync(file, skill('alpha', '外部修改'));
  await assert.rejects(f.m.save(r.id, skill('alpha'), d.revision), /已被其他/);
  assert.match(fs.readFileSync(file, 'utf8'), /外部修改/);
  fs.writeFileSync(config, JSON.stringify({ custom: 2 }));
  await assert.rejects(f.m.toggle(r.id, false, r.configRevision), /已被其他/);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).custom, 2);
});
test('没有原配置时可首次关闭 Skill，创建配置但不改原文', async (t) => {
  const f = fixture(t);
  f.add('alpha');
  const r = await row(f.m, 'alpha');
  const result = await f.m.toggle(r.id, false, r.configRevision);
  assert.equal(result.backup, null);
  assert.equal(result.snapshot.skills[0].enabled, false);
});
test('损坏配置阻止写入，越界标识和备份路径不被接受', async (t) => {
  const f = fixture(t);
  f.add('alpha');
  const r = await row(f.m, 'alpha');
  await assert.rejects(f.m.detail('../settings.json'), /无效/);
  await assert.rejects(f.m.restore(r.id, '../../settings.json', ''), /无效/);
  f.write(path.join(f.agentDir, 'settings.json'), '{broken');
  await assert.rejects(f.m.toggle(r.id, false, r.configRevision), /配置无法解析/);
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'settings.json'), 'utf8'), '{broken');
});
test('默认不加载项目配置；显式项目视图只在原所属范围写开关', async (t) => {
  const f = fixture(t);
  f.add('global-one');
  f.add('project-one', skill('project-one'), path.join(f.cwd, '.pi/skills'));
  assert.equal((await f.m.list()).skills.length, 1);
  const m = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd, project: true });
  const r = await row(m, 'project-one');
  assert.equal(r.scope, 'project');
  await m.toggle(r.id, false, r.configRevision);
  assert.equal((await row(m, 'project-one')).enabled, false);
  assert.equal(fs.existsSync(path.join(f.agentDir, 'settings.json')), false);
});
test('删除后的 Skill 不再允许访问；符号链接只备份和修改目标文件', async (t) => {
  const f = fixture(t);
  const file = f.add('alpha');
  const r = await row(f.m, 'alpha');
  fs.unlinkSync(file);
  await assert.rejects(f.m.detail(r.id), /不再处于/);
  const target = f.write(path.join(f.root, 'target.md'), skill('linked'));
  const link = path.join(f.agentDir, 'skills/link.md');
  try { fs.symlinkSync(target, link); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows 未授予 symlink 权限，跳过本用例的链接部分。'); return; } throw error; }
  const linked = await row(f.m, 'linked');
  const d = await f.m.detail(linked.id);
  const result = await f.m.save(linked.id, skill('linked', '修改链接目标'), d.revision);
  assert(fs.lstatSync(link).isSymbolicLink());
  assert.match(fs.readFileSync(target, 'utf8'), /修改链接目标/);
  assert.equal(result.detail.backups.length, 1);
});
test('校验名称、描述、手动调用字段和大小', () => {
  assert.throws(() => validateSkill(skill('Bad'), 'bad'), /name/);
  assert.throws(() => validateSkill(skill('good', ''), 'good'), /description/);
  assert.throws(() => validateSkill(skill('good').replace('metadata:', 'disable-model-invocation: "true"\nmetadata:'), 'good'), /disable-model/);
  assert.throws(() => validateSkill('x'.repeat(1024 * 1024 + 1), 'good'), /1 MiB/);
});
test('创建完整 Skill，保留全部原文和 CRLF，不改配置，返回可编辑详情', async (t) => {
  const f = fixture(t);
  const config = f.settings({ untouched: { keep: true } });
  const rawConfig = fs.readFileSync(config, 'utf8');
  const content = '\uFEFF' + skill('created-skill').replaceAll('\n', '\r\n');
  const result = await f.m.create(content);
  assert.equal(result.created, true);
  assert.equal(result.path, path.join(f.root, '.agents/skills/created-skill/SKILL.md'));
  assert.equal(fs.readFileSync(result.path, 'utf8'), content);
  assert.equal(fs.readFileSync(config, 'utf8'), rawConfig);
  assert.equal(result.item.effective, true);
  assert.equal(result.detail.content, content);
  assert.deepEqual(result.detail.backups, []);
  assert.deepEqual(fs.readdirSync(path.dirname(result.path)), ['SKILL.md']);
});
test('拒绝重复名称、已关闭 Skill 的同名和已有非 Skill 目录，不覆盖文件', async (t) => {
  const f = fixture(t);
  const existing = f.add('existing');
  const r = await row(f.m, 'existing');
  await f.m.toggle(r.id, false, r.configRevision);
  await assert.rejects(f.m.create(skill('existing')), /已存在/);
  assert.equal(fs.readFileSync(existing, 'utf8'), skill('existing'));
  const foreign = f.write(path.join(f.root, '.agents/skills/folder-only/notes.txt'), 'keep');
  await assert.rejects(f.m.create(skill('folder-only')), /目录.*已存在/);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
  const created = await f.m.create(skill('unique'));
  await assert.rejects(f.m.create(skill('unique', 'new')), /已存在/);
  assert.equal(fs.readFileSync(created.path, 'utf8'), skill('unique'));
});
test('创建拒绝坏 YAML、缺少头部、路径穿越、保留文件名、缺 description 和大文件', async (t) => {
  const f = fixture(t);
  const invalid = [
    '正文没有 YAML', '```markdown\n' + skill('x') + '```', skill('../outside'),
    skill('con'), skill('x', ''), '---\nname: bad\ndescription: text: bad\n---\n',
    '---\ndescription: only\n---\nbody', skill('x') + 'x'.repeat(1024 * 1024),
  ];
  for (const content of invalid) await assert.rejects(f.m.create(content));
  await assert.rejects(f.m.create(skill('x'), '../outside'), /范围/);
  assert.equal(fs.existsSync(f.m.creationRoots().global), false);
});
test('显式项目新建写入项目 skills，无项目视图不允许写项目范围', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.m.create(skill('project-new'), 'project'), /项目视图/);
  const m = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd, project: true });
  const result = await m.create(skill('project-new'), 'project');
  assert.equal(result.path, path.join(f.cwd, '.pi/skills/project-new/SKILL.md'));
  assert.equal(result.item.scope, 'project');
  assert.equal(fs.existsSync(path.join(f.agentDir, 'settings.json')), false);
});
test('创建不擅自开启现有过滤排除的新文件，明确返回状态提醒', async (t) => {
  const f = fixture(t);
  const config = f.settings({ skills: ['!**/new-one/**'] });
  const raw = fs.readFileSync(config, 'utf8');
  const result = await f.m.create(skill('new-one'));
  assert.equal(result.created, true);
  assert.equal(result.item.enabled, false);
  assert.match(result.warning, /未生效/);
  assert.equal(fs.readFileSync(config, 'utf8'), raw);
});
test('原生发现忽略新文件或创建后刷新失败时，仍明确告知文件已创建', async (t) => {
  const f = fixture(t);
  f.write(path.join(f.root, '.agents/skills/.gitignore'), 'hidden-one/\n');
  const hidden = await f.m.create(skill('hidden-one'));
  assert.equal(hidden.created, true);
  assert.equal(hidden.item, null);
  assert.match(hidden.warning, /暂不可见/);
  const list = f.m.list.bind(f.m);
  let calls = 0;
  f.m.list = async () => { if (++calls > 1) throw new Error('simulated refresh failure'); return list(); };
  const refreshed = await f.m.create(skill('refresh-fail'));
  assert.equal(refreshed.created, true);
  assert.match(refreshed.warning, /请勿重复/);
  assert.equal(fs.readFileSync(refreshed.path, 'utf8'), skill('refresh-fail'));
});
test('写入失败只清理本次临时文件和空目录；发布期间出现的同名文件不覆盖不删除', async (t) => {
  const f = fixture(t);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => { if (typeof file === 'number' || String(file).endsWith('.tmp')) throw new Error('simulated write failure'); return originalWrite(file, ...args); };
  try { await assert.rejects(f.m.create(skill('write-fail')), /simulated/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.existsSync(path.join(f.m.creationRoots().global, 'write-fail')), false);
  const originalLink = fs.linkSync;
  fs.linkSync = (src, dest) => { originalWrite(dest, 'foreign file'); return originalLink(src, dest); };
  try { await assert.rejects(f.m.create(skill('raced')), /没有覆盖/); }
  finally { fs.linkSync = originalLink; }
  const raced = path.join(f.m.creationRoots().global, 'raced');
  assert.equal(fs.readFileSync(path.join(raced, 'SKILL.md'), 'utf8'), 'foreign file');
  assert.deepEqual(fs.readdirSync(raced), ['SKILL.md']);
});
test('发布后清理暂存文件失败不把成功创建误报为失败', async (t) => {
  const f = fixture(t);
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => { if (String(file).endsWith('.tmp')) throw new Error('simulated cleanup failure'); return originalUnlink(file); };
  let result;
  try { result = await f.m.create(skill('cleanup-fail')); }
  finally { fs.unlinkSync = originalUnlink; }
  assert.equal(result.created, true);
  assert.match(result.warning, /临时文件清理失败/);
  assert.equal(fs.readFileSync(result.path, 'utf8'), skill('cleanup-fail'));
});
test('真实 HTTP 接口、同源写入、Host/Origin 防护与静态文件白名单', async (t) => {
  const f = fixture(t);
  f.add('alpha');
  const server = createServer(f.m);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/skills`);
  assert.equal(response.status, 200);
  const r = (await response.json()).skills[0];
  const data = JSON.stringify({ enabled: false, configRevision: r.configRevision });
  const url = `${base}/api/skills/${r.id}/toggle`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Skill-Manager': '1', 'Content-Type': 'application/json' }, body: data })).status, 403);
  const good = await fetch(url, { method: 'POST', headers: { Origin: base, 'X-Skill-Manager': '1', 'Content-Type': 'application/json' }, body: data });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).snapshot.skills[0].enabled, false);
  const createData = JSON.stringify({ content: skill('http-created'), scope: 'global' });
  assert.equal((await fetch(`${base}/api/skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: createData })).status, 403);
  assert.equal((await fetch(`${base}/api/skills`, { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Skill-Manager': '1', 'Content-Type': 'application/json' }, body: createData })).status, 403);
  const created = await fetch(`${base}/api/skills`, { method: 'POST', headers: { Origin: base, 'X-Skill-Manager': '1', 'Content-Type': 'application/json' }, body: createData });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).item.name, 'http-created');
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/skills`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/settings.json`)).status, 404);
  assert.equal((await fetch(`${base}/pi-adapter.mjs`)).status, 404);
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await html.text(), /Skill 管理/);
});
