import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { instance, projectRoot, serverPath } from '../server.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';
async function launch(script, port) {
  return run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(projectRoot, script), '-Port', String(port), ...(script === 'start-local.ps1' ? ['-NoBrowser'] : [])], { cwd: resolve(projectRoot, '..'), windowsHide: true, timeout: 20000 });
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('Windows launcher keeps a background server alive, reuses it, and safely stops it', { skip: !windows }, async t => {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  t.after(async () => { try { await launch('stop-local.ps1', port); } catch {} });
  await launch('start-local.ps1', port);
  const before = await (await fetch(`http://localhost:${port}/health`)).json();
  assert.equal(before.instance, instance);
  await launch('start-local.ps1', port);
  const after = await (await fetch(`http://localhost:${port}/health`)).json();
  assert.equal(after.pid, before.pid);
  assert.notEqual(after.pid, process.pid);
  await launch('stop-local.ps1', port);
  await assert.rejects(() => fetch(`http://localhost:${port}/health`));
});

test('Windows launch and stop scripts preserve an unrelated port owner', { skip: !windows }, async t => {
  const unrelated = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"app":"another-app"}'); });
  const port = await listen(unrelated);
  t.after(() => { unrelated.closeAllConnections(); unrelated.close(); });
  await assert.rejects(() => launch('start-local.ps1', port), error => {
    assert.match(error.stdout, /used by another service/);
    return true;
  });
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).app, 'another-app');
  const statePath = resolve(projectRoot, '.local', `server-${port}.json`);
  await mkdir(resolve(projectRoot, '.local'), { recursive: true });
  await writeFile(statePath, JSON.stringify({ app: 'red-room-xr', instance, port, serverPath, pid: process.pid, startedAt: new Date().toISOString() }));
  t.after(async () => { try { await unlink(statePath); } catch {} });
  await assert.rejects(() => launch('stop-local.ps1', port), error => {
    assert.match(error.stdout, /belongs to another process/);
    return true;
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});
