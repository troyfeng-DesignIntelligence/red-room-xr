import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const base=process.env.QA_URL||'http://localhost:4173';
const out=new URL('../test-results/',import.meta.url);
const path=name=>new URL(name,out).pathname.replace(/^\/([A-Z]:)/,'$1');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[],requests=[];
const report={passed:false,headsetTested:false};
function attach(page){
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
  page.on('request',request=>requests.push(request.url()));
}
// There is no interface: a click or a tap on the room steps in. Looks are
// chosen by the address (?look=) or the debug hook; V compares with none.
async function enter(page){
  const {width,height}=page.viewportSize();
  if(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches))await page.touchscreen.tap(width/2,height/2);
  else await page.mouse.click(width/2,height/2);
  await page.waitForFunction(()=>window.__redRoom.state.exploring&&!document.body.classList.contains('entering'),null,{timeout:5000});
  await page.evaluate(()=>{if(document.pointerLockElement)document.exitPointerLock();});
}
async function boot(page,query=''){
  attach(page);
  await page.goto(base+'/?debug'+query,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__redRoom?.state.ready&&window.__redRoom?.film&&window.__redRoom?.renderFrame&&document.body.classList.contains('ready'),null,{timeout:60000});
  await enter(page);
}
async function capture(page,name,look,strength=.65){
  const summary=await page.evaluate(({name,look,strength})=>{
    const r=window.__redRoom;
    r.film.setLook(look);r.film.setStrength(strength);
    r.renderFrame(12);
    const gl=r.renderer.getContext(),width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    const pixels=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    window.__filmPixels??={};window.__filmPixels[name]=pixels;
    let sum=0,nonBlack=0;
    for(let i=0;i<pixels.length;i+=4){sum+=pixels[i]+pixels[i+1]+pixels[i+2];if(pixels[i]+pixels[i+1]+pixels[i+2]>12)nonBlack++;}
    return {width,height,meanRGB:sum/(width*height*3),nonBlack,settings:r.film.inspect()};
  },{name,look,strength});
  assert.ok(summary.nonBlack>summary.width*summary.height*.35,`${name} renders the room instead of a blank framebuffer`);
  await page.waitForTimeout(250); // The WebGL frame remains frozen.
  await page.screenshot({path:path(`film-${name}.png`)});
  return summary;
}
async function compare(page,first,second){
  return page.evaluate(({first,second})=>{
    const a=window.__filmPixels[first],b=window.__filmPixels[second];
    if(a.length!==b.length)throw new Error('Compared film frames differ in size');
    let changedPixels=0,totalDifference=0,maxDifference=0;
    for(let i=0;i<a.length;i+=4){
      const difference=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
      if(difference>6)changedPixels++;
      totalDifference+=difference;maxDifference=Math.max(maxDifference,difference);
    }
    return {changedPixels,changedFraction:changedPixels/(a.length/4),meanDifference:totalDifference/(a.length/4*3),maxDifference};
  },{first,second});
}
try{
  const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  await boot(page);
  report.initial=await page.evaluate(()=>window.__redRoom.film.inspect());
  assert.equal(report.initial.look,'broadcast','first visit defaults to the 1991 look');
  assert.equal(report.initial.strength,.65,'default strength is subtle');
  await page.keyboard.press('KeyV');
  assert.equal(await page.evaluate(()=>window.__redRoom.film.inspect().look),'clean','V provides a clean comparison');
  await page.keyboard.press('KeyV');
  assert.equal(await page.evaluate(()=>window.__redRoom.film.inspect().look),'broadcast','V restores the look');

  // Use real keyboard contact before freezing animation for pixel comparisons.
  await page.evaluate(()=>{const r=window.__redRoom;r.setPose(-4.3,6,Math.PI/2,-.18);r.curtains.reset();});
  await page.waitForTimeout(100);
  await page.keyboard.down('KeyW');await page.waitForTimeout(1100);await page.keyboard.up('KeyW');
  report.curtain=await page.evaluate(()=>({x:window.__redRoom.rig.position.x,...window.__redRoom.curtains.inspect()}));
  assert.ok(report.curtain.emitted>0,'film mode preserves actual contact-driven curtain response');
  assert.ok(report.curtain.x>-4.8,'post-processing does not alter collision');
  await page.evaluate(()=>{const r=window.__redRoom;r.renderer.setAnimationLoop(null);r.setPose(-3.7,6,1.35,-.16);});
  await capture(page,'curtain-moving','film');
  await page.evaluate(()=>window.__redRoom.curtains.reset());
  await capture(page,'curtain-rest','film');
  report.curtainPixels=await compare(page,'curtain-moving','curtain-rest');
  assert.ok(report.curtainPixels.changedPixels>500,'cloth motion remains visible through the film shader');

  await page.evaluate(()=>window.__redRoom.setPose(0,7,0,-.035));
  report.clean=await capture(page,'clean','clean');
  report.film=await capture(page,'film','film');
  report.dream=await capture(page,'dream','dream');
  report.broadcast=await capture(page,'broadcast','broadcast');
  report.zero=await capture(page,'zero','film',0);
  report.zeroBroadcast=await capture(page,'zero-broadcast','broadcast',0);
  report.differences={
    film:await compare(page,'clean','film'),
    dream:await compare(page,'film','dream'),
    broadcast:await compare(page,'film','broadcast'),
    zero:await compare(page,'clean','zero'),
    zeroBroadcast:await compare(page,'clean','zero-broadcast')
  };
  assert.ok(report.differences.film.changedFraction>.05,'film modifies the rendered room, not just the DOM');
  assert.ok(report.differences.dream.changedFraction>.01,'dream has a distinct visible treatment');
  assert.ok(report.differences.broadcast.changedFraction>.05,'the 1991 look has its own grain, tone and colour smear');
  assert.ok(report.differences.zero.meanDifference<.05&&report.differences.zero.changedFraction<.001,'zero intensity preserves the clean image');
  assert.ok(report.differences.zeroBroadcast.meanDifference<.05&&report.differences.zeroBroadcast.changedFraction<.001,'zero intensity 1991 preserves the clean image');
  await page.setViewportSize({width:900,height:650});
  await page.waitForFunction(()=>window.__redRoom.renderer.domElement.width===900&&window.__redRoom.renderer.domElement.height===650);
  report.resized=await capture(page,'resized','film');
  assert.equal(report.resized.width,900,'render targets follow desktop resize');
  assert.equal(report.resized.height,650);
  await page.close();

  // The 4:3 broadcast frame, asked for by the address: a centred 4:3 canvas
  // whose render targets follow it.
  const framed=await browser.newPage({viewport:{width:900,height:650},deviceScaleFactor:1});
  await boot(framed,'&frame=4:3&look=film');
  assert.equal(await framed.evaluate(()=>window.__redRoom.film.inspect().look),'film','the address picks the look');
  await framed.waitForFunction(()=>window.__redRoom.renderer.domElement.width===867&&window.__redRoom.renderer.domElement.height===650);
  await framed.evaluate(()=>window.__redRoom.renderer.setAnimationLoop(null));
  report.frame43=await capture(framed,'frame43','broadcast');
  assert.equal(report.frame43.width,867,'4:3 frame keeps the full height');
  assert.equal(report.frame43.height,650);
  await framed.screenshot({path:path('film-frame43.png')});
  await framed.close();

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  await boot(mobile);
  report.mobile=await mobile.evaluate(()=>({settings:window.__redRoom.film.inspect(),fits:document.documentElement.scrollWidth<=innerWidth,buttons:document.querySelectorAll('button:not(#error button)').length}));
  assert.equal(report.mobile.settings.look,'broadcast');
  assert.equal(report.mobile.fits,true);
  assert.equal(report.mobile.buttons,0,'no controls on a phone either');
  await mobile.evaluate(()=>window.__redRoom.renderer.setAnimationLoop(null));
  report.mobileFrame=await capture(mobile,'mobile','dream',.35);
  await mobile.close();
  assert.deepEqual(errors,[],'no JavaScript, shader, or asset errors');
  assert.ok(requests.every(url=>new URL(url).origin===new URL(base).origin),'runtime stays local');
  report.passed=true;report.errors=errors;report.requests=requests.length;
  report.scope='Desktop/mobile Chromium WebGL; fixed-pose fixed-time framebuffer comparisons; actual keyboard curtain contact; the 1991 look by default, V comparison, looks and strengths through the renderer, a look and the 4:3 frame asked for by the address, resize. No physical headset test.';
  await writeFile(new URL('film-browser-qa.json',out),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
