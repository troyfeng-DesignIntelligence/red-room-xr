import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer, instance, parsePort } from '../server.mjs';

test('local server serves the project independently of working directory', async t => {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalDirectory = process.cwd();
  process.chdir('..');
  t.after(() => process.chdir(originalDirectory));

  await t.test('health identifies this project and is never cached', async () => {
    const result = await fetch(`${base}/health?probe=1`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const health = await result.json();
    assert.equal(health.app, 'red-room-xr');
    assert.equal(health.instance, instance);
    assert.equal(health.pid, process.pid);
  });
  await t.test('query strings preserve HTML content and XR headers', async () => {
    const result = await fetch(`${base}/?local=1`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /^text\/html/);
    assert.equal(result.headers.get('permissions-policy'), 'xr-spatial-tracking=(self)');
    assert.match(await result.text(), /<html/);
  });
  await t.test('HEAD sends the same asset length without a response body', async () => {
    const result = await fetch(`${base}/vendor/meshopt_decoder.mjs?v=2`, { method: 'HEAD' });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /^text\/javascript/);
    assert.ok(Number(result.headers.get('content-length')) > 0);
    assert.equal(await result.text(), '');
  });
  await t.test('asset caching revalidates and returns 304 for a matching ETag', async () => {
    const first = await fetch(`${base}/assets/milo.glb`, { method: 'HEAD' });
    assert.equal(first.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const result = await fetch(`${base}/assets/milo.glb`, { headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.equal(result.status, 304);
    assert.equal(await result.text(), '');
  });
  await t.test('invalid paths and nonpublic files cannot be served', async () => {
    for (const [path, status] of [['/%zz', 400], ['/%00', 400], ['/..%5Cserver.mjs', 400], ['/.openai/hosting.json', 403], ['/server.mjs', 404], ['/no-such-asset.glb', 404]]) {
      assert.equal((await fetch(base + path)).status, status, path);
    }
  });
  await t.test('unsupported methods return 405 without writing files', async () => {
    const result = await fetch(`${base}/assets/no-file.txt`, { method: 'POST', body: 'not saved' });
    assert.equal(result.status, 405);
    assert.equal(result.headers.get('allow'), 'GET, HEAD');
  });
});

test('local port options are explicit and reject malformed inputs', () => {
  assert.equal(parsePort([], undefined), 4173);
  assert.equal(parsePort([], '4175'), 4175);
  assert.equal(parsePort(['--port', '4176'], '4175'), 4176);
  assert.equal(parsePort(['--port=4177'], undefined), 4177);
  for (const args of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', 'NaN'], ['--port', '4173.5'], ['--host', '0.0.0.0']]) {
    assert.throws(() => parsePort(args, undefined));
  }
});
