import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.mkdirSync('verification', { recursive: true });
const suites = ['browser-smoke', 'organizing-browser', 'purge-browser', 'usability-browser', 'workspace-browser', 'ui-integration-browser', 'group-rename-browser'];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [`test/${suite}.mjs`], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
