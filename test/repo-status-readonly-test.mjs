import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixture = fs.mkdtempSync(path.resolve('../repo-status-readonly-test-'));
const repo = path.join(fixture, 'target');
const foreign = path.join(fixture, 'foreign');
for (const directory of [repo, foreign]) {
  fs.mkdirSync(directory);
  execFileSync('git', ['init', '-q', directory], { windowsHide: true });
}
fs.writeFileSync(path.join(repo, 'target-only.txt'), 'target');
fs.writeFileSync(path.join(foreign, 'foreign-only.txt'), 'foreign');
const marker = path.join(fixture, 'fsmonitor-ran');
const hook = path.join(fixture, process.platform === 'win32' ? 'fsmonitor.cmd' : 'fsmonitor.sh');
fs.writeFileSync(hook, process.platform === 'win32'
  ? `@echo off\r\necho unexpected>"${marker}"\r\n`
  : `#!/bin/sh\nprintf unexpected > '${marker.replaceAll("'", "'\\''")}'\n`);
fs.chmodSync(hook, 0o755);
execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', hook], { windowsHide: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/index.js')],
  env: {
    ...process.env,
    AGENT_BRIDGE_MODE: '', AGENT_BRIDGE_HTTP: '',
    AGENT_BRIDGE_ROOT: path.join(fixture, 'bridge-data'),
    AGENT_BRIDGE_REPO: repo,
    GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign,
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'repo-status-readonly-regression', version: '1.0.0' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'repo_status', arguments: {} });
  assert.notEqual(result.isError, true);
  const text = result.content.find(item => item.type === 'text').text;
  assert.match(text, /Status Summary:/);
  assert.match(text, /target-only\.txt/);
  assert.doesNotMatch(text, /foreign-only\.txt/);
  assert.equal(fs.existsSync(marker), false, 'repo_status must not execute configured fsmonitor');
  console.log('PASS: repo_status ignores inherited Git location overrides and does not execute fsmonitor.');
} finally {
  await client.close();
  assert.equal(path.dirname(fixture), path.resolve('..'));
  assert.ok(path.basename(fixture).startsWith('repo-status-readonly-test-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
