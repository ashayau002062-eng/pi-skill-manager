// Group renaming uses actual production UI/API; writes only isolated fixture preferences.
import fs from 'node:fs';

import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { playwright, executablePath } from './helpers/browser.mjs';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';

const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-group-rename-browser-')); const home = process.env.HOME; process.env.HOME = root;
const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const text = name => `---\r\nname: ${name}\r\ndescription: fixture\r\n---\r\n正文\r\n`;
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
const files = ['alpha', 'beta', 'gamma'].map(name => write(path.join(agentDir, 'skills', name, 'SKILL.md'), text(name)));
const manager = new SkillManager({ agentDir, cwd, project: true }); const settings = write(manager.settingsPath('global'), '{"untouched":42}');
const server = createServer(manager); let browser; const report = { at: new Date().toISOString(), scope: 'isolated group rename fixture only', checks: [], errors: [] }; const pass = name => report.checks.push({ name, pass: true });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const posts = [];
  page.on('pageerror', error => report.errors.push(error.message)); page.on('request', request => { if (request.method() !== 'GET') posts.push(request.url()); });
  const p = (selector, options) => page.locator(selector, options); const row = name => p('.skill-row').filter({ has: p('.row-title', { hasText: new RegExp(`^${name}$`) }) }); const idle = () => page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#total').textContent === '3'); assert.equal(await p('#group-rename-open').isDisabled(), true);
  const s = await manager.list(); const ids = Object.fromEntries(s.skills.map(row => [row.name, row.id])); const orphan = 'f'.repeat(64); const viewId = randomUUID();
  const value = { version: 1, favorites: [ids.alpha], organization: { [ids.alpha]: { group: '写作', tags: ['中文'], extra: 42 }, [ids.beta]: { group: '写作', tags: ['练习'] }, [ids.gamma]: { group: '其他', tags: ['keep'] }, [orphan]: { group: '写作', tags: ['orphan'] } }, notes: { [ids.alpha]: '原备注' }, added: { [ids.alpha]: 1790000000000 }, future: 'keep', views: [{ id: viewId, name: '写作视图名称保留', filters: { query: '', body: false, status: 'all', group: 'g:写作', tag: '', notes: 'all', sort: 'name' } }] };
  const orphanOnly = { version: 1, favorites: [], organization: { [orphan]: { group: '暂未发现组', future: 42 } }, views: [{ id: viewId, name: '未发现组视图', filters: { ...value.views[0].filters, group: 'g:暂未发现组' } }] };
  write(manager.preferencesPath, JSON.stringify(orphanOnly)); await p('#refresh').click(); await idle(); assert.equal(await p('#group-rename-open').isDisabled(), false);
  await p('#group-rename-open').click(); await p('#group-rename-dialog').waitFor(); assert.deepEqual(await p('#group-rename-from option').allTextContents(), ['暂未发现组']); assert.match(await p('#group-rename-summary').textContent(), /当前已发现 0 个成员，1 个常用视图/);
  await p('#group-rename-cancel').click(); assert.equal(posts.length, 0); assert.deepEqual(JSON.parse(fs.readFileSync(manager.preferencesPath)), orphanOnly);
  await p('#group-rename-open').click(); await p('#group-rename-name').fill('已改名的未发现组'); await p('#group-rename-submit').click(); await page.waitForFunction(() => !document.querySelector('#group-rename-dialog').open); await idle();
  const renamedOrphan = structuredClone(orphanOnly); renamedOrphan.organization[orphan].group = '已改名的未发现组'; renamedOrphan.views[0].filters.group = 'g:已改名的未发现组'; assert.deepEqual(JSON.parse(fs.readFileSync(manager.preferencesPath)), renamedOrphan); assert((await manager.list()).skills.every(row => !row.group)); assert.match(await p('#group-rename-receipt').textContent(), /1 条成员记录和 1 个视图引用/);
  const afterOrphanPosts = posts.length; assert.equal(afterOrphanPosts, 1); for (const [i, name] of ['alpha', 'beta', 'gamma'].entries()) assert.equal(fs.readFileSync(files[i], 'utf8'), text(name));
  pass('orphan-only stored group remains selectable with zero discovered members; cancel is read-only and actual rename preserves record/view shape and Skill bytes');
  write(manager.preferencesPath, JSON.stringify(value)); await p('#refresh').click(); await idle(); assert.equal(await p('#group-rename-open').isDisabled(), false);
  await p('#saved-view').selectOption(viewId); await row('alpha').locator('.row-title').click(); await idle(); await p('#ui-tab-source').click(); const original = await p('#editor').inputValue(); const draft = original + '\n未保存原文'; await p('#editor').fill(draft);
  const raw = () => JSON.parse(fs.readFileSync(manager.preferencesPath)); const open = async () => { await p('#group-rename-open').click(); await p('#group-rename-dialog').waitFor(); };
  await open(); assert.equal(await p('#group-rename-from').inputValue(), '写作'); assert.equal(await p('#group-rename-name').inputValue(), '写作'); assert(await p('#group-rename-submit').isDisabled()); assert.match(await p('#group-rename-summary').textContent(), /2 个成员，1 个常用视图/);
  await p('#group-rename-name').fill('   '); assert(await p('#group-rename-submit').isDisabled()); await p('#group-rename-name').fill('未提交'); page.once('dialog', dialog => dialog.dismiss()); await page.keyboard.press('Escape'); assert(await p('#group-rename-dialog').isVisible()); assert.equal(await p('#group-rename-name').inputValue(), '未提交');
  page.once('dialog', dialog => dialog.accept()); await p('#group-rename-cancel').click(); assert.equal(posts.length, afterOrphanPosts); assert.deepEqual(raw(), value); assert.equal(await p('#editor').inputValue(), draft);
  pass('rename entry disabled without groups; current group preselected, no-change/empty disabled and Cancel/Escape protect both drafts without POST');
  const newName = '<img src=x onerror="window.injected=true">'; await open(); await p('#group-rename-name').fill(newName); await page.screenshot({ path: 'verification/group-rename-dialog.png', fullPage: true }); await page.keyboard.press('Control+s'); await page.waitForFunction(() => !document.querySelector('#group-rename-dialog').open); await idle();
  assert.equal(await p('#editor').inputValue(), draft); assert.equal(fs.readFileSync(files[0], 'utf8'), text('alpha')); assert(!posts.some(url => url.includes('/skills/') && url.endsWith('/save')));
  assert.equal(await p('#group-filter').inputValue(), `g:${newName}`); assert.equal(await p('#saved-view').inputValue(), viewId); assert.equal(await p('#view-status').textContent(), '已应用'); assert.equal(await p('.skill-row').count(), 2); assert.equal(await p('#selection-count').textContent(), '已选 0');
  assert.equal(raw().organization[orphan].group, newName); assert.equal(raw().views[0].filters.group, `g:${newName}`); assert.equal(raw().views[0].name, value.views[0].name); assert.equal(raw().organization[ids.alpha].extra, 42); assert.equal(raw().future, 'keep'); assert.deepEqual(raw().notes, value.notes); assert.deepEqual(raw().added, value.added);
  pass('dialog Ctrl+S renames whole group including orphan record, follows active filter/view and preserves main draft/metadata/member set');
  assert.equal(await p('#ui-group-nav img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined); assert.match(await p('#group-rename-receipt').textContent(), /3 条成员记录和 1 个视图引用/); await page.screenshot({ path: 'verification/group-rename-result.png', fullPage: true });
  pass('untrusted new label and durable receipt render as literal text, never HTML; view names and other filter conditions stay intact');
  await open(); const beforeConflict = fs.readFileSync(manager.preferencesPath); await p('#group-rename-name').fill('其他'); await p('#group-rename-submit').click(); await idle(); await p('#group-rename-error').waitFor(); assert.match(await p('#group-rename-error').textContent(), /不会合并/); assert.equal(await p('#group-rename-name').inputValue(), '其他'); assert.deepEqual(fs.readFileSync(manager.preferencesPath), beforeConflict);
  pass('existing-name conflict stays in dialog, preserves typed input and does not merge groups or change stored content');
  await p('#group-rename-name').fill('再改名'); const current = await manager.list(); await manager.note(ids.gamma, '另一个窗口写入', current.preferencesRevision); const staleBefore = fs.readFileSync(manager.preferencesPath); await p('#group-rename-submit').click(); await idle(); assert.match(await p('#group-rename-error').textContent(), /其他窗口/); assert.deepEqual(fs.readFileSync(manager.preferencesPath), staleBefore); assert.equal(await p('#editor').inputValue(), draft); page.once('dialog', dialog => dialog.accept()); await p('#group-rename-cancel').click();
  pass('concurrent preference update rejects stale rename without clobbering another-window notes or source draft');
  await p('#ui-tab-source').click(); await p('#editor').fill(original); await p('#refresh').click(); await idle(); await page.setViewportSize({ width: 390, height: 844 }); await p('#ui-nav-toggle').click(); await open(); assert.equal(await p('#ui-sidebar').isVisible(), false); await p('#group-rename-from').selectOption('其他'); assert.equal(await p('#group-rename-name').inputValue(), '其他'); await p('#group-rename-name').fill('手机分组');
  await page.screenshot({ path: 'verification/group-rename-mobile.png', fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); const mobileBeforePosts = posts.length; page.once('dialog', dialog => dialog.accept()); await p('#group-rename-cancel').click(); assert.equal(posts.length, mobileBeforePosts); assert.equal(await p('#ui-library').getAttribute('inert'), null);
  pass('mobile drawer launches real rename dialog, source selection updates name, fits screen, and cancellation clears no data or selections');
  await page.setViewportSize({ width: 1440, height: 1000 }); await open(); await p('#group-rename-name').fill('已完成但刷新失败'); const list = manager.list.bind(manager); manager.list = async () => { throw new Error('fixture post-save refresh failure'); };
  await p('#group-rename-submit').click(); await page.waitForFunction(() => !document.querySelector('#group-rename-dialog').open); await idle(); assert.equal(raw().organization[ids.alpha].group, '已完成但刷新失败'); assert.match(await p('#group-rename-receipt').textContent(), /已更名.*偏好已保存.*刷新失败.*不要重复改名/s); assert(await p('#group-rename-open').isDisabled()); const postFailureCount = posts.length; await page.keyboard.press('Control+s'); assert.equal(posts.length, postFailureCount);
  manager.list = list; await p('#refresh').click(); await idle(); assert.equal(await p('#group-rename-open').isDisabled(), false); assert.equal(await p('#group-filter').inputValue(), 'g:已完成但刷新失败'); assert.equal(await p('.skill-row').count(), 2); assert.equal(await p('#view-status').textContent(), '已应用');
  pass('completed rename survives post-save refresh fault with durable honest receipt, prevents stale repeat and recovers on manual refresh');
  for (const [i, name] of ['alpha', 'beta', 'gamma'].entries()) assert.equal(fs.readFileSync(files[i], 'utf8'), text(name)); assert.equal(fs.readFileSync(settings, 'utf8'), '{"untouched":42}'); assert.deepEqual(raw().organization[ids.gamma], value.organization[ids.gamma]); assert.equal(raw().notes[ids.gamma], '另一个窗口写入'); assert.deepEqual(report.errors, []);
  pass('all original Skill bytes/Pi settings/unrelated group stay unchanged; no browser JS errors or Skill save requests'); report.pass = true;
} catch (error) { report.pass = false; report.failure = error.stack; throw error; }
finally { fs.writeFileSync('verification/group-rename-browser.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); }
