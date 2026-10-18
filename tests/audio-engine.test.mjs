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

test('cancelling a queued section prevents an undone change from returning at its boundary',()=>{
  const h=harness();h.arm({lengthFrames:1000});h.run(1200,()=>.1);
  const before={...h.engine.tracks.get('track').track.mix};
  h.engine.command({type:'section',section:{id:'quiet',tracks:{track:{muted:true,mix:{volume:.1}}}}});
  assert.equal(h.engine.pendingSection.frame,2000);
  h.engine.command({type:'cancel-section'});h.run(2000);
  assert.equal(h.engine.pendingSection,null);assert.equal(!!h.engine.tracks.get('track').track.muted,false);
  assert.deepEqual(h.engine.tracks.get('track').track.mix,before);
  assert.equal(h.events.filter(event=>event.type==='section').length,0);
  assert.equal(h.engine.playing,true);assert.equal(h.engine.frame,3200);
});

test('deleting one section cancels only its matching queued launch',()=>{
  const h=harness();h.arm({lengthFrames:1000});h.run(1200,()=>.1);
  h.engine.command({type:'section',section:{id:'next',tracks:{track:{muted:true,mix:{volume:.1}}}}});
  h.engine.command({type:'cancel-section',id:'different'});assert.equal(h.engine.pendingSection.section.id,'next');
  h.engine.command({type:'cancel-section',id:'next'});assert.equal(h.engine.pendingSection,null);
  h.run(1000);assert.equal(h.events.filter(event=>event.type==='section').length,0);
  h.engine.command({type:'section',section:{id:'later',tracks:{track:{muted:true,mix:{volume:.3}}}}});
  h.run(1000);assert.equal(h.events.filter(event=>event.type==='section').at(-1).id,'later');
  assert.equal(h.engine.tracks.get('track').track.muted,true);
});

test('bounded cache preserves opening pages while rolling through a long asset',()=>{
  const c=new PageCache(16,1,2,4);for(let n=0;n<2000;n++)c.write(n,n);assert.equal(c.slots.length,6);assert.equal(c.sample(0),0);assert.equal(c.sample(31),31);assert.equal(c.sample(1999),1999);assert(Number.isNaN(c.sample(500)));
});

test('long recorded loops play from bounded cache through wrap and reclaimed pages',()=>{
  const h=harness({pageFrames:256});h.arm({lengthFrames:12007});h.run(12008,i=>Math.sin(i*.02)*.1,93);assert.equal(h.engine.caches.get('raw').slots.length,16);h.run(40000,()=>0,93);assert(!h.events.some(e=>e.type==='underrun'));assert.equal(h.engine.caches.get('raw').slots.length,16);assert.equal(h.engine.missing.size,0);
});

test('asynchronous read-ahead across wrap cannot evict the page currently playing',()=>{
  // These lengths made the final page alias page 4 in the old modulo cache.
  for(const pages of [53,65]){
    const pageFrames=256,frames=(pages-1)*pageFrames+223,events=[],pending=[];
    const engine=new LoopEngine({sampleRate:8000,pageFrames,post:event=>events.push(event)});
    engine.command({type:'storage-port',port:{postMessage(message){if(message.type==='read')pending.push({...message,due:engine.clock+128});}}});
    engine.command({type:'track',track:{id:'wrap',assetId:'wrap',frames,channels:1,offsetFrames:1000,mix:{volume:1,highpass:0,compression:0,reverb:0,delay:0}}});
    const input=new Float32Array(64),left=new Float32Array(64),right=new Float32Array(64);
    function block(){
      for(let index=pending.length-1;index>=0;index--)if(pending[index].due<=engine.clock){const message=pending.splice(index,1)[0],length=Math.min(pageFrames,frames-message.index*pageFrames),pcm=new Float32Array(length);for(let i=0;i<length;i++)pcm[i]=Math.sin((message.index*pageFrames+i)*.07)*.2;engine.storageMessage({type:'page',assetId:'wrap',index:message.index,frames:length,channels:1,buffer:pcm.buffer});}
      engine.process(input,left,right);
    }
    while(!events.some(event=>event.type==='track-ready')){block();assert(engine.clock<8000);}
    engine.command({type:'play'});
    while(engine.frame<frames*3)block();
    assert.deepEqual(events.filter(event=>event.type==='underrun'),[],`${pages}-page wrap produced a gap`);
    const cache=engine.tracks.get('wrap').cache;assert.equal(cache.slots.length,16);assert(cache.pageSlots.size<=12);assert(cache.pending.size<=32);
  }
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

test('an edited replacement changes the same loop from mono to stereo and wraps at its new length',()=>{
  const h=harness({pageFrames:256});
  function source(id,frames,channels){
    const pages=new Map();
    for(let start=0,index=0;start<frames;start+=256,index++){
      const count=Math.min(256,frames-start),pcm=new Float32Array(count*channels);
      for(let frame=0;frame<count;frame++)for(let channel=0;channel<channels;channel++)pcm[frame*channels+channel]=Math.sin((start+frame)*(channel?.07:.03)+channel)*.1;
      pages.set(index,{buffer:pcm.buffer,frames:count,channels});
    }
    h.assets.set(id,{pages,frames,channels,status:'complete'});
  }
  source('original',1003,1);source('edited',613,2);
  const track={id:'same-loop',assetId:'original',frames:1003,channels:1,offsetFrames:97,mix:{volume:1,pan:0,highpass:0,compression:0,reverb:0,delay:0}};
  h.engine.command({type:'configure',baseFrames:1003});
  h.engine.command({type:'track',track});h.engine.command({type:'play'});h.run(1500);
  h.engine.command({type:'stop'});
  h.engine.command({type:'track',track:{...track,assetId:'edited',frames:613,channels:2}});
  assert.equal(h.engine.tracks.size,1);
  assert.equal(h.engine.tracks.get(track.id).cache.channels,2);
  assert.equal(h.engine.baseFrames,1003);
  h.engine.command({type:'play'});const sound=h.run(613*4,()=>0,73);
  assert(sound.l.some(sample=>Math.abs(sample)>.01));
  // Loop playback deliberately downmixes stereo sources before the per-layer
  // vocal DSP; both channels must reach its new cache without stale mono data.
  assert(sound.r.some(sample=>Math.abs(sample)>.01));
  assert(h.reads.some(read=>read.assetId==='edited'&&read.index===2));
  assert.equal(h.engine.tracks.get(track.id).cache.sample(612,1),new Float32Array(h.assets.get('edited').pages.get(2).buffer)[201]);
  assert(!h.events.some(event=>event.type==='underrun'));
  assert.equal(h.samples('original').length,1003);
  assert.equal(h.engine.tracks.get(track.id).track.frames,613);
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

test('compensated vocal controls apply exactly C frames later while command acknowledgement stays musical',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200,inputMix:{volume:1,highpass:0,compression:0,reverb:0,delay:0}});h.arm({kind:'vocal',masterAssetId:'master'});h.run(500,()=>.2);h.engine.command({type:'configure',inputMix:{volume:.3}});const ack=h.events.filter(e=>e.type==='command'&&e.inputMix?.volume===.3).at(-1);assert.equal(ack.frame,500);assert.equal(h.engine.vocalDSP.mix.volume,1);assert.equal(h.engine.inputMixTarget.volume,.3);h.run(200,()=>.2);assert.equal(h.engine.vocalDSP.mix.volume,1);h.run(1,()=>.2);assert.equal(h.engine.vocalDSP.mix.volume,.3);
});

test('recorded vocal FX automation matches uncompensated musical replay sample-for-sample',()=>{
  const h=harness(),ref=harness(),mix={volume:1,pan:-1,highpass:0,compression:0,reverb:0,delay:0};h.engine.command({type:'configure',compensationFrames:160,inputMix:mix});ref.engine.command({type:'configure',monitor:true,inputMix:mix});h.run(2000);ref.run(2000);h.arm({kind:'vocal',masterAssetId:'master'});ref.engine.command({type:'play'});const startClock=h.engine.clock,source=(_,clock)=>clock>=startClock+160?Math.sin((clock-startClock-160)*.1)*.2:0;
  h.run(300,source);const first=ref.run(300,i=>Math.sin(i*.1)*.2);h.engine.command({type:'configure',inputMix:{volume:.3,low:3}});ref.engine.command({type:'configure',inputMix:{volume:.3,low:3}});h.run(900,source);const next=ref.run(900,i=>Math.sin((i+300)*.1)*.2);h.engine.command({type:'finish'});h.run(161,source);const recorded=h.samples('master'),expected=new Float32Array(1200);expected.set(first.l);expected.set(next.l,300);for(let i=0;i<1200;i++)assert(Math.abs(recorded[i*2]-expected[i])<2e-6,`vocal automation moved at ${i}`);
});

test('cancel and Stop drain clear queued vocal-control changes before a subsequent take',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({kind:'vocal'});h.run(500);h.engine.command({type:'configure',inputMix:{volume:.31}});h.engine.command({type:'cancel'});assert.equal(h.engine.inputMixQueue.length,0);assert.equal(h.engine.vocalDSP.mix.volume,.31);
  h.arm({id:'again',assetId:'again',kind:'vocal',track:{id:'again-track',mix:{volume:.31}}});h.run(500);h.engine.command({type:'configure',inputMix:{volume:.72}});h.engine.command({type:'stop'});h.run(201);assert.equal(h.engine.inputMixQueue.length,0);assert.equal(h.engine.vocalDSP.mix.volume,.72);h.engine.command({type:'configure',compensationFrames:0,inputMix:{volume:.44}});h.arm({id:'third',assetId:'third',kind:'vocal',track:{id:'third-track',mix:{volume:.44}}});h.run(400);assert.equal(h.engine.vocalDSP.mix.volume,.44);
});

test('section membership never inherits object prototype names from imported track identifiers',()=>{
  const h=harness();h.engine.command({type:'track',track:{id:'constructor',assetId:'raw',frames:1000,channels:1,mix:{}}});h.engine.applySection({id:'empty',tracks:{}});assert.equal(h.engine.tracks.get('constructor').track.muted,true);assert.equal(h.engine.tracks.get('constructor').track.solo,false);
});

test('metronome ticks use exact rounded frame origins without cumulative tempo drift',()=>{
  const h=harness();h.engine.command({type:'configure',metronome:{enabled:true,bpm:137,beatsPerCycle:4}});h.engine.command({type:'play'});const audio=h.run(80000,()=>0,193),ticks=h.events.filter(e=>e.type==='click');assert(ticks.length>20);for(let i=0;i<ticks.length;i++)assert.equal(ticks[i].projectFrame,Math.round(i*8000*60/137));assert(audio.l.some(x=>Math.abs(x)>.1));h.engine.command({type:'stop'});assert(h.run(1000).l.every(x=>x===0));
});

test('with a base loop the click follows cycle divisions instead of the prior BPM',()=>{
  const h=harness();h.engine.command({type:'configure',baseFrames:10007,metronome:{enabled:true,bpm:200,beatsPerCycle:7}});h.engine.command({type:'play'});h.run(30022,()=>0,237);const ticks=h.events.filter(e=>e.type==='click');for(let i=0;i<ticks.length;i++){assert.equal(ticks[i].projectFrame,Math.round(i*10007/7));assert.equal(ticks[i].accent,i%7===0);}assert.equal(ticks[7].projectFrame,10007);assert.equal(ticks[14].projectFrame,20014);
});

test('count-in holds the empty musical origin and starts compensated capture at frame zero',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:100,metronome:{enabled:false,bpm:137,countInBeats:4}});h.arm();const duration=Math.round(4*8000*60/137);assert.equal(h.engine.capture.status,'counting');const countAudio=h.run(duration,(_,clock)=>clock/100000,213);assert.equal(h.engine.frame,0);assert.equal(h.engine.capture.raw.frames,0);assert(countAudio.l.some(x=>Math.abs(x)>.01));const counts=h.events.filter(e=>e.type==='count-in');assert.equal(counts.length,4);for(let i=0;i<4;i++)assert.equal(counts[i].clockFrame,Math.round(i*8000*60/137));h.run(1003,(_,clock)=>clock/100000,213);assert.equal(h.events.find(e=>e.type==='capture-start').clockFrame,duration);assert.equal(h.events.find(e=>e.type==='capture-start').startFrame,0);h.engine.command({type:'finish'});h.run(101,(_,clock)=>clock/100000);const raw=h.samples('raw');assert.equal(raw.length,1003);assert(Math.abs(raw[0]-(duration+100)/100000)<1e-7);assert.equal(h.engine.baseFrames,1003);
});

test('cancel, Finish, Stop and input interruption during count-in cannot later start a recording',()=>{
  for(const command of ['cancel','finish','stop','interrupt']){const h=harness();h.engine.command({type:'configure',metronome:{enabled:true,bpm:240,countInBeats:4}});h.arm();h.run(500);h.engine.command({type:command});const output=h.run(9000);assert.equal(h.engine.capture,null,command);assert.equal(h.engine.baseFrames,0,command);assert.equal(h.engine.playing,false,command);assert(output.l.every(x=>x===0),command);assert(!h.events.some(e=>e.type==='capture-start'),command);assert.equal(h.samples('raw').length,0,command);}
});

test('existing loops use cycle alignment without adding an extra count-in',()=>{
  const h=harness();h.engine.command({type:'configure',baseFrames:1000,metronome:{enabled:true,bpm:100,countInBeats:8}});h.engine.command({type:'play'});h.run(333);h.arm({quantized:true,lengthFrames:1000});assert.equal(h.engine.capture.status,'arming');h.run(668);assert.equal(h.events.find(e=>e.type==='capture-start').startFrame,1000);assert(!h.events.some(e=>e.type==='count-in'));
});

test('monitor click never enters captured raw audio or stereo master, including compensation history',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:160,metronome:{enabled:true,bpm:240,volume:.5}});h.arm({kind:'vocal',masterAssetId:'master'});const output=h.run(9000,()=>0);h.engine.command({type:'finish'});h.run(161,()=>0);assert(output.l.some(x=>Math.abs(x)>.1));assert(h.samples('raw').every(x=>x===0));assert(h.samples('master').every(x=>x===0));
});

for(const boundary of [2**31,2**32]){
  test(`continuous compensated capture crosses frame ${boundary} with identical backing phase and master audio`,()=>{
    const high=harness(),reference=harness(),compensation=160,warmup=compensation+37;
    for(const h of [high,reference]){h.arm({lengthFrames:1003});h.run(1004,i=>Math.sin(i*.031)*.15);h.engine.command({type:'configure',compensationFrames:compensation});h.engine.resetDSP();}
    const origin=boundary-173;
    high.engine.frame=origin-warmup;high.engine.clock=origin-warmup;
    reference.engine.frame=((origin-warmup)%1003+1003)%1003;reference.engine.clock=1000;
    for(const h of [high,reference]){h.run(warmup);h.arm({id:'lead',assetId:'lead',masterAssetId:'master',kind:'vocal'});h.run(703,i=>Math.sin(i*.049)*.2,61);h.engine.command({type:'finish'});h.run(compensation+1,i=>Math.cos(i*.029)*.1,37);}
    assert.deepEqual(high.samples('lead'),reference.samples('lead'));assert.deepEqual(high.samples('master'),reference.samples('master'));
    const start=high.events.find(event=>event.type==='capture-start'&&event.captureId==='lead'),end=high.events.find(event=>event.type==='capture-end'&&event.captureId==='lead');
    assert.equal(start.startFrame,origin);assert.equal(start.clockFrame,origin);assert.equal(end.frames,703);assert.equal(end.endFrame,origin+703);assert.equal(end.clockFrame,origin+703+compensation);
    assert.equal(high.engine.frame,origin+703+compensation+1);assert.equal(high.engine.clock,high.engine.frame);assert(!high.events.some(event=>event.type==='underrun'));
  });

  test(`quantized sections and multi-cycle loop offsets retain exact frames around ${boundary}`,()=>{
    const h=harness(),cycle=4003,compensation=211,target=Math.floor(boundary/cycle)*cycle;
    h.arm({lengthFrames:cycle});h.run(cycle+1,i=>Math.sin(i*.013)*.1);
    h.engine.frame=target-128;h.engine.clock=boundary-128;h.engine.resetDSP();h.engine.command({type:'configure',compensationFrames:compensation});
    h.engine.command({type:'section',section:{id:'new-section',tracks:{track:{muted:true,mix:{volume:.3}}}}});
    h.arm({id:'long-cycle',assetId:'long-cycle',kind:'loop',quantized:true,lengthFrames:cycle*2,track:{id:'long-cycle',mix:{volume:.6}}});
    h.run(128+cycle*2+compensation+1,(_,clock)=>(clock-(boundary-128))/100000,237);
    const section=h.events.find(event=>event.type==='section'&&event.id==='new-section'),start=h.events.find(event=>event.type==='capture-start'&&event.captureId==='long-cycle'),end=h.events.find(event=>event.type==='capture-end'&&event.captureId==='long-cycle');
    assert.equal(section.projectFrame,target);assert.equal(section.clockFrame,boundary);assert.equal(start.startFrame,target);assert.equal(start.initialState.tracks[0].muted,true);assert.equal(start.initialState.tracks[0].mix.volume,.3);
    assert.equal(end.frames,cycle*2);assert.equal(end.endFrame,target+cycle*2);assert.equal(end.clockFrame,boundary+cycle*2+compensation);assert.equal(end.track.offsetFrames,target%(cycle*2));assert.equal(h.samples('long-cycle').length,cycle*2);
    assert(Math.abs(h.samples('long-cycle')[0]-(128+compensation)/100000)<1e-8);assert(!h.events.some(event=>event.type==='underrun'));
  });
}

test('count-in crosses an unsigned 32-bit audio clock while preserving beat numbers and zero musical origin',()=>{
  const h=harness(),origin=2**32-4000;
  h.engine.clock=origin;h.engine.frame=2**32-123;h.engine.command({type:'configure',compensationFrames:200,metronome:{bpm:240,countInBeats:4}});h.arm();
  h.run(8000);assert.equal(h.engine.frame,0);assert.deepEqual(h.events.filter(event=>event.type==='count-in').map(event=>[event.beat,event.clockFrame]),[1,2,3,4].map((beat,index)=>[beat,origin+index*2000]));
  h.run(657,i=>i/10000);h.engine.command({type:'finish'});h.run(201,i=>(i+657)/10000);
  const start=h.events.find(event=>event.type==='capture-start'),end=h.events.find(event=>event.type==='capture-end');assert.equal(start.startFrame,0);assert.equal(start.clockFrame,origin+8000);assert.equal(end.frames,657);assert.equal(end.endFrame,657);assert.equal(end.clockFrame,origin+8000+657+200);assert.equal(h.samples('raw').length,657);
});

test('page tags and writer totals preserve values beyond unsigned 32-bit frames and page indexes',()=>{
  const pageFrames=256,cache=new PageCache(pageFrames),largePage=2**32+7;
  cache.put(largePage,new Float32Array(pageFrames).fill(.25).buffer,pageFrames,1);
  cache.put(7,new Float32Array(pageFrames).fill(.5).buffer,pageFrames,1);
  assert.equal(cache.sample(largePage*pageFrames+17),.25);assert.equal(cache.sample(7*pageFrames+17),.5);
  for(const frame of [2**31+17,2**32+17]){cache.write(frame,.75);assert.equal(cache.sample(frame),.75);assert(cache.has(Math.floor(frame/pageFrames)));}

  // Seed already-written history rather than allocating hours of PCM. Only the
  // final page and endpoint transition execute, using normal writer methods.
  for(const prefix of [2**32-55,2**32*pageFrames-55]){
  const events=[],writes=[],sealed=[],engine=new LoopEngine({sampleRate:8000,pageFrames,post:event=>events.push(event)});
  engine.command({type:'storage-port',port:{postMessage(message){if(message.type==='write'){writes.push({assetId:message.assetId,index:message.index,frames:message.frames,channels:message.channels});engine.storageMessage({type:'recycle',buffer:structuredClone(message.buffer,{transfer:[message.buffer]})});}else if(message.type==='end')sealed.push(message);}}});
  engine.command({type:'pool',buffers:Array.from({length:4},()=>new ArrayBuffer(pageFrames*8))});
  engine.command({type:'arm',capture:{id:'long-vocal',assetId:'raw',masterAssetId:'master',kind:'vocal'}});
  engine.process(new Float32Array(1),new Float32Array(1),new Float32Array(1));
  const capture=engine.capture;engine.clock=prefix;engine.frame=prefix;
  for(const writer of [capture.raw,capture.master]){writer.frames=prefix;writer.index=Math.floor(prefix/pageFrames);writer.offset=prefix%pageFrames;writer.buffer.fill(0);}
  engine.process(new Float32Array(211).fill(.2),new Float32Array(211),new Float32Array(211));engine.command({type:'finish'});engine.process(new Float32Array(1),new Float32Array(1),new Float32Array(1));
  assert.equal(engine.capture,null);assert.equal(events.find(event=>event.type==='capture-end').frames,prefix+211);assert.equal(events.find(event=>event.type==='capture-end').endFrame,prefix+211);
  for(const id of ['raw','master']){assert.deepEqual(writes.filter(write=>write.assetId===id).map(write=>[write.index,write.frames]),[[Math.floor(prefix/pageFrames),256],[Math.floor(prefix/pageFrames)+1,156]]);assert.equal(sealed.find(item=>item.assetId===id).frames,prefix+211);}
  }
});

function storedLoop(h, { id, frames=1003, muted=false, solo=false, mix={} }, source) {
  const assetId=`source-${id}`,pages=new Map();
  for(let at=0,index=0;at<frames;at+=h.engine.pageFrames,index++){
    const pcm=Float32Array.from({length:Math.min(h.engine.pageFrames,frames-at)},(_,i)=>source(at+i));
    pages.set(index,{buffer:pcm.buffer,frames:pcm.length,channels:1});
  }
  h.assets.set(assetId,{pages,channels:1,frames,status:'complete'});
  h.engine.command({type:'track',track:{id,assetId,frames,channels:1,muted,solo,offsetFrames:0,mix:{volume:.6,pan:0,highpass:0,compression:0,reverb:0,delay:0,...mix}}});
  return assetId;
}

test('loop-only stereo capture is the all-unmuted backing mix, excluding mic, vocal effects, metronome and preview',()=>{
  const actual=harness(),reference=harness();
  for(const h of [actual,reference]){
    storedLoop(h,{id:'left',solo:h===actual,mix:{pan:-.7,reverb:.2,delay:.15}},i=>Math.sin(i*.041)*.2);
    storedLoop(h,{id:'right',mix:{pan:.8,low:3}},i=>Math.cos(i*.092)*.17);
    storedLoop(h,{id:'muted',muted:true,mix:{volume:2}},i=>Math.sin(i*.3)*.9);
    h.engine.command({type:'configure',baseFrames:1003,masterVolume:.7});
  }
  actual.engine.command({type:'configure',monitor:true,compensationFrames:777,inputGain:4,inputMix:{volume:2,reverb:1,delay:.75},metronome:{enabled:true,volume:1}});
  actual.engine.command({type:'preview-take',take:{assetId:'source-muted',frames:1003,channels:1}});
  actual.arm({kind:'mix',assetId:'loops'});reference.engine.command({type:'play'});
  const expected=[],monitor=[];
  for(const [frames,commands] of [[2107,[{type:'mix',id:'left',muted:true}]], [1119,[{type:'mix',id:'right',mix:{volume:.3,pan:-.5,reverb:.4}},{type:'configure',masterVolume:1.1}]], [2041,[]]]){
    const output=actual.run(frames,(_,clock)=>Math.sin(clock*.17)*.95,73),backing=reference.run(frames,()=>0,73);
    expected.push(backing);monitor.push(output);
    for(const command of commands){actual.engine.command(command);reference.engine.command(command);}
  }
  actual.engine.command({type:'finish'});actual.run(1);
  const pcm=actual.samples('loops'),end=actual.events.find(e=>e.type==='capture-end');
  assert.equal(actual.assets.get('loops').channels,2);assert.equal(end.frames,5267);assert.equal(pcm.length,5267*2);
  assert.equal(end.compensationFrames,0);assert.equal(end.masterAssetId,undefined);
  assert.deepEqual([...actual.engine.tracks.keys()],['left','right','muted']);
  assert(actual.events.some(e=>e.type==='meter'&&e.capture?.kind==='mix'&&e.captureLevel>.02&&e.captureRms>.005));
  let at=0,difference=0;
  for(let segment=0;segment<expected.length;segment++)for(let i=0;i<expected[segment].l.length;i++,at++){
    assert.equal(pcm[at*2],monitor[segment].l[i],`captured left matches monitor at ${at}`);
    assert.equal(pcm[at*2+1],monitor[segment].r[i],`captured right matches monitor at ${at}`);
    assert.equal(pcm[at*2],expected[segment].l[i],`backing-only left at ${at}`);
    assert.equal(pcm[at*2+1],expected[segment].r[i],`backing-only right at ${at}`);
    difference+=Math.abs(pcm[at*2]-pcm[at*2+1]);
  }
  assert(difference>10,'Stereo panning is retained');
  assert(!actual.engine.caches.has('loops'),'A completed stereo mix must not become a loop or leak a capture cache');
});

test('loop-only capture stays silent with every loop muted despite a live microphone and residual vocal effects',()=>{
  const h=harness();storedLoop(h,{id:'muted',muted:true},i=>Math.sin(i*.05)*.5);
  h.engine.command({type:'configure',monitor:true,inputMix:{volume:2,reverb:1,delay:.75},metronome:{enabled:true,volume:1}});
  h.run(3000,()=>.8);h.arm({kind:'mix',assetId:'muted-mix'});const output=h.run(5000,()=>.9);
  h.engine.command({type:'finish'});h.run(1);
  assert(h.samples('muted-mix').every(x=>x===0));assert(output.l.every(x=>x===0));assert(output.r.every(x=>x===0));
  const meter=h.events.filter(e=>e.type==='meter'&&e.capture?.kind==='mix').at(-1);
  assert.equal(meter.captureLevel,0);assert.equal(meter.captureRms,0);assert(meter.inputLevel>.5);
});

test('loop-only capture starts on the next cycle and stops exactly without mic compensation or transport reset',()=>{
  const h=harness();storedLoop(h,{id:'loop'},i=>Math.sin(i*.05)*.2);
  h.engine.command({type:'configure',baseFrames:1003,compensationFrames:700,metronome:{countInBeats:8}});
  h.engine.command({type:'play'});h.run(421);h.arm({kind:'mix',assetId:'song',quantized:true});
  h.run(2500);const start=h.events.find(e=>e.type==='capture-start');assert.equal(start.startFrame,1003);assert.equal(start.compensationFrames,0);
  const stoppedAt=h.engine.frame;h.engine.command({type:'stop'});h.run(1);
  const end=h.events.find(e=>e.type==='capture-end');assert.equal(end.frames,stoppedAt-1003);assert.equal(end.endFrame,stoppedAt);
  assert.equal(h.samples('song').length,(stoppedAt-1003)*2);assert.equal(h.engine.frame,stoppedAt);assert.equal(h.engine.playing,false);
});

test('cancelling loop-only capture leaves source loops intact and releases capture memory',()=>{
  const h=harness();storedLoop(h,{id:'track'},i=>Math.sin(i*.07)*.1);
  for(let i=0;i<12;i++){
    h.arm({kind:'mix',id:`mix-${i}`,assetId:`mix-asset-${i}`});h.run(700);h.engine.command({type:'cancel'});
    assert.equal(h.engine.tracks.size,1);assert(h.engine.tracks.has('track'));assert.equal(h.engine.capture,null);assert.equal(h.engine.caches.size,1);
    assert.equal(h.assets.get(`mix-asset-${i}`).status,'cancelled');
  }
  assert(h.run(1000).l.some(x=>Math.abs(x)>.01));
});

test('loop-only capture preserves a valid stereo prefix on storage backpressure',()=>{
  const h=harness({pool:2,autoRecycle:false});storedLoop(h,{id:'track'},i=>Math.sin(i*.04)*.2);
  h.arm({kind:'mix',assetId:'prefix'});h.run(1300);
  const end=h.events.find(e=>e.type==='capture-end');assert.equal(end.status,'interrupted');assert.equal(end.reason,'write-buffer-exhausted');assert.equal(end.frames,512);
  assert.equal(h.assets.get('prefix').channels,2);assert.equal(h.samples('prefix').length,1024);assert(h.samples('prefix').some(x=>Math.abs(x)>.01));
  assert.equal(h.engine.tracks.size,1);assert.equal(h.engine.capture,null);assert.equal(h.engine.playing,true);
});

for(const kind of ['loop','vocal','mix'])test(`immediate ${kind} capture starts on the next quantum first sample without waiting for a playing loop boundary`,()=>{
  const h=harness();h.arm({lengthFrames:1003});h.run(1337,()=>.1);const startFrame=h.engine.frame,startClock=h.engine.clock;
  h.arm({id:'immediate',assetId:'immediate',kind,quantized:false,lengthFrames:0,track:{id:'immediate-track',mix:{volume:1,highpass:0,compression:0,reverb:0,delay:0}}});
  assert.equal(h.engine.frame,startFrame);assert.equal(h.engine.capture.status,'arming');
  h.run(1,()=>.875,1);const start=h.events.find(e=>e.type==='capture-start'&&e.captureId==='immediate');
  assert.equal(start.startFrame,startFrame);assert.equal(start.clockFrame,startClock);assert.equal(h.engine.capture.raw.frames,1);
  if(kind!=='mix')assert.equal(h.engine.capture.cache.sample(0),.875,'The first microphone sample must be retained without a fade or artificial wait.');
  assert.equal(h.engine.baseFrames,1003);assert.equal(h.engine.frame,startFrame+1);
});

test('arbitrary timed first loop starts immediately and establishes its exact duration at any render quantum size',()=>{
  for(const quantum of [1,61,128,237,513]){
    const h=harness();h.engine.command({type:'play'});h.run(421);const startClock=h.engine.clock;
    h.arm({lengthFrames:2347});assert.equal(h.engine.frame,0);h.run(2348,(_,clock)=>(clock-startClock)/10000,quantum);
    const start=h.events.find(e=>e.type==='capture-start'),end=h.events.find(e=>e.type==='capture-end');
    assert.equal(start.clockFrame,startClock);assert.equal(start.startFrame,0);assert.equal(end.frames,2347);assert.equal(end.endFrame,2347);assert.equal(h.engine.baseFrames,2347);
    assert.equal(h.samples('raw')[0],0);assert.equal(h.samples('raw').at(-1),Math.fround(.2346));assert(!h.events.some(e=>e.type==='underrun'));
  }
});

test('an immediate arbitrary length layer keeps existing backing phase and its own offset',()=>{
  const h=harness();h.arm({lengthFrames:1003});h.run(1471,()=>.1);const backing=h.engine.tracks.get('track'),start=h.engine.frame;
  h.arm({id:'custom',assetId:'custom',lengthFrames:761,track:{id:'custom-track',mix:{volume:1,highpass:0,compression:0,reverb:0,delay:0}}});
  h.run(762,()=>.3,113);const end=h.events.find(e=>e.type==='capture-end'&&e.captureId==='custom');
  assert.equal(end.startFrame,start);assert.equal(end.frames,761);assert.equal(end.endFrame,start+761);assert.equal(end.track.offsetFrames,start%761);
  assert.equal(h.engine.tracks.get('track'),backing);assert.equal(backing.track.offsetFrames,0);assert.equal(h.engine.baseFrames,1003);assert.equal(h.engine.frame,start+762);
});

test('existing loops without a shared base never have their transport reset by a new timed loop',()=>{
  const h=harness();h.arm({lengthFrames:1003});h.run(1471,()=>.1);h.engine.command({type:'configure',baseFrames:0});const start=h.engine.frame;
  h.arm({id:'custom',assetId:'custom',lengthFrames:761,track:{id:'custom-track',mix:{volume:1}}});h.run(1,()=>.2);
  assert.equal(h.events.find(e=>e.type==='capture-start'&&e.captureId==='custom').startFrame,start);assert.equal(h.engine.frame,start+1);
});

for(const quantized of [false,true])for(const lengthFrames of [0,6000])test(`Finish ends ${lengthFrames?'timed':'free'} ${quantized?'next-cycle':'immediate'} recording at its requested frame`,()=>{
  const h=harness();h.engine.command({type:'configure',baseFrames:1003});h.engine.command({type:'play'});h.run(421);h.arm({lengthFrames,quantized});
  if(quantized)h.run(1003-421);const start=h.engine.frame;h.run(713,(_,clock)=>clock/10000,61);const stop=h.engine.frame;
  h.engine.command({type:'finish'});assert.equal(h.engine.capture.status,'finishing');assert.equal(h.engine.capture.endFrame,stop);h.run(1);
  const end=h.events.find(e=>e.type==='capture-end');assert.equal(end.startFrame,start);assert.equal(end.frames,713);assert.equal(end.endFrame,stop);assert.equal(end.track.offsetFrames,start%713);
  assert.equal(h.samples('raw').length,713);assert.equal(h.engine.baseFrames,1003);assert.equal(h.engine.playing,true);
});

test('early Finish on a timed first loop drains exactly the frozen compensation and plays the shortened loop immediately',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({lengthFrames:6000});h.run(713,(_,clock)=>clock/10000,61);
  h.engine.command({type:'finish'});const track=h.engine.tracks.get('track');assert.equal(track.track.frames,713);assert.equal(h.engine.baseFrames,713);assert.equal(h.engine.capture.status,'finishing');
  h.run(201,(_,clock)=>clock/10000,73);const pcm=h.samples('raw'),end=h.events.find(e=>e.type==='capture-end');
  assert.equal(pcm.length,713);for(let i=0;i<pcm.length;i++)assert.equal(pcm[i],Math.fround((i+200)/10000));
  assert.equal(end.clockFrame,913);assert.equal(end.endFrame,713);assert.equal(end.compensationFrames,200);assert.equal(h.engine.tracks.get('track'),track);assert(!h.events.some(e=>e.type==='underrun'));
});

test('Finish before the safe minimum waits only for that minimum, never the original timed end',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:200});h.arm({lengthFrames:6000});h.run(73,()=>.25);
  h.engine.command({type:'finish'});assert.equal(h.engine.capture.targetEndFrame,329);h.run(329-73+201,()=>.25);
  const end=h.events.find(e=>e.type==='capture-end');assert.equal(end.frames,329);assert.equal(end.endFrame,329);assert.equal(end.clockFrame,529);assert.equal(h.engine.baseFrames,329);assert(h.samples('raw').every(x=>x===.25));
});

test('opt-in first-loop count-in applies equally to arbitrary timed recording and preserves exact compensated onset',()=>{
  const h=harness();h.engine.command({type:'configure',compensationFrames:100,metronome:{enabled:false,bpm:137,countInBeats:4}});h.arm({lengthFrames:1003});
  const countFrames=Math.round(4*8000*60/137);assert.equal(h.engine.capture.status,'counting');h.run(countFrames,(_,clock)=>clock/100000,237);
  assert.equal(h.engine.frame,0);assert.equal(h.engine.capture.raw.frames,0);h.run(1104,(_,clock)=>clock/100000,61);
  const start=h.events.find(e=>e.type==='capture-start'),end=h.events.find(e=>e.type==='capture-end'),pcm=h.samples('raw');
  assert.equal(start.clockFrame,countFrames);assert.equal(start.startFrame,0);assert.equal(end.frames,1003);assert.equal(end.endFrame,1003);assert.equal(end.clockFrame,countFrames+1103);
  assert.equal(pcm[0],Math.fround((countFrames+100)/100000));assert.equal(pcm.at(-1),Math.fround((countFrames+1102)/100000));assert.equal(h.events.filter(e=>e.type==='count-in').length,4);
});

test('a safe duration whose end overflows the exact audio timeline is rejected before capture changes transport or writes audio',()=>{
  const h=harness();h.engine.command({type:'configure',baseFrames:1003});h.engine.command({type:'play'});h.engine.frame=Number.MAX_SAFE_INTEGER-123;
  const frame=h.engine.frame,clock=h.engine.clock,pool=h.engine.pool.length,caches=h.engine.caches.size;
  h.arm({lengthFrames:1000,quantized:false});
  const rejected=h.events.find(event=>event.type==='capture-rejected');assert.equal(rejected.captureId,'capture');assert.match(rejected.message,/timeline/);
  assert.equal(h.engine.capture,null);assert.equal(h.engine.frame,frame);assert.equal(h.engine.clock,clock);assert.equal(h.engine.playing,true);assert.equal(h.engine.baseFrames,1003);
  assert.equal(h.engine.pool.length,pool);assert.equal(h.engine.caches.size,caches);assert.equal(h.assets.size,0);assert.equal(h.events.some(event=>event.type==='capture-start'),false);
});
