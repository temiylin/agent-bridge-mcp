import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(process.argv[2] || '.');
const sdk = path.join(repo, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
const { Client } = await import(pathToFileURL(path.join(sdk, 'client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, 'client/stdio.js')));
const fixture = fs.mkdtempSync(path.join(path.dirname(repo), 'project-inspection-test-'));
const project = path.join(fixture, 'alpha');
fs.mkdirSync(path.join(project, 'docs/nested'), { recursive: true });
fs.writeFileSync(path.join(project, 'docs/a.md'), 'abc');
fs.writeFileSync(path.join(project, 'docs/nested/b.md'), 'hello');
fs.mkdirSync(path.join(project, 'output'));
fs.mkdirSync(path.join(fixture, 'beta/docs'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'beta/docs/c.md'), 'seven!!');
const outside = path.join(fixture, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'must-not-count.txt'), 'outside');
fs.symlinkSync(outside, path.join(project, 'docs/escape'), process.platform === 'win32' ? 'junction' : 'dir');
execFileSync('git', ['init', '-q', project], { windowsHide: true });
const hookMarker = path.join(fixture, 'fsmonitor-was-run');
const hook = path.join(fixture, process.platform === 'win32' ? 'fsmonitor.cmd' : 'fsmonitor.sh');
fs.writeFileSync(hook, process.platform === 'win32'
  ? `@echo off\r\necho unsafe>"${hookMarker}"\r\n`
  : `#!/bin/sh\nprintf unsafe > '${hookMarker.replaceAll("'", "'\\''")}'\n`);
fs.chmodSync(hook, 0o755);
execFileSync('git', ['-C', project, 'config', 'core.fsmonitor', hook], { windowsHide: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repo, 'dist/index.js')],
  env: { ...process.env, AGENT_BRIDGE_ROOT: path.join(fixture, 'bridge-data'), AGENT_BRIDGE_MODE: '', AGENT_BRIDGE_HTTP: '' },
  stderr: 'pipe',
});
const client = new Client({ name: 'verify-project-inspection', version: '1.0.0' });
function parse(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find(item => item.name === 'inspect_project_directories');
  assert.ok(tool, 'new tool registered');
  for (const name of ['inspect_project_directories', 'read_result', 'get_task_status', 'read_task_output',
    'read_result_page', 'wait_task', 'repo_status', 'worker_alive_summary', 'list_tasks_summary',
    'agent_registry_summary', 'device_info', 'check_port', 'list_directory', 'read_file',
    'get_file_info', 'read_multiple_files', 'search_files', 'search_code', 'tail_file']) {
    const query = tools.find(item => item.name === name);
    assert.equal(query?.annotations?.readOnlyHint, true, `${name} is read-only`);
    assert.equal(query?.annotations?.destructiveHint, false, `${name} is non-destructive`);
  }
  for (const name of ['execute_command', 'send_task', 'cancel_task', 'write_file', 'edit_block', 'move_file', 'create_directory']) {
    assert.notEqual(tools.find(item => item.name === name)?.annotations?.readOnlyHint, true, `${name} must not claim read-only access`);
  }
  const result = parse(await client.callTool({ name: tool.name, arguments: {
    root_path: fixture, project_names: ['alpha', 'beta'], directory_names: ['docs', 'output', 'missing'],
  } }));
  const alpha = result.projects.find(item => item.name === 'alpha');
  const docs = alpha.directories.find(item => item.name === 'docs');
  assert.equal(docs.file_count, 2);
  assert.equal(docs.total_bytes, 8);
  assert.ok(docs.skipped_symlinks >= 1);
  const output = alpha.directories.find(item => item.name === 'output');
  assert.equal(output.file_count, 0);
  const missing = alpha.directories.find(item => item.name === 'missing');
  assert.notEqual(missing.status, output.status, 'missing is distinct from empty');
  assert.equal(fs.existsSync(hookMarker), false, 'git status must not invoke configured fsmonitor');
  const limited = parse(await client.callTool({ name: tool.name, arguments: {
    root_path: fixture, project_names: ['alpha'], directory_names: ['docs'], include_git_status: false, max_entries: 1,
  } }));
  assert.equal(limited.complete, false, 'bounded scans report incompleteness');
  for (const args of [
    { root_path: 'relative' },
    { root_path: fixture, project_names: ['../outside'] },
    { root_path: fixture, project_names: ['alpha'], directory_names: ['../outside'] },
  ]) {
    const rejected = await client.callTool({ name: tool.name, arguments: args });
    assert.equal(rejected.isError, true, 'unsafe/relative paths rejected');
  }
  assert.equal(fs.readFileSync(path.join(project, 'docs/a.md'), 'utf8'), 'abc');
  assert.equal(fs.readFileSync(path.join(project, 'docs/nested/b.md'), 'utf8'), 'hello');
  console.log('PASS: read-only MCP registration; project counts/bytes; empty vs missing; symlink exclusion; fsmonitor disabled; bounded results; traversal rejection; fixture unchanged.');
} finally {
  await client.close();
  // Only remove the fresh fixture directory allocated by this test.
  assert.equal(path.dirname(fixture), path.dirname(repo));
  assert.ok(path.basename(fixture).startsWith('project-inspection-test-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
