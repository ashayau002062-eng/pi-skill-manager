import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
let loaded;
const sources = [import.meta.url, ...(process.env.PLAYWRIGHT_PACKAGE_DIR ? [path.join(process.env.PLAYWRIGHT_PACKAGE_DIR, 'package.json')] : []), path.join(os.homedir(), '.pi/agent/npm/package.json')];
for (const source of sources) {
  try { loaded = createRequire(source)('playwright'); break; } catch { /* Try already installed tooling only. */ }
}
if (!loaded) throw new Error('可选浏览器测试需要已安装 Playwright；可设置 PLAYWRIGHT_PACKAGE_DIR 指向包含它的 package.json 的目录。不自动安装。');
export const playwright = loaded;
export const executablePath = [process.env.BROWSER_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', playwright.chromium.executablePath()].find(file => file && fs.existsSync(file));
if (!executablePath) throw new Error('可选浏览器测试需要已有浏览器，请设置 BROWSER_EXECUTABLE。不自动下载。');
