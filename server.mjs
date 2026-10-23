import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverPath = fileURLToPath(import.meta.url);
export const projectRoot = dirname(serverPath);
export const publicRoot = resolve(projectRoot, 'dist');
export const instance = createHash('sha256').update(process.platform === 'win32' ? serverPath.toLowerCase() : serverPath).digest('hex').slice(0, 20);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

function send(req, res, status, body, headers = {}) {
  const bytes = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...headers });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

export function createAppServer() {
  return createServer(async (req, res) => {
    res.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self)');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) {
      send(req, res, 405, 'Only GET and HEAD are supported.', { Allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path');
    } catch {
      send(req, res, 400, 'Invalid URL.');
      return;
    }
    if (pathname === '/health') {
      send(req, res, 200, JSON.stringify({ app: 'red-room-xr', instance, pid: process.pid, port: res.socket.localPort }), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }
    if (pathname.split('/').some(part => part.startsWith('.'))) {
      send(req, res, 403, 'Path is not public.');
      return;
    }
    try {
      const path = resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      const actualPath = await realpath(path);
      const actualRoot = await realpath(publicRoot);
      if (!actualPath.startsWith(actualRoot + sep)) {
        send(req, res, 403, 'Path is not public.');
        return;
      }
      const info = await stat(actualPath);
      if (!info.isFile()) {
        send(req, res, 404, 'Not found.');
        return;
      }
      const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': mime[extname(actualPath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': info.mtime.toUTCString(),
      };
      if (req.headers['if-none-match']?.split(',').map(value => value.trim()).includes(etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(actualPath);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      send(req, res, ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? 404 : 500, 'Not found.');
    }
  });
}

export function parsePort(args, environmentPort) {
  let value = environmentPort || '4173';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port') value = args[++index];
    else if (args[index].startsWith('--port=')) value = args[index].slice(7);
    else throw new Error(`Unknown argument: ${args[index]}. Use node server.mjs --port 4173.`);
  }
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('Port must be an integer from 1 to 65535. Example: node server.mjs --port 4174');
  }
  return Number(value);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Red Room XR local server\nUsage: node server.mjs [--port 4173]\nPORT is also supported. Listens on 127.0.0.1 only. No npm install is needed.');
    return;
  }
  const port = parsePort(process.argv.slice(2), process.env.PORT);
  await stat(resolve(publicRoot, 'index.html'));
  const server = createAppServer();
  const stateFile = resolve(projectRoot, '.local', `server-${port}.json`);
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Open start-local.cmd to reuse this app, or select another port: node server.mjs --port ${port === 65535 ? 4173 : port + 1}. No process was stopped.`);
    } else console.error(`Local server failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', async () => {
    try {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ app: 'red-room-xr', instance, pid: process.pid, port, serverPath, startedAt: new Date().toISOString() }, null, 2));
    } catch (error) {
      console.warn(`Could not write local status file: ${error.message}`);
    }
    console.log(`Red Room XR: http://localhost:${port}\nLoopback only. Ctrl+C stops this foreground server.`);
  });
  async function close() {
    server.close();
    server.closeAllConnections();
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.pid === process.pid) await unlink(stateFile);
    } catch { /* Missing/stale state needs no cleanup. */ }
  }
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (process.argv[1] && resolve(process.argv[1]) === serverPath) {
  main().catch(error => { console.error(`Local server failed: ${error.message}`); process.exitCode = 1; });
}
