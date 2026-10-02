import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNode, checkPi } from '../scripts/check-env.mjs';
const fn = () => {};
const api = () => ({ SettingsManager: { create: fn, inMemory: fn }, DefaultPackageManager: { prototype: { resolve: fn } }, loadSkills: fn, parseFrontmatter: fn, lockfile: { lockSync: fn }, yaml: { parseDocument: fn }, structuredPatch: fn });
test('环境检查接受最低 Node 与当前 LTS', () => { for (const v of ['22.19.0', '24.14.0', '26.0.0']) checkNode(v); });
test('旧 Node 或未知版本拒绝，不尝试安装', () => { for (const v of ['18.20.0', '22.18.9', 'garbage', '24.0.0-rc.1']) assert.throws(() => checkNode(v), /Node.js/); });
test('Pi 入口齐全通过，只检查能力而不调用它们', () => { const value = api(); value.loadSkills = () => { throw new Error('must not execute discovery'); }; checkPi(value); });
test('Pi SDK 入口或复用依赖缺失明确拒绝', () => { for (const key of Object.keys(api())) { const value = api(); delete value[key]; assert.throws(() => checkPi(value), /不兼容/); } });
