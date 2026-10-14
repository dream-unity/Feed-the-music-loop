import test from 'node:test';
import assert from 'node:assert/strict';
import {LoopEngine,PageCache} from '../src/audio/loop-worklet.mjs';
import {TrackDSP,SharedFX,softCeiling,cleanMix} from '../src/audio/dsp.mjs';

function harness({sampleRate=8000,pageFrames=256,pool=16,autoRecycle=true}={}){
  const events=[],assets=new Map(),reads=[],engine=new LoopEngine({sampleRate,pageFrames,post:e=>events.push(e)});
  const storage={postMessage(m){
    if(m.type==='write'){
      const copy=new Float32Array(m.buffer,0,m.frames*m.channels).slice();let a=assets.get(m.assetId);if(!a){a={pages:new Map(),channels:m.channels,frames:0};assets.set(m.assetId,a);}a.pages.set(m.index,{buffer:copy.buffer,frames:m.frames,channels:m.channels});a.frames+=m.frames;
      // Real MessagePorts detach the sender; use actual transfer in the harness.
      const recycled=structuredClone(m.buffer,{transfer:[m.buffer]});if(autoRecycle)engine.storageMessage({type:'recycle',buffer:recycled});
    }else if(m.type==='read'){reads.push(m);const page=assets.get(m.assetId)?.pages.get(m.index);engine.storageMessage(page?{type:'page',assetId:m.assetId,index:m.index,...page,buffer:page.buffer.slice(0)}:{type:'page-missing',assetId:m.assetId,index:m.index,retryable:true});}
    else if(m.type==='end'){let a=assets.get(m.assetId);if(!a){a={pages:new Map(),channels:1,frames:0};assets.set(m.assetId,a);}a.status=m.status;a.frames=m.frames;engine.storageMessage({type:'sealed',assetId:m.assetId,frames:m.frames,status:m.status});}
  }};
  engine.command({type:'storage-port',port:storage});engine.command({type:'pool',buffers:Array.from({length:pool},()=>new ArrayBuffer(pageFrames*8))});
  const run=(count,input=()=>0,blockSize=128)=>{const l=new Float32Array(count),r=new Float32Array(count);for(let at=0;at<count;at+=blockSize){const n=Math.min(blockSize,count-at),mic=new Float32Array(n);for(let i=0;i<n;i++)mic[i]=input(at+i,engine.clock+i);engine.process(mic,l.subarray(at,at+n),r.subarray(at,at+n));}return {l,r};};
  const samples=id=>{const a=assets.get(id);const result=new Float32Array(a.frames*a.channels);let offset=0;for(const [,p]of [...a.pages].sort((a,b)=>a[0]-b[0])){result.set(new Float32Array(p.buffer),offset);offset+=p.frames*p.channels;}return result;};
  const arm=(extra={})=>engine.command({type:'arm',capture:{id:'capture',assetId:'raw',kind:'loop',lengthFrames:0,quantized:false,track:{id:'track',mix:{volume:1,highpass:0,compression:0,reverb:0,delay:0}},...extra}});
  return {engine,events,assets,reads,run,samples,arm};
}

test('free first loop turns around on its exact frame without waiting for storage or UI',()=>{
  const h=harness();h.arm();h.run(1003,i=>Math.sin(i*.1)*.2,73);h.engine.command({type:'finish'});assert.equal(h.engine.baseFrames,1003);assert.equal(h.engine.tracks.get('track').track.frames,1003);h.run(1);const end=h.events.find(e=>e.type==='capture-end');assert.equal(end.frames,1003);assert.equal(end.endFrame,1003);assert.equal(h.samples('raw').length,1003);assert.equal(h.engine.frame,1004);assert(h.events.some(e=>e.type==='asset-sealed'));
  const audio=h.run(1003);assert(audio.l.some(x=>Math.abs(x)>.01));assert(!h.events.some(e=>e.type==='underrun'));
});

test('fixed four-cycle loop finishes sample-exactly across arbitrary render quantum lengths',()=>{
  const h=harness();h.engine.command({type:'configure',baseFrames:1003});h.engine.command({type:'play'});h.run(501);h.arm({lengthFrames:4012,quantized:true});h.run(5200,()=>.1,237);const start=h.events.find(e=>e.type==='capture-start'),end=h.events.find(e=>e.type==='capture-end');assert.equal(start.startFrame,1003);assert.equal(end.frames,4012);assert.equal(end.endFrame,5015);assert.equal(end.track.offsetFrames,1003);assert.equal(h.engine.frame,5701);
});

test('compensation captures [S+C,E+C) while first repeat starts at E',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({lengthFrames:1003});h.run(1004,(_,clock)=>clock/10000,61);assert.equal(h.engine.tracks.get('track').track.frames,1003);assert.equal(h.engine.capture.status,'finishing');h.run(201,(_,clock)=>clock/10000,61);const raw=h.samples('raw');assert.equal(raw.length,1003);assert(Math.abs(raw[0]-.0200)<1e-7);assert(Math.abs(raw[1002]-.1202)<1e-7);assert(!h.events.some(e=>e.type==='underrun'));assert.equal(h.events.find(e=>e.type==='capture-end').startFrame,0);
});

test('singing over a four-cycle loop never resets the ongoing loop phase or starts replaying the lead',()=>{
  const h=harness();h.arm({lengthFrames:4000});h.run(4001,()=>.1);h.run(1999);assert.equal(h.engine.frame,6000);h.arm({id:'lead-take',assetId:'lead',masterAssetId:'master',kind:'vocal',quantized:false});h.run(1703,()=>.2);h.engine.command({type:'finish'});h.run(1);assert.equal(h.engine.frame,7704);assert.equal(h.engine.playing,true);assert.deepEqual([...h.engine.tracks.keys()],['track']);assert.equal(h.samples('lead').length,1703);assert.equal(h.samples('master').length,3406);assert.equal(h.events.filter(e=>e.type==='capture-end').at(-1).startFrame,6000);
});

test('cancel queued recording cannot start after the future boundary',()=>{
  const h=harness();h.engine.command({type:'configure',baseFrames:1000});h.engine.command({type:'play'});h.run(300);h.arm({quantized:true});h.engine.command({type:'cancel'});h.run(3000,()=>.5);assert.equal(h.events.filter(e=>e.type==='capture-start').length,0);assert.equal(h.assets.get('raw').status,'cancelled');assert.equal(h.engine.capture,null);
});

test('stop during compensated capture drains aligned ending without moving transport',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({kind:'vocal',masterAssetId:'master'});h.run(700,(_,clock)=>clock/10000);h.engine.command({type:'stop'});h.run(300,(_,clock)=>clock/10000);assert.equal(h.engine.frame,700);assert.equal(h.engine.playing,false);assert.equal(h.samples('raw').length,700);assert.equal(h.samples('master').length,1400);assert(Math.abs(h.samples('raw').at(-1)-.0899)<1e-7);
});

test('write backpressure stops both dry and stereo capture at the same valid prefix',()=>{
  const h=harness({pool:2,autoRecycle:false});h.arm({kind:'vocal',masterAssetId:'master'});h.run(1000,()=>.25);assert.equal(h.engine.capture,null);assert.equal(h.samples('raw').length,256);assert.equal(h.samples('master').length,512);assert.equal(h.assets.get('raw').status,'interrupted');assert.equal(h.events.find(e=>e.type==='capture-end').reason,'write-buffer-exhausted');
});

test('record backing uses delayed post-FX samples and master gain at the matching musical frame',()=>{
  const h=harness();h.arm({lengthFrames:1800});h.run(1801,i=>Math.sin(i*.06)*.2);h.engine.vocalDSP.reset();h.engine.vocalFX.reset();h.engine.command({type:'configure',compensationFrames:160});h.arm({id:'lead',assetId:'lead',masterAssetId:'master',kind:'vocal'});const monitor=h.run(700,()=>0);h.engine.command({type:'configure',masterVolume:.35});const monitor2=h.run(700,()=>0);h.engine.command({type:'finish'});h.run(161,()=>0);const recorded=h.samples('master');const full=new Float32Array(1400);full.set(monitor.l);full.set(monitor2.l,700);for(let i=0;i<1400;i++)assert(Math.abs(recorded[i*2]-full[i])<2e-6,`misaligned master at ${i}: ${recorded[i*2]} != ${full[i]}`);
});

test('section launches atomically on boundary and excludes later-added tracks',()=>{
  const h=harness();h.arm({lengthFrames:1000});h.run(1001,()=>.1);h.engine.command({type:'track',track:{id:'later',assetId:'raw',frames:1000,channels:1,mix:{volume:1},muted:false}});h.engine.command({type:'section',section:{id:'intro',tracks:{track:{muted:false,mix:{volume:.4}}}}});assert.equal(h.engine.tracks.get('later').track.muted,false);h.run(1000);assert.equal(h.engine.tracks.get('later').track.muted,true);assert.equal(h.engine.tracks.get('track').track.mix.volume,.4);assert.equal(h.events.find(e=>e.type==='section').projectFrame,2000);
});

test('bounded cache preserves opening pages while rolling through a long asset',()=>{
  const c=new PageCache(16,1,2,4);for(let n=0;n<2000;n++)c.write(n,n);assert.equal(c.slots.length,6);assert.equal(c.sample(0),0);assert.equal(c.sample(31),31);assert.equal(c.sample(1999),1999);assert(Number.isNaN(c.sample(500)));
});

test('long recorded loops play from bounded cache through wrap and reclaimed pages',()=>{
  const h=harness({pageFrames:256});h.arm({lengthFrames:12007});h.run(12008,i=>Math.sin(i*.02)*.1,93);assert.equal(h.engine.caches.get('raw').slots.length,16);h.run(40000,()=>0,93);assert(!h.events.some(e=>e.type==='underrun'));assert.equal(h.engine.caches.get('raw').slots.length,16);assert.equal(h.engine.missing.size,0);
});

test('missing pages are reported with unchanged timeline and retry rate is bounded',()=>{
  const h=harness();h.engine.command({type:'track',track:{id:'missing',assetId:'missing',frames:80000,channels:1,mix:{}}});h.engine.tracks.get('missing').ready=true;h.engine.command({type:'play'});h.run(16000);assert.equal(h.engine.frame,16000);assert(h.events.some(e=>e.type==='underrun'));assert.equal(h.engine.missing.size,1);assert(h.reads.length<300);h.engine.command({type:'remove-track',id:'missing'});assert.equal(h.engine.missing.size,0);
});

test('malformed mixing controls cannot create NaNs and soft ceiling stays within full scale',()=>{
  const mix=cleanMix({volume:NaN,pan:Infinity,low:'bad',highpass:-100,reverb:99});assert.equal(mix.volume,.8);assert.equal(mix.highpass,0);assert.equal(mix.reverb,1);const dsp=new TrackDSP(48000,mix),fx=new SharedFX(48000);for(let i=0;i<5000;i++){dsp.process(i%100===0?100:0);fx.process(dsp.left,dsp.right,dsp.left,dsp.right);assert(Number.isFinite(fx.left));assert(Number.isFinite(dsp.left));assert(Math.abs(softCeiling(dsp.left+fx.left))<=1);}assert.equal(softCeiling(NaN),0);
});

test('same-asset reconciliation preserves DSP state and reports actual command frame',()=>{
  const h=harness();h.arm({lengthFrames:1000});h.run(1100,()=>.1);const dsp=h.engine.tracks.get('track').dsp;h.engine.command({type:'track',track:{...h.engine.tracks.get('track').track,name:'renamed'}});assert.equal(h.engine.tracks.get('track').dsp,dsp);const ack=h.events.filter(e=>e.type==='command').at(-1);assert.equal(ack.command,'track');assert.equal(ack.frame,1100);
});

test('first loop establishes zero origin after an empty transport and cancelled capture',()=>{
  const h=harness();h.engine.command({type:'play'});h.run(333);h.arm();assert.equal(h.engine.frame,0);h.run(511);h.engine.command({type:'cancel'});h.run(99);h.arm({id:'second',assetId:'second-raw',lengthFrames:1003});assert.equal(h.engine.frame,0);h.run(1004);const end=h.events.find(e=>e.type==='capture-end'&&e.captureId==='second');assert.equal(end.startFrame,0);assert.equal(end.track.offsetFrames,0);assert.equal(h.engine.baseFrames,1003);
});

test('interrupt finalizes the real captured prefix immediately without compensation silence',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({kind:'vocal',masterAssetId:'master'});h.run(701,()=>.2);h.engine.command({type:'interrupt',reason:'microphone-off'});assert.equal(h.engine.capture,null);assert.equal(h.samples('raw').length,501);assert.equal(h.samples('master').length,1002);assert.equal(h.events.find(e=>e.type==='capture-end').reason,'microphone-off');assert.equal(h.engine.playing,true);
});

test('cold tracks become ready only after opening and current phase pages arrive',()=>{
  const h=harness();h.engine.frame=1800;h.engine.command({type:'track',track:{id:'cold',assetId:'cold',frames:4000,channels:1,mix:{}}});
  const put=index=>h.engine.command({type:'page',assetId:'cold',index,frames:256,channels:1,buffer:new Float32Array(256).buffer});
  put(0);assert(!h.events.some(e=>e.type==='track-ready'));put(1);put(2);put(3);assert(!h.events.some(e=>e.type==='track-ready'));put(7);assert(!h.events.some(e=>e.type==='track-ready'));put(8);assert(h.events.some(e=>e.type==='track-ready'&&e.id==='cold'));
});

test('soft source end preserves effect tails without looping new audio',()=>{
  const h=harness();h.arm({lengthFrames:1000,track:{id:'track',mix:{volume:1,highpass:0,compression:0,reverb:.5,delay:.5}}});h.run(1001,i=>Math.sin(i*.2)*.2);h.run(1000);h.engine.sourceEndFrame=h.engine.frame;const tail=h.run(8000);assert(tail.l.some(x=>Math.abs(x)>.0001));assert(tail.l.slice(-1000).reduce((s,x)=>s+x*x,0)<tail.l.slice(0,1000).reduce((s,x)=>s+x*x,0));assert(!h.events.some(e=>e.type==='underrun'));
});

test('high pass, shelving EQ and compressor have audible intended frequency/dynamic behavior',()=>{
  function rms(mix,frequency,amplitude=.1){const dsp=new TrackDSP(48000,{volume:1,pan:-1,highpass:0,low:0,mid:0,high:0,compression:0,reverb:0,delay:0,...mix});let sum=0;for(let i=0;i<24000;i++){dsp.process(amplitude*Math.sin(2*Math.PI*frequency*i/48000));if(i>=12000)sum+=dsp.left*dsp.left;}return Math.sqrt(sum/12000);}
  assert(rms({highpass:500},100)<rms({},100)*.06);assert(rms({high:12},10000)>rms({},10000)*3);const compressedRatio=rms({compression:1},1000,.7)/rms({compression:1},1000,.07);assert(compressedRatio<4);assert(Math.abs(rms({},1000,.7)/rms({},1000,.07)-10)<.01);
});

test('repeated cancelled takes and stale page replies do not accumulate playback caches',()=>{
  const h=harness();for(let i=0;i<30;i++){h.arm({id:'c'+i,assetId:'a'+i,kind:'vocal'});h.run(300);h.engine.command({type:'cancel'});}assert.equal(h.engine.caches.size,0);h.engine.storageMessage({type:'page',assetId:'a0',index:0,frames:256,channels:1,buffer:new Float32Array(256).buffer});assert.equal(h.engine.caches.size,0);
});

test('compensation changes are retained for the next take while active capture stays fixed',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:100});h.arm({kind:'vocal'});h.run(500);h.engine.command({type:'configure',compensationFrames:300});assert.equal(h.engine.capture.compensation,100);h.engine.command({type:'finish'});h.run(101);assert.equal(h.samples('raw').length,500);h.arm({id:'next',assetId:'next',kind:'vocal'});assert.equal(h.engine.capture.compensation,300);
});

test('live mix audition aligns one-shot lead to backing phase and matches renderer vocal DSP',()=>{
  function session(){const h=harness();h.arm({lengthFrames:1000});h.run(1001,i=>Math.sin(i*.13)*.15);h.run(312);const startFrame=h.engine.frame;h.arm({id:'voice',assetId:'voice',kind:'vocal'});h.run(1807,i=>Math.cos(i*.057)*.17);h.engine.command({type:'finish'});h.run(1);h.engine.command({type:'stop'});return {...h,startFrame};}
  const a=session(),b=session(),mix={volume:.72,pan:-.2,low:2,mid:1,high:-1,highpass:70,compression:.45,reverb:.18,delay:.1};
  a.engine.command({type:'audition',take:{id:'take',assetId:'voice',frames:1807,startFrame:a.startFrame,mix},tailFrames:300});assert.equal(a.engine.frame,a.startFrame);assert.equal(a.engine.audition.status,'playing');
  b.engine.frame=b.startFrame;b.engine.resetDSP();b.engine.command({type:'configure',inputGain:1,monitor:true,inputMix:mix});b.engine.sourceEndFrame=b.startFrame+1807;b.engine.command({type:'play'});
  const lead=b.samples('voice'),actual=a.run(2107,()=>.9),expected=b.run(2107,i=>lead[i]||0);for(let i=0;i<2107;i++){assert(Math.abs(actual.l[i]-expected.l[i])<1e-6,`L mismatch at ${i}`);assert(Math.abs(actual.r[i]-expected.r[i])<1e-6,`R mismatch at ${i}`);}a.run(1);assert.equal(a.engine.playing,false);assert.equal(a.engine.audition,null);assert(a.events.some(e=>e.type==='audition-end'&&e.reason==='complete'));assert.equal(a.engine.sourceEndFrame,Infinity);
});

test('live vocal mixer updates audition immediately and Stop cancels without recording',()=>{
  const h=harness();h.arm({id:'voice',assetId:'voice',kind:'vocal'});h.run(4000,i=>Math.sin(i*.11)*.3);h.engine.command({type:'finish'});h.run(1);h.engine.command({type:'stop'});
  h.engine.command({type:'audition',take:{id:'take',assetId:'voice',frames:4000,startFrame:0,mix:{volume:1,highpass:0,compression:0,reverb:0,delay:0}},tailFrames:0});const loud=h.run(1500);h.engine.command({type:'mix',id:'take',mix:{volume:0}});const quiet=h.run(1500);assert(loud.l.slice(1000).some(x=>Math.abs(x)>.05));assert(quiet.l.slice(1000).every(x=>Math.abs(x)<1e-6));h.engine.command({type:'stop'});assert.equal(h.engine.audition,null);assert.equal(h.engine.capture,null);assert.equal(h.engine.playing,false);assert.equal(h.engine.caches.size,0);
});

test('audition loads before advancing and can be cancelled before page arrival',()=>{
  const h=harness();h.engine.command({type:'audition',take:{id:'take',assetId:'unloaded',frames:4000,startFrame:1234,mix:{}}});assert.equal(h.engine.audition.status,'loading');h.run(500);assert.equal(h.engine.frame,1234);h.engine.command({type:'stop'});h.engine.storageMessage({type:'page',assetId:'unloaded',index:0,frames:256,channels:1,buffer:new Float32Array(256).buffer});h.run(500);assert.equal(h.engine.playing,false);assert.equal(h.engine.audition,null);assert(!h.events.some(e=>e.type==='audition-start'));
});

test('cancelling a provisional first loop restores empty base while compensation tail is pending',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({lengthFrames:1000});h.run(1001,()=>.1);assert.equal(h.engine.baseFrames,1000);assert.equal(h.engine.capture.status,'finishing');h.engine.command({type:'cancel'});assert.equal(h.engine.baseFrames,0);assert.equal(h.engine.tracks.size,0);assert.equal(h.engine.trackList.length,0);
});

test('two long loops sharing an asset keep independent cache windows at conflicting offsets',()=>{
  const h=harness();h.arm({lengthFrames:40007});h.run(40008,i=>Math.sin(i*.018)*.08,97);h.engine.command({type:'track',track:{...h.engine.tracks.get('track').track,id:'shifted',offsetFrames:3072}});
  const first=h.engine.tracks.get('track'),second=h.engine.tracks.get('shifted');assert.notEqual(first.cache,second.cache);assert.equal(h.engine.cacheGroups.get('raw').size,2);h.run(100000,()=>0,97);assert(!h.events.some(e=>e.type==='underrun'));assert.equal(first.cache.slots.length,16);assert.equal(second.cache.slots.length,16);
  h.engine.command({type:'remove-track',id:'track'});assert.equal(h.engine.cacheGroups.get('raw').size,1);assert.equal(h.engine.caches.get('raw'),second.cache);h.run(20000,()=>0,97);assert(!h.events.some(e=>e.type==='underrun'));h.engine.command({type:'remove-track',id:'shifted'});assert.equal(h.engine.cacheGroups.size,0);assert.equal(h.engine.caches.size,0);
});

test('audition can read a long vocal that is also layered at a different loop phase',()=>{
  const h=harness();h.arm({assetId:'voice',kind:'vocal'});h.run(40007,i=>Math.sin(i*.014)*.08,103);h.engine.command({type:'finish'});h.run(1);h.engine.command({type:'track',track:{id:'layer',assetId:'voice',frames:40007,channels:1,offsetFrames:3072,mix:{volume:.5}}});h.engine.command({type:'stop'});h.engine.command({type:'audition',take:{id:'take',assetId:'voice',frames:40007,startFrame:0,mix:{volume:.5}},tailFrames:0});assert.equal(h.engine.cacheGroups.get('voice').size,2);h.run(40008,()=>0,103);assert(!h.events.some(e=>e.type==='underrun'));assert.equal(h.engine.audition,null);assert.equal(h.engine.cacheGroups.get('voice').size,1);
});

test('capture snapshot contains actual boundary section, latest mixer, spotlight and frozen alignment',()=>{
  const h=harness();h.arm({lengthFrames:1000});h.run(1001,()=>.1);h.engine.command({type:'configure',compensationFrames:80});h.arm({id:'lead',assetId:'lead',kind:'vocal',masterAssetId:'master',quantized:true});h.engine.command({type:'section',section:{id:'quiet',tracks:{track:{muted:true,mix:{volume:.23,pan:.4}}}}});h.engine.command({type:'configure',masterVolume:.61,inputGain:1.3,compensationFrames:300});h.engine.command({type:'spotlight',active:true});h.run(1000);
  const start=h.events.find(e=>e.type==='capture-start'&&e.captureId==='lead'),snapshot=start.initialState;assert.equal(start.startFrame,2000);assert.equal(snapshot.frame,2000);assert.equal(snapshot.tracks[0].muted,true);assert.equal(snapshot.tracks[0].mix.volume,.23);assert.equal(snapshot.tracks[0].mix.pan,.4);assert.equal(snapshot.master.volume,.61);assert.equal(snapshot.input.gain,1.3);assert.equal(snapshot.input.compensationMs,10);assert.equal(snapshot.spotlight,true);assert(h.events.findIndex(e=>e.type==='section'&&e.id==='quiet')<h.events.indexOf(start));
  h.engine.command({type:'mix',id:'track',mix:{volume:.9}});assert.equal(snapshot.tracks[0].mix.volume,.23);
});

test('Stop silences speakers and monitor immediately without erasing compensated master ending',()=>{
  const h=harness();h.arm({lengthFrames:1800});h.run(1801,i=>Math.sin(i*.06)*.2);h.engine.vocalDSP.reset();h.engine.vocalFX.reset();h.engine.command({type:'configure',compensationFrames:160,monitor:false});h.arm({id:'lead',assetId:'lead',masterAssetId:'master',kind:'vocal'});const before=h.run(700,()=>0);h.engine.command({type:'stop'});const after=h.run(161,()=>0);assert(after.l.every(x=>x===0));assert(after.r.every(x=>x===0));assert.equal(h.engine.monitor,false);const master=h.samples('master');for(let i=0;i<700;i++)assert(Math.abs(master[i*2]-before.l[i])<2e-6,`ending lost at ${i}`);
  h.engine.command({type:'configure',monitor:true});assert(h.run(500,()=>.3).l.some(x=>Math.abs(x)>.01));h.engine.command({type:'stop'});assert(h.run(500,()=>.3).l.every(x=>x===0));
});

test('a section restores saved solo membership at its exact in-block boundary',()=>{
  const h=harness();h.arm({lengthFrames:1003,track:{id:'track',mix:{volume:1,pan:-1,highpass:0,compression:0,reverb:0,delay:0}}});h.run(1004,i=>Math.sin(i*.03)*.2);h.engine.command({type:'track',track:{...h.engine.tracks.get('track').track,id:'right',mix:{volume:1,pan:1,highpass:0,compression:0,reverb:0,delay:0}}});h.engine.command({type:'section',section:{id:'left-only',tracks:{track:{muted:false,solo:true},right:{muted:false,solo:false}}}});const audio=h.run(1500,()=>0,237);assert.equal(h.events.find(e=>e.type==='section'&&e.id==='left-only').projectFrame,2006);assert.equal(h.engine.tracks.get('track').track.solo,true);assert.equal(h.engine.tracks.get('right').track.solo,false);assert(audio.r.slice(200,800).some(x=>Math.abs(x)>.05));assert(audio.r.slice(1400).every(x=>Math.abs(x)<.00002));assert(audio.l.slice(1400).some(x=>Math.abs(x)>.05));
});

test('DSP accepts the full project high-pass range and shared delay range',()=>{
  assert.equal(cleanMix({highpass:2000}).highpass,2000);assert.equal(cleanMix({highpass:5000}).highpass,2000);assert.equal(cleanMix({delay:1}).delay,.75);
});

test('stereo loop archives downmix both channels instead of discarding right-only audio',()=>{
  const h=harness();const stereo=new Float32Array(512);for(let i=0;i<256;i++)stereo[i*2+1]=Math.sin(i*.1)*.4;h.engine.command({type:'page',assetId:'stereo',index:0,frames:256,channels:2,buffer:stereo.buffer});h.engine.command({type:'track',track:{id:'stereo',assetId:'stereo',frames:256,channels:2,mix:{volume:1,pan:0,highpass:0,compression:0,reverb:0,delay:0}}});h.engine.command({type:'play'});const audio=h.run(1000);assert(audio.l.some(x=>Math.abs(x)>.05));for(let i=0;i<audio.l.length;i++)assert(Math.abs(audio.l[i]-audio.r[i])<1e-7);
});
