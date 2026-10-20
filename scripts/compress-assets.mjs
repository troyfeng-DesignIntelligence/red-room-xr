import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {dedup,prune,meshopt} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptDecoder} from 'meshoptimizer';
import {mkdir,copyFile,readFile,writeFile,stat} from 'node:fs/promises';
await MeshoptEncoder.ready;
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
const raw=new URL('../../work/xr-glb-raw/',import.meta.url);
await mkdir(raw,{recursive:true});
const report=JSON.parse(await readFile(new URL('../dist/assets/asset-report.json',import.meta.url),'utf8'));
for(const name of Object.keys(report.assets)){
  const target=new URL(`../dist/assets/${name}.glb`,import.meta.url);
  const backup=new URL(`${name}.glb`,raw);
  if(!process.argv.includes('--from-backup'))await copyFile(target,backup);
  const document=await io.read(backup.pathname.replace(/^\/([A-Z]:)/,'$1'));
  for(const mesh of document.getRoot().listMeshes()){
    for(const primitive of mesh.listPrimitives()){
      // Native illumination already includes normals; unlit rendering needs no
      // normal/tangent buffers. Keep positions and baked RGBA colours.
      if(primitive.getMaterial()?.getExtension('KHR_materials_unlit')){
        primitive.setAttribute('NORMAL',null);primitive.setAttribute('TANGENT',null);
      }
    }
  }
  await document.transform(dedup(),prune(),meshopt({encoder:MeshoptEncoder,level:'high',quantizePosition:16,quantizeColor:10}));
  await io.write(target.pathname.replace(/^\/([A-Z]:)/,'$1'),document);
  report.assets[name].rawBytes=(await stat(backup)).size;
  report.assets[name].bytes=(await stat(target)).size;
}
report.totalBytes=Object.values(report.assets).reduce((sum,a)=>sum+a.bytes,0);
report.compression='EXT_meshopt_compression, 16-bit positions, 10-bit baked colors; redundant unlit normals removed';
await writeFile(new URL('../dist/assets/asset-report.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
