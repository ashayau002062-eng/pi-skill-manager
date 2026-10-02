import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
export const MAX_ORGANIZATION_BYTES = 1024 * 1024;
export const MAX_VIEWS = 30;
export const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export const validViewId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const label = (v, max) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const note = v => typeof v === 'string' && v.length <= 10000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
export function validateFilters(value) {
  if (!object(value) || !label(value.query, 200) || typeof value.body !== 'boolean' || !['all', 'enabled', 'disabled', 'issues', 'favorites'].includes(value.status) || !label(value.group, 62) || (value.group && value.group !== '-' && !value.group.startsWith('g:')) || !label(value.tag, 34) || (value.tag && !value.tag.startsWith('t:')) || !['favorite', 'name', 'modified', 'added'].includes(value.sort) || !['all', 'present', 'none'].includes(value.notes)) throw new AppError('常用视图筛选条件无效。');
  return { query: value.query, body: value.body, status: value.status, group: value.group, tag: value.tag, sort: value.sort, notes: value.notes };
}
export function validateViews(views) {
  if (!Array.isArray(views) || views.length > MAX_VIEWS) throw new AppError('常用视图最多 30 个。');
  const ids = new Set(); const names = new Set();
  for (const view of views) {
    if (!object(view) || !validViewId(view.id) || !label(view.name, 60) || !view.name.trim() || view.name !== view.name.trim() || ids.has(view.id) || names.has(view.name)) throw new AppError('常用视图 ID／名称无效或重复。');
    validateFilters(view.filters); ids.add(view.id); names.add(view.name);
  }
  return views;
}
function validateItem(item) {
  if (!object(item) || !validId(item.id) || typeof item.favorite !== 'boolean' || !label(item.group, 60) || !Array.isArray(item.tags) || item.tags.length > 20 || item.tags.some(t => !label(t, 32) || !t.trim()) || !note(item.note) || (item.name !== null && !label(item.name, 256)) || (item.path !== null && !label(item.path, 4096)) || ![null, 'global', 'project'].includes(item.scope)) throw new AppError('整理备份条目无效（ID／名称／路径／收藏／分组／标签／备注）。');
  return { id: item.id, name: item.name, path: item.path, scope: item.scope, favorite: item.favorite, group: item.group, tags: [...new Set(item.tags)], note: item.note };
}
export function validateOrganizationBackup(input) {
  if (!object(input) || input.format !== 'pi-skill-manager-organization' || input.version !== 1 || !Array.isArray(input.items) || input.items.length > 1000 || !Array.isArray(input.views)) throw new AppError('不是支持的整理信息备份（version 1，最多 1000 项）。');
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_ORGANIZATION_BYTES) throw new AppError('整理信息备份不能超过 1 MiB。');
  const items = input.items.map(validateItem); const ids = new Set(items.map(i => i.id));
  if (ids.size !== items.length) throw new AppError('整理信息备份含重复 Skill ID，整批拒绝。');
  const views = validateViews(input.views).map(v => ({ id: v.id, name: v.name, filters: validateFilters(v.filters) }));
  return { format: input.format, version: 1, items, views };
}
export function exportOrganization(preferences, rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const ids = new Set([...preferences.favorites, ...Object.keys(preferences.organization), ...Object.keys(preferences.notes)]);
  const document = { format: 'pi-skill-manager-organization', version: 1, exportedAt: new Date().toISOString(), items: [...ids].sort().map(id => {
    const row = byId.get(id);
    return { id, name: row?.name ?? null, path: row?.path ?? null, scope: row?.scope ?? null, favorite: preferences.favorites.includes(id), group: preferences.organization[id]?.group || '', tags: preferences.organization[id]?.tags || [], note: preferences.notes[id] || '' };
  }), views: (preferences.views || []).map(v => ({ id: v.id, name: v.name, filters: validateFilters(v.filters) })) };
  validateOrganizationBackup(document);
  if (Buffer.byteLength(JSON.stringify(document, null, 2)) > MAX_ORGANIZATION_BYTES) throw new AppError('整理信息备份不能超过 1 MiB，请减少备注或记录。');
  return document;
}
export function planOrganizationImport(input, mode, preferences, rows, preferencesRevision) {
  const document = validateOrganizationBackup(input);
  if (!['merge', 'replace'].includes(mode)) throw new AppError('请选择合并或覆盖匹配项。');
  const byId = new Map(rows.map(r => [r.id, r])); const favorites = new Set(preferences.favorites);
  const organization = { ...preferences.organization }; const notes = { ...preferences.notes }; const items = [];
  for (const item of document.items) {
    const row = byId.get(item.id);
    if (!row) { items.push({ id: item.id, name: item.name, path: item.path, matched: false, changed: false, reason: '当前范围未发现相同位置 ID；不按名称自动匹配，不写入。' }); continue; }
    const old = { favorite: favorites.has(item.id), group: organization[item.id]?.group || '', tags: organization[item.id]?.tags || [], note: notes[item.id] || '' };
    const next = mode === 'replace' ? { favorite: item.favorite, group: item.group, tags: item.tags, note: item.note } : { favorite: old.favorite || item.favorite, group: old.group || item.group, tags: [...new Set([...old.tags, ...item.tags])], note: old.note || item.note };
    if (next.tags.length > 20) throw new AppError(`${row.name} 合并后超过 20 个标签；整批未保存。`);
    const changed = JSON.stringify(old) !== JSON.stringify(next);
    if (changed) {
      if (next.favorite) favorites.add(item.id); else favorites.delete(item.id);
      organization[item.id] = { ...organization[item.id], group: next.group, tags: next.tags };
      if (next.note) notes[item.id] = next.note; else delete notes[item.id];
    }
    items.push({ id: item.id, name: row.name, path: row.path, backupName: item.name, matched: true, changed, before: old, after: next });
  }
  const views = [...(preferences.views || [])]; const viewResults = [];
  for (const view of document.views) {
    const index = views.findIndex(v => v.id === view.id); const nameConflict = views.some(v => v.name === view.name && v.id !== view.id);
    if (nameConflict || (index >= 0 && mode === 'merge')) { viewResults.push({ id: view.id, name: view.name, changed: false, reason: nameConflict ? '同名不同 ID，保留现有视图，不覆盖。' : '合并模式保留现有视图。' }); continue; }
    const next = { ...(index >= 0 ? views[index] : {}), ...view, filters: { ...(index >= 0 ? views[index].filters : {}), ...view.filters } };
    const changed = index < 0 || views[index].name !== next.name || JSON.stringify(validateFilters(views[index].filters)) !== JSON.stringify(view.filters);
    if (index >= 0) views[index] = next; else views.push(next);
    viewResults.push({ id: view.id, name: view.name, changed, before: index < 0 ? null : { name: preferences.views[index].name, filters: validateFilters(preferences.views[index].filters) }, after: { name: view.name, filters: view.filters }, reason: index < 0 ? '新增视图。' : '覆盖同 ID 视图。' });
  }
  validateViews(views);
  const { raw: _raw, ...stored } = preferences;
  const next = { ...stored, favorites: [...favorites], organization, notes, views };
  if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > 2 * 1024 * 1024) throw new AppError('合并后的管理器偏好超过 2 MiB，整批未保存。');
  const token = createHash('sha256').update(JSON.stringify({ document, mode, preferencesRevision, items, viewResults })).digest('hex');
  return { next, public: { token, preferencesRevision, mode, items, views: viewResults, changed: items.filter(i => i.changed).length + viewResults.filter(v => v.changed).length, skipped: items.filter(i => !i.matched).length, warning: '只保存预览中匹配的整理信息与视图，不创建 Skill，不修改正文、添加时间或 Pi 配置。未知条目保留在备份，本次跳过；备份含路径与私人备注，请妥善保存。' } };
}
