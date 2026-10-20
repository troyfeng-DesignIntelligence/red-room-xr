import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root=resolve('dist'), port=Number(process.env.PORT||4173);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.glb':'model/gltf-binary','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    if(!(await stat(path)).isFile())throw new Error('not file');
    res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Permissions-Policy':'xr-spatial-tracking=(self)','Cache-Control':'no-cache'});
    res.end(await readFile(path));
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'0.0.0.0',()=>console.log(`Local: http://localhost:${port}`));
