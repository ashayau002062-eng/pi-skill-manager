import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const name = '@earendil-works/pi-coding-agent';
const require = createRequire(import.meta.url);
function findPi() {
  const candidates = [process.env.PI_PACKAGE_DIR];
  try { candidates.push(path.dirname(require.resolve(`${name}/package.json`))); } catch {}
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm/node_modules', name));
  candidates.push(path.resolve(path.dirname(process.execPath), '../lib/node_modules', name));
  for (const root of candidates.filter(Boolean)) {
    if (fs.existsSync(path.join(root, 'dist/core/package-manager.js'))) return path.resolve(root);
  }
  throw new Error('找不到已安装的 Pi。请设置 PI_PACKAGE_DIR 为 pi-coding-agent 包目录。');
}
export const piRoot = findPi();
const load = (file) => import(pathToFileURL(path.join(piRoot, 'dist', file)).href);
export const { SettingsManager } = await load('core/settings-manager.js');
export const { DefaultPackageManager } = await load('core/package-manager.js');
export const { loadSkills } = await load('core/skills.js');
export const { parseFrontmatter } = await load('utils/frontmatter.js');
export const lockfile = createRequire(path.join(piRoot, 'package.json'))('proper-lockfile');
export const yaml = createRequire(path.join(piRoot, 'package.json'))('yaml');
// Reuse Pi's installed jsdiff (BSD-3-Clause), without bundling upstream source.
export const { structuredPatch } = createRequire(path.join(piRoot, 'package.json'))('diff');
function readPiVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json'), 'utf8')).version; }
  catch (error) { throw new Error('无法读取 Pi 的版本信息，请检查 PI_PACKAGE_DIR。', { cause: error }); }
}
export const piVersion = readPiVersion();
export const defaultAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'));
