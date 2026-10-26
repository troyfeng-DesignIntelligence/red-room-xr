import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
const out=new URL('../test-results/',import.meta.url);
// The record is a local file kept out of the repository; without it the far rooms are only quieter.
const hasRecord=existsSync(new URL('../dist/assets/music/falling.mp3',import.meta.url));
const optional=text=>!hasRecord&&/assets\/music\/falling\.mp3/.test(text);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',message=>{if(message.type()==='error'&&!optional(message.location().url+message.text()))errors.push(message.text());});
page.on('response',r=>{if(r.status()>=400&&!optional(r.url()))errors.push(`${r.status()} ${r.url()}`);});
page.on('request',r=>requests.push(r.url()));
const base=process.env.QA_URL||'http://localhost:4173';
// Listens to what reaches the speakers in two bands the drone barely touches:
// above 800 Hz for speech, 300–1500 Hz for the muffled record. A sound must be
// heard, not only triggered.
await page.addInitScript(()=>{
  const connect=AudioNode.prototype.connect;
  AudioNode.prototype.connect=function(target,...rest){
    if(target instanceof AudioDestinationNode){
      const band=(low,high)=>{
        const a=this.context.createBiquadFilter(),b=this.context.createBiquadFilter(),meter=this.context.createAnalyser();
        a.type='highpass';a.frequency.value=low;b.type='lowpass';b.frequency.value=high;meter.fftSize=2048;
        connect.call(this,a);connect.call(a,b);connect.call(b,meter);return meter;
      };
      window.__meters={speech:band(800,20000),music:band(300,1500)};
      // Each ear on its own, above 800 Hz: where a placed voice is heard.
      const splitter=this.context.createChannelSplitter(2);connect.call(this,splitter);
      window.__ears=[0,1].map(channel=>{
        const high=this.context.createBiquadFilter(),meter=this.context.createAnalyser();
        high.type='highpass';high.frequency.value=800;meter.fftSize=2048;
        splitter.connect(high,channel);high.connect(meter);return meter;
      });
    }
    return connect.call(this,target,...rest);
  };
  window.__ear=channel=>{
    const meter=window.__ears?.[channel];if(!meter)return 0;
    const data=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);
  };
  window.__level=name=>{
    const meter=window.__meters?.[name];if(!meter)return 0;
    const data=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);
  };
});
const loudest=async(seconds,band='speech')=>{let level=0;for(let i=0;i<seconds*20;i++){level=Math.max(level,await page.evaluate(band=>window.__level(band),band));await page.waitForTimeout(50);}return level;};
const average=async(seconds,band)=>{let power=0,count=0;for(let i=0;i<seconds*20;i++){const level=await page.evaluate(band=>window.__level(band),band);power+=level*level;count++;await page.waitForTimeout(50);}return Math.sqrt(power/count);};
const dB=level=>20*Math.log10(Math.max(level,1e-6));
// Text drawn over the room, subtitles aside: there should never be any.
const shown=(target=page)=>target.evaluate(()=>[...document.querySelectorAll('body *')].filter(element=>{
  if(element.closest('.unseen,#subtitle,[hidden]'))return false;
  let opacity=1;for(let e=element;e&&e!==document.body;e=e.parentElement)opacity*=+getComputedStyle(e).opacity;
  const box=element.getBoundingClientRect();
  return opacity>.01&&box.width>1&&box.height>1&&getComputedStyle(element).visibility!=='hidden'&&[...element.childNodes].some(node=>node.nodeType===3&&node.textContent.trim());
}).map(element=>element.textContent.trim()));
try{
  await page.goto(base+'/?debug',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__redRoom?.state.ready,null,{timeout:60000}).catch(error=>{throw new Error(error.message+'\n'+errors.join('\n'));});
  // Nothing on the page but the room: black while it loads, then the room,
  // dim and silent, until a click steps in.
  await page.waitForFunction(()=>document.body.classList.contains('ready'));
  await page.waitForTimeout(2600);
  await page.screenshot({path:new URL('desktop-entry.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  const waiting=await page.evaluate(()=>({veil:+getComputedStyle(document.getElementById('veil')).opacity,
    buttons:[...document.querySelectorAll('button')].filter(button=>!button.closest('[hidden]')).length,started:window.__redRoom.audio.inspect().started}));
  assert.ok(waiting.veil>.5&&waiting.veil<.9,`the room shows, dim (veil ${waiting.veil})`);
  assert.equal(waiting.buttons,0,'no buttons');
  assert.deepEqual(await shown(),[],'no text over the room');
  assert.equal(waiting.started,false,'silent until the visitor steps in');
  await page.mouse.click(720,450);
  assert.equal(await page.evaluate(()=>document.body.classList.contains('entering')),true,'a click steps in, dipping to black first');
  const before=await page.evaluate(()=>window.__redRoom.rig.position.toArray());
  await page.keyboard.down('KeyW');await page.waitForTimeout(600);await page.keyboard.up('KeyW');
  const after=await page.evaluate(()=>window.__redRoom.rig.position.toArray());
  assert.ok(after[2]<before[2]-.1,'W moves forward');
  await page.waitForFunction(()=>!document.body.classList.contains('entering'),null,{timeout:5000});
  const entry=await page.evaluate(()=>({audio:window.__redRoom.audio.inspect()}));
  assert.deepEqual(await shown(),[],'nothing over the walk');
  assert.equal(entry.audio.started,true,'the entering click starts the sound');
  assert.equal(entry.audio.steps,13,'the recorded steps are decoded');
  assert.ok(entry.audio.footsteps>0,'walking plays them');
  assert.ok(entry.audio.settles>0,'stopping sets the trailing foot down');
  await page.keyboard.press('KeyG');
  assert.equal(await page.evaluate(()=>window.__redRoom.state.route),true);
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(()=>window.__redRoom.navigation.dots.count)>12,'continuous navigation breadcrumbs');
  await page.keyboard.press('KeyG');
  assert.equal(await page.evaluate(()=>window.__redRoom.state.route),false);
  // Esc only releases the mouse: there is no menu to go back to.
  await page.evaluate(()=>{if(document.pointerLockElement)document.exitPointerLock();});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.__redRoom.state.exploring),true,'Esc leaves the visitor in the room');
  assert.deepEqual(await shown(),[],'and brings nothing up');
  // The room speaks backwards in some rooms, subtitled in English and Chinese.
  await page.waitForFunction(async()=>window.__redRoom.voices&&window.__redRoom.audio.inspect().clips===(await (await fetch('./assets/voices/manifest.json')).json()).lines.length,null,{timeout:15000,polling:250});
  const droneOnly=await loudest(1);
  const voicesBefore=await page.evaluate(()=>{const r=window.__redRoom;r.voices.reset();r.setPose(-14,-.6,0,-.05);return r.audio.inspect().voices;});
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(()=>document.getElementById('subtitle').classList.contains('show')),false,'a line waits until the visitor is in the room');
  await page.waitForFunction(()=>document.getElementById('subtitle').classList.contains('show'),null,{timeout:3000});
  const withVoice=await loudest(1.6);
  await page.screenshot({path:new URL('room-subtitle.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  const spoken=await page.evaluate(()=>({en:document.getElementById('subtitle-en').textContent,zh:document.getElementById('subtitle-zh').textContent,audio:window.__redRoom.audio.inspect()}));
  assert.equal(spoken.en,'Someone is waiting behind the curtain.');
  assert.equal(spoken.zh,'有人在帘子后面等你。');
  assert.equal(spoken.audio.voices,voicesBefore+1,'the line plays');
  const speechGain=20*Math.log10(withVoice/Math.max(droneOnly,1e-6));
  assert.ok(speechGain>20&&20*Math.log10(withVoice)>-26,`the line is heard over the drone (speech band ${speechGain.toFixed(1)} dB above the drone, peak ${(20*Math.log10(withVoice)).toFixed(1)} dBFS)`);
  await page.waitForFunction(()=>!document.getElementById('subtitle').classList.contains('show'),null,{timeout:7000});
  // A placed voice is heard from where it is: louder in the nearer ear, and in
  // the other one once the visitor turns round.
  const ears=async seconds=>{
    let left=0,right=0;
    for(let i=0;i<seconds*20;i++){const [l,r]=await page.evaluate(()=>[window.__ear(0),window.__ear(1)]);left=Math.max(left,l);right=Math.max(right,r);await page.waitForTimeout(50);}
    return {left,right};
  };
  const heardFrom={};
  for(const [name,yaw] of [['facing',0],['turned',Math.PI]]){
    await page.evaluate(yaw=>{const r=window.__redRoom;r.voices.mute=r.voices.update;r.voices.update=()=>null;r.setPose(-14,1,yaw,0);},yaw);
    await page.waitForTimeout(300);
    const listener=await page.evaluate(()=>window.__redRoom.audio.inspect().listener);
    await page.evaluate(()=>window.__redRoom.speakLine({id:'waiting',en:'',zh:'',duration:3,trigger:{from:[-17,1]}}));
    const {left,right}=await ears(1.6);
    heardFrom[name]={balanceDb:+(dB(left)-dB(right)).toFixed(1),forward:listener.forward.map(v=>+v.toFixed(3))};
    await page.evaluate(()=>{const r=window.__redRoom;r.voices.update=r.voices.mute;});
    await page.waitForTimeout(1800);
  }
  assert.ok(Math.abs(heardFrom.facing.forward[2]+1)<.01&&Math.abs(heardFrom.turned.forward[2]-1)<.01,'the ears face where the camera faces');
  assert.ok(heardFrom.facing.balanceDb>4,`a voice 3 m to the left is louder in the left ear (${heardFrom.facing.balanceDb} dB)`);
  assert.ok(heardFrom.turned.balanceDb<-4,`turned round, it is in the right ear (${heardFrom.turned.balanceDb} dB)`);
  // Someone walks behind a curtain: their figure presses out of the cloth, each
  // step ripples it, and the steps come through it. (On ordinary circuits it
  // comes by itself now and then; here it is started by hand.)
  const walkerBefore=await page.evaluate(()=>{const r=window.__redRoom;r.voices.mute=r.voices.update;r.voices.update=()=>null;r.setPose(0.3,2.2,0,-.05);return r.audio.inspect();});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.__redRoom.walkBehindCurtain()),true,'a curtain to walk behind in the waiting room');
  await page.waitForTimeout(1500);
  const walking=await page.evaluate(()=>({walker:window.__redRoom.curtainWalker.inspect(),cloth:window.__redRoom.curtains.inspect(),audio:window.__redRoom.audio.inspect()}));
  assert.equal(walking.walker.walking,true);
  assert.ok(walking.cloth.walker>.5,'the cloth bulges where they are');
  assert.ok(walking.audio.walker>walkerBefore.walker,'their steps come through the cloth');
  assert.ok(walking.audio.rustles>walkerBefore.rustles,'and it rustles where each step touches it');
  await page.waitForFunction(()=>!window.__redRoom.curtainWalker.inspect().walking,null,{timeout:9000});
  assert.ok(await page.evaluate(()=>window.__redRoom.curtains.inspect().walker)<.01,'then nothing');
  await page.evaluate(()=>{const r=window.__redRoom;r.voices.update=r.voices.mute;});
  // A statue keeps still while she is watched; out of sight for a few seconds
  // she turns, at once, to face the visitor.
  const statueA=()=>page.evaluate(()=>{
    const r=window.__redRoom,s=r.watchers.inspect().find(s=>s.index===6),[x,z]=r.spatial.obstacles[6].center,head=r.camera.getWorldPosition(r.camera.position.clone());
    const off=s.facing+s.yaw-Math.atan2(head.z-z,head.x-x);
    return {yaw:+s.yaw.toFixed(3),off:+Math.abs(Math.atan2(Math.sin(off),Math.cos(off))).toFixed(3)};
  });
  const lookAtStatue=away=>page.evaluate(away=>{
    const r=window.__redRoom,[x,z]=r.spatial.obstacles[6].center,cx=.2,cz=-1.6;
    r.setPose(cx,cz,Math.atan2(cx-x,cz-z)+(away?Math.PI:0),-.08);
  },away);
  await page.evaluate(()=>{const r=window.__redRoom;r.voices.mute=r.voices.update;r.voices.update=()=>null;});
  await lookAtStatue(false);await page.waitForTimeout(300);
  const watched=await statueA();
  await page.waitForTimeout(3200);
  assert.equal((await statueA()).yaw,watched.yaw,'a statue does not move while she is watched');
  await lookAtStatue(true);await page.waitForTimeout(3200);
  const unwatched=await statueA();
  assert.ok(Math.abs(unwatched.yaw-watched.yaw)>.3&&unwatched.off<.36,`out of sight she turns to face the visitor (${JSON.stringify({watched,unwatched})})`);
  await lookAtStatue(false);await page.waitForTimeout(300);
  const drawnTurned=await page.evaluate(()=>{
    const r=window.__redRoom,gl=r.renderer.getContext(),head=r.camera.getWorldPosition(r.camera.position.clone());
    const read=()=>{r.renderFrame(12);const px=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,px);return px;};
    const turned=read();r.watchers.reset();r.placeFurniture();
    const home=read();r.watchers.turnAll([head.x,head.z]);r.placeFurniture();
    let changed=0;
    for(let i=0;i<turned.length;i+=4)if(Math.abs(turned[i]-home[i])+Math.abs(turned[i+1]-home[i+1])+Math.abs(turned[i+2]-home[i+2])>24)changed++;
    return changed/(turned.length/4);
  });
  assert.ok(drawnTurned>.003,`and she is drawn turned (${(drawnTurned*100).toFixed(2)}% of the picture changes)`);
  assert.equal((await statueA()).yaw,unwatched.yaw,'still facing the visitor when looked at again');
  await page.evaluate(()=>{const r=window.__redRoom;r.voices.update=r.voices.mute;});
  // The record: silent at the start, faint by the mirror room's back curtain.
  let record={present:false};
  if(hasRecord){
    assert.equal(await page.evaluate(()=>window.__redRoom.audio.inspect().music?.playing),true,'the record plays');
    await page.evaluate(()=>{const r=window.__redRoom;r.voices.mute=r.voices.update;r.voices.update=()=>null;r.setPose(0,7,0,0);});
    await page.waitForTimeout(1500);
    const away=await average(1.5,'music');
    await page.evaluate(()=>window.__redRoom.setPose(-7,24.2,0,0));
    await page.waitForTimeout(2500);
    const near=await average(1.5,'music');
    await page.evaluate(()=>{const r=window.__redRoom;r.voices.update=r.voices.mute;});
    record={present:true,awayDb:+dB(away).toFixed(1),nearDb:+dB(near).toFixed(1)};
    assert.ok(record.nearDb-record.awayDb>8,`the record comes through by the far curtain (${record.awayDb} -> ${record.nearDb} dBFS, 300-1500 Hz)`);
    assert.ok(record.nearDb<-18,'and stays faint');
  }
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
    return {state:{...r.simulation.state},milo:r.models.milo.visible,repeated:r.models.repeated.visible,double:r.models.double.visible,audio:r.audio.inspect()};
  });
  assert.equal(loop.state.phase,'dream');assert.equal(loop.milo,false);assert.equal(loop.repeated,false);assert.equal(loop.double,true);
  assert.deepEqual(await shown(),[],'a completed circuit is not announced in text');
  assert.ok(loop.audio.shifts>0,'the completed circuit is heard instead');
  // The lights stutter and go out with a surge of electricity, then come back.
  assert.ok(loop.audio.surges>0,'electricity surges as the circuit completes');
  await page.waitForFunction(()=>+getComputedStyle(document.getElementById('flicker')).opacity>.9,null,{timeout:1500});
  await page.waitForFunction(()=>+getComputedStyle(document.getElementById('flicker')).opacity<.02,null,{timeout:3000});
  // In the dark every statue turned to the visitor at once.
  const turnedInDark=await page.evaluate(()=>{
    const r=window.__redRoom,head=r.camera.getWorldPosition(r.camera.position.clone());
    return r.watchers.inspect().map(({index,facing,yaw})=>{
      const [x,z]=r.spatial.obstacles[index].center,off=facing+yaw-Math.atan2(head.z-z,head.x-x);
      return +Math.abs(Math.atan2(Math.sin(off),Math.cos(off))).toFixed(3);
    });
  });
  assert.ok(turnedInDark.length===3&&turnedInDark.every(off=>off<.36),`in the dark the statues turned to the visitor (${turnedInDark})`);
  await page.waitForFunction(()=>document.getElementById('subtitle').classList.contains('show')&&document.getElementById('subtitle-en').textContent==='You have been here before.',null,{timeout:6000});
  // The club chairs are leather; lamp poles and statues stay out of it.
  const leather=await page.evaluate(()=>{
    const r=window.__redRoom,counts={},near={};
    for(const root of [r.models.environment,r.models.repeated])root.traverse(mesh=>{
      const attribute=mesh.isMesh&&mesh.geometry.getAttribute('propLeather');if(!attribute)return;
      const position=mesh.geometry.getAttribute('position'),e=mesh.matrixWorld.elements;let count=0;
      for(let i=0;i<attribute.count;i++){
        if(!attribute.getX(i))continue;count++;
        const x=position.getX(i),y=position.getY(i),z=position.getZ(i),wx=e[0]*x+e[4]*y+e[8]*z+e[12],wz=e[2]*x+e[6]*y+e[10]*z+e[14];
        for(const o of r.spatial.obstacles)if(/torchiere|statue/i.test(o.name)&&Math.hypot(wx-o.center[0],wz-o.center[1])<.15)near[o.name]=(near[o.name]||0)+1;
      }
      counts[mesh.name]=count;
    });
    return {counts,near};
  });
  assert.ok(Object.keys(leather.counts).length===2&&Object.values(leather.counts).every(n=>n>20000),'both furnished rooms have leather chairs');
  assert.deepEqual(leather.near,{},'no leather on lamp poles or statues');
  // After the circuit the chairs and lamps stand a little differently, never far.
  const furnitureMoves=()=>page.evaluate(async()=>{
    const r=window.__redRoom,home=(await fetch('./assets/spatial.json').then(response=>response.json())).obstacles;
    const moved=({index})=>Math.hypot(r.spatial.obstacles[index].center[0]-home[index].center[0],r.spatial.obstacles[index].center[1]-home[index].center[1]);
    return {moves:r.furniture.pieces.filter(piece=>piece.kind!=='table').map(moved),tables:r.furniture.pieces.filter(piece=>piece.kind==='table').map(moved),
      double:r.models.double.position.length()+Math.abs(r.models.double.quaternion.y)};
  });
  const furnished=await furnitureMoves();
  assert.equal(furnished.moves.length,11,'chairs, floor lamps and the double chair');
  assert.ok(furnished.moves.filter(d=>d>.02).length>=9&&furnished.moves.every(d=>d<=.121),`the furniture moved ${furnished.moves.map(d=>d.toFixed(3))}`);
  assert.ok(furnished.tables.length===2&&furnished.tables.every(d=>d>.25&&d<.35),`the side tables stand beside their chairs, not in them (${furnished.tables.map(d=>d.toFixed(3))})`);
  assert.ok(furnished.double>.01,'the double chair too');
  // On the dream circuit violet haze fills the mirrored waiting room, lit over the double chair.
  await page.waitForFunction(()=>window.__redRoom.haze.inspect().strength>.95,null,{timeout:6000});
  const hazed=await page.evaluate(()=>{
    const r=window.__redRoom,gl=r.renderer.getContext();
    const read=()=>{r.renderFrame(12);const px=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,px);return px;};
    r.setPose(-9.5,15.2,Math.PI,-.04);
    const strength=r.haze.uniforms.hazeStrength.value,misty=read();
    r.haze.uniforms.hazeStrength.value=0;const clear=read();r.haze.uniforms.hazeStrength.value=strength;
    let changed=0,violet=0;
    for(let i=0;i<misty.length;i+=4){
      const d=Math.abs(misty[i]-clear[i])+Math.abs(misty[i+1]-clear[i+1])+Math.abs(misty[i+2]-clear[i+2]);
      if(d>12){changed++;if(misty[i+2]-clear[i+2]>misty[i+1]-clear[i+1])violet++;}
    }
    return {share:+(changed/(misty.length/4)).toFixed(3),violetShare:+(violet/Math.max(changed,1)).toFixed(3)};
  });
  assert.ok(hazed.share>.2&&hazed.violetShare>.8,`violet haze over the room seen from the corridor (${JSON.stringify(hazed)})`);
  await page.evaluate(()=>window.__redRoom.setPose(-6.6,19.1,Math.PI,-.2));
  await page.waitForTimeout(200);
  await page.screenshot({path:new URL('room-double.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  // On a dream circuit someone walks behind the visitor, and stops when they stop.
  await page.evaluate(()=>{if(document.pointerLockElement)document.exitPointerLock();window.__redRoom.setPose(-14,2.2,0,0);});
  const followerBefore=await page.evaluate(()=>window.__redRoom.audio.inspect().follower);
  await page.keyboard.down('KeyW');await page.waitForTimeout(7500);await page.keyboard.up('KeyW');
  await page.waitForTimeout(1500);
  const followed=await page.evaluate(()=>({audio:window.__redRoom.audio.inspect(),phase:window.__redRoom.simulation.state.phase}));
  assert.equal(followed.phase,'dream');
  assert.ok(followed.audio.follower>followerBefore,'someone walks behind on a dream circuit');
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(()=>window.__redRoom.audio.inspect().follower),followed.audio.follower,'and stops when the visitor stops');
  // Moving the mouse brings nothing up over the room.
  await page.mouse.move(700,420);await page.mouse.move(720,430);
  await page.waitForTimeout(400);
  assert.deepEqual(await shown(),[],'the mouse brings nothing up');
  // Starting again (the headset's two-grip hold, or reloading the page) puts everything back.
  const restarted=await page.evaluate(()=>{const r=window.__redRoom;r.reset();return {exploring:r.state.exploring,phase:r.simulation.state.phase,position:r.rig.position.toArray()};});
  assert.deepEqual(restarted,{exploring:true,phase:'normal',position:[0,0,7]});
  const restored=await furnitureMoves();
  assert.ok(restored.moves.every(d=>d<1e-9)&&restored.double<1e-9,'starting again puts the furniture back');
  assert.ok(await page.evaluate(()=>window.__redRoom.watchers.inspect().every(s=>s.yaw===0)),'and the statues face as they stood');
  assert.deepEqual(restored.tables,furnished.tables,'the tables stay beside their chairs');
  assert.equal(await page.evaluate(()=>window.__redRoom.haze.inspect().target),0,'no haze on an ordinary circuit');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:new URL('mobile-entry.png',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  mobile.on('pageerror',error=>errors.push(error.message));
  // A muted room from an older visit, when there was a switch for it, is forgotten.
  await mobile.goto(base+'/?debug',{waitUntil:'networkidle'});
  await mobile.evaluate(()=>localStorage.setItem('red-room-audio','muted'));
  await mobile.reload({waitUntil:'networkidle'});
  await mobile.waitForFunction(()=>window.__redRoom?.state.ready&&document.body.classList.contains('ready'));
  assert.equal(await mobile.evaluate(()=>window.__redRoom.audio.inspect().muted),false,'an old muted choice is forgotten');
  assert.equal(await mobile.evaluate(()=>localStorage.getItem('red-room-audio')),null);
  await mobile.touchscreen.tap(195,422);
  assert.equal(await mobile.evaluate(()=>window.__redRoom.state.exploring),true,'a tap steps in');
  assert.deepEqual(await shown(mobile),[],'no controls over the room on a phone either');
  await mobile.waitForFunction(()=>!document.body.classList.contains('entering'),null,{timeout:5000});
  const touchBefore=await mobile.evaluate(()=>({z:window.__redRoom.rig.position.z,yaw:window.__redRoom.state.yaw}));
  const cdp=await mobile.context().newCDPSession(mobile);
  // Held still, a finger walks forward; dragged, it only looks around.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:500}]});
  await mobile.waitForTimeout(900);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.waitForTimeout(900); // the walk eases out
  const touchWalked=await mobile.evaluate(()=>window.__redRoom.rig.position.z);
  assert.ok(touchWalked<touchBefore.z-.08,`holding a finger still walks forward (${touchBefore.z} -> ${touchWalked})`);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:120,y:500}]});
  for(let i=1;i<=6;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:120+i*25,y:500}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.waitForTimeout(400);
  const dragged=await mobile.evaluate(()=>({z:window.__redRoom.rig.position.z,yaw:window.__redRoom.state.yaw}));
  assert.ok(Math.abs(dragged.yaw-touchBefore.yaw)>.2,'dragging turns');
  assert.ok(Math.abs(dragged.z-touchWalked)<.05,'a quick drag does not walk');
  await mobile.close();
  assert.equal(errors.length,0,errors.join('\n'));
  assert.ok(!requests.some(url=>!url.startsWith(base)),'No external runtime dependencies');
  const report={passed:true,errors,frames,loop,record,heardFrom,statues:{watched,unwatched,drawnTurned:+drawnTurned.toFixed(4),turnedInDark},speech:{droneOnlyDb:+(20*Math.log10(Math.max(droneOnly,1e-6))).toFixed(1),withVoiceDb:+(20*Math.log10(withVoice)).toFixed(1)},requests:requests.length,mobileTouch:true,headsetTested:false,scope:'Desktop Chromium WebGL rendering, a page with no interface (black while loading, the dim room until a click, nothing drawn over the walk, Esc only releasing the mouse), entry fade, recorded footsteps and other sound triggers, backwards voice lines with bilingual subtitles, voices placed in 3D (heard in the nearer ear, the other after turning round), someone walking behind a curtain (bulge, steps through the cloth, rustles), a statue keeping still while watched and turning to face the visitor once out of sight (and all of them in the dark of a completed circuit), violet haze in the dream room (and none on ordinary circuits), footsteps following on dream circuits, the lights flickering at a completed circuit, the chairs and lamps standing a little differently after it, they and the statues back in place after a restart, old saved settings forgotten, emulated mobile touch (tap to enter, hold to walk, drag to look), state integration. Controller maths tested separately with mocked XR poses. Sound is checked by its triggers and by the level above 800 Hz reaching the speakers while a line plays, not by listening.'};
  await writeFile(new URL('browser-qa.json',out),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
