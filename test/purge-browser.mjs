import { ui } from './ui-navigation.mjs';
// Permanent deletion acceptance: isolated fixture archives ONLY, never real trash.
import fs from 'node:fs';

import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { playwright, executablePath } from './helpers/browser.mjs';
import { randomUUID } from 'node:crypto';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';

const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('../', import.meta.url)), '.test-purge-browser-'));
const home = process.env.HOME; process.env.HOME = root;
const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const content = (name) => `---\nname: ${name}\ndescription: fixture\n---\n正文\n`;
const alpha = path.join(agentDir, 'skills/alpha/SKILL.md'); const beta = path.join(agentDir, 'skills/beta/SKILL.md'); const keep = path.join(agentDir, 'skills/keep/SKILL.md');
for (const [file, name] of [[alpha, 'alpha'], [beta, 'beta'], [keep, 'keep']]) write(file, content(name));
write(path.join(path.dirname(alpha), '.git/config'), 'hidden'); write(path.join(path.dirname(alpha), 'node_modules/a.js'), 'never execute');
const config = path.join(agentDir, 'settings.json'); write(config, '{"untouched":42}');
const manager = new SkillManager({ agentDir, cwd, project: true }); assert.equal((await manager.list()).skills.length, 3, 'no real Skills allowed');
async function remove(name) {
  const row = (await manager.list()).skills.find(row => row.name === name); const relative = path.relative(root, fs.realpathSync(row.path)); assert(!relative.startsWith('..') && !path.isAbsolute(relative));
  const detail = await manager.detail(row.id); return manager.delete(row.id, detail.revision, name, detail.deletion.token);
}
const a = await remove('alpha'); const b = await remove('beta'); const item = (await manager.deleted()).items.find(item => item.name === 'beta'); await manager.undelete(item.id, item.token);
const archiveRoot = path.dirname(path.dirname(a.record)); const malformed = path.join(archiveRoot, randomUUID()); write(path.join(malformed, 'deletion-record.json'), '{bad');
const server = createServer(manager); let browser;
const report = { at: new Date().toISOString(), scope: 'isolated fixture archives only; no real permanent deletion', checks: [], errors: [] };
const pass = name => report.checks.push({ name, pass: true });
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#total').textContent === '2'); await ui(page, '#trash-open').click(); await ui(page, '#trash-dialog').waitFor({ state: 'visible' });
  await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' });
  assert.match(await ui(page, '#purge-summary').textContent(), /2 个归档目录.*1 个含备份.*1 个仅残留/); assert.equal(await ui(page, '#purge-items .trash-item').count(), 2); assert.match(await ui(page, '#purge-warnings').textContent(), /保留/); assert.equal(await ui(page, '#purge-submit').isDisabled(), true);
  await page.screenshot({ path: 'verification/purge-confirmation.png', fullPage: true }); pass('preview displays exact archives, active/restored counts, permanent warning and malformed-record retention');
  await ui(page, '#purge-confirmation').fill('清空'); assert.equal(await ui(page, '#purge-submit').isDisabled(), true); await ui(page, '#purge-confirmation').fill('永久清空回收站'); assert.equal(await ui(page, '#purge-submit').isDisabled(), false); await ui(page, '#purge-cancel').click(); assert(fs.existsSync(a.record)); assert(fs.existsSync(b.record));
  await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' }); assert.equal(await ui(page, '#purge-confirmation').inputValue(), ''); await page.keyboard.press('Escape'); assert(fs.existsSync(a.archivedTo)); pass('exact typed confirmation required; Cancel/Escape perform no deletion and next preview resets input');
  await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' }); write(path.join(a.archivedTo, 'new.txt'), 'new'); await ui(page, '#purge-confirmation').fill('永久清空回收站'); await ui(page, '#purge-submit').click(); await ui(page, '#purge-error').waitFor({ state: 'visible' }); assert.match(await ui(page, '#purge-error').textContent(), /回收站已改变/); assert.equal(await ui(page, '#purge-submit').isDisabled(), true); assert(fs.existsSync(a.record)); await ui(page, '#purge-cancel').click(); pass('changed archive invalidates preview and prevents repeat submission until re-preview');
  await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' }); await ui(page, '#purge-confirmation').fill('永久清空回收站'); await ui(page, '#purge-submit').click(); await page.waitForFunction(() => !document.querySelector('#purge-dialog').open && !document.querySelector('#trash-refresh').disabled); assert.match(await ui(page, '#toast').textContent(), /已删除 2 个归档/);
  assert(!fs.existsSync(a.record)); assert(!fs.existsSync(b.record)); assert.equal(fs.readFileSync(beta, 'utf8'), content('beta')); assert.equal(fs.readFileSync(keep, 'utf8'), content('keep')); assert.equal(fs.readFileSync(config, 'utf8'), '{"untouched":42}'); assert(fs.existsSync(malformed)); assert.equal(await ui(page, '.undelete-action').count(), 0); pass('real fixture deletion removes full backup and restored record only, preserves live files/config and unknown archive');
  await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' }); await ui(page, '#purge-confirmation').fill('永久清空回收站'); assert.equal(await ui(page, '#purge-submit').isDisabled(), true); await ui(page, '#purge-cancel').click(); pass('empty eligible trash cannot be submitted even when unknown entries remain');
  write(alpha, content('alpha')); const c = await remove('alpha'); await ui(page, '#trash-refresh').click(); await page.waitForFunction(() => document.querySelector('.undelete-action') && !document.querySelector('#trash-refresh').disabled); await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' });
  await page.route('**/api/deleted', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟刷新故障' }) }));
  await ui(page, '#purge-confirmation').fill('永久清空回收站'); await ui(page, '#purge-submit').click(); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('列表刷新失败') && !document.querySelector('#trash-refresh').disabled); assert.match(await ui(page, '#toast').textContent(), /永久清理已执行.*已删除 1 个归档.*不要重复提交/); assert(!fs.existsSync(c.record)); assert.equal(await ui(page, '.undelete-action').count(), 0); pass('completed permanent deletion remains final when subsequent trash GET fails and stale restore actions are removed');
  await page.unroute('**/api/deleted'); await ui(page, '#trash-refresh').click(); await page.waitForFunction(() => document.querySelector('#trash-items').textContent.includes('暂无') && !document.querySelector('#trash-refresh').disabled); await ui(page, '#trash-purge').click(); await ui(page, '#purge-dialog').waitFor({ state: 'visible' }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'verification/purge-narrow.png', fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); pass('manual refresh recovers after failure and permanent-confirmation dialog has no narrow-screen overflow');
  assert.deepEqual(report.errors, []); report.pass = true;
} catch (e) { report.pass = false; report.failure = e.stack; throw e; }
finally { fs.mkdirSync('verification', { recursive: true }); fs.writeFileSync('verification/purge-browser.json', JSON.stringify(report, null, 2)); await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); console.log(JSON.stringify(report, null, 2)); }
