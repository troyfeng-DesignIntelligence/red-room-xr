import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const base=process.env.QA_URL||'http://localhost:4173';
const out=new URL('../test-results/',import.meta.url);
const path=name=>new URL(name,out).pathname.replace(/^\/([A-Z]:)/,'$1');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[];
const attach=page=>{
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
};
async function frames(page,count=2){
  const start=await page.evaluate(()=>window.__redRoom.renderer.info.render.frame);
  await page.waitForFunction(({start,count})=>window.__redRoom.renderer.info.render.frame>=start+count,{start,count});
}
async function boot(page){
  attach(page);
  await page.goto(base+'/?debug',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__redRoom?.state.ready&&document.body.classList.contains('ready'),null,{timeout:30000});
  // There is no entry button: a click or a tap on the room steps in.
  const {width,height}=page.viewportSize();
  if(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches))await page.touchscreen.tap(width/2,height/2);
  else await page.mouse.click(width/2,height/2);
  await frames(page);
}
const report={passed:false,headsetTested:false};
try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await boot(page);
  report.initial=await page.evaluate(()=>window.__redRoom.curtains.inspect());
  assert.equal(report.initial.emitted,0,'distant stationary entry stays still');
  assert.equal(report.initial.meshes,7);
  report.geometry=await page.evaluate(()=>{
    const c=window.__redRoom.curtains;let finite=true,pinned=0,vertices=0,normals=true,foldMax=0,shapes=true,pleatMax=0,cornerVertices=0;const heightRange=[Infinity,-Infinity];
    for(const mesh of c.meshes){
      const attr=mesh.geometry.getAttribute('curtainSurface');vertices+=attr.count;
      for(const value of attr.array)if(!Number.isFinite(value))finite=false;
      for(let i=0;i<attr.count;i++)if(attr.getZ(i)===0)pinned++;
      const fold=mesh.geometry.getAttribute('curtainFold');
      if(!fold||!mesh.geometry.getAttribute('normal')){normals=false;continue;}
      for(const value of fold.array)if(!Number.isFinite(value))finite=false;
      for(let i=0;i<fold.count;i++)foldMax=Math.max(foldMax,Math.abs(fold.getX(i)));
      // Reshaping data: each vertex's pleat (the fold without the slow sway it
      // hangs on), its slopes, how much corner it sits in, and its height.
      const shape=mesh.geometry.getAttribute('curtainShape'),height=mesh.geometry.getAttribute('curtainHeight');
      if(!shape||!height){shapes=false;continue;}
      for(const value of shape.array)if(!Number.isFinite(value))finite=false;
      for(let i=0;i<shape.count;i++){pleatMax=Math.max(pleatMax,Math.abs(shape.getX(i)));if(shape.getW(i)>.6)cornerVertices++;heightRange[0]=Math.min(heightRange[0],height.getX(i));heightRange[1]=Math.max(heightRange[1],height.getX(i));}
    }
    return {finite,vertices,pinned,normals,foldMax,shapes,pleatMax,cornerVertices,heightRange};
  });
  assert.ok(report.geometry.finite&&report.geometry.pinned>1000);
  // Relighting needs recovered normals and fold offsets that stay within the pleats.
  assert.ok(report.geometry.normals&&report.geometry.foldMax>.03&&report.geometry.foldMax<.3,'velvet fold data');
  assert.ok(report.geometry.shapes&&report.geometry.pleatMax>.03&&report.geometry.pleatMax<.2,'pleats separated from the sway they hang on');
  assert.ok(report.geometry.cornerVertices>2000,'corners found for rounding and gathering');
  assert.deepEqual(report.geometry.heightRange,[0,1]);
  await page.evaluate(()=>window.__redRoom.setPose(-4.3,6,Math.PI/2,-.18));
  await frames(page);
  await page.keyboard.down('KeyW');await page.waitForTimeout(1100);await page.keyboard.up('KeyW');
  await frames(page);
  report.collision=await page.evaluate(()=>({x:window.__redRoom.rig.position.x,...window.__redRoom.curtains.inspect()}));
  assert.ok(report.collision.emitted>0,'real blocked W movement excites cloth');
  assert.ok(report.collision.presence>.3,'standing close, the cloth eases away from the visitor');
  assert.ok(report.collision.x>-4.8,'curtain still blocks the body');
  await page.keyboard.down('KeyS');await page.waitForTimeout(430);await page.keyboard.up('KeyS');
  await frames(page);
  // Freeze the same camera and GPU impulses for a genuine before/after image
  // comparison. Only the cloth response changes between the two renders.
  await page.evaluate(()=>{
    const r=window.__redRoom;r.renderer.setAnimationLoop(null);
    r.renderer.render(r.scene,r.camera);
    const gl=r.renderer.getContext(),size=gl.drawingBufferWidth*gl.drawingBufferHeight*4;
    window.__clothPixels=new Uint8Array(size);
    gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,window.__clothPixels);
  });
  await page.screenshot({path:path('curtain-contact-moving.png')});
  report.visibleChange=await page.evaluate(()=>{
    const r=window.__redRoom,drawCalls=r.renderer.info.render.calls;
    r.curtains.reset();r.renderer.render(r.scene,r.camera);
    const gl=r.renderer.getContext(),pixels=new Uint8Array(window.__clothPixels.length);
    gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let changedPixels=0,totalDifference=0;
    for(let i=0;i<pixels.length;i+=4){
      const difference=Math.abs(pixels[i]-window.__clothPixels[i])+Math.abs(pixels[i+1]-window.__clothPixels[i+1])+Math.abs(pixels[i+2]-window.__clothPixels[i+2]);
      if(difference>6)changedPixels++;
      totalDifference+=difference;
    }
    return {changedPixels,totalDifference,drawCalls,restDrawCalls:r.renderer.info.render.calls};
  });
  await page.screenshot({path:path('curtain-contact-rest.png')});
  assert.ok(report.visibleChange.changedPixels>500,'GPU contact visibly bends the cloth at the same camera pose');
  assert.equal(report.visibleChange.drawCalls,report.visibleChange.restDrawCalls,'no extra draw calls for motion');
  // Without any contact the cloth still breathes on its own clock.
  report.breath=await page.evaluate(()=>{
    const r=window.__redRoom,gl=r.renderer.getContext();
    const read=()=>{const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
    r.curtains.reset();r.setPose(-3.7,6,1.35,-.16);r.renderer.render(r.scene,r.camera);
    const before=read();
    r.curtains.update(2.4,[]);r.renderer.render(r.scene,r.camera);
    const after=read();
    let changedPixels=0;
    for(let i=0;i<before.length;i+=4)if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>6)changedPixels++;
    return {changedPixels,...r.curtains.inspect()};
  });
  assert.ok(report.breath.changedPixels>2000,'idle curtains breathe without contact');
  assert.equal(report.breath.emitted,0,'breathing never counts as contact');
  // Someone walking behind the cloth presses a body's width out of it, seen
  // here along the waiting room's back curtain.
  report.walker=await page.evaluate(()=>{
    const r=window.__redRoom,gl=r.renderer.getContext();
    const read=()=>{const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
    r.curtains.reset();r.setPose(-2.6,1.2,-.75,-.04);
    r.curtains.update(0,[]);r.renderer.render(r.scene,r.camera);
    const before=read(),drawCalls=r.renderer.info.render.calls,walker={at:[-1.06,1.1,-2.03],amount:1};
    r.curtains.setWalker(walker);r.curtains.update(0,[]);r.curtains.setWalker(walker);r.renderer.render(r.scene,r.camera);
    const after=read();
    let changedPixels=0;
    for(let i=0;i<before.length;i+=4)if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>6)changedPixels++;
    return {changedPixels,drawCalls,walkerDrawCalls:r.renderer.info.render.calls,walker:r.curtains.inspect().walker};
  });
  await page.screenshot({path:path('curtain-walker.png')});
  assert.ok(report.walker.changedPixels>8000,`someone behind the cloth shows plainly (${report.walker.changedPixels} pixels)`);
  assert.equal(report.walker.drawCalls,report.walker.walkerDrawCalls,'no extra draw calls for them either');
  await page.evaluate(()=>{window.__redRoom.curtains.setWalker(null);window.__redRoom.curtains.update(0,[]);});
  await page.close();

  const brush=await browser.newPage({viewport:{width:1280,height:800}});
  await boot(brush);
  await brush.evaluate(()=>window.__redRoom.setPose(-4.55,6,.10,-.15));
  await frames(brush);
  await brush.keyboard.down('KeyW');await brush.waitForTimeout(1100);await brush.keyboard.up('KeyW');
  await brush.waitForTimeout(600); // walking eases out before the body is still
  report.brush=await brush.evaluate(()=>window.__redRoom.curtains.inspect());
  assert.ok(report.brush.emitted>0,'walking alongside a curtain excites it');
  await brush.screenshot({path:path('curtain-brush.png')});
  await brush.waitForTimeout(4400);
  report.settled=await brush.evaluate(()=>window.__redRoom.curtains.inspect());
  assert.equal(report.settled.emitted,report.brush.emitted,'standing still emits no new waves');
  assert.equal(report.settled.activeImpulses,0,'cloth returns to rest');
  await brush.evaluate(()=>{
    const r=window.__redRoom;r.simulation.state.phase='dream';r.setPhase();r.setPose(-7,18,Math.PI,-.08);
  });
  await frames(brush);
  report.dream=await brush.evaluate(()=>({visible:window.__redRoom.models.dreamCurtains.visible,stats:window.__redRoom.curtains.inspect()}));
  assert.equal(report.dream.visible,true);
  await brush.screenshot({path:path('curtain-dream.png')});
  await brush.close();

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  await boot(mobile);
  await mobile.evaluate(()=>window.__redRoom.setPose(-4.3,6,Math.PI/2,-.1));
  await frames(mobile);
  // A finger held still on the picture walks forward.
  const cdp=await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:500}]});
  await mobile.waitForTimeout(1300);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  report.mobile=await mobile.evaluate(()=>window.__redRoom.curtains.inspect());
  assert.ok(report.mobile.emitted>0,'touch movement excites the same curtain response');
  await mobile.close();
  assert.deepEqual(errors,[]);
  report.errors=errors;report.passed=true;
  await writeFile(new URL('curtain-browser-qa.json',out),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
