import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { SettingsManager, DefaultPackageManager, loadSkills, parseFrontmatter, lockfile, piVersion, yaml, structuredPatch } from './pi-adapter.mjs';
import { collectFiles, encodeZip, decodeZip, validateFiles, skillText, readBounded } from './bundles.mjs';
import { AppError } from './errors.mjs';
import { listDeleted, restoreDeleted } from './recycle.mjs';
import { previewPurge, publicPurge, purgeDeleted } from './purge.mjs';
import { listAttachments, readAttachment } from './attachments.mjs';
import { explainLoading } from './loading-diagnostics.mjs';
import { exportOrganization, planOrganizationImport, validateViews, validateFilters, validViewId, MAX_VIEWS } from './organization-store.mjs';
export { AppError } from './errors.mjs';

function renameContent(content, name) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new AppError('新名称需为小写英文、数字和单个连接符，最多 64 字符。');
  validateSkill(content);
  const match = /^\uFEFF?---[^\S\r\n]*(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?=\r\n|\n|\r|$)/.exec(content);
  if (!match) throw new AppError('需要完整 YAML 头部。');
  const doc = yaml.parseDocument(match[1]);
  const value = doc.contents?.items?.find((item) => item.key?.value === 'name')?.value;
  if (doc.errors.length || !(yaml.isScalar(value) || yaml.isAlias(value)) || !value.range) throw new AppError('无法安全替换 YAML name，请先将 name 改成普通文本值。');
  const [start, end] = value.range;
  const old = match[1].slice(start, end);
  const ending = old.match(/(?:\r\n|\n|\r)$/)?.[0] || '';
  const header = match[1].slice(0, start) + name + ending + match[1].slice(end);
  const offset = match[0].indexOf(match[1], match[0].indexOf('---') + 3);
  const result = content.slice(0, offset) + header + content.slice(offset + match[1].length);
  validateSkill(result);
  return result;
}
export const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const readOptional = (file) => {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const revision = (value) => hash(value === undefined ? '\0missing' : value);
const label = (value, max = 60) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const plainMap = (value) => value && typeof value === 'object' && !Array.isArray(value);
const validNote = value => typeof value === 'string' && value.length <= 10000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const backupName = (name) => typeof name === 'string' && /^[\dT.Z_-]+_[a-f0-9-]+\.bak$/.test(name);
function parseSettings(raw) {
  try {
    const settings = raw === undefined ? {} : JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
    if (settings.skills && typeof settings.skills === 'object' && !Array.isArray(settings.skills)) {
      // Reuse Pi's migration only for Skill fields; do not rewrite unrelated legacy settings.
      const migrated = SettingsManager.inMemory({ skills: settings.skills, enableSkillCommands: settings.enableSkillCommands }).getGlobalSettings();
      if (migrated.skills === undefined) delete settings.skills;
      else settings.skills = migrated.skills;
      if (settings.enableSkillCommands === undefined && migrated.enableSkillCommands !== undefined) settings.enableSkillCommands = migrated.enableSkillCommands;
    }
    for (const field of ['skills', 'packages']) {
      if (settings[field] !== undefined && !Array.isArray(settings[field])) throw new Error(`${field} must be an array`);
    }
    if (settings.skills?.some((entry) => typeof entry !== 'string')) throw new Error('skills must contain strings');
    return settings;
  } catch (error) { throw new AppError(`Pi 配置无法解析，未作修改：${error.message}`, 409); }
}
export function validateSkill(content, fallbackName) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new AppError('正文必须是文本，且不能超过 1 MiB。');
  let frontmatter;
  try { ({ frontmatter } = parseFrontmatter(content)); }
  catch (error) { throw new AppError(`YAML 格式有误：${error.message}`); }
  const name = frontmatter.name || fallbackName;
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new AppError('name 需为小写英文、数字和单个连接符，最多 64 字符。');
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim() || frontmatter.description.length > 1024) throw new AppError('description 必须是非空文本，最多 1024 字符。');
  if (frontmatter['disable-model-invocation'] !== undefined && typeof frontmatter['disable-model-invocation'] !== 'boolean') throw new AppError('disable-model-invocation 必须是 true 或 false。');
  return frontmatter;
}
function absolutePattern(value, base) {
  const expanded = value.startsWith('~/') || value.startsWith('~\\') ? path.join(os.homedir(), value.slice(2)) : value;
  return key(path.resolve(base, expanded));
}
function togglePatterns(patterns, target, base, enabled, packageResource = false) {
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) throw new AppError('现有 Skill 过滤配置不是字符串数组，未作修改。', 409);
  // A package skills:[] means NONE; adding only +path would otherwise enable ALL.
  if (packageResource && patterns.length === 0) return enabled ? [path.relative(base, target).replaceAll('\\', '/')] : [];
  const targets = new Set([key(target)]);
  // Pi treats an exact skill directory and its SKILL.md as the same exclusion.
  if (path.basename(target) === 'SKILL.md') targets.add(key(path.dirname(target)));
  const rest = patterns.filter((p) => !(['+', '-'].includes(p[0]) && targets.has(absolutePattern(p.slice(1), base))));
  const entry = packageResource ? path.relative(base, target).replaceAll('\\', '/') : target.replaceAll('\\', '/');
  return [...rest, `${enabled ? '+' : '-'}${entry}`];
}

export class SkillManager {
  constructor({ agentDir, cwd = process.cwd(), project = false, backupDir } = {}) {
    this.agentDir = path.resolve(agentDir);
    this.cwd = path.resolve(cwd);
    this.project = project;
    this.backupDir = backupDir || path.join(this.agentDir, 'skill-manager-backups');
    this.rows = new Map();
    this.preferencesPath = path.join(this.agentDir, 'skill-manager.json');
    this.globalCreateRoot = path.resolve(process.env.HOME || os.homedir(), '.agents/skills');
  }
  creationRoots() {
    return { global: this.globalCreateRoot, project: this.project ? path.join(this.cwd, '.pi/skills') : null };
  }
  settingsPath(scope) { return scope === 'project' ? path.join(this.cwd, '.pi/settings.json') : path.join(this.agentDir, 'settings.json'); }
  standardRoots() { return [...new Set([this.globalCreateRoot, path.join(this.agentDir, 'skills'), ...(this.project ? [path.join(this.cwd, '.pi/skills')] : [])])]; }
  async list() {
    const globalRaw = readOptional(this.settingsPath('global'));
    parseSettings(globalRaw);
    const projectRaw = this.project ? readOptional(this.settingsPath('project')) : undefined;
    if (this.project) parseSettings(projectRaw);
    const settingsManager = SettingsManager.create(this.cwd, this.agentDir, { projectTrusted: this.project });
    const errors = settingsManager.drainErrors();
    if (errors.length) throw new AppError(`读取 Pi 配置失败：${errors.map((e) => e.error.message).join('; ')}`, 409);
    const packageManager = new DefaultPackageManager({ cwd: this.cwd, agentDir: this.agentDir, settingsManager });
    const missing = [];
    // Only resolve existing resources. Never install packages or execute extensions.
    const resolved = await packageManager.resolve(async (source) => { missing.push(source); return 'skip'; });
    this.protectedPackageRoots = resolved.skills.filter((r) => r.metadata.origin === 'package').map((r) => r.metadata.packageRoot || r.metadata.baseDir).filter(Boolean).map((root) => key(fs.realpathSync(root)));
    const enabledPaths = resolved.skills.filter((r) => r.enabled).map((r) => r.path);
    const effective = loadSkills({ cwd: this.cwd, agentDir: this.agentDir, skillPaths: enabledPaths, includeDefaults: false });
    const winners = new Set(effective.skills.map((s) => key(fs.realpathSync(s.filePath))));
    const diagnostics = [...effective.diagnostics];
    const rows = [];
    const seen = new Set();
    for (const resource of resolved.skills) {
      const single = loadSkills({ cwd: this.cwd, agentDir: this.agentDir, skillPaths: [resource.path], includeDefaults: false });
      diagnostics.push(...single.diagnostics);
      let files = single.skills.map((s) => ({ skill: s, file: s.filePath }));
      if (!files.length) {
        const isDirectory = fs.statSync(resource.path).isDirectory();
        const file = isDirectory ? path.join(resource.path, 'SKILL.md') : resource.path;
        files = [{ skill: null, file }];
      }
      for (const { skill, file } of files) {
        if (!fs.existsSync(file)) continue;
        const real = fs.realpathSync(file);
        const id = hash(key(real));
        if (seen.has(id)) continue;
        seen.add(id);
        const scope = resource.metadata.scope === 'project' ? 'project' : 'global';
        const stat = fs.statSync(real);
        const row = {
          modifiedAt: stat.mtimeMs, addedAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs,
          contentRevision: stat.size <= 1024 * 1024 ? hash(readBounded(real, 1024 * 1024)) : null,
          id, name: skill?.name || path.basename(path.dirname(file)), description: skill?.description || '',
          path: file, source: resource.metadata.source, scope, package: resource.metadata.origin === 'package',
          enabled: resource.enabled, valid: Boolean(skill), effective: Boolean(skill && resource.enabled && winners.has(key(real))),
          manualOnly: skill?.disableModelInvocation || false,
          configRevision: revision(scope === 'global' ? globalRaw : projectRaw),
          _resource: resource, _real: real,
        };
        rows.push(row);
      }
    }
    this.loadingContext = { settings: { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings() }, effective: effective.skills, diagnostics, commandEnabled: settingsManager.getEnableSkillCommands() };
    let preferences = { favorites: [], organization: {}, added: {}, notes: {}, views: [], raw: undefined };
    let preferencesError = null;
    try { preferences = this.preferences(); }
    catch (error) { preferencesError = error.message; diagnostics.push({ path: this.preferencesPath, message: error.message }); }
    for (const row of rows) {
      row.favorite = preferences.favorites.includes(row.id);
      row.group = preferences.organization[row.id]?.group || '';
      row.tags = preferences.organization[row.id]?.tags || [];
      row.note = preferences.notes[row.id] || '';
      row.addedAt = preferences.added[row.id] || row.addedAt;
    }
    this.rows = new Map(rows.map((r) => [r.id, r]));
    return {
      skills: rows.map(({ _resource, _real, ...row }) => ({ ...row, deletion: this.deletionInfo(this.rows.get(row.id)) })), 
      diagnostics: [...new Map(diagnostics.map((d) => [`${d.path}|${d.message}`, { path: d.path, message: d.message }])).values()],
      missing, piVersion, cwd: this.cwd, project: this.project, agentDir: this.agentDir, creationRoots: this.creationRoots(),
      preferencesRevision: revision(preferences.raw), preferencesError, views: preferences.views,
      organizationGroups: [...new Set(Object.values(preferences.organization).map(item => item.group).filter(name => typeof name === 'string' && name.trim()))].sort(),
    };
  }
  async create(content, scope = 'global', companions = []) {
    if (scope !== 'global' && scope !== 'project') throw new AppError('无效创建范围。');
    const root = this.creationRoots()[scope];
    if (!root) throw new AppError('当前未打开项目视图，不能创建项目 Skill。');
    if (typeof content !== 'string' || !/^\uFEFF?---(?:\r\n|\r|\n)/.test(content)) throw new AppError('请粘贴完整 SKILL.md，从 --- 开始，包含 name 和 description；不要包含外围 Markdown 代码围栏。');
    const frontmatter = validateSkill(content);
    const name = frontmatter.name;
    const files = validateFiles([{ path: 'SKILL.md', data: Buffer.from(content) }, ...companions]);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new AppError('此名称是 Windows 保留文件名，请换一个名称。');
    const before = await this.list();
    if (before.skills.some((s) => s.name === name)) throw new AppError(`已存在名为 ${name} 的 Skill（包括已关闭的），请换一个 name，不会覆盖原文件。`, 409);
    fs.mkdirSync(root, { recursive: true });
    const directory = path.join(root, name);
    try { fs.mkdirSync(directory); }
    catch (error) {
      if (error.code === 'EEXIST') throw new AppError(`目录 ${directory} 已存在，不会覆盖，请换一个 name。`, 409);
      throw error;
    }
    const file = path.join(directory, 'SKILL.md');
    const staged = path.join(directory, `.create-${randomUUID()}.tmp`);
    let published = false;
    let cleanupWarning = null;
    const owned = new Map();
    const directories = [directory];
    const writeNew = (target, data) => {
      const fd = fs.openSync(target, 'wx', 0o600);
      try { owned.set(target, fs.fstatSync(fd)); fs.writeFileSync(fd, data); }
      finally { fs.closeSync(fd); }
    };
    const mkdir = (relative) => {
      let current = directory;
      for (const segment of relative.split('/').filter(Boolean)) {
        current = path.join(current, segment);
        if (directories.includes(current)) continue;
        fs.mkdirSync(current); // exclusive, never enter a foreign directory/link
        directories.push(current);
      }
    };
    const removeOwned = (target) => {
      const expected = owned.get(target);
      let actual;
      try { actual = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('文件已被外部替换，保留并请手动检查');
      fs.unlinkSync(target);
    };
    try {
      writeNew(staged, content);
      for (const companion of files.filter((item) => item.path !== 'SKILL.md')) {
        if (companion.data === null) mkdir(companion.path);
        else {
          mkdir(companion.path.split('/').slice(0, -1).join('/'));
          writeNew(path.join(directory, ...companion.path.split('/')), companion.data);
        }
      }
      // Publish SKILL.md last: companion files are present before Pi can discover it.
      fs.linkSync(staged, file);
      published = true;
    } catch (error) {
      if (error.code === 'EEXIST') throw new AppError('创建期间出现了同名文件，没有覆盖，请检查目录。', 409);
      throw error;
    } finally {
      for (const target of owned.keys()) {
        if (published && target !== staged) continue;
        try { removeOwned(target); }
        catch (error) { cleanupWarning = `${target === staged ? '临时文件清理失败' : '创建未完成，清理失败'}，请自行检查 ${target}：${error.message}`; console.error(cleanupWarning); }
      }
      if (!published) {
        for (const dir of directories.toReversed()) {
          try { fs.rmdirSync(dir); }
          catch (error) { console.error(`创建未完成，目录中可能有其他文件，请自行检查 ${dir}：${error.message}`); }
        }
      }
    }
    // Creation is already published; preference failure must never invite a retry.
    let metadataWarning;
    try { metadataWarning = this.rememberAdded(hash(key(fs.realpathSync(file))), Date.now()); }
    catch (e) { metadataWarning = `文件已创建，但添加时间未记录：${e.message}`; }
    cleanupWarning = [cleanupWarning, metadataWarning].filter(Boolean).join(' ') || null;
    // A refresh failure must not turn a successful creation into an invitation to overwrite/retry.
    try {
      const snapshot = await this.list();
      const item = snapshot.skills.find((s) => key(s.path) === key(file));
      let warning = cleanupWarning;
      if (!item) warning = [warning, '文件已创建，但被现有发现/忽略规则排除，列表中暂不可见。'].filter(Boolean).join(' ');
      else if (!item.enabled || !item.effective) warning = [warning, '文件已创建，但现有关闭或同名过滤规则使其未生效；请在列表检查状态。'].filter(Boolean).join(' ');
      return { created: true, path: file, snapshot, item: item || null, detail: item ? await this.detail(item.id) : null, warning };
    } catch (error) {
      return { created: true, path: file, snapshot: null, item: null, detail: null, warning: [cleanupWarning, `文件已创建，但刷新失败，请勿重复创建：${error.message}`].filter(Boolean).join(' ') };
    }
  }
  preferences() {
    const raw = readOptional(this.preferencesPath);
    try {
      const value = raw === undefined ? { version: 1, favorites: [] } : JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.favorites) || value.favorites.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid favorites');
      const organization = value.organization ?? {};
      const added = value.added ?? {};
      const notes = value.notes ?? {};
      if (!plainMap(organization) || !plainMap(added) || !plainMap(notes)) throw new Error('invalid preferences');
      for (const [id, item] of Object.entries(organization)) {
        if (!/^[a-f0-9]{64}$/.test(id) || !plainMap(item) || !label(item.group ?? '') || !Array.isArray(item.tags ?? []) || (item.tags || []).length > 20 || (item.tags || []).some((tag) => !label(tag, 32) || !tag.trim())) throw new Error('invalid labels');
      }
      if (Object.entries(added).some(([id, time]) => !/^[a-f0-9]{64}$/.test(id) || !Number.isFinite(time) || time <= 0)) throw new Error('invalid added time');
      if (Object.entries(notes).some(([id, note]) => !/^[a-f0-9]{64}$/.test(id) || !validNote(note))) throw new Error('invalid notes');
      const views = validateViews(value.views ?? []);
      return { ...value, favorites: [...new Set(value.favorites)], organization, added, notes, views, raw };
    } catch { throw new AppError('收藏配置（含分组／标签）无法解析，未覆盖；请检查 skill-manager.json。', 409); }
  }
  async favorite(id, favorite) {
    if (typeof favorite !== 'boolean') throw new AppError('favorite 必须是布尔值。');
    await this.row(id);
    const preferences = this.preferences();
    this.writeLocked(this.preferencesPath, revision(preferences.raw), () => {
      const { raw: _raw, ...value } = preferences;
      const favorites = new Set(value.favorites);
      if (favorite) favorites.add(id); else favorites.delete(id);
      return JSON.stringify({ ...value, favorites: [...favorites] }, null, 2) + '\n';
    });
    return { snapshot: await this.list() };
  }
  rememberAdded(id, time) {
    try {
      const preferences = this.preferences();
      if (preferences.added[id]) return null;
      this.writeLocked(this.preferencesPath, revision(preferences.raw), () => {
        const { raw: _raw, ...value } = preferences;
        return JSON.stringify({ ...value, added: { ...value.added, [id]: time } }, null, 2) + '\n';
      });
      return null;
    } catch (e) { return `文件操作已完成，但添加时间未记录：${e.message}`; }
  }
  async organize(id, group, tags, expected) {
    await this.row(id);
    if (!label(group) || !Array.isArray(tags) || tags.length > 20 || tags.some((tag) => !label(tag, 32) || !tag.trim())) throw new AppError('分组最多 60 字符，标签最多 20 个，每个 32 字符，不含控制字符。');
    const preferences = this.preferences();
    this.writeLocked(this.preferencesPath, expected, () => {
      const { raw: _raw, ...value } = preferences;
      return JSON.stringify({ ...value, organization: { ...value.organization, [id]: { ...value.organization[id], group: group.trim(), tags: [...new Set(tags.map((tag) => tag.trim()))] } } }, null, 2) + '\n';
    });
    return { snapshot: await this.list() };
  }
  async savePreferences(expected, preferences, extra = {}, storedValue) {
    const { raw, ...value } = preferences;
    if (typeof expected !== 'string' || revision(raw) !== expected) throw new AppError('整理偏好已被其他窗口修改，请刷新后再保存。', 409);
    const next = JSON.stringify(storedValue ?? value, null, 2) + '\n';
    if (Buffer.byteLength(next) > 2 * 1024 * 1024) throw new AppError('管理器偏好超过 2 MiB，未保存，请减少备注或记录。');
    let warning = null;
    try { this.writeLocked(this.preferencesPath, expected, () => next); }
    catch (e) {
      if (readOptional(this.preferencesPath) !== next) throw e;
      warning = `偏好已保存，但后续清理失败：${e.message}`;
    }
    let snapshot = null;
    try { snapshot = await this.list(); } catch (e) { warning = [warning, `偏好已保存，但刷新失败：${e.message}，请手动刷新，不要重复提交。`].filter(Boolean).join(' '); }
    return { saved: true, ...extra, snapshot, warning };
  }
  async loadingDiagnostics(id) {
    const row = await this.row(id);
    return explainLoading(row, this.loadingContext, this.cwd, this.agentDir, this.project);
  }
  async organizationExport() {
    await this.list(); return exportOrganization(this.preferences(), [...this.rows.values()]);
  }
  async organizationPreview(document, mode) {
    const snapshot = await this.list(); const preferences = this.preferences();
    return planOrganizationImport(document, mode, preferences, snapshot.skills, revision(preferences.raw)).public;
  }
  async organizationImport(document, mode, token) {
    const snapshot = await this.list(); const preferences = this.preferences();
    const plan = planOrganizationImport(document, mode, preferences, snapshot.skills, revision(preferences.raw));
    if (typeof token !== 'string' || plan.public.token !== token) throw new AppError('整理信息／目标已改变，请重新预览后确认；未保存。', 409);
    if (!plan.public.changed) throw new AppError('预览没有可保存的变更。');
    return this.savePreferences(plan.public.preferencesRevision, { ...plan.next, raw: preferences.raw }, { count: plan.public.changed });
  }
  async saveView(id, name, filters, expected) {
    if (id !== null && !validViewId(id)) throw new AppError('视图 ID 无效。');
    if (!label(name) || !name.trim()) throw new AppError('视图名称不能为空，最多 60 字符。');
    const normalized = validateFilters(filters); const preferences = this.preferences();
    const views = [...preferences.views]; const index = id === null ? -1 : views.findIndex(v => v.id === id);
    if (id !== null && index < 0) throw new AppError('视图已不存在，请刷新。', 409);
    if (views.some(v => v.id !== id && v.name === name.trim())) throw new AppError('已有同名视图，不会覆盖；请另起名称或明确更新所选视图。', 409);
    if (index < 0 && views.length >= MAX_VIEWS) throw new AppError('常用视图最多 30 个。');
    const view = { ...(index >= 0 ? views[index] : {}), id: id ?? randomUUID(), name: name.trim(), filters: { ...(index >= 0 ? views[index].filters : {}), ...normalized } };
    if (index < 0) views.push(view); else views[index] = view;
    return this.savePreferences(expected, { ...preferences, views }, { viewId: view.id });
  }
  async renameGroup(from, name, expected) {
    if (!label(from) || !from.trim() || !label(name) || !name.trim()) throw new AppError('分组名称不能为空，最多 60 字符，不含控制字符。');
    const to = name.trim();
    if (from === to) throw new AppError('名称没有变化，未保存。');
    const preferences = this.preferences();
    const entries = Object.entries(preferences.organization);
    if (!entries.some(([, item]) => item.group === from)) throw new AppError('原分组已不存在，请刷新后重选；未保存。', 409);
    if (entries.some(([, item]) => item.group === to) || preferences.views.some(view => view.filters.group === `g:${to}`)) throw new AppError('已有同名分组或视图引用该名称，不会合并或覆盖；请换一个名称。', 409);
    // Use the original stored shape: even optional fields and duplicate favorite
    // entries must stay intact. Only exact group labels/references are changed.
    let value;
    try { value = JSON.parse(preferences.raw); }
    catch { throw new AppError('整理偏好无法解析，未保存。', 409); }
    let count = 0; let viewCount = 0;
    value.organization = { ...value.organization };
    for (const [id, item] of entries) if (item.group === from) { value.organization[id] = { ...item, group: to }; count++; }
    if (value.views) value.views = value.views.map(view => {
      if (view.filters.group !== `g:${from}`) return view;
      viewCount++; return { ...view, filters: { ...view.filters, group: `g:${to}` } };
    });
    return this.savePreferences(expected, preferences, { from, to, count, viewCount }, value);
  }
  async deleteView(id, expected) {
    if (!validViewId(id)) throw new AppError('视图 ID 无效。');
    const preferences = this.preferences();
    if (!preferences.views.some(v => v.id === id)) throw new AppError('视图已不存在，请刷新。', 409);
    return this.savePreferences(expected, { ...preferences, views: preferences.views.filter(v => v.id !== id) });
  }
  async note(id, text, expected) {
    await this.row(id);
    if (!validNote(text)) throw new AppError('备注最多 10000 字符，允许换行和 Tab，不含其他控制字符。');
    const preferences = this.preferences();
    preferences.notes = { ...preferences.notes };
    if (text) preferences.notes[id] = text; else delete preferences.notes[id];
    return this.savePreferences(expected, preferences);
  }
  async batchOrganize(ids, { groupMode, group, tagMode, tags, preferencesRevision } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new AppError('请选择 1–100 个不同的 Skill。');
    if (!['keep', 'set'].includes(groupMode) || !['keep', 'replace', 'add', 'remove'].includes(tagMode) || (groupMode === 'keep' && tagMode === 'keep')) throw new AppError('请选择要修改的分组或标签方式。');
    if (!label(group) || !Array.isArray(tags) || tags.length > 20 || tags.some(tag => !label(tag, 32) || !tag.trim())) throw new AppError('分组最多 60 字符，标签最多 20 个，每个 32 字符。');
    await this.list();
    if (ids.some(id => !this.rows.has(id))) throw new AppError('所选 Skill 已不存在，请刷新后重选；未保存。', 409);
    const preferences = this.preferences(); preferences.organization = { ...preferences.organization };
    const requested = [...new Set(tags.map(tag => tag.trim()))];
    for (const id of ids) {
      const old = preferences.organization[id] || {};
      let nextTags = [...new Set(old.tags || [])];
      if (tagMode === 'replace') nextTags = requested;
      if (tagMode === 'add') nextTags = [...new Set([...nextTags, ...requested])];
      if (tagMode === 'remove') nextTags = nextTags.filter(tag => !requested.includes(tag));
      if (nextTags.length > 20) throw new AppError('追加后有 Skill 的标签超过 20 个，整批未保存。');
      preferences.organization[id] = { ...old, group: groupMode === 'set' ? group.trim() : old.group || '', tags: nextTags };
    }
    return this.savePreferences(preferencesRevision, preferences, { count: ids.length });
  }
  async attachments(id) { return listAttachments((await this.row(id)).path); }
  async attachment(id, relative, expected) { return readAttachment((await this.row(id)).path, relative, expected); }
  async search(query) {
    if (typeof query !== 'string' || query.length > 200) throw new AppError('搜索文字最多 200 字符。');
    await this.list();
    const needle = query.trim().toLowerCase();
    const hits = [];
    const skipped = [];
    let bytes = 0;
    if (needle) for (const row of this.rows.values()) {
      try {
        const stat = fs.statSync(row._real);
        if (stat.size > 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) { skipped.push(row.name); continue; }
        const data = readBounded(row._real, 1024 * 1024);
        if (bytes + data.length > 32 * 1024 * 1024) { skipped.push(row.name); continue; }
        bytes += data.length;
        const content = data.toString('utf8');
        const at = content.toLowerCase().indexOf(needle);
        if (at >= 0) hits.push({ id: row.id, excerpt: content.slice(Math.max(0, at - 50), at + needle.length + 80) });
      } catch { skipped.push(row.name); }
    }
    return { hits, skipped, query, warning: skipped.length ? `${skipped.length} 个正文过大、读取失败或超过本次 32 MiB 搜索预算，未检索；名称搜索仍可用。` : null };
  }
  async deleted() {
    await this.list();
    return listDeleted(this.standardRoots(), [...this.rows.values()], this.protectedPackageRoots);
  }
  async purgePreview() { return publicPurge(previewPurge(this.standardRoots())); }
  async purgeTrash(token, confirmation) { return purgeDeleted(this.standardRoots(), token, confirmation, lockfile); }
  async purgeOnePreview(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new AppError('无效单条归档标识。');
    return publicPurge(previewPurge(this.standardRoots(), id));
  }
  async purgeOne(id, token, confirmation) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new AppError('无效单条归档标识。');
    return purgeDeleted(this.standardRoots(), token, confirmation, lockfile, id);
  }
  async undelete(id, token) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new AppError('无效回收站标识。');
    const trash = await this.deleted();
    const item = trash.items.find((entry) => entry.id === id);
    if (!item) throw new AppError('备份已不存在或不在当前回收站范围内。', 404);
    if (token !== item.token) throw new AppError('备份已改变，请刷新回收站后再恢复。', 409);
    const result = restoreDeleted(item, lockfile);
    try {
      result.snapshot = await this.list();
      const file = item.directorySkill ? path.join(item.originalPath, 'SKILL.md') : item.originalPath;
      result.item = result.snapshot.skills.find((row) => key(row.path) === key(file)) || null;
      result.detail = result.item ? await this.detail(result.item.id) : null;
      if (!result.item || !result.item.enabled || !result.item.effective) result.warning = [result.warning, '文件已恢复，但原过滤／关闭／同名规则可能使其未生效，请检查列表。'].filter(Boolean).join(' ');
    } catch (e) { result.snapshot = null; result.warning = [result.warning, `文件已恢复，但刷新失败，请勿重复恢复：${e.message}`].filter(Boolean).join(' '); }
    return result;
  }
  async exportSelected(items) {
    if (!Array.isArray(items) || !items.length || items.length > 50) throw new AppError('请选中 1–50 个 Skill。');
    await this.list();
    const files = [];
    const manifest = [];
    const seen = new Set();
    let bytes = 0;
    for (const [index, item] of items.entries()) {
      const row = this.rows.get(item?.id);
      if (!row || seen.has(row.id)) throw new AppError('所选标识无效、重复或已不存在。', 409);
      seen.add(row.id);
      if (!row.contentRevision || item.revision !== row.contentRevision) throw new AppError('所选正文已改变或超过 1 MiB，请刷新后重选；大文件可单独导出。', 409);
      const collected = collectFiles(row.path);
      if (hash(collected.find((file) => file.path === 'SKILL.md').data) !== item.revision) throw new AppError('读取期间正文改变，请刷新后重选。', 409);
      const directory = `${String(index + 1).padStart(3, '0')}-${row.valid ? row.name : 'skill-backup'}`;
      files.push({ path: directory, data: null });
      for (const file of collected) {
        bytes += file.data?.length || 0;
        if (bytes > 50 * 1024 * 1024 || files.length >= 999) throw new AppError('整个批量备份最多 50 MiB、1000 个文件／目录（含清单）。');
        files.push({ ...file, path: `${directory}/${file.path}` });
      }
      manifest.push({ directory, name: row.name, scope: row.scope, standalone: path.basename(row.path) !== 'SKILL.md' });
    }
    files.push({ path: 'skill-manager-bundle.json', data: Buffer.from(JSON.stringify({ format: 'pi-skill-manager-bundle', version: 1, at: new Date().toISOString(), items: manifest }, null, 2)) });
    return { data: await encodeZip(files, false), name: 'skills-backup.zip' };
  }
  async exportZip(id) {
    const row = await this.row(id);
    // Use the discovered spelling to reject a linked root rather than following it.
    if (fs.lstatSync(row.path).isSymbolicLink()) throw new AppError('请先把链接 Skill 复制成普通目录，再打包。');
    return { data: await encodeZip(collectFiles(row.path)), name: `${row.valid ? row.name : 'skill-backup'}.zip` };
  }
  async duplicate(id, name, scope = 'global', expected) {
    const row = await this.row(id);
    const files = collectFiles(row.path);
    const original = skillText(files);
    if (revision(original) !== expected) throw new AppError('文件已被其他窗口或程序修改，请刷新后再复制。', 409);
    const content = renameContent(original, name);
    return this.create(content, scope, files.filter((file) => file.path !== 'SKILL.md'));
  }
  async importZip(buffer, scope = 'global', name = '') {
    const files = await decodeZip(buffer);
    let content = skillText(files);
    if (name) content = renameContent(content, name);
    return this.create(content, scope, files.filter((file) => file.path !== 'SKILL.md'));
  }
  async folder(id) {
    const row = await this.row(id);
    return path.dirname(row._real);
  }
  deletionInfo(row) {
    const denied = (reason) => ({ allowed: false, reason });
    if (row.package) return denied('扩展包 Skill 不提供删除，请使用关闭或包管理。');
    const within = (parent, child) => { const relative = path.relative(key(parent), key(child)); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
    try {
      if (key(row.path) !== key(row._real) || fs.lstatSync(row.path).isSymbolicLink()) return denied('链接 Skill 不提供删除，请在文件管理器中处理链接。');
      const directorySkill = path.basename(row.path) === 'SKILL.md';
      const target = directorySkill ? path.dirname(row.path) : row.path;
      const roots = this.standardRoots();
      const root = roots.find((candidate) => key(path.dirname(target)) === key(candidate));
      if (!root) return denied('仅支持标准个人／项目 Skill 目录中的直属 Skill；自定义路径请用文件夹手动管理。');
      if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(target).isSymbolicLink()) return denied('链接目录不提供删除。');
      if ((this.protectedPackageRoots || []).some((pkg) => within(pkg, target) || within(target, pkg))) return denied('此位置属于扩展包，不能删除。');
      if (directorySkill && [...this.rows.values()].some((other) => other.id !== row.id && within(target, other._real))) return denied('目录内还有其他已发现 Skill，不能整体删除。');
      const stat = fs.statSync(target);
      if (directorySkill ? !stat.isDirectory() : !stat.isFile()) return denied('只支持普通 Skill 文件或目录。');
      const archiveRoot = path.join(fs.realpathSync(path.dirname(root)), 'skill-manager-deleted');
      const token = hash(JSON.stringify({ target: key(target), real: key(row._real), dev: stat.dev, ino: stat.ino, mtime: stat.mtimeMs, directorySkill }));
      return { allowed: true, target, archiveRoot, directorySkill, token };
    } catch { return denied('无法确认文件范围，请刷新或手动管理。'); }
  }
  async delete(id, expected, confirmation, deleteToken) {
    const row = await this.row(id);
    const plan = this.deletionInfo(row);
    if (!plan.allowed) throw new AppError(plan.reason, 403);
    if (confirmation !== row.name) throw new AppError('请完整输入当前 Skill 名称确认删除。');
    if (deleteToken !== plan.token) throw new AppError('文件或目录已改变，请刷新后重新确认删除。', 409);
    let release;
    try { release = lockfile.lockSync(plan.target, { realpath: false }); }
    catch { throw new AppError('Skill 正在被其他程序操作，请稍后再试。', 409); }
    let container;
    let record;
    let recordStat;
    let archivedTo;
    let moved = false;
    let warning = null;
    try {
      if (plan.directorySkill && fs.existsSync(row._real + '.lock')) throw new AppError('Skill 文件正在被其他程序修改，请稍后再试。', 409);
      if (this.deletionInfo(row).token !== deleteToken || revision(fs.readFileSync(row._real, 'utf8')) !== expected) throw new AppError('文件已被其他窗口或程序修改，请刷新后再删除。', 409);
      fs.mkdirSync(plan.archiveRoot, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(plan.archiveRoot).isSymbolicLink() || key(fs.realpathSync(plan.archiveRoot)) !== key(plan.archiveRoot)) throw new AppError('已删除备份目录是链接或位置改变，未删除。', 409);
      container = path.join(plan.archiveRoot, randomUUID());
      fs.mkdirSync(container, { mode: 0o700 });
      archivedTo = path.join(container, path.basename(plan.target));
      record = path.join(container, 'deletion-record.json');
      // SKILL.md cannot have this name as its target; standalone files with this basename are refused.
      if (key(record) === key(archivedTo)) throw new AppError('备份文件名冲突，未删除。');
      const fd = fs.openSync(record, 'wx', 0o600);
      try {
        recordStat = fs.fstatSync(fd);
        fs.writeFileSync(fd, JSON.stringify({ version: 1, at: new Date().toISOString(), name: row.name, originalPath: plan.target, archivedTo, skillRevision: expected, directorySkill: plan.directorySkill }, null, 2) + '\n');
      } finally { fs.closeSync(fd); }
      if (fs.existsSync(archivedTo)) throw new AppError('备份位置已被其他程序占用，未删除。', 409);
      // Same-volume atomic move, including ALL attachments/hidden files; never recursively erase.
      fs.renameSync(plan.target, archivedTo);
      moved = true;
    } finally {
      if (!moved && container) {
        try {
          if (recordStat && fs.existsSync(record)) { const stat = fs.lstatSync(record); if (stat.isFile() && stat.ino === recordStat.ino && stat.dev === recordStat.dev) fs.unlinkSync(record); }
          fs.rmdirSync(container); // refuse removal if any foreign file is present
        } catch (error) { console.error(`删除未完成，保留备份暂存目录 ${container}：${error.message}`); }
      }
      try { release(); }
      catch (error) { if (!moved) console.error(error); else warning = `文件已移入备份，但锁清理失败：${error.message}`; }
    }
    let snapshot = null;
    try {
      snapshot = await this.list();
      if (snapshot.skills.some((item) => key(item.path) === key(path.join(archivedTo, 'SKILL.md')) || key(item.path) === key(archivedTo))) warning = [warning, '备份目录仍被自定义发现规则加载，请检查配置。'].filter(Boolean).join(' ');
    } catch (error) { warning = [warning, `文件已删除并保留备份，但刷新失败，请勿重复删除：${error.message}`].filter(Boolean).join(' '); }
    return { deleted: true, id, name: row.name, archivedTo, record, snapshot, warning };
  }
  applyToggle(settings, row, enabled) {
    const resource = row._resource;
    if (row.package) {
      const packages = settings.packages || [];
      const index = packages.findIndex((p) => (typeof p === 'string' ? p : p.source) === row.source);
      if (index === -1) throw new AppError('扩展包配置已改变，请刷新。', 409);
      const original = packages[index];
      const pkg = typeof original === 'string' ? { source: original } : { ...original };
      pkg.skills = togglePatterns(pkg.skills ?? ['**'], resource.path, resource.metadata.packageRoot || resource.metadata.baseDir, enabled, true);
      packages[index] = pkg;
      settings.packages = packages;
    } else {
      const base = resource.metadata.baseDir || (row.scope === 'global' ? this.agentDir : path.join(this.cwd, '.pi'));
      settings.skills = togglePatterns(settings.skills || [], resource.path, base, enabled);
    }
  }
  async batchToggle(items, enabled) {
    if (typeof enabled !== 'boolean' || !Array.isArray(items) || !items.length || items.length > 1000) throw new AppError('请选择 1–1000 个 Skill，并提供 enabled 布尔值。');
    await this.list();
    const groups = new Map();
    const seen = new Set();
    for (const item of items) {
      if (!item || seen.has(item.id)) throw new AppError('批量标识无效或重复。');
      seen.add(item.id);
      const row = this.rows.get(item.id);
      if (!row) throw new AppError('所选 Skill 已不存在，请刷新。', 409);
      if (row.configRevision !== item.configRevision) throw new AppError('文件已被其他窗口或程序修改，请刷新后再操作。', 409);
      if (!groups.has(row.scope)) groups.set(row.scope, []);
      groups.get(row.scope).push(row);
    }
    const backups = [];
    const processedIds = [];
    let warning = null;
    // One atomic write per settings file. Cross-scope writes are deliberately not a transaction.
    for (const [scope, rows] of groups) {
      try {
        const backup = this.writeLocked(this.settingsPath(scope), rows[0].configRevision, (raw) => {
          const settings = parseSettings(raw);
          const changes = rows.filter((row) => row.enabled !== enabled);
          if (!changes.length) return raw;
          for (const row of changes) this.applyToggle(settings, row, enabled);
          return JSON.stringify(settings, null, 2) + '\n';
        });
        backups.push({ scope, path: backup });
        processedIds.push(...rows.map((row) => row.id));
      } catch (error) {
        warning = `${scope === 'global' ? '全局' : '项目'}配置未确认完成：${error.message} 已确认处理 ${processedIds.length} 个，未确认 ${items.length - processedIds.length} 个。请刷新核对；不会自动重试或回滚其他范围。`;
        break;
      }
    }
    let snapshot = null;
    try {
      snapshot = await this.list();
      if (processedIds.some((id) => snapshot.skills.find((row) => row.id === id)?.enabled !== enabled)) warning = [warning, '配置已保存，但部分状态不符合预期，请检查过滤规则。'].filter(Boolean).join(' ');
    } catch (error) { warning = [warning, `配置操作已结束，但刷新失败：${error.message} 请勿盲目重复操作。`].filter(Boolean).join(' '); }
    return { snapshot, backups, processedIds, warning };
  }
  async row(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new AppError('无效的 Skill 标识。');
    const previous = this.rows.get(id);
    await this.list();
    const row = this.rows.get(id);
    if (!row) throw new AppError('Skill 已不存在或不再处于当前管理范围，请刷新。', 404);
    if (previous && key(previous._real) !== key(row._real)) throw new AppError('文件链接目标已改变，请刷新。', 409);
    return row;
  }
  backup(file, content) {
    const folder = path.join(this.backupDir, hash(key(file)));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replaceAll(':', '-')}_${randomUUID()}.bak`;
    const destination = path.join(folder, name);
    fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
    return destination;
  }
  writeLocked(file, expected, transform) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let release;
    try { release = lockfile.lockSync(file, { realpath: false }); }
    catch (error) { throw new AppError(`文件正被其他程序修改，请稍后再试：${error.message}`, 409); }
    let temp;
    try {
      const current = readOptional(file);
      if (revision(current) !== expected) throw new AppError('文件已被其他窗口或程序修改，请刷新后再操作。', 409);
      const next = transform(current);
      if (next === current) return null;
      const backup = current === undefined ? null : this.backup(file, current);
      const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
      temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, next, { flag: 'wx', mode });
      fs.renameSync(temp, file);
      return backup;
    } finally {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      release();
    }
  }
  async toggle(id, enabled, configRevision) {
    if (typeof enabled !== 'boolean') throw new AppError('enabled 必须是布尔值。');
    const row = await this.row(id);
    const target = this.settingsPath(row.scope);
    const backup = this.writeLocked(target, configRevision, (raw) => {
      const settings = parseSettings(raw);
      if (row.enabled === enabled) return raw;
      this.applyToggle(settings, row, enabled);
      return `${JSON.stringify(settings, null, 2)}\n`;
    });
    const snapshot = await this.list();
    const actual = snapshot.skills.find((s) => s.id === id);
    if (!actual || actual.enabled !== enabled) throw new AppError(`配置已保存但状态没有符合预期，请检查过滤规则。备份：${backup || '无原文件'}`, 409);
    return { snapshot, backup };
  }
  async detail(id) {
    const row = await this.row(id);
    const stat = fs.statSync(row._real);
    if (stat.size > 1024 * 1024) throw new AppError('文件超过 1 MiB，暂不支持网页编辑。');
    const content = readBounded(row._real, 1024 * 1024).toString('utf8');
    const folder = path.join(this.backupDir, hash(key(row._real)));
    const backups = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => /^[\dT.Z_-]+_[a-f0-9-]+\.bak$/.test(n)).sort().toReversed() : [];
    return { content, revision: revision(content), backups, backupDir: folder, deletion: this.deletionInfo(row) };
  }
  async save(id, content, expected) {
    const row = await this.row(id);
    validateSkill(content, path.basename(path.dirname(row.path)));
    const addedAt = this.preferencesTime(row);
    const backup = this.writeLocked(row._real, expected, () => content);
    const warning = this.rememberAdded(id, addedAt);
    return { backup, warning, detail: await this.detail(id), snapshot: await this.list() };
  }
  preferencesTime(row) {
    try { return this.preferences().added[row.id] || row.addedAt; } catch { return row.addedAt; }
  }
  readBackup(row, name) {
    if (!backupName(name)) throw new AppError('无效备份名称。');
    const folder = path.join(this.backupDir, hash(key(row._real)));
    const file = path.join(folder, name);
    if (!fs.existsSync(file)) throw new AppError('备份不存在。', 404);
    if (fs.lstatSync(folder).isSymbolicLink() || key(fs.realpathSync(folder)) !== key(folder) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new AppError('备份是链接、特殊文件或超过 1 MiB，拒绝读取。');
    return readBounded(file, 1024 * 1024).toString('utf8');
  }
  async compare(id, { content, revision: expected, backup } = {}) {
    const row = await this.row(id);
    const current = await this.detail(id);
    if (current.revision !== expected) throw new AppError('文件已被其他窗口或程序修改，请刷新后再对比。', 409);
    const oldText = backup === undefined ? current.content : this.readBackup(row, backup);
    const newText = backup === undefined ? content : current.content;
    if (typeof newText !== 'string' || Buffer.byteLength(newText) > 1024 * 1024) throw new AppError('对比正文必须是文本，且不能超过 1 MiB。');
    const normalize = (text) => text.replace(/\r\n?/g, '\n');
    const patch = structuredPatch(backup === undefined ? '当前已保存版本' : '所选历史备份', backup === undefined ? '编辑草稿' : '当前已保存版本', normalize(oldText), normalize(newText), undefined, undefined, { context: 3, timeout: 150, maxEditLength: 2000 });
    return { changed: oldText !== newText, newlineOnly: oldText !== newText && normalize(oldText) === normalize(newText), limited: !patch, patch: patch || null };
  }
  async restore(id, name, expected) {
    const row = await this.row(id);
    return this.save(id, this.readBackup(row, name), expected);
  }
}
