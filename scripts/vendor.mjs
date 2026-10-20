import { mkdir,copyFile } from 'node:fs/promises';
const pairs=[
['build/three.module.js','three.module.js'],
['build/three.core.js','three.core.js'],
['examples/jsm/loaders/GLTFLoader.js','addons/loaders/GLTFLoader.js'],
['examples/jsm/utils/BufferGeometryUtils.js','addons/utils/BufferGeometryUtils.js'],
['examples/jsm/utils/SkeletonUtils.js','addons/utils/SkeletonUtils.js'],
['LICENSE','THREE-LICENSE.txt']
];
for(const [from,to] of pairs){
  const target=new URL('../dist/vendor/'+to,import.meta.url);
  await mkdir(new URL('.',target),{recursive:true});
  await copyFile(new URL('../node_modules/three/'+from,import.meta.url),target);
}
console.log('Vendored Three.js 0.186.1: all runtime code served locally.');
await copyFile(new URL('../node_modules/meshoptimizer/meshopt_decoder.mjs',import.meta.url),new URL('../dist/vendor/meshopt_decoder.mjs',import.meta.url));
await copyFile(new URL('../node_modules/meshoptimizer/LICENSE.md',import.meta.url),new URL('../dist/vendor/MESHOPT-LICENSE.txt',import.meta.url));
