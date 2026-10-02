const $ = (id) => document.getElementById(id);
let snapshot;
let selected;
let detail;
let filter = 'all';
let busy = false;
let toastTimer;
const batchSelection = new Set();
let transferMode = 'import';
let duplicateSource;
let duplicateDefaultName = '';
let searchTimer;
let searchController;
let searchGeneration = 0;
let searchHits = new Map();
let organizationSource;
let organizationRevision;
let organizationInitial = '';
let purgePlan;
let attachmentSource;
let noteSource;
let noteRevision;
let noteInitial = '';
let batchOrganizationIds = [];
let batchOrganizationRevision;
let batchOrganizationInitial = '';
let organizationBackupDocument;
let organizationBackupPlan;
let viewSource = null;
let viewInitial = '';
let viewRevision;
let viewFilters;
let uiPanel = 'overview';
let uiShownId;
let uiAttachmentStamp;
let uiNavOpen = false;
let groupRenameRevision;
let groupRenameInitial = '';
let groupRenameNeedsRefresh = false;
const groupRenameText = () => JSON.stringify([$ ('group-rename-from').value, $('group-rename-name').value]);
const groupRenameGroups = () => snapshot?.organizationGroups ?? [...new Set((snapshot?.skills || []).map(row => row.group).filter(name => typeof name === 'string' && name.trim()))].sort();
const batchOrganizationText = () => JSON.stringify(['batch-group-mode', 'batch-group', 'batch-tag-mode', 'batch-tags'].map(id => $(id).value));
const organizationText = () => JSON.stringify([$ ('organize-group').value, $('organize-tags').value]);
const normalizeEditorText = (text) => text.replace(/\r\n?/g, '\n');
const dirty = () => Boolean(detail && $('editor').value !== normalizeEditorText(detail.content));
function savedEditorText() {
  // Textareas normalize CRLF to LF; retain the original file's newline style on save.
  const newline = detail.content.match(/\r\n|\n|\r/)?.[0] || '\n';
  return $('editor').value.replaceAll('\n', newline);
}
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function notify(text, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').className = error ? 'error' : '';
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 15000 : 6000);
}
async function api(url, data, binary = false) {
  const response = await fetch(url, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': binary ? 'application/zip' : 'application/json', 'X-Skill-Manager': '1' }, body: binary ? data : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败。');
  return value;
}
function updateControls() {
  $('save').disabled = busy || !dirty();
  $('discard').disabled = busy || !dirty();
  $('restore').disabled = busy || !detail?.backups.length;
  $('refresh').disabled = busy;
  $('new-skill').disabled = busy || !snapshot;
  $('create-submit').disabled = busy || !$('create-content').value.trim();
  $('create-submit').textContent = busy && $('create-dialog').open ? '创建中…' : '创建 Skill';
  $('create-cancel').disabled = busy;
  $('create-template').disabled = busy;
  $('create-scope').disabled = busy;
  $('create-content').readOnly = busy;
  $('editor').readOnly = busy;
  $('dirty').textContent = dirty() ? '有未保存修改' : '未修改';
  $('dirty').className = dirty() ? 'dirty unsaved' : 'dirty';
  document.querySelectorAll('.switch, .favorite-button, .batch-check').forEach((node) => { node.disabled = busy; });
  $('import-skill').disabled = busy || !snapshot;
  for (const id of ['open-folder', 'export-skill', 'attachments-open', 'loading-open']) $(id).disabled = busy || !selected;
  $('delete-skill').disabled = busy || !selected || !detail?.deletion?.allowed;
  $('delete-submit').disabled = busy || $('delete-confirmation').value !== $('delete-name').textContent || !$('delete-name').textContent;
  $('delete-cancel').disabled = busy;
  $('delete-confirmation').disabled = busy;
  $('duplicate-skill').disabled = busy || !selected || !snapshot?.skills.find((row) => row.id === selected)?.valid;
  for (const id of ['transfer-cancel', 'transfer-name', 'transfer-scope', 'import-file']) $(id).disabled = busy;
  $('transfer-submit').disabled = busy || (transferMode === 'import' ? !$('import-file').files.length : !$('transfer-name').value.trim());
  $('transfer-submit').textContent = busy && $('transfer-dialog').open ? '处理中…' : transferMode === 'import' ? '导入 ZIP' : '复制 Skill';
  for (const id of ['trash-open', 'trash-refresh', 'trash-close', 'trash-purge', 'purge-cancel', 'diff-close', 'organize-cancel', 'organize-submit', 'attachments-refresh', 'attachments-close', 'note-cancel', 'note-submit', 'batch-organize-cancel']) $(id).disabled = busy || !snapshot;
  $('purge-confirmation').disabled = busy;
  $('purge-submit').disabled = busy || !purgePlan?.items.length || $('purge-confirmation').value !== purgePlan.confirmation;
  $('organize-skill').disabled = busy || !selected || Boolean(snapshot?.preferencesError);
  $('note-open').disabled = busy || !selected || Boolean(snapshot?.preferencesError);
  $('note-submit').disabled = busy || $('note-content').value === noteInitial;
  $('note-content').readOnly = busy;
  $('batch-group-mode').disabled = busy;
  $('batch-tag-mode').disabled = busy;
  $('batch-group').disabled = busy || $('batch-group-mode').value === 'keep';
  $('batch-tags').disabled = busy || $('batch-tag-mode').value === 'keep';
  $('batch-organize-submit').disabled = busy || ($('batch-group-mode').value === 'keep' && $('batch-tag-mode').value === 'keep');
  $('compare-draft').disabled = busy || !selected;
  $('backup-compare').disabled = busy || !detail?.backups.length;
  $('organize-group').disabled = busy;
  $('organize-tags').disabled = busy;
  document.querySelectorAll('.undelete-action, .purge-one-action, .purge-preview-one-action').forEach((node) => { node.disabled = busy || node.dataset.allowed !== 'true'; });
  for (const id of ['loading-close', 'organization-backup-cancel', 'organization-backup-export', 'organization-backup-file', 'organization-backup-mode', 'view-cancel', 'saved-view', 'notes-filter']) $(id).disabled = busy || !snapshot;
  $('organization-backup-open').disabled = busy || !snapshot || Boolean(snapshot.preferencesError);
  $('organization-backup-preview').disabled = busy || !$('organization-backup-file').files.length;
  $('organization-backup-submit').disabled = busy || !organizationBackupPlan?.changed;
  $('view-new').disabled = busy || !snapshot || Boolean(snapshot.preferencesError) || (snapshot.views || []).length >= 30;
  for (const id of ['view-edit', 'view-delete']) $(id).disabled = busy || !$('saved-view').value || Boolean(snapshot?.preferencesError);
  $('view-name').readOnly = busy;
  $('view-submit').disabled = busy || !$('view-name').value.trim();
  $('group-rename-open').disabled = busy || !snapshot || Boolean(snapshot.preferencesError) || groupRenameNeedsRefresh || !groupRenameGroups().length;
  $('group-rename-submit').disabled = busy || groupRenameNeedsRefresh || !$('group-rename-from').value || !$('group-rename-name').value.trim() || $('group-rename-name').value.trim() === $('group-rename-from').value;
  $('group-rename-cancel').disabled = busy; $('group-rename-from').disabled = busy; $('group-rename-name').readOnly = busy;
  for (const id of ['ui-detail-favorite', 'ui-detail-toggle', 'ui-attachments-refresh']) $(id).disabled = busy || !selected;
  document.querySelectorAll('[data-ui-panel], [data-ui-group], [data-ui-view], [data-ui-filter]').forEach(node => { node.disabled = busy || !snapshot; });
  $('ui-nav-toggle').disabled = busy;
  $('ui-back').disabled = busy;
  updateBatchControls();
}
async function operation(work) {
  if (busy) return;
  busy = true;
  updateControls();
  try { await work(); }
  catch (error) { notify(error.message, true); }
  finally { busy = false; updateControls(); }
}
function visibleRows() {
  if (!snapshot) return [];
  const query = $('search').value.toLowerCase().trim();
  return snapshot.skills.filter((row) => {
    const matches = `${row.name} ${row.description} ${row.path} ${row.source} ${row.group || ''} ${(row.tags || []).join(' ')} ${row.note || ''}`.toLowerCase().includes(query) || ($('search-body').checked && searchHits.has(row.id));
    const group = $('group-filter').value;
    const tag = $('tag-filter').value;
    const organizationMatches = (!group || (group === '-' ? !row.group : group === `g:${row.group}`)) && (!tag || (row.tags || []).some((value) => tag === `t:${value}`));
    const status = filter === 'all' || (filter === 'enabled' && row.enabled) || (filter === 'disabled' && !row.enabled) ||
      (filter === 'issues' && (!row.valid || (row.enabled && !row.effective))) || (filter === 'favorites' && row.favorite);
    const noteCondition = $('notes-filter').value;
    const noteMatches = noteCondition === 'all' || (noteCondition === 'present' ? Boolean(row.note) : !row.note);
    return matches && status && organizationMatches && noteMatches;
  }).sort((a, b) => {
    const order = $('sort-order').value;
    if (order === 'modified' || order === 'added') return (b[order === 'modified' ? 'modifiedAt' : 'addedAt'] || 0) - (a[order === 'modified' ? 'modifiedAt' : 'addedAt'] || 0) || a.name.localeCompare(b.name);
    if (order === 'name') return a.name.localeCompare(b.name);
    return Number(b.favorite) - Number(a.favorite);
  });
}
function updateBatchControls() {
  const visible = new Set(visibleRows().map((row) => row.id));
  const hidden = [...batchSelection].filter((id) => !visible.has(id)).length;
  $('selection-count').textContent = `已选 ${batchSelection.size}${hidden ? `（${hidden} 个在筛选外）` : ''}`;
  $('select-visible').disabled = busy || !visible.size;
  $('clear-selection').disabled = busy || !batchSelection.size;
  $('batch-enable').disabled = busy || !batchSelection.size;
  $('batch-disable').disabled = busy || !batchSelection.size;
  $('batch-export').disabled = busy || !batchSelection.size;
  $('batch-organize').disabled = busy || !batchSelection.size || batchSelection.size > 100 || Boolean(snapshot?.preferencesError);
  $('ui-batch-bar').hidden = !batchSelection.size;
  $('ui-batch-close').disabled = busy;
}
function renderList() {
  if (!snapshot) return;
  const rows = visibleRows();
  $('total').textContent = snapshot.skills.length;
  const enabled = snapshot.skills.filter((s) => s.enabled).length;
  $('summary').textContent = `${enabled} 个开启 · ${snapshot.skills.length - enabled} 个关闭 · 当前显示 ${rows.length} 个`;
  $('list').replaceChildren();
  if (!rows.length) $('list').append(element('p', '没有符合条件的 Skill。', 'no-results'));
  for (const row of rows) {
    const node = element('div', undefined, `skill-row${selected === row.id ? ' selected' : ''}`);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `查看 ${row.name}`);
    const check = element('input', undefined, 'batch-check');
    check.type = 'checkbox';
    check.checked = batchSelection.has(row.id);
    check.disabled = busy;
    check.setAttribute('aria-label', `选择 ${row.name}`);
    check.addEventListener('click', (event) => event.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) batchSelection.add(row.id); else batchSelection.delete(row.id);
      updateBatchControls();
    });
    const info = element('div');
    info.append(element('div', row.name, 'row-title'), element('div', row.description || '缺少有效描述，可以打开修复。', 'row-desc'));
    const meta = element('div', undefined, 'row-meta');
    meta.append(element('span', row.package ? '扩展包' : '本地文件'), element('span', row.scope === 'global' ? '全局' : '项目'));
    if (!row.valid) meta.append(element('span', '格式待修复', 'issue'));
    else if (row.enabled && !row.effective) meta.append(element('span', '同名被遮蔽', 'issue'));
    else if (row.manualOnly && row.enabled) meta.append(element('span', '仅手动调用'));
    if (row.group) meta.append(element('span', row.group, 'label-chip'));
    for (const tag of row.tags || []) meta.append(element('span', `#${tag}`, 'label-chip'));
    if (row.note) meta.append(element('span', '有备注', 'label-chip'));
    info.append(meta);
    if ($('search-body').checked && searchHits.has(row.id)) info.append(element('div', searchHits.get(row.id), 'body-excerpt'));
    const sort = $('sort-order').value;
    if (sort === 'modified' || sort === 'added') info.append(element('div', `${sort === 'modified' ? '修改' : '添加'} ${new Date(row[sort === 'modified' ? 'modifiedAt' : 'addedAt']).toLocaleString()}`, 'row-time'));
    const toggle = element('button', undefined, 'switch');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(row.enabled));
    toggle.setAttribute('aria-label', `${row.enabled ? '关闭' : '开启'} ${row.name}`);
    toggle.title = row.enabled ? '关闭（不删除文件）' : '开启';
    toggle.disabled = busy;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSkill(row);
    });
    const favorite = element('button', row.favorite ? '★' : '☆', 'favorite-button');
    favorite.setAttribute('aria-label', `${row.favorite ? '取消收藏' : '收藏'} ${row.name}`);
    favorite.setAttribute('aria-pressed', String(row.favorite));
    favorite.disabled = busy;
    favorite.addEventListener('click', (event) => {
      event.stopPropagation();
      favoriteSkill(row);
    });
    const tools = element('div', undefined, 'row-tools');
    tools.append(favorite, toggle);
    node.append(check, info, tools);
    const open = () => {
      if (busy) return;
      if (selected === row.id) { $('app').dataset.scene = 'detail'; return; }
      if (dirty() && !confirm('当前修改尚未保存，丢弃后打开另一个 Skill？')) return;
      operation(async () => {
        const next = await api(`/api/skills/${row.id}`);
        selected = row.id;
        showDetail(next);
        renderList();
      });
    };
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => {
      if (event.target === node && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
    });
    $('list').append(node);
  }
  updateBatchControls();
  renderWorkbench();
}
function applySnapshot(next) {
  snapshot = next; groupRenameNeedsRefresh = false;
  const ids = new Set(next.skills.map((row) => row.id));
  for (const id of batchSelection) if (!ids.has(id)) batchSelection.delete(id);
  $('context').textContent = next.project ? `本地 · 项目视图 · Pi ${next.piVersion}` : `本地 · 个人全局 · Pi ${next.piVersion}`;
  $('context').title = next.project ? next.cwd : next.agentDir;
  $('warning-count').textContent = next.diagnostics.length + next.missing.length;
  $('diagnostics').hidden = !next.diagnostics.length && !next.missing.length;
  $('warnings').replaceChildren();
  for (const warning of next.diagnostics) $('warnings').append(element('p', `${warning.message}\n${warning.path || ''}`));
  for (const missing of next.missing) $('warnings').append(element('p', `未安装或版本不匹配，已跳过（不会自动安装）：${missing}`));
  $('create-project-option').hidden = !next.project;
  $('create-project-option').disabled = !next.project;
  $('transfer-project-option').hidden = !next.project;
  $('transfer-project-option').disabled = !next.project;
  renderTransferLocation();
  renderCreateLocation();
  renderOrganizationFilters();
  renderSavedViews();
  renderList();
  queueSearch();
  if (selected) renderHeading();
}
function renderHeading() {
  const row = snapshot.skills.find((s) => s.id === selected);
  if (!row) {
    selected = null;
    detail = null;
    $('detail').hidden = true;
    $('empty').hidden = false;
    $('app').dataset.scene = 'list';
    uiShownId = undefined; uiAttachmentStamp = undefined;
    return;
  }
  $('skill-name').textContent = row.name;
  $('description').textContent = row.description;
  $('source').textContent = `${row.scope === 'global' ? '个人全局' : '当前项目'} / ${row.package ? row.source : '本地 Skill'}`;
  $('file-path').textContent = row.path;
  $('state').textContent = row.enabled ? '已开启' : '已关闭';
  $('state').className = row.enabled ? 'badge' : 'badge off';
  $('package-warning').hidden = !row.package;
  $('organization-summary').textContent = [row.group || '未分组', ...(row.tags || []).map((tag) => `#${tag}`)].join(' · ');
  $('organize-skill').title = snapshot.preferencesError || '只影响网页整理，不改变 Pi 加载';
  $('note-summary').textContent = row.note || '';
  $('note-summary').hidden = !row.note;
  $('delete-reason').hidden = Boolean(detail?.deletion?.allowed);
  $('delete-reason').textContent = detail?.deletion?.reason || '';
  const message = !row.valid ? 'Pi 暂时无法加载此文件。修复 YAML 或 description 后即可保存。' :
    row.enabled && !row.effective ? '此 Skill 与另一个已启用 Skill 同名，Pi 当前使用的是另一个文件。' :
      row.manualOnly ? '这是仅手动调用的 Skill。不会进入自动选择列表，但可以用 /skill:名称 调用。' : '';
  $('skill-warning').hidden = !message;
  $('skill-warning').textContent = message;
  $('ui-purpose').textContent = row.description || '缺少有效描述，请检查原文中的 YAML 和 description。';
  $('ui-note-empty').hidden = Boolean(row.note);
  $('ui-file-time').textContent = `最近修改 ${new Date(row.modifiedAt).toLocaleString()} · 添加时间 ${new Date(row.addedAt).toLocaleString()}（既有文件可能为近似时间）`;
  $('ui-loading-status').textContent = !row.valid ? '格式尚未通过原生加载器检查，请查看具体诊断。' : !row.enabled ? '配置解析为关闭，未进入当前有效 Skill 集合。' : !row.effective ? '已开启，但当前同名有效文件是另一个 Skill。' : row.manualOnly ? '已进入有效集合，仅支持手动调用。' : '已进入当前管理范围的原生有效 Skill 集合。';
  $('ui-detail-favorite').textContent = row.favorite ? '★' : '☆';
  $('ui-detail-favorite').setAttribute('aria-pressed', String(row.favorite));
  $('ui-detail-favorite').setAttribute('aria-label', `${row.favorite ? '取消收藏' : '收藏'} ${row.name}`);
  $('ui-detail-toggle').setAttribute('aria-checked', String(row.enabled));
  $('ui-detail-toggle').setAttribute('aria-label', `${row.enabled ? '关闭' : '开启'} ${row.name}`);
}
function showDetail(next) {
  const previousRevision = detail?.revision;
  detail = next;
  $('empty').hidden = true;
  $('detail').hidden = false;
  $('editor').value = next.content;
  $('backup-count').textContent = `(${next.backups.length})`;
  $('backup-select').replaceChildren();
  if (!next.backups.length) $('backup-select').append(element('option', '暂无备份'));
  for (const name of next.backups) {
    const option = element('option', name.split('_')[0].replace('T', ' '));
    option.value = name;
    $('backup-select').append(option);
  }
  $('backup-path').textContent = next.backupDir;
  renderHeading();
  renderPreview();
  if (uiShownId !== selected) {
    uiShownId = selected; uiAttachmentStamp = undefined;
    moveAttachments(false); $('attachments-tree').replaceChildren(); $('attachment-content').textContent = '';
    setWorkbenchPanel('overview');
  } else if (previousRevision !== next.revision) {
    uiAttachmentStamp = undefined; $('attachments-tree').replaceChildren(); $('attachment-content').textContent = '';
    $('ui-attachments-status').textContent = '原文件已刷新，请重新读取附件清单。';
  }
  $('app').dataset.scene = 'detail';
  updateControls();
}
// A deliberately small, safe preview: all Skill content is rendered as text nodes, never HTML.
function renderPreview() {
  const root = $('preview');
  root.replaceChildren();
  let code = null;
  let list = null;
  for (const line of $('editor').value.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      list = null;
      if (code) code = null;
      else { code = element('pre', ''); root.append(code); }
      continue;
    }
    if (code) { code.textContent += `${line}\n`; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!list) { list = element('ul'); root.append(list); }
      list.append(element('li', bullet[1]));
    } else {
      list = null;
      root.append(heading ? element(`h${heading[1].length}`, heading[2]) : element('p', line || '\u00a0'));
    }
  }
}
function renderCreateLocation() {
  const root = snapshot?.creationRoots?.[$('create-scope').value];
  $('create-location').textContent = root ? `${root}/<name>/SKILL.md` : '请先刷新页面，或重启更新后的服务。';
}
function closeCreate() {
  if (busy) return;
  if ($('create-content').value.trim() && !confirm('放弃尚未创建的 Skill 内容？')) return;
  $('create-dialog').close();
  $('create-content').value = '';
  $('create-error').hidden = true;
  updateControls();
}
$('new-skill').addEventListener('click', () => {
  if (dirty()) {
    if (!confirm('当前修改尚未保存，放弃后新建 Skill？')) return;
    $('editor').value = detail.content;
    renderPreview();
  }
  renderCreateLocation();
  $('create-dialog').showModal();
  $('create-content').focus();
  updateControls();
});
$('create-cancel').addEventListener('click', closeCreate);
$('create-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeCreate(); });
$('create-scope').addEventListener('change', renderCreateLocation);
$('create-content').addEventListener('input', () => { $('create-error').hidden = true; updateControls(); });
$('create-template').addEventListener('click', () => {
  if ($('create-content').value.trim() && !confirm('用基础模板替换当前粘贴的内容？')) return;
  $('create-content').value = '---\nname: my-skill\ndescription: "说明这个 Skill 做什么，以及什么时候使用"\n---\n\n# 我的 Skill\n\n在这里粘贴或编写指令正文。\n';
  $('create-error').hidden = true;
  updateControls();
  $('create-content').focus();
});
$('create-submit').addEventListener('click', () => operation(async () => {
  $('create-error').hidden = true;
  let result;
  try { result = await api('/api/skills', { content: $('create-content').value, scope: $('create-scope').value }); }
  catch (error) { $('create-error').textContent = error.message; $('create-error').hidden = false; throw error; }
  $('create-dialog').close();
  $('create-content').value = '';
  showCreated(result, '创建');
}));
function showCreated(result, verb) {
  $('search').value = '';
  $('group-filter').value = '';
  $('tag-filter').value = '';
  filter = 'all';
  document.querySelectorAll('.filter').forEach((n) => n.classList.toggle('active', n.dataset.filter === 'all'));
  if (result.snapshot) applySnapshot(result.snapshot);
  if (result.item && result.detail) {
    selected = result.item.id;
    showDetail(result.detail);
    renderList();
    tab(false);
  }
  $('changed').hidden = false;
  notify(result.warning ? `${result.warning} 文件：${result.path}` : `Skill 已${verb}。在 Pi 输入 /reload 生效。`, Boolean(result.warning));
}
function renderTransferLocation() {
  const root = snapshot?.creationRoots?.[$('transfer-scope').value];
  $('transfer-location').textContent = root ? `${root}/<name>/SKILL.md` : '当前没有此保存范围。';
}
function transferDraft() {
  return $('transfer-dialog').open && (transferMode === 'import' ? $('import-file').files.length > 0 : $('transfer-name').value !== duplicateDefaultName);
}
function closeTransfer() {
  if (busy || (transferDraft() && !confirm('放弃当前尚未完成的复制／导入？'))) return;
  $('transfer-dialog').close();
  $('import-file').value = '';
  $('transfer-name').value = '';
  $('transfer-error').hidden = true;
  updateControls();
}
function openTransfer(mode) {
  if (busy) return;
  if (dirty()) {
    if (mode === 'duplicate') { notify('请先保存或撤销未保存修改，再复制。', true); return; }
    if (!confirm('当前修改尚未保存，放弃后导入 Skill？')) return;
    $('editor').value = detail.content;
    renderPreview();
  }
  transferMode = mode;
  duplicateSource = mode === 'duplicate' ? selected : null;
  const row = snapshot.skills.find((item) => item.id === duplicateSource);
  duplicateDefaultName = row ? `${row.name.slice(0, 58).replace(/-$/, '')}-copy` : '';
  $('transfer-title').textContent = mode === 'import' ? '导入整个 Skill' : '复制为新 Skill';
  $('transfer-note').textContent = row ? `从 ${row.name} 复制完整目录，仅替换 YAML name，不改原文件。独立 Markdown 只复制自身。` : '选择一个含 SKILL.md 的 ZIP，可带 references、scripts、assets 等文件。可填写新名称解决同名冲突。';
  $('import-file-label').hidden = mode !== 'import';
  $('import-file').value = '';
  $('transfer-name').value = duplicateDefaultName;
  $('transfer-scope').value = 'global';
  $('transfer-error').hidden = true;
  renderTransferLocation();
  $('transfer-dialog').showModal();
  updateControls();
  $(mode === 'import' ? 'import-file' : 'transfer-name').focus();
}
$('import-skill').addEventListener('click', () => openTransfer('import'));
$('duplicate-skill').addEventListener('click', () => openTransfer('duplicate'));
$('transfer-cancel').addEventListener('click', closeTransfer);
$('transfer-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeTransfer(); });
$('transfer-scope').addEventListener('change', renderTransferLocation);
for (const id of ['transfer-name', 'import-file']) $(id).addEventListener('input', () => { $('transfer-error').hidden = true; updateControls(); });
$('transfer-submit').addEventListener('click', () => operation(async () => {
  $('transfer-error').hidden = true;
  let result;
  try {
    const name = $('transfer-name').value.trim();
    const scope = $('transfer-scope').value;
    if (transferMode === 'import') {
      const file = $('import-file').files[0];
      if (file.size > 52 * 1024 * 1024) throw new Error('ZIP 不能超过 52 MiB。');
      const query = new URLSearchParams({ scope, name });
      result = await api(`/api/import?${query}`, file, true);
    } else result = await api(`/api/skills/${duplicateSource}/duplicate`, { name, scope, revision: detail.revision });
  } catch (error) { $('transfer-error').textContent = error.message; $('transfer-error').hidden = false; throw error; }
  $('transfer-dialog').close();
  $('import-file').value = '';
  $('transfer-name').value = '';
  showCreated(result, transferMode === 'import' ? '导入' : '复制');
}));
$('open-folder').addEventListener('click', () => operation(async () => {
  const result = await api(`/api/skills/${selected}/open-folder`, {});
  notify(`已请求系统打开文件夹：${result.path}`);
}));
$('delete-skill').addEventListener('click', () => {
  if (busy || !detail?.deletion?.allowed) return;
  if (dirty()) { notify('请先保存或撤销未保存修改，再删除 Skill。', true); return; }
  const row = snapshot.skills.find((item) => item.id === selected);
  $('delete-name').textContent = row.name;
  $('delete-target').textContent = detail.deletion.target;
  $('delete-archive').textContent = detail.deletion.archiveRoot;
  $('delete-confirmation').value = '';
  $('delete-error').hidden = true;
  $('delete-dialog').showModal();
  updateControls();
  $('delete-confirmation').focus();
});
function closeDelete() { if (!busy) { $('delete-dialog').close(); $('delete-confirmation').value = ''; updateControls(); } }
$('delete-cancel').addEventListener('click', closeDelete);
$('delete-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDelete(); });
$('delete-confirmation').addEventListener('input', () => { $('delete-error').hidden = true; updateControls(); });
$('delete-submit').addEventListener('click', () => operation(async () => {
  let result;
  try {
    result = await api(`/api/skills/${selected}/delete`, { revision: detail.revision, confirmation: $('delete-confirmation').value, deleteToken: detail.deletion.token });
  } catch (error) { $('delete-error').textContent = error.message; $('delete-error').hidden = false; throw error; }
  $('delete-dialog').close();
  $('delete-confirmation').value = '';
  selected = null;
  detail = null;
  $('editor').value = '';
  $('detail').hidden = true;
  $('empty').hidden = false;
  batchSelection.delete(result.id);
  if (result.snapshot) applySnapshot(result.snapshot);
  else { snapshot.skills = snapshot.skills.filter((row) => row.id !== result.id); renderList(); }
  $('deletion-result').hidden = false;
  $('deleted-summary').textContent = `${result.name} 已删除，完整文件保留在`;
  $('deleted-path').textContent = result.archivedTo;
  $('changed').hidden = false;
  notify(result.warning || '已删除并保留完整备份。在 Pi 输入 /reload 更新。', Boolean(result.warning));
}));
$('copy-deleted-path').addEventListener('click', () => operation(async () => {
  await navigator.clipboard.writeText($('deleted-path').textContent);
  notify('已复制已删除 Skill 的备份路径。');
}));
$('export-skill').addEventListener('click', () => {
  if (dirty()) { notify('请先保存或撤销未保存修改，再导出。', true); return; }
  operation(async () => {
    const row = snapshot.skills.find((item) => item.id === selected);
    const response = await fetch(`/api/skills/${selected}/export`);
    if (!response.ok) throw new Error((await response.json()).error || '导出失败。');
    const href = URL.createObjectURL(await response.blob());
    const link = element('a');
    link.href = href;
    link.download = `${row.valid ? row.name : 'skill-backup'}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    notify('ZIP 已交给浏览器下载。不包含 .git、node_modules，不运行脚本。');
  });
});
$('select-visible').addEventListener('click', () => { for (const row of visibleRows()) batchSelection.add(row.id); renderList(); });
$('clear-selection').addEventListener('click', () => { batchSelection.clear(); renderList(); });
function runBatch(enabled) {
  const rows = snapshot.skills.filter((row) => batchSelection.has(row.id));
  if (!rows.length || !confirm(`将${enabled ? '开启' : '关闭'}选中的 ${rows.length} 个 Skill（包含筛选外所选项）？\n${rows.slice(0, 12).map((row) => row.name).join('、')}${rows.length > 12 ? '…' : ''}\n只修改原生配置，不改文件。跨全局/项目范围按顺序保存，失败会明确提示已处理项。`)) return;
  operation(async () => {
    const result = await api('/api/batch-toggle', { enabled, items: rows.map(({ id, configRevision }) => ({ id, configRevision })) });
    for (const id of result.processedIds) batchSelection.delete(id);
    if (result.snapshot) applySnapshot(result.snapshot); else renderList();
    if (result.processedIds.length) $('changed').hidden = false;
    notify(result.warning || `已批量${enabled ? '开启' : '关闭'} ${result.processedIds.length} 个 Skill。在 Pi 输入 /reload 生效。`, Boolean(result.warning));
  });
}
$('batch-enable').addEventListener('click', () => runBatch(true));
$('batch-disable').addEventListener('click', () => runBatch(false));
$('search').addEventListener('input', () => { queueSearch(); renderList(); renderViewStatus(); });
$('search-body').addEventListener('change', () => { queueSearch(); renderList(); renderViewStatus(); });
document.querySelectorAll('.filter').forEach((node) => node.addEventListener('click', () => {
  filter = node.dataset.filter;
  document.querySelectorAll('.filter').forEach((n) => n.classList.toggle('active', n === node));
  renderList();
  renderViewStatus();
}));
$('refresh').addEventListener('click', () => {
  if (dirty() && !confirm('刷新会丢弃未保存的修改，继续？')) return;
  operation(async () => {
    const next = await api('/api/skills');
    const nextDetail = selected && next.skills.some((s) => s.id === selected) ? await api(`/api/skills/${selected}`) : null;
    applySnapshot(next);
    if (nextDetail) showDetail(nextDetail);
    notify('列表已刷新。');
  });
});
$('editor').addEventListener('input', () => { updateControls(); renderPreview(); });
$('discard').addEventListener('click', () => {
  if (detail && confirm('撤销全部未保存修改？')) { $('editor').value = detail.content; renderPreview(); updateControls(); }
});
$('save').addEventListener('click', () => operation(async () => {
  const row = snapshot.skills.find((s) => s.id === selected);
  if (row.package && !confirm('将直接修改扩展包中的 SKILL.md，包更新可能覆盖它。保存前会自动备份，继续？')) return;
  const result = await api(`/api/skills/${selected}/save`, { content: savedEditorText(), revision: detail.revision });
  applySnapshot(result.snapshot);
  showDetail(result.detail);
  $('changed').hidden = false;
  notify(result.warning || '已保存并备份原文件。在 Pi 输入 /reload 生效。', Boolean(result.warning));
}));
$('restore').addEventListener('click', () => {
  if (!confirm('恢复所选备份？当前文件会先备份，未保存的编辑会丢弃。')) return;
  operation(async () => {
    const result = await api(`/api/skills/${selected}/restore`, { name: $('backup-select').value, revision: detail.revision });
    applySnapshot(result.snapshot);
    showDetail(result.detail);
    $('changed').hidden = false;
    notify('已恢复备份。在 Pi 输入 /reload 生效。');
  });
});
$('copy-path').addEventListener('click', () => operation(async () => {
  await navigator.clipboard.writeText($('file-path').textContent);
  notify('路径已复制。');
}));
function tab(preview) {
  setWorkbenchPanel('source');
  $('editor').hidden = preview;
  $('preview').hidden = !preview;
  $('edit-tab').classList.toggle('active', !preview);
  $('preview-tab').classList.toggle('active', preview);
}
$('edit-tab').addEventListener('click', () => tab(false));
$('preview-tab').addEventListener('click', () => tab(true));
window.addEventListener('beforeunload', (event) => {
  if (dirty() || ($('create-dialog').open && $('create-content').value.trim()) || transferDraft() || ($('organize-dialog').open && organizationText() !== organizationInitial) || ($('note-dialog').open && $('note-content').value !== noteInitial) || ($('batch-organize-dialog').open && batchOrganizationText() !== batchOrganizationInitial) || ($('view-dialog').open && $('view-name').value !== viewInitial) || ($('group-rename-dialog').open && groupRenameText() !== groupRenameInitial) || ($('organization-backup-dialog').open && $('organization-backup-file').files.length)) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if ($('create-dialog').open) { if (!$('create-submit').disabled) $('create-submit').click(); }
    else if ($('delete-dialog').open || $('trash-dialog').open || $('diff-dialog').open || $('attachments-dialog').open || $('loading-dialog').open || $('organization-backup-dialog').open) { /* Read-only/recovery dialogs never use the save shortcut. */ }
    else if ($('group-rename-dialog').open) { if (!$('group-rename-submit').disabled) $('group-rename-submit').click(); }
    else if ($('view-dialog').open) { if (!$('view-submit').disabled) $('view-submit').click(); }
    else if ($('note-dialog').open) { if (!$('note-submit').disabled) $('note-submit').click(); }
    else if ($('batch-organize-dialog').open) { if (!$('batch-organize-submit').disabled) $('batch-organize-submit').click(); }
    else if ($('organize-dialog').open) { if (!$('organize-submit').disabled) $('organize-submit').click(); }
    else if ($('transfer-dialog').open) { if (!$('transfer-submit').disabled) $('transfer-submit').click(); }
    else if (uiPanel === 'source' && !$('save').disabled) $('save').click(); }
});
function renderOrganizationFilters() {
  const groups = [...new Set(snapshot.skills.map((row) => row.group).filter(Boolean))].sort();
  const tags = [...new Set(snapshot.skills.flatMap((row) => row.tags || []))].sort();
  for (const [id, values, prefix, title] of [['group-filter', groups, 'g:', '所有分组'], ['tag-filter', tags, 't:', '所有标签']]) {
    const previous = $(id).value;
    $(id).replaceChildren(element('option', title));
    $(id).firstChild.value = '';
    if (id === 'group-filter') { const option = element('option', '未分组'); option.value = '-'; $(id).append(option); }
    for (const value of values) { const option = element('option', value); option.value = prefix + value; $(id).append(option); }
    retainFilterValue(id, previous);
  }
  $('known-groups').replaceChildren();
  for (const value of groups) { const option = element('option'); option.value = value; $('known-groups').append(option); }
}
for (const id of ['group-filter', 'tag-filter', 'sort-order', 'notes-filter']) $(id).addEventListener('change', () => {
  if (id === 'sort-order') { try { localStorage.setItem('skill-manager-sort', $(id).value); } catch { /* Optional UI preference. */ } }
  renderList(); renderViewStatus(); updateControls();
});
try { const order = localStorage.getItem('skill-manager-sort'); if (['favorite', 'modified', 'added', 'name'].includes(order)) $('sort-order').value = order; } catch { /* Optional UI preference. */ }
function queueSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  const generation = ++searchGeneration;
  searchHits.clear();
  const query = $('search').value.trim();
  $('search-status').textContent = '';
  if (!$('search-body').checked || !query) return;
  if (query.length > 200) { $('search-status').textContent = '正文搜索最多 200 字符'; return; }
  $('search-status').textContent = '正在搜索正文…';
  searchTimer = setTimeout(async () => {
    const controller = new AbortController();
    searchController = controller;
    try {
      const response = await fetch(`/api/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '正文搜索失败');
      if (generation !== searchGeneration) return;
      searchHits = new Map(result.hits.map((hit) => [hit.id, hit.excerpt]));
      $('search-status').textContent = result.warning || `正文匹配 ${searchHits.size} 项`;
      renderList();
    } catch (e) { if (generation === searchGeneration && e.name !== 'AbortError') $('search-status').textContent = e.message; }
  }, 250);
}
async function loadAttachments() {
  const result = await api(`/api/skills/${attachmentSource}/attachments`);
  $('attachments-tree').replaceChildren();
  $('attachment-content').textContent = '';
  $('attachment-info').textContent = '选择一个文件，只读查看。';
  $('attachments-note').textContent = result.warning || '';
  $('attachments-warnings').replaceChildren(...result.diagnostics.map(item => element('p', `${item.message} ${item.path}`)));
  const parents = new Map([['', $('attachments-tree')]]);
  for (const item of result.items) {
    const parts = item.path.split('/'); const name = parts.pop(); const parent = parents.get(parts.join('/')) || $('attachments-tree');
    if (item.directory) {
      const folder = element('details'); folder.append(element('summary', name));
      const children = element('div', undefined, 'attachment-folder'); folder.append(children); parent.append(folder); parents.set(item.path, children);
    } else {
      const button = element('button', name, 'attachment-file'); button.title = item.path;
      button.addEventListener('click', () => operation(async () => {
        $('attachment-content').textContent = ''; $('attachment-info').textContent = '正在读取…';
        try {
          const result = await api(`/api/skills/${attachmentSource}/attachment?${new URLSearchParams({ path: item.path, revision: item.revision })}`);
          $('attachment-info').textContent = `${result.path} · ${result.bytes} 字节${result.reason ? ` · ${result.reason}` : ' · UTF-8 纯文本，只读'}`;
          $('attachment-content').textContent = result.text ?? '';
        } catch (e) { $('attachment-info').textContent = e.message; throw e; }
      })); parent.append(button);
    }
  }
  if (!result.items.length) $('attachments-tree').append(element('p', '没有可浏览的附件。'));
}
$('attachments-open').addEventListener('click', () => operation(async () => {
  moveAttachments(false);
  attachmentSource = selected; $('attachments-title').textContent = `附件只读浏览 · ${snapshot.skills.find(row => row.id === selected).name}`;
  await loadAttachments(); $('attachments-dialog').showModal();
}));
$('attachments-refresh').addEventListener('click', () => operation(loadAttachments));
$('attachments-close').addEventListener('click', () => { if (!busy) $('attachments-dialog').close(); });
$('attachments-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('attachments-dialog').addEventListener('close', () => { if (uiPanel === 'attachments') moveAttachments(true); });
$('note-open').addEventListener('click', () => {
  const row = snapshot.skills.find(row => row.id === selected);
  if (busy || !row || snapshot.preferencesError) return;
  noteSource = row.id; noteRevision = snapshot.preferencesRevision; noteInitial = row.note || '';
  $('note-title').textContent = `个人备注 · ${row.name}`; $('note-content').value = noteInitial; $('note-error').hidden = true;
  $('note-dialog').showModal(); updateControls(); $('note-content').focus();
});
function closeNote() {
  if (busy || ($('note-content').value !== noteInitial && !confirm('放弃尚未保存的个人备注？'))) return;
  $('note-dialog').close();
}
$('note-cancel').addEventListener('click', closeNote);
$('note-dialog').addEventListener('cancel', event => { event.preventDefault(); closeNote(); });
$('note-content').addEventListener('input', updateControls);
$('note-submit').addEventListener('click', () => operation(async () => {
  try {
    const result = await api(`/api/skills/${noteSource}/note`, { note: $('note-content').value, preferencesRevision: noteRevision });
    $('note-dialog').close(); if (result.snapshot) applySnapshot(result.snapshot);
    notify(result.warning || '个人备注已保存。不改 Skill 文件或 Pi 配置。', Boolean(result.warning));
  } catch (e) { $('note-error').textContent = e.message; $('note-error').hidden = false; throw e; }
}));
$('batch-organize').addEventListener('click', () => {
  if (busy || !batchSelection.size || batchSelection.size > 100 || snapshot.preferencesError) return;
  const rows = snapshot.skills.filter(row => batchSelection.has(row.id));
  batchOrganizationIds = rows.map(row => row.id); batchOrganizationRevision = snapshot.preferencesRevision;
  const hidden = rows.length - rows.filter(row => visibleRows().some(visible => visible.id === row.id)).length;
  $('batch-organize-summary').textContent = `将整理 ${rows.length} 个 Skill（其中 ${hidden} 个在筛选外）。保存只作用于以下选择。`;
  $('batch-organize-items').replaceChildren(...rows.map(row => element('p', `${row.name} · ${row.group || '未分组'} · ${(row.tags || []).join('，')}`)));
  $('batch-group-mode').value = 'keep'; $('batch-tag-mode').value = 'keep'; $('batch-group').value = ''; $('batch-tags').value = '';
  batchOrganizationInitial = batchOrganizationText(); $('batch-organize-error').hidden = true;
  $('batch-organize-dialog').showModal(); updateControls();
});
function closeBatchOrganization() {
  if (busy || (batchOrganizationText() !== batchOrganizationInitial && !confirm('放弃尚未保存的批量分组／标签？'))) return;
  $('batch-organize-dialog').close();
}
$('batch-organize-cancel').addEventListener('click', closeBatchOrganization);
$('batch-organize-dialog').addEventListener('cancel', event => { event.preventDefault(); closeBatchOrganization(); });
for (const id of ['batch-group-mode', 'batch-group', 'batch-tag-mode', 'batch-tags']) $(id).addEventListener('input', updateControls);
$('batch-organize-submit').addEventListener('click', () => operation(async () => {
  try {
    const result = await api('/api/batch-organize', { ids: batchOrganizationIds, preferencesRevision: batchOrganizationRevision, groupMode: $('batch-group-mode').value, group: $('batch-group').value, tagMode: $('batch-tag-mode').value, tags: $('batch-tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) });
    $('batch-organize-dialog').close(); if (result.snapshot) applySnapshot(result.snapshot);
    notify(result.warning || `已批量整理 ${result.count} 个 Skill。不改文件或 Pi 加载。`, Boolean(result.warning));
  } catch (e) { $('batch-organize-error').textContent = e.message; $('batch-organize-error').hidden = false; throw e; }
}));
$('organize-skill').addEventListener('click', () => {
  const row = snapshot.skills.find((item) => item.id === selected);
  if (busy || !row || snapshot.preferencesError) return;
  organizationSource = row.id;
  organizationRevision = snapshot.preferencesRevision;
  $('organize-group').value = row.group || '';
  $('organize-tags').value = (row.tags || []).join(', ');
  organizationInitial = organizationText();
  $('organize-error').hidden = true;
  $('organize-title').textContent = `整理 ${row.name}`;
  $('organize-dialog').showModal();
  $('organize-group').focus();
});
function closeOrganization() {
  if (busy || (organizationText() !== organizationInitial && !confirm('放弃尚未保存的分组／标签？'))) return;
  $('organize-dialog').close();
}
$('organize-cancel').addEventListener('click', closeOrganization);
$('organize-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeOrganization(); });
$('organize-submit').addEventListener('click', () => operation(async () => {
  try {
    const result = await api(`/api/skills/${organizationSource}/organize`, { group: $('organize-group').value.trim(), tags: $('organize-tags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), preferencesRevision: organizationRevision });
    $('organize-dialog').close();
    applySnapshot(result.snapshot);
    notify('分组和标签已保存。不改 Skill 原文或 Pi 加载规则。');
  } catch (e) { $('organize-error').textContent = e.message; $('organize-error').hidden = false; throw e; }
}));
async function loadTrash() {
  const result = await api('/api/deleted');
  $('trash-items').replaceChildren();
  $('trash-warnings').replaceChildren(...result.diagnostics.map((item) => element('p', `${item.message} ${item.path}`)));
  if (!result.items.length) $('trash-items').append(element('p', '回收站暂无可恢复备份。'));
  for (const item of result.items) {
    const node = element('section', undefined, 'trash-item');
    node.append(element('strong', item.name), element('p', `删除时间 ${new Date(item.at).toLocaleString()}`), element('p', `恢复到 ${item.originalPath}`), element('p', `备份 ${item.archivedTo}`));
    const restore = element('button', '恢复原位置', 'secondary undelete-action');
    restore.dataset.allowed = String(item.allowed);
    restore.disabled = busy || !item.allowed;
    restore.addEventListener('click', () => {
      if (busy || !confirm(`恢复 ${item.name} 到原位置？\n${item.originalPath}\n不会覆盖已有文件，不改 Pi 配置。`)) return;
      operation(async () => {
        const result = await api('/api/undelete', { id: item.id, token: item.token });
        if (result.snapshot) applySnapshot(result.snapshot);
        if (result.item && result.detail && !dirty()) { selected = result.item.id; showDetail(result.detail); renderList(); }
        $('changed').hidden = false;
        if ($('deleted-path').textContent === item.archivedTo) $('deletion-result').hidden = true;
        try {
          await loadTrash();
          notify(result.warning || '文件已恢复。在 Pi 输入 /reload 更新。', Boolean(result.warning));
        } catch (e) {
          // The restore receipt is final; a later GET failure must not invite a retry.
          node.remove();
          if (!$('trash-items').children.length) $('trash-items').append(element('p', '文件已恢复，回收站列表暂未刷新；请点击「刷新」重新读取。'));
          notify([result.warning, `文件已恢复到 ${result.path}，但回收站列表刷新失败：${e.message} 请点击刷新，不要重复恢复。`].filter(Boolean).join(' '), true);
        }
      });
    });
    const permanent = element('button', '永久删除这一条…', 'secondary danger purge-one-action');
    permanent.dataset.allowed = 'true'; permanent.disabled = busy;
    permanent.addEventListener('click', () => operation(() => openPurge(item.id)));
    node.append(restore, permanent);
    if (item.reason) node.append(element('p', item.reason, 'issue'));
    $('trash-items').append(node);
  }
}
$('trash-open').addEventListener('click', () => operation(async () => { await loadTrash(); $('trash-dialog').showModal(); }));
$('trash-refresh').addEventListener('click', () => operation(loadTrash));
$('trash-close').addEventListener('click', () => { if (!busy) $('trash-dialog').close(); });
$('trash-dialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
async function openPurge(id) {
  purgePlan = undefined;
  $('purge-confirmation').value = '';
  $('purge-error').hidden = true;
  const plan = await api(id ? `/api/deleted/purge-one-preview?${new URLSearchParams({ id })}` : '/api/deleted/purge-preview');
  purgePlan = plan;
  $('purge-title').textContent = id ? '永久删除这一条备份' : '永久清空回收站';
  $('purge-confirmation-label').textContent = `输入「${plan.confirmation}」确认`;
  const active = plan.items.filter((item) => item.active).length;
  $('purge-summary').textContent = `本次将永久删除 ${plan.items.length} 个归档目录（${active} 个含备份，${plan.items.length - active} 个仅残留记录）。异常或不属于管理器的内容保留。`;
  $('purge-items').replaceChildren(...plan.items.map((item) => {
    const node = element('section', undefined, 'trash-item');
    node.append(element('strong', item.name), element('p', item.path), element('p', `${item.entries} 个文件／目录，约 ${(item.bytes / 1024 / 1024).toFixed(2)} MiB${item.active ? '' : '；原文件已恢复或归档数据不存在，仅清理记录'}`));
    if (!plan.targetId) {
      const single = element('button', '只永久删除这一条…', 'secondary danger purge-preview-one-action'); single.dataset.allowed = 'true'; single.disabled = busy;
      single.addEventListener('click', () => operation(async () => { $('purge-dialog').close(); await openPurge(item.id); })); node.append(single);
    }
    return node;
  }));
  $('purge-warnings').replaceChildren(...plan.diagnostics.map((item) => element('p', `保留：${item.message} ${item.path}`, 'issue')));
  $('purge-dialog').showModal();
}
$('trash-purge').addEventListener('click', () => operation(() => openPurge()));
$('purge-confirmation').addEventListener('input', updateControls);
$('purge-cancel').addEventListener('click', () => { if (!busy) { purgePlan = undefined; $('purge-dialog').close(); } });
$('purge-dialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); else purgePlan = undefined; });
$('purge-submit').addEventListener('click', () => operation(async () => {
  let result;
  try { result = await api(purgePlan?.targetId ? '/api/deleted/purge-one' : '/api/deleted/purge', { id: purgePlan?.targetId, token: purgePlan?.token, confirmation: $('purge-confirmation').value }); }
  catch (e) { purgePlan = undefined; $('purge-error').textContent = `${e.message} 请取消后重新预览，不要重复提交旧确认。`; $('purge-error').hidden = false; throw e; }
  // Deletion receipt is final. A later refresh must never replace it with a generic failure.
  purgePlan = undefined;
  $('purge-dialog').close();
  $('trash-items').replaceChildren(element('p', '永久清理已执行，正在刷新剩余备份…'));
  if (result.deleted.some((item) => $('deleted-path').textContent.startsWith(item.path))) $('deletion-result').hidden = true;
  const messages = [`永久清理已执行：已删除 ${result.deleted.length} 个归档、${result.removedEntries} 个文件／目录。此操作不可撤销。`, result.warning];
  if (result.diagnostics.length) messages.push('异常或非管理器归档已保留，请检查。');
  try { await loadTrash(); }
  catch (e) { $('trash-items').replaceChildren(element('p', '永久清理已执行，列表刷新失败；请点击刷新，不要重复提交。')); messages.push(`列表刷新失败：${e.message}，请手动刷新，不要重复提交。`); }
  if (result.failures.length) $('trash-warnings').append(...result.failures.map((item) => element('p', `未全部清理：${item.message} ${item.path}`, 'issue')));
  notify(messages.filter(Boolean).join(' '), Boolean(result.warning || result.failures.length || result.diagnostics.length || messages.some((text) => text?.includes('列表刷新失败'))));
}));
function showDiff(result, history) {
  $('diff-description').textContent = history ? '所选历史备份 → 当前已保存版本（不包含未保存草稿）' : '当前已保存版本 → 编辑草稿';
  $('diff-content').replaceChildren();
  const lines = result.patch?.hunks.flatMap((hunk) => [{ heading: `@@ 原 ${hunk.oldStart},${hunk.oldLines} → 新 ${hunk.newStart},${hunk.newLines} @@` }, ...hunk.lines.map((text) => ({ text }))]) || [];
  const added = lines.filter((line) => line.text?.startsWith('+')).length;
  const removed = lines.filter((line) => line.text?.startsWith('-')).length;
  $('diff-summary').textContent = result.limited ? '差异过大或计算超过限额，未生成对比；不会影响原文件或草稿。' : result.newlineOnly ? '仅换行样式不同，正文行没有变化。' : !result.changed ? '没有变化。' : `新增 ${added} 行，删除 ${removed} 行。`;
  for (const line of lines.slice(0, 3000)) $('diff-content').append(element('pre', line.heading || line.text, line.heading ? 'diff-hunk' : line.text.startsWith('+') ? 'diff-added' : line.text.startsWith('-') ? 'diff-removed' : 'diff-context'));
  if (lines.length > 3000) $('diff-content').append(element('p', '超过 3000 行，界面只展示前 3000 行；统计为本次完整差异。'));
  $('diff-dialog').showModal();
}
$('compare-draft').addEventListener('click', () => operation(async () => showDiff(await api(`/api/skills/${selected}/compare`, { content: savedEditorText(), revision: detail.revision }), false)));
$('backup-compare').addEventListener('click', () => operation(async () => showDiff(await api(`/api/skills/${selected}/compare`, { backup: $('backup-select').value, revision: detail.revision }), true)));
$('diff-close').addEventListener('click', () => { if (!busy) $('diff-dialog').close(); });
$('diff-dialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
$('batch-export').addEventListener('click', () => {
  const rows = snapshot.skills.filter((row) => batchSelection.has(row.id));
  if (dirty() && rows.some((row) => row.id === selected)) { notify('所选 Skill 有未保存修改，请先保存或撤销再导出。', true); return; }
  if (!rows.length || !confirm(`打包选中的 ${rows.length} 个 Skill（包含筛选外所选项）？\n${rows.slice(0, 12).map((row) => row.name).join('、')}\n最多 50 项、合计 50 MiB／1000 文件目录。不含 .git 和 node_modules，不运行脚本。\n这是多 Skill 备份包；请手动解压后逐个文件夹导入，不直接使用单 Skill 导入按钮。`)) return;
  operation(async () => {
    const response = await fetch('/api/export-selected', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skill-Manager': '1' }, body: JSON.stringify({ items: rows.map((row) => ({ id: row.id, revision: row.contentRevision })) }) });
    if (!response.ok) throw new Error((await response.json()).error || '打包失败');
    const href = URL.createObjectURL(await response.blob());
    const link = element('a'); link.href = href; link.download = 'skills-backup.zip'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    notify('多 Skill 备份 ZIP 已交给浏览器下载。未修改原文件或配置。');
  });
});
function currentFilters() {
  return { query: $('search').value, body: $('search-body').checked, status: filter, group: $('group-filter').value, tag: $('tag-filter').value, sort: $('sort-order').value, notes: $('notes-filter').value };
}
function retainFilterValue(id, value) {
  if (value && ![...$(id).options].some(option => option.value === value)) { const option = element('option', `${value.slice(2)}（当前无匹配项）`); option.value = value; $(id).append(option); }
  $(id).value = value;
}
function renderViewStatus() {
  const view = snapshot?.views?.find(v => v.id === $('saved-view').value);
  const current = currentFilters();
  $('view-status').textContent = view ? JSON.stringify(current) === JSON.stringify(Object.fromEntries(Object.keys(current).map(key => [key, view.filters[key]]))) ? '已应用' : '已调整，未更新视图' : '';
  renderWorkbench();
}
function renderSavedViews() {
  const previous = $('saved-view').value;
  $('saved-view').replaceChildren(element('option', '当前自定义筛选')); $('saved-view').firstChild.value = '';
  for (const view of snapshot.views || []) { const option = element('option', view.name); option.value = view.id; $('saved-view').append(option); }
  $('saved-view').value = (snapshot.views || []).some(v => v.id === previous) ? previous : '';
  renderViewStatus();
}
$('saved-view').addEventListener('change', () => {
  const view = snapshot.views.find(v => v.id === $('saved-view').value);
  if (view) {
    const f = view.filters; $('search').value = f.query; $('search-body').checked = f.body; filter = f.status;
    retainFilterValue('group-filter', f.group); retainFilterValue('tag-filter', f.tag); $('sort-order').value = f.sort; $('notes-filter').value = f.notes;
    document.querySelectorAll('.filter').forEach(n => n.classList.toggle('active', n.dataset.filter === filter));
    queueSearch(); renderList();
  }
  renderViewStatus(); updateControls();
});
function renderGroupRenameSummary() {
  const from = $('group-rename-from').value;
  const count = snapshot.skills.filter(row => row.group === from).length;
  const views = (snapshot.views || []).filter(view => view.filters.group === `g:${from}`).length;
  $('group-rename-summary').textContent = `当前已发现 ${count} 个成员，${views} 个常用视图引用该分组。其他暂未发现的同组记录亦会保留成员关系并同步名称。`;
}
$('group-rename-open').addEventListener('click', () => {
  if ($('group-rename-open').disabled) return;
  const groups = groupRenameGroups();
  $('group-rename-from').replaceChildren(...groups.map(name => { const option = element('option', name); option.value = name; return option; }));
  const current = $('group-filter').value; if (current.startsWith('g:') && groups.includes(current.slice(2))) $('group-rename-from').value = current.slice(2);
  $('group-rename-name').value = $('group-rename-from').value; groupRenameInitial = groupRenameText(); groupRenameRevision = snapshot.preferencesRevision;
  $('group-rename-error').hidden = true; renderGroupRenameSummary(); $('group-rename-dialog').showModal(); updateControls(); $('group-rename-name').focus(); $('group-rename-name').select();
});
function closeGroupRename() {
  if (busy || (groupRenameText() !== groupRenameInitial && !confirm('放弃尚未保存的分组新名称？'))) return;
  $('group-rename-dialog').close(); updateControls();
}
$('group-rename-cancel').addEventListener('click', closeGroupRename);
$('group-rename-dialog').addEventListener('cancel', event => { event.preventDefault(); closeGroupRename(); });
$('group-rename-from').addEventListener('change', () => { $('group-rename-name').value = $('group-rename-from').value; $('group-rename-error').hidden = true; renderGroupRenameSummary(); updateControls(); });
$('group-rename-name').addEventListener('input', () => { $('group-rename-error').hidden = true; updateControls(); });
$('group-rename-submit').addEventListener('click', () => operation(async () => {
  let result;
  try { result = await api('/api/groups/rename', { from: $('group-rename-from').value, name: $('group-rename-name').value, preferencesRevision: groupRenameRevision }); }
  catch (error) { $('group-rename-error').textContent = error.message; $('group-rename-error').hidden = false; throw error; }
  $('group-rename-dialog').close();
  if ($('group-filter').value === `g:${result.from}`) retainFilterValue('group-filter', `g:${result.to}`);
  groupRenameNeedsRefresh = !result.snapshot;
  if (result.snapshot) applySnapshot(result.snapshot);
  const receipt = `分组「${result.from}」已更名为「${result.to}」，${result.count} 条成员记录和 ${result.viewCount} 个视图引用已同步；内容未改动。${result.warning ? ` ${result.warning} 请手动刷新，不要重复改名。` : ''}`;
  $('group-rename-receipt').textContent = receipt; $('group-rename-receipt').hidden = false; notify(receipt, Boolean(result.warning));
}));
function openView(update) {
  const view = update ? snapshot.views.find(v => v.id === $('saved-view').value) : null;
  if (busy || (update && !view)) return;
  viewSource = view?.id ?? null; viewInitial = view?.name || ''; viewRevision = snapshot.preferencesRevision; viewFilters = currentFilters();
  $('view-title').textContent = view ? '更新所选常用视图' : '保存为新的常用视图'; $('view-name').value = viewInitial; $('view-filters').textContent = JSON.stringify(viewFilters, null, 2); $('view-error').hidden = true;
  $('view-dialog').showModal(); updateControls(); $('view-name').focus();
}
$('view-new').addEventListener('click', () => openView(false)); $('view-edit').addEventListener('click', () => openView(true));
function closeView() { if (busy || ($('view-name').value !== viewInitial && !confirm('放弃尚未保存的视图名称？'))) return; $('view-dialog').close(); updateControls(); }
$('view-cancel').addEventListener('click', closeView); $('view-dialog').addEventListener('cancel', event => { event.preventDefault(); closeView(); });
$('view-name').addEventListener('input', () => { $('view-error').hidden = true; updateControls(); });
$('view-submit').addEventListener('click', () => operation(async () => {
  let result;
  try { result = await api('/api/views/save', { id: viewSource, name: $('view-name').value, filters: viewFilters, preferencesRevision: viewRevision }); }
  catch (e) { $('view-error').textContent = e.message; $('view-error').hidden = false; throw e; }
  $('view-dialog').close(); if (result.snapshot) { applySnapshot(result.snapshot); $('saved-view').value = result.viewId; renderViewStatus(); }
  notify(result.warning || '常用视图已保存，只影响网页筛选。', Boolean(result.warning));
}));
$('view-delete').addEventListener('click', () => {
  const view = snapshot.views.find(v => v.id === $('saved-view').value); const expected = snapshot.preferencesRevision;
  if (!view || !confirm(`删除常用视图「${view.name}」？不改变当前筛选、Skill 或其他整理信息。`)) return;
  operation(async () => { const result = await api('/api/views/delete', { id: view.id, preferencesRevision: expected }); if (result.snapshot) applySnapshot(result.snapshot); notify(result.warning || '常用视图已删除，当前筛选保留。', Boolean(result.warning)); });
});
$('loading-open').addEventListener('click', () => operation(async () => {
  const result = await api(`/api/skills/${selected}/diagnostics`); const root = $('loading-content'); root.replaceChildren(element('p', result.path));
  for (const message of result.messages) root.append(element('p', message));
  if (result.winner) root.append(element('h3', '当前同名有效文件'), element('p', result.winner.path));
  const evidence = result.evidence; root.append(element('h3', '配置与过滤证据'), element('p', `${evidence.file}\n来源 ${evidence.source} · 模式 ${evidence.mode}\n相对路径基准 ${evidence.base}`));
  if (evidence.confirmed && evidence.decisive) root.append(element('p', `决定性匹配规则 ${evidence.decisive}`));
  if (evidence.note) root.append(element('p', evidence.note));
  for (const rule of evidence.rules) root.append(element('p', `第 ${rule.index + 1} 条 ${rule.pattern} → ${rule.enabled ? '包含／开启' : '排除／关闭'}（匹配证据）`));
  for (const warning of result.diagnostics) root.append(element('p', `${warning.message}\n${warning.path}`, 'issue'));
  root.append(element('p', result.warning)); $('loading-dialog').showModal();
}));
$('loading-close').addEventListener('click', () => { if (!busy) $('loading-dialog').close(); }); $('loading-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
function invalidateOrganizationPreview() {
  organizationBackupPlan = null; organizationBackupDocument = null; $('organization-backup-results').replaceChildren(); $('organization-backup-error').hidden = true; updateControls();
}
$('organization-backup-open').addEventListener('click', () => {
  if (busy) return; $('organization-backup-file').value = ''; $('organization-backup-mode').value = 'merge'; invalidateOrganizationPreview(); $('organization-backup-dialog').showModal();
});
function closeOrganizationBackup() {
  if (busy || ($('organization-backup-file').files.length && !confirm('取消导入并丢弃当前预览？未保存的整理信息不会写入。'))) return;
  $('organization-backup-dialog').close(); $('organization-backup-file').value = ''; invalidateOrganizationPreview();
}
$('organization-backup-cancel').addEventListener('click', closeOrganizationBackup); $('organization-backup-dialog').addEventListener('cancel', event => { event.preventDefault(); closeOrganizationBackup(); });
for (const id of ['organization-backup-file', 'organization-backup-mode']) $(id).addEventListener('change', invalidateOrganizationPreview);
$('organization-backup-export').addEventListener('click', () => operation(async () => {
  const response = await fetch('/api/organization/export'); if (!response.ok) throw new Error((await response.json()).error || '导出失败');
  const href = URL.createObjectURL(await response.blob()); const link = element('a'); link.href = href; link.download = 'skill-manager-organization.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  notify('整理信息 JSON 已交给浏览器下载；含路径和私人备注，请妥善保存。');
}));
$('organization-backup-preview').addEventListener('click', () => operation(async () => {
  invalidateOrganizationPreview();
  try {
    const file = $('organization-backup-file').files[0]; if (!file || file.size > 1024 * 1024) throw new Error('整理信息 JSON 不能超过 1 MiB。');
    organizationBackupDocument = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
    const result = await api('/api/organization/preview', { document: organizationBackupDocument, mode: $('organization-backup-mode').value }); organizationBackupPlan = result;
    const root = $('organization-backup-results'); root.append(element('h3', `将变更 ${result.changed} 项，跳过 ${result.skipped} 个未匹配 Skill`), element('p', result.warning));
    for (const item of result.items) {
      const node = element('details'); node.append(element('summary', `${item.name || item.id} · ${!item.matched ? '未匹配' : item.changed ? '将更新' : '无变化'}`)); node.append(element('p', item.path || '没有位置资料'));
      if (item.matched) node.append(element('pre', `原值\n${JSON.stringify(item.before, null, 2)}\n导入后\n${JSON.stringify(item.after, null, 2)}`)); else node.append(element('p', item.reason)); root.append(node);
    }
    for (const view of result.views) {
      const node = element('details'); node.append(element('summary', `视图「${view.name}」· ${view.reason}`));
      if (view.after) node.append(element('pre', `原视图\n${JSON.stringify(view.before, null, 2)}\n导入后\n${JSON.stringify(view.after, null, 2)}`)); root.append(node);
    }
  } catch (e) { organizationBackupPlan = null; $('organization-backup-error').textContent = e.message; $('organization-backup-error').hidden = false; throw e; }
}));
$('organization-backup-submit').addEventListener('click', () => operation(async () => {
  const plan = organizationBackupPlan; let result;
  try { result = await api('/api/organization/import', { document: organizationBackupDocument, mode: plan.mode, token: plan.token }); }
  catch (e) { organizationBackupPlan = null; $('organization-backup-error').textContent = `${e.message} 请重新预览；旧确认已失效。`; $('organization-backup-error').hidden = false; throw e; }
  organizationBackupPlan = null; organizationBackupDocument = null; $('organization-backup-file').value = ''; $('organization-backup-dialog').close();
  if (result.snapshot) applySnapshot(result.snapshot); notify(result.warning || `整理信息已保存，变更 ${result.count} 项；Skill 正文和 Pi 配置未改动。`, Boolean(result.warning));
}));
function toggleSkill(row) {
  operation(async () => {
    const result = await api(`/api/skills/${row.id}/toggle`, { enabled: !row.enabled, configRevision: row.configRevision });
    applySnapshot(result.snapshot); $('changed').hidden = false;
    notify(`${row.name} 已${row.enabled ? '关闭' : '开启'}。在 Pi 输入 /reload 生效。`);
  });
}
function favoriteSkill(row) {
  operation(async () => {
    const result = await api(`/api/skills/${row.id}/favorite`, { favorite: !row.favorite });
    applySnapshot(result.snapshot); notify(row.favorite ? '已取消收藏。' : '已收藏，只影响网页排序，不改变 Pi 加载规则。');
  });
}
function uiIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function renderWorkbench() {
  if (!snapshot) return;
  $('ui-count-all').textContent = snapshot.skills.length;
  $('ui-count-favorites').textContent = snapshot.skills.filter(row => row.favorite).length;
  $('ui-count-issues').textContent = snapshot.skills.filter(row => !row.valid || (row.enabled && !row.effective)).length;
  $('ui-scope-note').textContent = snapshot.project ? '当前项目与全局资料库' : '个人资料库';
  const group = $('group-filter').value;
  const currentView = snapshot.views?.find(view => view.id === $('saved-view').value);
  $('ui-list-title').textContent = currentView ? currentView.name : group ? group === '-' ? '未分组' : group.slice(2) : ({ all: '全部 Skills', favorites: '收藏', issues: '需注意', enabled: '已开启', disabled: '已关闭' })[filter];
  $('ui-result-count').textContent = `${visibleRows().length} 个结果 · ${snapshot.skills.length} 个 Skills`;
  const groups = [...new Set(snapshot.skills.map(row => row.group).filter(Boolean))].sort();
  $('ui-group-nav').replaceChildren();
  for (const name of groups) {
    const button = element('button', undefined, `nav-item${group === `g:${name}` ? ' active' : ''}`); button.dataset.uiGroup = name; button.disabled = busy;
    button.append(element('span', '', 'group-dot'), element('span', name), element('span', snapshot.skills.filter(row => row.group === name).length, 'nav-count'));
    button.addEventListener('click', () => { if (busy) return; retainFilterValue('group-filter', `g:${name}`); $('group-filter').dispatchEvent(new Event('change')); $('app').dataset.scene = 'list'; setWorkbenchNav(false); });
    $('ui-group-nav').append(button);
  }
  if (!groups.length) $('ui-group-nav').append(element('span', '还没有分组', 'nav-empty'));
  $('ui-view-nav').replaceChildren();
  for (const view of snapshot.views || []) {
    const button = element('button', undefined, `nav-item${currentView?.id === view.id ? ' active' : ''}`); button.dataset.uiView = view.id; button.disabled = busy;
    button.append(uiIcon('view'), element('span', view.name)); button.addEventListener('click', () => { if (busy) return; $('saved-view').value = view.id; $('saved-view').dispatchEvent(new Event('change')); setWorkbenchNav(false); }); $('ui-view-nav').append(button);
  }
  if (!snapshot.views?.length) $('ui-view-nav').append(element('span', '保存一组常用筛选', 'nav-empty'));
  document.querySelectorAll('[data-ui-filter]').forEach(button => { const active = filter === button.dataset.uiFilter && !group && !currentView; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  const labels = [group ? $('group-filter').selectedOptions[0]?.textContent : '', $('tag-filter').value ? $('tag-filter').selectedOptions[0]?.textContent : '', $('notes-filter').value !== 'all' ? $('notes-filter').selectedOptions[0].textContent : '', $('search-body').checked ? '含正文' : ''].filter(Boolean);
  $('ui-filter-count').textContent = labels.length ? labels.length : ''; $('ui-active-filters').replaceChildren(...labels.map(label => element('span', label))); $('ui-active-filters').hidden = !labels.length;
}
function moveAttachments(inline) {
  const root = $('attachments-body'); const target = inline ? $('ui-inline-attachments') : $('attachments-dialog');
  if (root.parentElement !== target) target.append(root);
}
function setWorkbenchPanel(name, focus = false) {
  uiPanel = name;
  document.querySelectorAll('[data-ui-panel]').forEach(button => {
    const active = button.dataset.uiPanel === name; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; $(`ui-panel-${button.dataset.uiPanel}`).hidden = !active;
  });
  $('ui-editor-actions').hidden = name !== 'source'; $('ui-read-source').hidden = name === 'source';
  if (name === 'attachments') moveAttachments(true);
  if (focus) $(`ui-tab-${name}`).focus();
}
async function refreshInlineAttachments() {
  attachmentSource = selected; const target = selected; const revision = detail?.revision;
  $('ui-attachments-status').textContent = '正在读取附件清单…';
  $('attachments-tree').replaceChildren(); $('attachment-content').textContent = '';
  try { await loadAttachments(); uiAttachmentStamp = `${target}:${revision}`; $('ui-attachments-status').textContent = '只展示经范围与版本检查的附件。'; }
  catch (error) { uiAttachmentStamp = undefined; $('ui-attachments-status').textContent = error.message; throw error; }
}
function setWorkbenchNav(open) {
  uiNavOpen = open; $('app').classList.toggle('nav-open', open); $('ui-nav-scrim').hidden = !open;
  $('ui-nav-toggle').setAttribute('aria-expanded', String(open));
  for (const id of ['ui-library', 'detail', 'empty']) $(id).inert = open;
  if (open) $('ui-nav-close').focus();
}
$('ui-detail-toggle').addEventListener('click', () => { const row = snapshot?.skills.find(row => row.id === selected); if (row) toggleSkill(row); });
$('ui-detail-favorite').addEventListener('click', () => { const row = snapshot?.skills.find(row => row.id === selected); if (row) favoriteSkill(row); });
$('ui-read-source').addEventListener('click', () => { tab(false); $('ui-tab-source').focus(); });
for (const button of document.querySelectorAll('[data-ui-panel]')) button.addEventListener('click', () => {
  if (busy || !detail) return; const name = button.dataset.uiPanel; setWorkbenchPanel(name);
  if (name === 'attachments' && uiAttachmentStamp !== `${selected}:${detail.revision}`) operation(refreshInlineAttachments);
});
$('ui-attachments-refresh').addEventListener('click', () => operation(refreshInlineAttachments));
$('ui-tab-history').addEventListener('click', () => { if (!busy) document.querySelector('.backups').open = true; });
for (const button of document.querySelectorAll('[data-ui-filter]')) button.addEventListener('click', () => {
  if (busy) return; $('group-filter').value = ''; $('saved-view').value = '';
  document.querySelector(`.filter[data-filter="${button.dataset.uiFilter}"]`).click(); $('app').dataset.scene = 'list'; setWorkbenchNav(false);
});
$('ui-reset-filters').addEventListener('click', () => {
  if (busy) return; $('search').value = ''; $('search-body').checked = false; $('group-filter').value = ''; $('tag-filter').value = ''; $('notes-filter').value = 'all'; $('saved-view').value = ''; filter = 'all';
  document.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
  queueSearch(); renderList(); renderViewStatus(); updateControls();
});
$('ui-batch-close').addEventListener('click', () => { if (!busy) { batchSelection.clear(); renderList(); } });
$('ui-receipt-close').addEventListener('click', () => { $('deletion-result').hidden = true; });
$('ui-nav-toggle').addEventListener('click', () => setWorkbenchNav(!uiNavOpen));
for (const id of ['ui-nav-close', 'ui-nav-scrim']) $(id).addEventListener('click', () => { setWorkbenchNav(false); $('ui-nav-toggle').focus(); });
$('ui-back').addEventListener('click', () => { $('app').dataset.scene = 'list'; $('search').focus(); });
document.addEventListener('click', event => {
  if (event.target.closest('#ui-sidebar button') && !event.target.closest('#ui-nav-close')) setWorkbenchNav(false);
  if (!event.target.closest('#ui-more-menu')) $('ui-more-menu').open = false;
  if (!event.target.closest('#ui-filter-details')) $('ui-filter-details').open = false;
}, true);
$('saved-view').addEventListener('change', () => { $('app').dataset.scene = 'list'; setWorkbenchNav(false); });
document.querySelector('.detail-tabs').addEventListener('keydown', event => {
  if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const tabs = [...document.querySelectorAll('[data-ui-panel]')]; const index = tabs.indexOf(event.target);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
});
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { $('ui-more-menu').open = false; $('ui-filter-details').open = false; if (uiNavOpen) { setWorkbenchNav(false); $('ui-nav-toggle').focus(); } }
  if (uiNavOpen && event.key === 'Tab') {
    const buttons = [...$('ui-sidebar').querySelectorAll('button:not([disabled]), select:not([disabled]), summary')].filter(node => node.getClientRects().length);
    if (event.shiftKey && event.target === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && event.target === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }
  if (!busy && !uiNavOpen && event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('input, textarea, select')) { event.preventDefault(); $('app').dataset.scene = 'list'; $('search').focus(); }
});
window.addEventListener('resize', () => { if (uiNavOpen && !matchMedia('(max-width:1060px)').matches) setWorkbenchNav(false); });
operation(async () => applySnapshot(await api('/api/skills')));
