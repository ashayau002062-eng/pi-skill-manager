// Legacy regression actions now take the same visible navigation steps as a user.
// No forced clicks, DOM patching, API interception, or mutation of application state.
const menuIds = ['duplicate-skill', 'open-folder', 'export-skill', 'delete-skill'];
const overviewIds = ['note-open', 'organize-skill', 'loading-open', 'attachments-open', 'copy-path'];
const sourceIds = ['editor', 'save', 'discard', 'edit-tab', 'preview-tab', 'compare-draft'];
const historyIds = ['restore', 'backup-compare', 'backup-select'];
const filterIds = ['group-filter', 'tag-filter', 'notes-filter', 'search-body'];
const sidebarIds = ['trash-open', 'organization-backup-open', 'view-new', 'view-edit', 'view-delete', 'saved-view', 'group-rename-open'];
export function ui(page, selector, options) {
  function wrap(locator) {
    return new Proxy(locator, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (['locator', 'filter', 'first', 'last', 'nth'].includes(key)) return (...args) => wrap(value.apply(target, args));
        if (['click', 'fill', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'waitFor'].includes(key)) return async (...args) => {
          if (key !== 'waitFor' || !args[0]?.state || args[0].state === 'visible') await expose(page, selector);
          return value.apply(target, args);
        };
        return value.bind(target);
      },
    });
  }
  return wrap(page.locator(selector, options));
}
async function expose(page, selector) {
  if (await page.locator('dialog[open]').count()) return;
  const has = ids => ids.some(id => selector.includes(`#${id}`));
  if (!has(filterIds) && !selector.includes('#ui-filter') && await page.locator('#ui-filter-details').getAttribute('open') !== null) await page.locator('#ui-filter-details summary').click();
  if (selector.includes('.skill-row') || selector.includes('.row-title') || selector.includes('.batch-check') || has(['search', 'select-visible', 'clear-selection', 'batch-enable', 'batch-disable', 'batch-organize', 'batch-export']) || selector.includes('[data-filter=')) {
    if (!(await page.locator('#ui-library').isVisible()) && await page.locator('#ui-back').isVisible()) await page.locator('#ui-back').click();
  }
  if (has(sidebarIds) && !(await page.locator('#ui-sidebar').isVisible())) await page.locator('#ui-nav-toggle').click();
  if (has(filterIds) && await page.locator('#ui-filter-details').getAttribute('open') === null) await page.locator('#ui-filter-details summary').click();
  if (has(overviewIds) && !(await page.locator('#ui-panel-overview').isVisible())) await page.locator('#ui-tab-overview').click();
  if (has(sourceIds)) {
    if (!(await page.locator('#ui-panel-source').isVisible())) await page.locator('#ui-tab-source').click();
    if (selector.includes('#editor') && !(await page.locator('#editor').isVisible())) await page.locator('#edit-tab').click();
  }
  if (selector.includes('.backups') || has(historyIds)) {
    if (!(await page.locator('#ui-panel-history').isVisible())) await page.locator('#ui-tab-history').click();
    if (has(historyIds) && await page.locator('.backups').getAttribute('open') === null) await page.locator('.backups summary').click();
  }
  if (has(menuIds) && await page.locator('#ui-more-menu').getAttribute('open') === null) await page.locator('#ui-more-menu summary').click();
}
