import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { SkillManager, hash } from '../manager.mjs';
import { createServer } from '../server.mjs';
import { collectFiles, encodeZip, decodeZip, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../bundles.mjs';

const content = (name = 'alpha') => `---\nname: "${name}" # 保留注释\ndescription: "复制与归档测试"\nmetadata:\n  author: personal\nallowed-tools: [read, bash]\n---\n\n# 保留正文\n\n引用 references/中文 文件.md。\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skill-features-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const add = (name, text = content(name), base = path.join(agentDir, 'skills')) => write(path.join(base, name, 'SKILL.md'), text);
  const m = new SkillManager({ agentDir, cwd, project: true });
  return { root, agentDir, cwd, write, add, m };
}
const row = async (m, name) => (await m.list()).skills.find((item) => item.name === name);
const selection = (rows) => rows.map(({ id, configRevision }) => ({ id, configRevision }));
// Test-only stored/deflated ZIP builder permits hostile names rejected by normal ZIP writers.
function rawZip(entries) {
  const local = []; const central = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.path);
    const data = item.data || Buffer.alloc(0);
    const compressed = item.deflate ? deflateRawSync(data) : data;
    const checksum = item.checksum ?? crc32(data);
    const size = item.size ?? data.length;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800 | (item.encrypted ? 1 : 0), 6);
    l.writeUInt16LE(item.deflate ? 8 : 0, 8); l.writeUInt32LE(checksum, 14); l.writeUInt32LE(compressed.length, 18); l.writeUInt32LE(size, 22); l.writeUInt16LE(name.length, 26);
    local.push(l, name, compressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800 | (item.encrypted ? 1 : 0), 8);
    c.writeUInt16LE(item.deflate ? 8 : 0, 10); c.writeUInt32LE(checksum, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((item.mode ?? 0o100600) * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name); offset += l.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
const baseEntry = () => ({ path: 'SKILL.md', data: Buffer.from(content()) });

test('完整复制保留 CRLF/BOM、注释、未知字段、正文、二进制附件与空目录，只改 name', async (t) => {
  const f = fixture(t);
  const original = '\uFEFF' + content().replaceAll('\n', '\r\n');
  const originalFile = f.add('alpha', original);
  const folder = path.dirname(originalFile);
  const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
  f.write(path.join(folder, 'assets/image.bin'), binary);
  f.write(path.join(folder, 'references/中文 文件.md'), '参考文件\r\n');
  fs.mkdirSync(path.join(folder, 'empty'));
  f.write(path.join(folder, '.git/config'), 'not exported'); f.write(path.join(folder, 'node_modules/a.js'), 'not exported');
  const settings = f.write(path.join(f.agentDir, 'settings.json'), '{"untouched":true}');
  const r = await row(f.m, 'alpha'); const d = await f.m.detail(r.id);
  const result = await f.m.duplicate(r.id, 'alpha-copy', 'global', d.revision);
  assert.equal(result.created, true);
  assert.equal(result.detail.content, original.replace('"alpha"', 'alpha-copy'));
  assert.equal(fs.readFileSync(originalFile, 'utf8'), original);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(result.path), 'assets/image.bin')), binary);
  assert.equal(fs.readFileSync(path.join(path.dirname(result.path), 'references/中文 文件.md'), 'utf8'), '参考文件\r\n');
  assert(fs.statSync(path.join(path.dirname(result.path), 'empty')).isDirectory());
  assert(!fs.existsSync(path.join(path.dirname(result.path), '.git')));
  assert(!fs.existsSync(path.join(path.dirname(result.path), 'node_modules')));
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"untouched":true}');
  await assert.rejects(f.m.duplicate(r.id, 'alpha-copy', 'global', d.revision), /已存在/);
});
test('复制安全支持块标量名称，旧版本拒绝，原文件不变', async (t) => {
  const f = fixture(t);
  const text = content().replace('name: "alpha" # 保留注释', 'name: >-\n  alpha');
  const file = f.add('alpha', text);
  const r = await row(f.m, 'alpha'); const d = await f.m.detail(r.id);
  const result = await f.m.duplicate(r.id, 'block-copy', 'project', d.revision);
  assert.match(result.detail.content, /name: block-copy\ndescription:/);
  assert.equal(result.item.scope, 'project');
  f.write(file, content('alpha') + '\n外部修改');
  await assert.rejects(f.m.duplicate(r.id, 'stale-copy', 'global', d.revision), /已被其他/);
  assert(!fs.existsSync(path.join(f.root, '.agents/skills/stale-copy')));
});
test('复制 YAML 别名名称只替换该别名，不改锚点和其他元数据', async (t) => {
  const f = fixture(t);
  const text = content().replace('name: "alpha" # 保留注释', 'metadata-name: &old-name alpha\nname: *old-name # 保留注释');
  const file = f.add('alpha', text);
  const r = await row(f.m, 'alpha'); const d = await f.m.detail(r.id);
  const result = await f.m.duplicate(r.id, 'alias-copy', 'global', d.revision);
  assert.equal(result.detail.content, text.replace('*old-name', 'alias-copy'));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('独立 Markdown 打包和复制只包含自身，不带入同目录的其他 Skill 或配置', async (t) => {
  const f = fixture(t);
  const file = f.write(path.join(f.agentDir, 'skills/single.md'), content('single'));
  f.write(path.join(f.agentDir, 'skills/private.json'), 'unrelated');
  const r = await row(f.m, 'single');
  const zip = await f.m.exportZip(r.id);
  assert.deepEqual((await decodeZip(zip.data)).map((file) => file.path), ['SKILL.md']);
  const d = await f.m.detail(r.id);
  const result = await f.m.duplicate(r.id, 'single-copy', 'global', d.revision);
  assert.deepEqual(fs.readdirSync(path.dirname(result.path)), ['SKILL.md']);
  assert.equal(fs.readFileSync(file, 'utf8'), content('single'));
});
test('ZIP 往返保留 UTF-8/BOM、二进制、0B、中文路径和目录，可原样导入或改名', async (t) => {
  const f = fixture(t);
  const text = '\uFEFF' + content('imported').replaceAll('\n', '\r\n');
  const entries = [{ path: 'SKILL.md', data: Buffer.from(text) }, { path: 'assets', data: null }, { path: 'assets/零字节.bin', data: Buffer.alloc(0) }, { path: 'references/中文 # 文件.md', data: Buffer.from('资料') }];
  const zip = await encodeZip(entries);
  const files = await decodeZip(zip);
  assert.deepEqual(files.map((file) => [file.path, file.data && hash(file.data)]), entries.map((file) => [file.path, file.data && hash(file.data)]));
  const result = await f.m.importZip(zip);
  assert.equal(result.detail.content, text);
  assert.equal(fs.statSync(path.join(path.dirname(result.path), 'assets/零字节.bin')).size, 0);
  await assert.rejects(f.m.importZip(zip), /已存在/);
  const renamed = await f.m.importZip(zip, 'project', 'renamed');
  assert.equal(renamed.item.name, 'renamed');
  assert.match(renamed.detail.content, /metadata:\r\n  author: personal/);
});
test('ZIP 接受外包一层目录，拒绝多个 Skill 和根外文件', async () => {
  const zipped = rawZip([{ path: 'bundle/', mode: 0o40700 }, { path: 'bundle/SKILL.md', data: Buffer.from(content()) }, { path: 'bundle/assets/a.txt', data: Buffer.from('x') }]);
  assert.deepEqual((await decodeZip(zipped)).map((file) => file.path), ['SKILL.md', 'assets/a.txt']);
  await assert.rejects(decodeZip(rawZip([{ path: 'a/SKILL.md', data: Buffer.from(content('a')) }, { path: 'b/SKILL.md', data: Buffer.from(content('b')) }])), /一个 Skill/);
  await assert.rejects(decodeZip(rawZip([{ path: 'bundle/SKILL.md', data: Buffer.from(content()) }, { path: 'outside.txt', data: Buffer.from('x') }])), /之外/);
});
test('恶意 ZIP 路径、ADS、Windows 保留名、大小写冲突、文件目录冲突、链接和加密均在写入前拒绝', async (t) => {
  const f = fixture(t);
  for (const unsafe of ['../outside', '/absolute', 'C:/absolute', 'assets\\outside', 'assets/../outside', 'assets/.', 'assets//empty', 'assets/a:b', 'assets/NUL.txt', 'assets/COM¹.txt', 'assets/trailing.', 'assets/trailing ', 'assets/a\u0000b']) {
    await assert.rejects(f.m.importZip(rawZip([baseEntry(), { path: unsafe, data: Buffer.from('hostile') }])));
  }
  for (const entries of [
    [baseEntry(), { path: 'assets/A.txt' }, { path: 'assets/a.txt' }],
    [baseEntry(), { path: 'assets/a.txt' }, { path: 'Assets/b.txt' }],
    [baseEntry(), { path: 'assets' }, { path: 'assets/file' }],
    [baseEntry(), { path: 'assets/link', mode: 0o120777, data: Buffer.from('../outside') }],
    [baseEntry(), { path: 'assets/file', encrypted: true }],
  ]) await assert.rejects(f.m.importZip(rawZip(entries)));
  assert(!fs.existsSync(f.m.creationRoots().global));
});
test('损坏 ZIP、CRC、无效 UTF-8、坏 YAML、缺 SKILL.md 被拒绝', async (t) => {
  const f = fixture(t);
  for (const buffer of [Buffer.from('not zip'), rawZip([{ ...baseEntry(), checksum: 1 }]), rawZip([{ path: 'SKILL.md', data: Buffer.from([0xff, 0xff]) }]), rawZip([{ path: 'SKILL.md', data: Buffer.from('---\nname: x\ndescription: bad: yaml\n---\n') }]), rawZip([{ path: 'assets/a' }])]) await assert.rejects(f.m.importZip(buffer));
  assert(!fs.existsSync(f.m.creationRoots().global));
});
test('ZIP 文件数和声明/实际膨胀限额阻止炸弹，文件收集也有总量限制', async (t) => {
  const f = fixture(t);
  await assert.rejects(decodeZip(rawZip([baseEntry(), ...Array.from({ length: 1000 }, (_, i) => ({ path: `files/${i}` }))])), /1000/);
  await assert.rejects(decodeZip(rawZip([baseEntry(), { path: 'large', data: Buffer.from('x'), deflate: true, size: MAX_FILE_BYTES + 1 }])), /20 MiB/);
  await assert.rejects(decodeZip(rawZip([baseEntry(), { path: 'bomb', data: Buffer.alloc(MAX_FILE_BYTES + 1), deflate: true, size: 1 }])));
  const file = f.add('alpha');
  for (let i = 0; i < 3; i++) { const big = path.join(path.dirname(file), `big-${i}`); const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 18 * 1024 * 1024); fs.closeSync(fd); }
  assert.throws(() => collectFiles(file), /50 MiB/);
  assert.equal(MAX_TOTAL_BYTES, 50 * 1024 * 1024);
});
test('Windows junction 和目录链接拒绝打包，外部文件保持不变', async (t) => {
  const f = fixture(t);
  const file = f.add('alpha');
  const outside = f.write(path.join(f.root, 'external/secret.txt'), 'untouched');
  const link = path.join(path.dirname(file), 'linked');
  try { fs.symlinkSync(path.dirname(outside), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('环境不允许创建目录链接'); return; } throw error; }
  assert.throws(() => collectFiles(file), /链接|junction/);
  const r = await row(f.m, 'alpha');
  await assert.rejects(f.m.exportZip(r.id), /链接|junction/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});
test('配套文件写入失败精确清理，发布竞争保留外来文件；成功后的刷新失败仍报告已创建', async (t) => {
  const f = fixture(t);
  const zip = await encodeZip([baseEntry(), { path: 'references/a.md', data: Buffer.from('a') }]);
  const originalWrite = fs.writeFileSync;
  let count = 0;
  fs.writeFileSync = (file, ...args) => { if (typeof file === 'number' && ++count === 2) throw new Error('companion failure'); return originalWrite(file, ...args); };
  try { await assert.rejects(f.m.importZip(zip), /companion failure/); } finally { fs.writeFileSync = originalWrite; }
  assert(!fs.existsSync(path.join(f.m.creationRoots().global, 'alpha')));
  const originalLink = fs.linkSync;
  fs.linkSync = (source, target) => { originalWrite(path.join(path.dirname(target), 'foreign.txt'), 'keep'); originalWrite(target, 'foreign'); return originalLink(source, target); };
  try { await assert.rejects(f.m.importZip(zip), /没有覆盖/); } finally { fs.linkSync = originalLink; }
  const folder = path.join(f.m.creationRoots().global, 'alpha');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['SKILL.md', 'foreign.txt']);
  assert.equal(fs.readFileSync(path.join(folder, 'foreign.txt'), 'utf8'), 'keep');
  const list = f.m.list.bind(f.m); let calls = 0;
  f.m.list = async () => { if (++calls > 1) throw new Error('refresh failure'); return list(); };
  const result = await f.m.importZip(zip, 'global', 'refresh-copy');
  assert.equal(result.created, true); assert.match(result.warning, /请勿重复/);
  assert(fs.existsSync(path.join(path.dirname(result.path), 'references/a.md')));
});
test('收藏只写管理器配置，跨实例持久化，不改原文或 Pi settings/加载胜者', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); f.add('beta');
  const settings = f.write(path.join(f.agentDir, 'settings.json'), '{"untouched":42}');
  const r = await row(f.m, 'alpha');
  const before = fs.readFileSync(settings); const text = fs.readFileSync(file);
  const result = await f.m.favorite(r.id, true);
  assert.equal(result.snapshot.skills.find((item) => item.id === r.id).favorite, true);
  const another = new SkillManager({ agentDir: f.agentDir, cwd: f.cwd });
  assert.equal((await row(another, 'alpha')).favorite, true);
  assert((await another.list()).skills.every((item) => item.effective));
  await another.favorite(r.id, false);
  assert.equal((await row(f.m, 'alpha')).favorite, false);
  assert.deepEqual(fs.readFileSync(settings), before); assert.deepEqual(fs.readFileSync(file), text);
});
test('收藏坏配置显示提醒并拒绝覆盖，其他字段保留，不能收藏越界标识', async (t) => {
  const f = fixture(t); f.add('alpha'); const r = await row(f.m, 'alpha');
  f.write(f.m.preferencesPath, JSON.stringify({ version: 1, favorites: [], future: 'keep' }));
  await f.m.favorite(r.id, true);
  assert.equal(JSON.parse(fs.readFileSync(f.m.preferencesPath, 'utf8')).future, 'keep');
  f.write(f.m.preferencesPath, '{bad');
  assert((await f.m.list()).diagnostics.some((item) => item.message.includes('收藏配置')));
  await assert.rejects(f.m.favorite(r.id, false), /收藏配置/);
  assert.equal(fs.readFileSync(f.m.preferencesPath, 'utf8'), '{bad');
  await assert.rejects(f.m.favorite('../x', true), /无效/);
});
test('批量同范围一次原子写入和一份备份，支持包空 skills 精准开启，不误开第三项', async (t) => {
  const f = fixture(t); const pkg = path.join(f.root, 'package');
  for (const name of ['pack-a', 'pack-b', 'pack-c']) f.add(name, content(name), path.join(pkg, 'skills'));
  f.write(path.join(pkg, 'package.json'), JSON.stringify({ pi: { skills: ['./skills'], extensions: [] } }));
  const settings = f.write(path.join(f.agentDir, 'settings.json'), JSON.stringify({ packages: [{ source: pkg, skills: [], extensions: [], prompts: ['x'] }], untouched: true }));
  const before = fs.readFileSync(settings, 'utf8');
  const rows = (await f.m.list()).skills.filter((item) => ['pack-a', 'pack-b'].includes(item.name));
  const result = await f.m.batchToggle(selection(rows), true);
  assert.equal(result.warning, null); assert.equal(result.backups.length, 1);
  assert.equal(fs.readFileSync(result.backups[0].path, 'utf8'), before);
  assert.equal(result.snapshot.skills.find((item) => item.name === 'pack-c').enabled, false);
  assert(result.snapshot.skills.filter((item) => ['pack-a', 'pack-b'].includes(item.name)).every((item) => item.enabled));
  const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(saved.untouched, true); assert.deepEqual(saved.packages[0].prompts, ['x']);
  const disabled = await f.m.batchToggle(selection(result.snapshot.skills.filter((item) => ['pack-a', 'pack-b'].includes(item.name))), false);
  assert(disabled.snapshot.skills.filter((item) => item.name.startsWith('pack-')).every((item) => !item.enabled));
});
test('批量先验证全部标识/摘要，旧版本不写任何范围；坏字段拒绝', async (t) => {
  const f = fixture(t); f.add('global-one'); f.add('project-one', content('project-one'), path.join(f.cwd, '.pi/skills'));
  const globalFile = f.write(path.join(f.agentDir, 'settings.json'), '{}'); const projectFile = f.write(path.join(f.cwd, '.pi/settings.json'), '{}');
  const rows = (await f.m.list()).skills.filter((item) => ['global-one', 'project-one'].includes(item.name));
  f.write(globalFile, '{"external":true}');
  await assert.rejects(f.m.batchToggle(selection(rows), false), /已被其他/);
  assert.equal(fs.readFileSync(globalFile, 'utf8'), '{"external":true}'); assert.equal(fs.readFileSync(projectFile, 'utf8'), '{}');
  for (const items of [[], [{ id: '../x', configRevision: 'x' }], [selection(rows)[0], selection(rows)[0]]]) await assert.rejects(f.m.batchToggle(items, false));
  await assert.rejects(f.m.batchToggle(selection(rows), 'false'));
});
test('跨范围失败明确已处理项，不伪报全部成功，不重试或修改失败范围', async (t) => {
  const f = fixture(t); f.add('global-one'); f.add('project-one', content('project-one'), path.join(f.cwd, '.pi/skills'));
  const rows = (await f.m.list()).skills;
  const ordered = ['global-one', 'project-one'].map((name) => rows.find((item) => item.name === name));
  const write = f.m.writeLocked.bind(f.m);
  f.m.writeLocked = (file, ...args) => { if (file === f.m.settingsPath('project')) throw new Error('project simulated failure'); return write(file, ...args); };
  const result = await f.m.batchToggle(selection(ordered), false);
  assert.deepEqual(result.processedIds, [ordered[0].id]); assert.match(result.warning, /已确认处理 1 个，未确认 1 个/);
  assert.equal(result.snapshot.skills.find((item) => item.name === 'global-one').enabled, false);
  assert.equal(result.snapshot.skills.find((item) => item.name === 'project-one').enabled, true);
  assert(!fs.existsSync(f.m.settingsPath('project')));
});
test('全部新接口沿用同源保护；真实 ZIP HTTP 往返与文件夹注册路径，导入不运行脚本', async (t) => {
  const f = fixture(t); const file = f.add('alpha'); const r = await row(f.m, 'alpha');
  const opened = []; const server = createServer(f.m, { openFolder: async (folder) => opened.push(folder) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'X-Skill-Manager': '1', 'Content-Type': 'application/json' };
  for (const endpoint of [`/api/skills/${r.id}/favorite`, `/api/skills/${r.id}/duplicate`, `/api/skills/${r.id}/open-folder`, '/api/batch-toggle', '/api/import']) {
    assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  }
  const folder = await fetch(`${base}/api/skills/${r.id}/open-folder`, { method: 'POST', headers, body: '{"path":"C:/Windows"}' });
  assert.equal(folder.status, 200); assert.deepEqual(opened, [path.dirname(file)]);
  const fav = await fetch(`${base}/api/skills/${r.id}/favorite`, { method: 'POST', headers, body: '{"favorite":true}' }); assert.equal(fav.status, 200);
  const exported = await fetch(`${base}/api/skills/${r.id}/export`); assert.equal(exported.headers.get('content-type'), 'application/zip'); assert.match(exported.headers.get('content-disposition'), /alpha.zip/);
  const zip = Buffer.from(await exported.arrayBuffer());
  const imported = await fetch(`${base}/api/import?scope=global&name=http-copy`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: zip });
  assert.equal(imported.status, 201); assert.equal((await imported.json()).item.name, 'http-copy');
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/skills/${'f'.repeat(64)}/open-folder`, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal(opened.length, 1);
});
