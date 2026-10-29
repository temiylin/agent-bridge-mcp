import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const token = 'relay-log-test-credential';
if (process.argv[2] === '--child') {
  process.env.AGENT_BRIDGE_HTTP_DASHBOARD = '0';
  process.env.AGENT_BRIDGE_EMBEDDED_WORKER = '0';
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    close() { this.onclose?.(); }
  };
  const { startRelayClient } = await import('../dist/client.js');
  const relay = await startRelayClient({
    serverUrl: 'wss://relay.invalid/ws', token,
    customRootDir: process.argv[3],
    onConnect() { console.log('FAKE_RELAY_CONNECTED'); },
  });
  relay.close();
} else {
  const parent = path.resolve('..');
  const fixture = fs.mkdtempSync(path.join(parent, 'relay-log-test-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', fixture], {
      windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FAKE_RELAY_CONNECTED/);
    assert.ok(!(result.stdout + result.stderr).includes(token), 'daemon output must not contain device credentials');
    assert.ok(!fs.readFileSync(path.join(fixture, 'logs/server.log'), 'utf8').includes(token));
    console.log('PASS: redirected relay output and persisted logs omit device credentials.');
  } finally {
    assert.equal(path.dirname(fixture), parent);
    assert.ok(path.basename(fixture).startsWith('relay-log-test-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
