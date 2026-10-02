import path from 'node:path';
import fs from 'node:fs';
import { DefaultPackageManager, SettingsManager } from './pi-adapter.mjs';
const canonical = file => { try { const p = fs.realpathSync(file); return process.platform === 'win32' ? p.toLowerCase() : p; } catch { return file; } };
// Use the installed resolver's filter methods, on a synthetic one-path manifest.
// No manifest traversal, package install, extension evaluation, or model session.
function filterEvidence(resource, settings, cwd, agentDir) {
  const scope = resource.metadata.scope === 'project' ? 'project' : 'global';
  const config = settings[scope]; const base = resource.metadata.packageRoot || resource.metadata.baseDir || (scope === 'project' ? path.join(cwd, '.pi') : agentDir);
  const entry = resource.metadata.origin === 'package' ? (config.packages || []).find(p => (typeof p === 'string' ? p : p.source) === resource.metadata.source) : null;
  const mode = resource.metadata.origin === 'package' ? (entry && typeof entry === 'object' && Array.isArray(entry.skills) ? (entry.autoload === false && scope === 'project' ? 'delta' : 'package') : 'manifest') : 'overrides';
  const allPatterns = mode === 'manifest' ? [] : mode === 'package' || mode === 'delta' ? entry.skills : config.skills || [];
  const indexed = allPatterns.map((pattern, index) => ({ pattern, index })).filter(item => mode !== 'overrides' || /^[!+-]/.test(item.pattern));
  const patterns = indexed.map(item => item.pattern);
  const evidence = { file: scope === 'project' ? path.join(cwd, '.pi/settings.json') : path.join(agentDir, 'settings.json'), scope, base, target: resource.path, source: resource.metadata.source, mode, rules: [], decisive: null, confirmed: mode === 'manifest', note: '' };
  if (resource.metadata.origin === 'package') {
    try {
      const identityProbe = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}) });
      if (typeof identityProbe.getPackageIdentity !== 'function') throw new Error('Pi 内部包身份接口不兼容');
      const packageScope = resource.metadata.scope === 'project' ? 'project' : 'user';
      const identity = identityProbe.getPackageIdentity(resource.metadata.source, packageScope);
      const entries = (config.packages || []).filter(p => identityProbe.getPackageIdentity(typeof p === 'string' ? p : p.source, packageScope) === identity);
      if (entries.length !== 1) {
        evidence.confirmed = false; evidence.mode = 'ambiguous-package';
        evidence.note = '当前作用域有重复包身份声明或无法唯一定位声明；仅显示原生开启状态，不确认具体过滤规则，避免把旧声明误当作生效来源。'; return evidence;
      }
    } catch (e) { evidence.confirmed = false; evidence.note = `无法确认包声明身份：${e.message}；不确认具体规则。`; return evidence; }
  }
  if (patterns.length > 200) { evidence.note = '当前过滤数组超过 200 条，未作逐条解释；不推断决定性规则，原生开启状态仍以当前解析结果为准。'; return evidence; }
  if (mode === 'manifest') { evidence.note = '未设置包 skills 过滤；使用扩展包 manifest／默认目录发现结果。'; return evidence; }
  try {
    const probe = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}) });
    if (typeof probe.applyPackageFilter !== 'function' || typeof probe.applyPackageDeltaFilter !== 'function') throw new Error('Pi 内部过滤接口不兼容');
    probe.collectManifestFiles = () => ({ allFiles: [resource.path], enabledByManifest: new Set([resource.path]) });
    for (const { index, pattern } of indexed) {
      const map = new Map(); probe.applyPackageDeltaFilter(base, [pattern], 'skills', map, resource.metadata);
      if (map.has(resource.path)) evidence.rules.push({ index, pattern, enabled: map.get(resource.path).enabled });
    }
    const result = new Map();
    if (mode === 'delta') probe.applyPackageDeltaFilter(base, patterns, 'skills', result, resource.metadata);
    else if (patterns.length) probe.applyPackageFilter(base, patterns, 'skills', result, resource.metadata);
    else result.set(resource.path, { enabled: mode !== 'package' });
    const predicted = result.get(resource.path)?.enabled;
    evidence.confirmed = predicted === resource.enabled;
    if (mode === 'delta') evidence.decisive = evidence.rules.at(-1)?.pattern || null;
    else evidence.decisive = evidence.rules.find(r => r.pattern.startsWith('-'))?.pattern || evidence.rules.find(r => r.pattern.startsWith('+'))?.pattern || evidence.rules.find(r => r.pattern.startsWith('!'))?.pattern || null;
    if (mode === 'package' && !patterns.length) evidence.note = '包 skills: [] 明确关闭该包全部 Skill。';
    else if (mode === 'package' && patterns.some(p => !/^[!+-]/.test(p)) && !evidence.rules.length) evidence.note = '不在包 skills 普通包含规则的匹配范围。';
    if (!evidence.confirmed) evidence.note += ' 以下仅为配置匹配证据，与原生最终状态不完全一致，不推断决定性规则。';
  } catch (e) { evidence.confirmed = false; evidence.note = `无法确认详细规则：${e.message}；原生开启状态仍以当前解析结果为准。`; }
  return evidence;
}
export function explainLoading(row, context, cwd, agentDir, project) {
  const evidence = filterEvidence(row._resource, context.settings, cwd, agentDir);
  const winner = context.effective.find(s => s.name === row.name);
  const shadowed = Boolean(row.valid && row.enabled && !row.effective && winner && canonical(winner.filePath) !== canonical(row.path));
  const messages = [];
  if (!row.valid) messages.push('原生 Skill 加载器未接受此文件，请查看下面的格式诊断；不把它假装成同名冲突。');
  if (!row.enabled) messages.push('原生资源解析结果为关闭，不会进入本次有效 Skill 集合。');
  if (shadowed) messages.push('已开启但与另一已开启文件同名；原生加载器保留了下面的首个有效文件。');
  if (row.effective) messages.push('已进入当前管理范围的原生有效 Skill 集合。');
  if (row.manualOnly && row.effective) messages.push('disable-model-invocation: true；不会在自动选择列表中出现，仍可手动输入 /skill:名称 调用。');
  if (context.commandEnabled === false) messages.push('enableSkillCommands: false 隐藏交互命令发现；手动输入 /skill:名称 仍可用，不等于 Skill 被关闭。');
  return { id: row.id, name: row.name, path: row.path, enabled: row.enabled, valid: row.valid, effective: row.effective, manualOnly: row.manualOnly, messages, winner: shadowed ? { name: winner.name, path: winner.filePath } : null, evidence, diagnostics: context.diagnostics.filter(d => canonical(d.path || '') === canonical(row.path)).map(d => ({ path: d.path, message: d.message })), warning: `这是${project ? '当前项目已信任视图' : '个人全局视图'}的当前配置解析，不是运行中 Pi 会话的遥测。未读取会话、信任凭证或命令行参数；实际 Pi 可能因 --no-skills、CLI 路径、项目信任、SDK 覆盖或尚未 /reload 而不同。管理器不会替你授予信任、修文件、改开关或安装缺包。` };
}
