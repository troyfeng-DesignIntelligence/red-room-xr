import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out=new URL('../test-results/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
page.on('request',r=>requests.push(r.url()));
const base=process.env.QA_URL||'http://localhost:4173';
try{
  await page.goto(base+'/?debug',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__redRoom?.state.ready,null,{timeout:60000}).catch(error=>{throw new Error(error.message+'\n'+errors.join('\n'));});
  await page.waitForTimeout(1600);
  await page.screenshot({path:new URL('desktop-entry.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  await page.getByRole('button',{name:'查看操作说明'}).click();
  assert.equal(await page.locator('#help-dialog').evaluate(d=>d.open),true);
  await page.locator('#help-dialog [data-close]').first().click();
  await page.getByRole('button',{name:'进入房间'}).click();
  assert.equal(await page.evaluate(()=>document.body.classList.contains('entering')),true,'entry dips to black first');
  assert.equal(await page.locator('#hud').isVisible(),true);
  const before=await page.evaluate(()=>window.__redRoom.rig.position.toArray());
  await page.keyboard.down('KeyW');await page.waitForTimeout(350);await page.keyboard.up('KeyW');
  const after=await page.evaluate(()=>window.__redRoom.rig.position.toArray());
  assert.ok(after[2]<before[2]-.1,'W moves forward');
  await page.waitForFunction(()=>!document.body.classList.contains('entering'),null,{timeout:5000});
  const entry=await page.evaluate(()=>({chrome:document.body.classList.contains('chrome-visible'),hint:document.body.classList.contains('hint-visible'),audio:window.__redRoom.audio.inspect()}));
  assert.ok(entry.chrome&&entry.hint,'controls and hint surface briefly after the entry');
  assert.equal(entry.audio.started,true,'the entry click starts the procedural sound');
  assert.ok(entry.audio.footsteps>0,'walking produces footfalls');
  await page.keyboard.press('KeyG');
  assert.equal(await page.evaluate(()=>window.__redRoom.state.route),true);
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(()=>window.__redRoom.navigation.dots.count)>12,'continuous navigation breadcrumbs');
  await page.keyboard.press('KeyG');
  assert.equal(await page.evaluate(()=>window.__redRoom.state.route),false);
  // The route guide is an option in the help dialog. Esc releases the mouse first.
  await page.evaluate(()=>{if(document.pointerLockElement)document.exitPointerLock();});
  await page.getByRole('button',{name:'查看操作说明'}).click();
  await page.locator('#route-toggle').check();
  assert.equal(await page.evaluate(()=>window.__redRoom.state.route),true,'help dialog option enables the guide');
  await page.locator('#route-toggle').uncheck();
  await page.locator('#help-dialog [data-close]').first().click();
  const frames=[];
  const poses=[
    ['main',0,7,0,-.08],['milo',-7.2,.1,0,-.06],
    ['empty',-14,1,0,-.04],['return',-12.2,13.8,-Math.PI/2,-.06],
    ['shell',-21,7.3,Math.atan2(4.8,-.7),-.13],
    ['repeated',-7,17.75,Math.PI,-.06]
  ];
  for(const [name,x,z,yaw,pitch] of poses){
    await page.evaluate(args=>window.__redRoom.setPose(...args),[x,z,yaw,pitch]);
    await page.waitForTimeout(200);
    await page.screenshot({path:new URL(`room-${name}.png`,out).pathname.replace(/^\/([A-Z]:)/,'$1')});
    frames.push({room:name,...await page.evaluate(()=>window.__redRoom.inspect())});
  }
  const loop=await page.evaluate(()=>{
    const r=window.__redRoom;r.simulation.resetProgress();
    for(const [x,z] of r.spatial.route)r.simulation.updateProgress(x,z);
    r.setPhase();
    const toast=document.getElementById('toast');
    return {state:{...r.simulation.state},milo:r.models.milo.visible,repeated:r.models.repeated.visible,double:r.models.double.visible,
      toast:toast.classList.contains('show')?toast.textContent:'',lapLabel:document.getElementById('lap-label').textContent,audio:r.audio.inspect()};
  });
  assert.equal(loop.state.phase,'dream');assert.equal(loop.milo,false);assert.equal(loop.repeated,false);assert.equal(loop.double,true);
  assert.ok(!loop.toast.includes('回来')&&!loop.lapLabel.includes('变了'),'a completed circuit is not announced in text');
  assert.ok(loop.audio.shifts>0,'the completed circuit is heard instead');
  await page.evaluate(()=>window.__redRoom.setPose(-6.6,19.1,Math.PI,-.2));
  await page.waitForTimeout(200);
  await page.screenshot({path:new URL('room-double.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  // Controls stay out of the picture while walking and return on mouse movement.
  await page.evaluate(()=>window.__redRoom.revealChrome(20));
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('chrome-visible')),false,'controls hide during the walk');
  await page.mouse.move(700,420);await page.mouse.move(720,430);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('chrome-visible')),true,'mouse movement reveals the controls');
  await page.locator('#reset-button').click();
  assert.equal(await page.evaluate(()=>window.__redRoom.simulation.state.phase),'normal');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#welcome').isVisible(),true);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:new URL('mobile-entry.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const desktopXR=await page.locator('#enter-vr').textContent();
  assert.ok(desktopXR.includes('头显')||desktopXR.includes('VR'));
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  mobile.on('pageerror',error=>errors.push(error.message));
  await mobile.goto(base+'/?debug',{waitUntil:'networkidle'});
  await mobile.waitForFunction(()=>window.__redRoom?.state.ready);
  await mobile.locator('#enter-desktop').tap();
  assert.equal(await mobile.locator('#touch-controls').isVisible(),true);
  const touchBefore=await mobile.evaluate(()=>window.__redRoom.rig.position.z);
  const button=await mobile.locator('[data-move="forward"]').boundingBox();
  const cdp=await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:button.x+button.width/2,y:button.y+button.height/2}]});
  await mobile.waitForTimeout(250);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.ok(await mobile.evaluate(()=>window.__redRoom.rig.position.z)<touchBefore-.08,'touch forward moves');
  await mobile.close();
  assert.equal(errors.length,0,errors.join('\n'));
  assert.ok(!requests.some(url=>!url.startsWith(base)),'No external runtime dependencies');
  const report={passed:true,errors,frames,loop,requests:requests.length,mobileTouch:true,headsetTested:false,scope:'Desktop Chromium WebGL rendering, entry fade, procedural sound triggers, auto-hiding controls, responsive entry, keyboard/UI, emulated mobile touch movement, state integration. Controller maths tested separately with mocked XR poses. Sound is checked by its triggers, not by listening.'};
  await writeFile(new URL('browser-qa.json',out),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
