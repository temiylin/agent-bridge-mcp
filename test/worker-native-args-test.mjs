import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const fixture = fs.mkdtempSync(path.resolve('../worker-native-args-test-'));
const inheritedEnvironment = { ...process.env };
process.env.AGENT_BRIDGE_ROOT = fixture;
process.env.AGENT_BRIDGE_NOTIFY = '0';
const { processTaskFile } = await import('../dist/worker.js');
const tasksDir = path.join(fixture, 'tasks');
const resultsDir = path.join(fixture, 'results');
const agentDirectory = path.join(fixture, 'agent scripts with spaces');
fs.mkdirSync(agentDirectory, { recursive: true });
const captureScript = path.join(agentDirectory, 'capture args.cjs');
fs.writeFileSync(captureScript, `let stdin = '';
const emit = () => process.stdout.write('CAPTURE:' + JSON.stringify({
  args: process.argv.slice(2).filter(arg => arg !== '--arg-mode'), stdin,
  pathKeys: Object.keys(process.env).filter(key => key.toLowerCase() === 'path'),
  pathValue: process.env[Object.keys(process.env).find(key => key.toLowerCase() === 'path')],
}));
if (process.argv.includes('--arg-mode')) emit();
else { process.stdin.on('data', chunk => stdin += chunk); process.stdin.on('end', emit); }
`);
const failureScript = path.join(agentDirectory, 'exit seven.cjs');
fs.writeFileSync(failureScript, "process.stderr.write('EXPECTED_FAILURE'); process.exit(7);\n");
const prompt = 'Keep "double quotes", spaces, & ampersand | pipe > redirect < input %PATH% ! ^ characters\\ and 中文 intact.';
const staticArgs = ['space value', 'embedded "quotes"', 'trailing\\', '& echo bad', 'a|b', '%PATH%', '中文'];
const registry = {
  nativeArg: { command: process.execPath, args: [captureScript, '--arg-mode', ...staticArgs], input: 'arg' },
  nativeStdin: { command: process.execPath, args: [captureScript, ...staticArgs], input: 'stdin' },
  failure: { command: process.execPath, args: [failureScript], input: 'stdin' },
  codex: { command: process.execPath, args: [captureScript, 'exec', '--sandbox', 'read-only'], input: 'stdin' },
  agy: { command: process.execPath, args: [captureScript, '--dangerously-skip-permissions'], input: 'stdin' },
  batch: { command: path.join(agentDirectory, 'unsafe.cmd'), args: [], input: 'arg' },
};
const processed = {};
async function runTask(id, agent, metadata = '') {
  fs.writeFileSync(path.join(tasksDir, `${id}.md`), `# Native argument regression\n\n- **Agent**: ${agent}\n${metadata}\n---\n\n## Prompt\n\n${prompt}`);
  assert.equal(await processTaskFile(`${id}.md`, tasksDir, resultsDir, processed, registry, 10000, fixture), true);
  const result = fs.readFileSync(path.join(resultsDir, `${id}.md`), 'utf8');
  const status = JSON.parse(fs.readFileSync(path.join(fixture, 'status', `${id}.json`), 'utf8'));
  return { result, status };
}
function capture(result) {
  const text = result.split('CAPTURE:')[1];
  assert.ok(text, 'child emitted capture data');
  return JSON.parse(text.trim());
}
try {
  const nativeArg = await runTask('native_arg', 'nativeArg');
  assert.equal(nativeArg.status.state, 'completed');
  assert.deepEqual(capture(nativeArg.result).args, [...staticArgs, prompt]);
  const nativeStdin = await runTask('native_stdin', 'nativeStdin');
  const stdinOutput = capture(nativeStdin.result);
  assert.equal(stdinOutput.stdin, prompt);
  assert.deepEqual(stdinOutput.args, staticArgs);
  assert.equal(stdinOutput.pathKeys.length, 1, 'child receives a single PATH spelling');
  const pathKey = Object.keys(inheritedEnvironment).find(key => key.toLowerCase() === 'path');
  for (const entry of (inheritedEnvironment[pathKey] || '').split(path.delimiter).filter(Boolean)) {
    assert.ok(stdinOutput.pathValue.split(path.delimiter).includes(entry), `preserve PATH entry ${entry}`);
  }
  const failure = await runTask('native_failure', 'failure');
  assert.equal(failure.status.state, 'failed');
  assert.equal(failure.status.exitCode, 7);
  assert.match(failure.result, /EXPECTED_FAILURE/);
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const resumed = await runTask('native_resume', 'codex', `- **Session ID**: ${sessionId}\n- **Model**: model-v1\n- **Reasoning Effort**: high`);
  assert.equal(resumed.status.state, 'completed');
  assert.deepEqual(capture(resumed.result).args, ['exec', 'resume', sessionId, '--sandbox', 'read-only', '-m', 'model-v1', '-c', 'model_reasoning_effort="high"']);
  const agyTask = await runTask('native_agy', 'agy', `- **Session ID**: ${sessionId}\n- **Model**: gemini-2.5-flash`);
  assert.equal(agyTask.status.state, 'completed');
  assert.deepEqual(capture(agyTask.result).args, ['--dangerously-skip-permissions', '--conversation', sessionId, `--print=${prompt}`, '--model', 'gemini-2.5-flash']);
  const agyContinue = await runTask('native_agy_continue', 'agy', `- **Continue Session**: true`);
  assert.equal(agyContinue.status.state, 'completed');
  assert.deepEqual(capture(agyContinue.result).args, ['--dangerously-skip-permissions', '--continue', `--print=${prompt}`]);
  if (process.platform === 'win32') {
    const marker = path.join(fixture, 'batch-must-not-run');
    fs.writeFileSync(registry.batch.command, `@echo off\r\necho unsafe>"${marker}"\r\n`);
    const rejected = await runTask('native_batch_rejected', 'batch');
    assert.equal(rejected.status.state, 'failed');
    assert.match(rejected.result, /Register the native \.exe/);
    assert.equal(fs.existsSync(marker), false);
  }
  console.log('PASS: native argv and stdin preserve quotes/metacharacters/spaces; PATH entries survive; exit codes and session/model arguments stay correct; Windows batch wrappers fail clearly.');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in inheritedEnvironment)) delete process.env[key];
  Object.assign(process.env, inheritedEnvironment);
  assert.equal(path.dirname(fixture), path.dirname(repoRoot));
  assert.ok(path.basename(fixture).startsWith('worker-native-args-test-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
