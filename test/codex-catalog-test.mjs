import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { queryNativeCodexCatalog } from '../dist/codex-catalog.js';
import { readCodexAgentDefaults, registerModelsTool } from '../dist/models.js';
import { BridgeLogger } from '../dist/logger.js';

// The executable is Node itself; the fake app-server only implements catalog
// methods and throws if the caller attempts inference or thread creation.
const fixture = fs.mkdtempSync(path.resolve('../codex-catalog-test-'));
const mockPath = path.join(fixture, 'mock-app-server.mjs');
fs.writeFileSync(mockPath, `
import assert from 'node:assert/strict';
import readline from 'node:readline';
const mode = process.argv[2];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialized') return;
  assert.ok(['initialize', 'model/list'].includes(message.method), 'catalog must never run inference');
  let result = {};
  if (message.method === 'model/list') {
    assert.equal(message.params.includeHidden, false);
    if (mode === 'error') {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\\n');
      return;
    }
    if (mode === 'malformed') result = { data: 'invalid' };
    else if (mode === 'empty') result = { data: [{ model: 'retired-hidden', hidden: true }] };
    else if (mode === 'cycle') result = { data: [], nextCursor: 'same' };
    else if (!message.params.cursor) result = {
      data: [
        { id: 'internal-a', model: 'visible-a', displayName: 'Visible A', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{reasoningEffort:'low'}, {reasoningEffort:'medium'}] },
        { model: 'hidden-model', hidden: true, isDefault: true },
      ], nextCursor: 'second-page'
    };
    else {
      assert.equal(message.params.cursor, 'second-page');
      result = { data: [
        { model: 'visible-a', displayName: 'Visible A', supportedReasoningEfforts: ['low', 'medium'] },
        { id: 'visible-b', supportedReasoningEfforts: ['high'] },
        null,
      ] };
    }
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`);

let client;
let server;
try {
  const catalog = await queryNativeCodexCatalog(process.execPath, [mockPath, 'pages']);
  assert.deepEqual(catalog.models.map(model => model.id), ['visible-a', 'visible-b']);
  assert.equal(catalog.defaultModel.id, 'visible-a');
  assert.equal(catalog.defaultModel.defaultReasoning, 'medium');
  assert.deepEqual(catalog.models[1].supportedEfforts, ['high']);
  assert.deepEqual((await queryNativeCodexCatalog(process.execPath, [mockPath, 'empty'])).models, []);
  for (const mode of ['error', 'malformed', 'cycle']) {
    assert.equal(await queryNativeCodexCatalog(process.execPath, [mockPath, mode]), null, mode);
  }
  assert.equal(await queryNativeCodexCatalog(path.join(fixture, 'missing.exe')), null);
  assert.equal(await queryNativeCodexCatalog('codex'), null, 'do not shell-resolve untrusted command strings');

  assert.deepEqual(readCodexAgentDefaults(['exec', '-c', 'model="config-model"', '--model=selected-model', '--config=model_reasoning_effort="high"']), {
    model: 'selected-model', reasoningEffort: 'high',
  });
  assert.deepEqual(readCodexAgentDefaults(['-m', 'selected', '-cmodel="config"', '--config', "model_reasoning_effort='medium'"]), {
    model: 'selected', reasoningEffort: 'medium',
  });
  assert.deepEqual(readCodexAgentDefaults(['--model', '-c', 'model="valid"']), { model: 'valid' });
  assert.deepEqual(readCodexAgentDefaults(['--model=', '-c', 'model=""']), {});

  const root = path.join(fixture, 'bridge-data');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'agents.json'), JSON.stringify({ codex: {
    command: path.join(fixture, 'missing.exe'),
    args: ['exec', '--model', 'agent-override', '-c', 'model_reasoning_effort="high"'], input: 'stdin',
  } }));
  server = new McpServer({ name: 'offline-catalog-test', version: '1.0.0' });
  registerModelsTool(server, root, new BridgeLogger(path.join(root, 'logs')));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'catalog-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'list_models', arguments: { agent: 'codex' } });
  assert.notEqual(result.isError, true);
  const report = JSON.parse(result.content.find(item => item.type === 'text').text).codex;
  assert.equal(report.catalogSource, 'desktop cache or built-in fallback');
  assert.ok(report.models.length > 0, 'native failure preserves cache/built-in fallback');
  assert.deepEqual(report.currentDefault, { model: 'agent-override', reasoningEffort: 'high' });
  console.log('PASS: native catalog pagination, hidden filtering, empty catalogs, RPC failures/cycles, cache fallback, and agent default precedence (offline; no inference).');
} finally {
  await client?.close();
  await server?.close();
  assert.equal(path.dirname(fixture), path.resolve('..'));
  assert.ok(path.basename(fixture).startsWith('codex-catalog-test-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
