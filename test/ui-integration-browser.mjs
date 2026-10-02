// Real integrated frontend; all mutations are project-local isolated fixtures.
// Direct visible UI actions only: no ui() navigation wrapper and no forced clicks.
import fs from 'node:fs';
import path from 'node:path';

import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { playwright, executablePath } from './helpers/browser.mjs';
import { SkillManager } from '../manager.mjs';
import { createServer } from '../server.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));

const root = fs.mkdtempSync(path.join(project, '.test-ui-integration-'));
const home = process.env.HOME; process.env.HOME = root;
const agentDir = path.join(root, 'agent'); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const text = (name, newline = '\n') => `---\nname: ${name}\ndescription: "集成测试真实说明 ${name}"\nextra-metadata: retained\n---\n\n# ${name}\n\n安全的原文 <script>window.injected=true</script>\n`.replaceAll('\n', newline);
const alphaFile = path.join(agentDir, 'skills/alpha/SKILL.md'); write(alphaFile, text('alpha', '\r\n'));
write(path.join(agentDir, 'skills/beta/SKILL.md'), text('beta'));
write(path.join(agentDir, 'skills/broken/SKILL.md'), '---\nname: broken\n---\ninvalid fixture\n');
const attachment = path.join(agentDir, 'skills/alpha/references/readme.html'); write(attachment, '<script>window.injected=true</script>\r\nonly text');
const manager = new SkillManager({ agentDir, cwd, project: true }); let s = await manager.list();
const alpha = s.skills.find(row => row.name === 'alpha'); const beta = s.skills.find(row => row.name === 'beta');
const groupName = '长分组'.repeat(18); await manager.organize(alpha.id, groupName, ['测试标签'], s.preferencesRevision); s = await manager.list();
await manager.note(alpha.id, '<img src=x onerror="window.injected=true">\n真实个人备注', s.preferencesRevision); await manager.favorite(alpha.id, true);
s = await manager.list(); const saved = await manager.saveView(null, '已存视图'.repeat(12), { query: 'alpha', status: 'all', body: false, group: '', tag: '', notes: 'all', sort: 'name' }, s.preferencesRevision);
const server = createServer(manager); const report = { at: new Date().toISOString(), scope: 'integrated production UI with isolated project-local fixture files only', checks: [], errors: [] };
const pass = name => report.checks.push({ name, pass: true }); let browser;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Later approved features may change the backend. This UI test must not mutate
// the backend present when this run starts; original milestone hashes stay archived.
const backendPaths = ['manager.mjs', 'server.mjs', 'pi-adapter.mjs', 'attachments.mjs', 'bundles.mjs', 'errors.mjs', 'loading-diagnostics.mjs', 'organization-store.mjs', 'purge.mjs', 'recycle.mjs', 'package.json', 'package-lock.json'];
const baseline = { unchanged: Object.fromEntries(backendPaths.map(file => [file, hash(path.join(project, file))])) };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const posts = [];
  page.on('pageerror', error => report.errors.push(error.message)); page.on('request', request => { if (request.method() !== 'GET') posts.push(request.url()); });
  const p = (selector, options) => page.locator(selector, options); const idle = () => page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  const row = name => p('.skill-row').filter({ has: p('.row-title', { hasText: new RegExp(`^${name}$`) }) });
  await page.goto(base); await page.waitForFunction(() => document.querySelector('#total').textContent === '3');
  assert.equal(await p('#detail').isVisible(), false); assert(await p('#empty').isVisible()); assert.equal(await p('.skill-row').count(), 3);
  pass('production workbench starts with actual discovered list and empty detail, no fictional records');
  await row('alpha').locator('.row-title').click(); await idle(); assert(await p('#ui-panel-overview').isVisible());
  assert.match(await p('#ui-purpose').textContent(), /集成测试真实说明 alpha/); assert.equal(await p('#file-path').textContent(), alphaFile);
  assert.match(await p('#note-summary').textContent(), /真实个人备注/); assert.equal(await p('#note-summary img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.screenshot({ path: 'verification/ui-integration-desktop.png', fullPage: true }); pass('overview derives actual description/path/note/state and safely displays untrusted text');
  await p('[data-ui-filter="favorites"]').click(); assert.equal(await p('.skill-row').count(), 1); await p('[data-ui-filter="issues"]').click(); assert.equal(await p('.skill-row').count(), 1);
  await p('[data-ui-filter="all"]').click(); await p('[data-ui-group]').click(); assert.equal(await p('#group-filter').inputValue(), `g:${groupName}`); assert.equal(await p('.skill-row').count(), 1);
  await p('[data-ui-view]').click(); assert.equal(await p('#saved-view').inputValue(), saved.viewId); assert.equal(await p('#search').inputValue(), 'alpha'); assert.equal(posts.length, 0);
  pass('sidebar favorites/issues/groups/saved-view are real read-only filters, including long labels');
  await p('#ui-filter-details summary').click(); await p('#notes-filter').selectOption('present'); await p('#tag-filter').selectOption('t:测试标签'); assert.equal(await p('#ui-filter-count').textContent(), '2');
  await page.keyboard.press('Escape'); assert.equal(await p('#ui-filter-details').getAttribute('open'), null);
  await p('#ui-filter-details summary').click(); await p('#ui-reset-filters').click(); assert.equal(await p('.skill-row').count(), 3); await page.keyboard.press('Escape');
  pass('advanced filters stack, display count, reset and close with Escape using visible controls');
  await p('#ui-tab-source').click(); const original = await p('#editor').inputValue(); const draft = original + '\n<!-- unsaved integration -->\n'; await p('#editor').fill(draft);
  await p('#ui-tab-overview').click(); const beforeShortcut = posts.length; await page.keyboard.press('Control+s'); assert.equal(posts.length, beforeShortcut); assert.equal(fs.readFileSync(alphaFile, 'utf8'), text('alpha', '\r\n'));
  page.once('dialog', dialog => dialog.dismiss()); await row('beta').locator('.row-title').click(); assert.equal(await p('#skill-name').textContent(), 'alpha'); assert.equal(await p('#editor').inputValue(), draft);
  pass('hidden source draft stays protected; overview Ctrl+S cannot save it; cancelled switching retains it');
  await p('#note-open').click(); await p('#note-content').fill('新版备注\n<img src=x onerror="window.injected=true">'); await page.keyboard.press('Control+s'); await page.waitForFunction(() => !document.querySelector('#note-dialog').open); await idle();
  assert.equal(await p('#editor').inputValue(), draft); assert.equal(fs.readFileSync(alphaFile, 'utf8'), text('alpha', '\r\n')); assert.equal(await page.evaluate(() => window.injected), undefined);
  pass('note-dialog Ctrl+S persists only notes and never saves hidden main source draft');
  await p('#ui-tab-attachments').click(); await idle(); await p('#attachments-tree summary').click(); await p('.attachment-file', { hasText: 'readme.html' }).click(); await idle();
  assert.match(await p('#attachment-content').textContent(), /<script>window.injected=true<\/script>/); assert.equal(await p('#attachment-content script').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined); assert.equal(hash(attachment), crypto.createHash('sha256').update('<script>window.injected=true</script>\r\nonly text').digest('hex'));
  await page.screenshot({ path: 'verification/ui-integration-attachments.png', fullPage: true }); pass('inline attachments reuse real bounded scope/version API and render HTML as text without execution');
  write(attachment, 'external fixture edit'); await p('.attachment-file').click(); await idle(); assert.match(await p('#attachment-info').textContent(), /已改变|改变/); assert.equal(await p('#attachment-content').textContent(), '');
  await p('#ui-attachments-refresh').click(); await idle(); await p('#attachments-tree summary').click(); await p('.attachment-file').click(); await idle(); assert.equal(await p('#attachment-content').textContent(), 'external fixture edit');
  pass('stale inline attachment revision fails closed and explicit refresh obtains a new listing');
  await p('#ui-tab-history').focus(); await page.keyboard.press('Home'); assert.equal(await p('#ui-tab-overview').getAttribute('aria-selected'), 'true'); await page.keyboard.press('ArrowRight'); assert.equal(await p('#ui-tab-source').getAttribute('aria-selected'), 'true');
  assert.equal(await p('#ui-tab-source').getAttribute('tabindex'), '0'); assert.equal(await p('#editor').inputValue(), draft);
  await p('#preview-tab').click(); assert.match(await p('#preview').textContent(), /<script>/); assert.equal(await page.evaluate(() => window.injected), undefined); await p('#edit-tab').click();
  await page.screenshot({ path: 'verification/ui-integration-editor.png', fullPage: true }); pass('real editor/preview retains hidden draft and safe rendering; tabs support Home/arrows/roving focus');
  await page.keyboard.press('Control+s'); await idle(); await page.waitForFunction(() => document.querySelector('#save').disabled); assert.equal(fs.readFileSync(alphaFile, 'utf8'), draft.replaceAll('\n', '\r\n')); assert.match(fs.readFileSync(alphaFile, 'utf8'), /extra-metadata: retained/);
  await p('#ui-tab-history').click(); assert.equal(await p('#backup-select option').count(), 1); await p('#backup-compare').click(); await p('#diff-dialog').waitFor(); assert.match(await p('#diff-content').textContent(), /unsaved integration/); await p('#diff-close').click();
  pass('active-source Ctrl+S saves with original CRLF/unknown YAML metadata and leaves a real read-only history diff');
  await p('#ui-tab-overview').click(); const checked = await p('#ui-detail-toggle').getAttribute('aria-checked'); await p('#ui-detail-toggle').click(); await idle(); assert.notEqual(await p('#ui-detail-toggle').getAttribute('aria-checked'), checked); assert.match(await p('#ui-loading-status').textContent(), /关闭/); await p('#ui-detail-toggle').click(); await idle();
  await p('#ui-detail-favorite').click(); await idle(); assert.equal(await p('#ui-detail-favorite').getAttribute('aria-pressed'), 'false'); await p('#ui-detail-favorite').click(); await idle();
  pass('detail status/favorite controls call existing native toggle/preferences APIs and refresh actual state');
  await p('#ui-more-menu summary').click(); await p('#duplicate-skill').click(); await p('#transfer-dialog').waitFor(); await p('#transfer-cancel').click();
  await p('#ui-more-menu summary').click(); await p('#delete-skill').click(); await p('#delete-dialog').waitFor(); assert.equal(await p('#delete-submit').isDisabled(), true); await p('#delete-cancel').click(); assert(fs.existsSync(alphaFile));
  pass('more menu exposes original duplication/deletion dialogs and preserves typed-name cancellation safeguards');
  await row('alpha').locator('.batch-check').check(); await row('beta').locator('.batch-check').check(); await p('#search').fill('alpha'); assert.match(await p('#selection-count').textContent(), /1 个在筛选外/); assert(await p('#ui-batch-bar').isVisible());
  await page.screenshot({ path: 'verification/ui-integration-batch.png', fullPage: true }); pass('conditional batch toolbar keeps explicit hidden-selection count and real checked rows');
  for (const width of [1920, 1280, 1060, 820, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  pass('production layout with long real group/view labels fits 1920/1280/1060/820/390/360 viewports');
  await page.setViewportSize({ width: 390, height: 844 }); assert(await p('#detail').isVisible()); assert.equal(await p('#ui-batch-bar').isVisible(), false); await p('#ui-back').click();
  assert(await p('#ui-library').isVisible()); assert(await p('#ui-batch-bar').isVisible()); assert.match(await p('#selection-count').textContent(), /已选 2/);
  await page.screenshot({ path: 'verification/ui-integration-mobile-list.png', fullPage: true }); await row('alpha').locator('.row-title').click(); assert(await p('#detail').isVisible()); assert.equal(await p('#editor').inputValue(), draft);
  await page.screenshot({ path: 'verification/ui-integration-mobile-detail.png', fullPage: true }); pass('mobile list/detail screens preserve selection/editor while preventing batch overlay from hiding detail actions');
  await p('#ui-nav-toggle').click(); assert(await p('#ui-sidebar').isVisible()); assert.equal(await p('#ui-library').getAttribute('inert'), ''); await p('#ui-nav-close').focus(); await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(() => document.activeElement.closest('#ui-sidebar') !== null)); await page.keyboard.press('Escape'); assert.equal(await p('#ui-sidebar').isVisible(), false); assert.equal(await p('#detail').getAttribute('inert'), null);
  await p('#ui-nav-toggle').click(); await p('#trash-open').click(); await p('#trash-dialog').waitFor(); assert.equal(await p('#ui-sidebar').isVisible(), false); await p('#trash-close').click();
  pass('mobile drawer traps boundary focus, inerts workspace, closes on Escape and opens actual recycle-bin modal');
  await p('#ui-tab-source').click(); const navigationDraft = draft + 'drawer navigation draft'; await p('#editor').fill(navigationDraft); const beforeNavigationPosts = posts.length;
  for (const action of ['[data-ui-filter="favorites"]', '[data-ui-filter="all"]', '[data-ui-group]', '[data-ui-view]', '#saved-view']) {
    await p('#ui-nav-toggle').click();
    if (action === '#saved-view') await p(action).selectOption(saved.viewId); else await p(action).click();
    assert(await p('#ui-library').isVisible(), `mobile navigation must return to list: ${action}`); assert.equal(await p('#detail').isVisible(), false); assert.equal(await p('#ui-sidebar').isVisible(), false);
    assert.equal(await p('#editor').inputValue(), navigationDraft); assert.equal(await p('#skill-name').textContent(), 'alpha'); assert.equal(await p('#ui-library').getAttribute('inert'), null); assert.match(await p('#selection-count').textContent(), /已选 2/);
    assert.equal(posts.length, beforeNavigationPosts); await row('alpha').locator('.row-title').click(); assert(await p('#detail').isVisible()); assert.equal(await p('#editor').inputValue(), navigationDraft);
  }
  pass('mobile drawer filters/groups/view buttons/view dropdown return to list without discarding source draft, selection or issuing writes');
  await p('#ui-tab-source').click(); await p('#editor').fill(draft + 'mobile draft'); await p('#ui-back').click(); await p('#search').fill('');
  page.once('dialog', dialog => dialog.dismiss()); await row('beta').locator('.row-title').click(); assert(await p('#ui-library').isVisible());
  page.once('dialog', dialog => dialog.accept()); await row('beta').locator('.row-title').click(); await idle(); assert.equal(await p('#skill-name').textContent(), 'beta'); assert(await p('#ui-panel-overview').isVisible()); assert.equal(await p('#save').isDisabled(), true);
  await p('#ui-tab-attachments').click(); await idle(); assert.equal(await p('.attachment-file').count(), 0); assert.equal(await p('#attachment-content').textContent(), '');
  pass('mobile unsaved-source switch cancellation/discard work normally and old attachment state never leaks into new Skill');
  await p('#ui-tab-overview').click(); await p('#ui-back').click(); await p('#ui-batch-close').click(); await p('#search').fill('');
  await p('#ui-nav-toggle').click(); await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForFunction(() => document.querySelector('#ui-nav-toggle').getAttribute('aria-expanded') === 'false'); assert.equal(await p('#ui-nav-toggle').getAttribute('aria-expanded'), 'false'); assert.equal(await p('#ui-library').getAttribute('inert'), null);
  await p('#refresh').focus(); await page.keyboard.press('/'); assert.equal(await p('#search').evaluate(node => node === document.activeElement), true); await p('#search').fill('beta/'); assert.equal(await p('#search').inputValue(), 'beta/');
  pass('resize closes drawer/inert state; slash shortcut focuses search but typing slash in inputs is not intercepted');
  for (const [file, digest] of Object.entries(baseline.unchanged)) assert.equal(hash(path.join(project, file)), digest, `backend changed: ${file}`);
  assert.deepEqual(report.errors, []); pass('backend/dependency hashes unchanged and no browser JS errors; mutations stayed within fixture root'); report.pass = true;
} catch (error) { report.pass = false; report.failure = error.stack; throw error; }
finally {
  fs.writeFileSync(path.join(project, 'verification/ui-integration-browser.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true });
}
