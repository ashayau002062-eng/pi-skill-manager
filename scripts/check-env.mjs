import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Entry-point checks only: no Skill discovery, configuration writes or installation.
export function checkNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new Error('需要 Node.js >=22.19，建议使用已验证的 Node.js 24 LTS。');
  }
}
export function checkPi(api) {
  const required = [api.SettingsManager?.create, api.SettingsManager?.inMemory, api.DefaultPackageManager?.prototype?.resolve, api.loadSkills, api.parseFrontmatter, api.lockfile?.lockSync, api.yaml?.parseDocument, api.structuredPatch];
  if (required.some(value => typeof value !== 'function')) throw new Error('Pi 内部接口或依赖不兼容；请使用已验证的 Pi 1.0.0，不自动修改安装。');
}
export async function checkEnvironment() {
  checkNode(process.versions.node);
  const api = await import('../pi-adapter.mjs');
  checkPi(api);
  const require = createRequire(import.meta.url);
  if (typeof require('yauzl').open !== 'function' || typeof require('yazl').ZipFile !== 'function') throw new Error('ZIP 依赖不完整，请在本项目运行 npm ci --ignore-scripts。');
  return { node: process.versions.node, pi: api.piVersion, testedPi: api.piVersion === '1.0.0' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkEnvironment();
    console.log(`环境入口检查通过：Node.js ${result.node}，Pi ${result.pi}。`);
    if (!result.testedPi) console.warn('该 Pi 版本未列入 v1.0.0 的验证基线；入口存在不保证行为兼容，升级后请先运行 npm test。');
  } catch (error) {
    console.error(`环境检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
