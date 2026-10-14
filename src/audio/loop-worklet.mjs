import {clamp,cleanMix,TrackDSP,SharedFX,softCeiling} from './dsp.mjs';

const positiveModulo=(n,d)=>((n%d)+d)%d;
const integer=(n,lo=0,hi=Number.MAX_SAFE_INTEGER)=>Math.round(clamp(n,lo,hi,lo));

/** Fixed-size opening + rolling page cache. Storage owns the complete recording. */
export class PageCache {
  constructor(pageFrames,channels=1,headPages=4,rollingPages=12) {
    this.pageFrames=pageFrames;this.channels=channels;this.headPages=headPages;this.rollingPages=rollingPages;
    this.slots=Array.from({length:headPages+rollingPages},()=>new Float32Array(pageFrames*channels));
    this.tags=new Float64Array(this.slots.length);this.tags.fill(-1);this.lengths=new Uint32Array(this.slots.length);this.lastUsed=new Float64Array(this.slots.length);this.pageSlots=new Map();this.pending=new Map();this.totalFrames=0;this.sequence=0;this.readIndex=-1;this.readSlot=-1;this.writeIndex=-1;this.writeSlot=-1;
  }
  slot(index){return index<this.headPages?index:this.pageSlots.get(index)??-1;}
  has(index){const slot=this.slot(index);return slot>=0&&this.tags[slot]===index;}
  claim(index){
    let slot=this.slot(index);if(slot>=0&&this.tags[slot]===index)return slot;
    if(index>=this.headPages){slot=this.headPages;for(let i=this.headPages;i<this.slots.length;i++){if(this.tags[i]<0){slot=i;break;}if(this.lastUsed[i]<this.lastUsed[slot])slot=i;}if(this.tags[slot]>=this.headPages)this.pageSlots.delete(this.tags[slot]);this.pageSlots.set(index,slot);}
    // Modulo-by-page-number is unsafe at loop wrap: e.g. pages 52 and 4
    // collide while page 52 is still playing. Bounded LRU retains the reader.
    if(this.readSlot===slot||this.readIndex===index)this.readIndex=-1;if(this.writeSlot===slot||this.writeIndex===index)this.writeIndex=-1;
    this.tags[slot]=index;this.lengths[slot]=0;this.lastUsed[slot]=++this.sequence;return slot;
  }
  put(index,buffer,frames,channels){if(channels!==this.channels)return false;const s=this.claim(index);this.slots[s].set(new Float32Array(buffer,0,frames*channels));this.lengths[s]=frames;this.lastUsed[s]=++this.sequence;this.pending.delete(index);return true;}
  write(frame,x){const index=Math.floor(frame/this.pageFrames),offset=frame%this.pageFrames;if(this.writeIndex!==index){this.writeSlot=this.claim(index);this.writeIndex=index;}const s=this.writeSlot;this.slots[s][offset]=x;this.lengths[s]=offset+1;this.lastUsed[s]=++this.sequence;}
  sample(frame,channel=0){const index=Math.floor(frame/this.pageFrames),offset=frame%this.pageFrames;if(this.readIndex!==index){this.readIndex=index;this.readSlot=this.slot(index);}const s=this.readSlot;if(s<0||this.tags[s]!==index||offset>=this.lengths[s])return NaN;this.lastUsed[s]=++this.sequence;return this.slots[s][offset*this.channels+channel];}
}

class CaptureWriter {
  constructor(engine,assetId,channels){this.engine=engine;this.assetId=assetId;this.channels=channels;this.buffer=null;this.offset=0;this.index=0;this.frames=0;}
  reserve(){if(!this.buffer)this.buffer=this.engine.pool.pop()||null;return !!this.buffer;}
  write(l,r=0){this.buffer[this.offset*this.channels]=l;if(this.channels===2)this.buffer[this.offset*2+1]=r;this.offset++;this.frames++;if(this.offset===this.engine.pageFrames)this.flush();}
  flush(){if(!this.buffer)return;if(this.offset){const buffer=this.buffer.buffer;this.engine.storage.postMessage({type:'write',assetId:this.assetId,index:this.index++,frames:this.offset,channels:this.channels,buffer},[buffer]);}else this.engine.pool.push(this.buffer);this.buffer=null;this.offset=0;}
  end(status){this.flush();this.engine.storage.postMessage({type:'end',assetId:this.assetId,frames:this.frames,status});}
}

/** Audio-clock state machine, deliberately independent of browser globals for tests. */
export class LoopEngine {
  constructor({sampleRate=48000,pageFrames=16384,post=()=>{}}={}) {
    this.sampleRate=sampleRate;this.pageFrames=pageFrames;this.post=post;this.storage=null;this.pool=[];this.tracks=new Map();this.trackList=[];this.caches=new Map();this.cacheGroups=new Map();this.playing=false;this.frame=0;this.clock=0;this.baseFrames=0;this.capture=null;this.pendingSection=null;this.sourceEndFrame=Infinity;
    this.inputGain=1;this.monitor=false;this.compensationFrames=0;this.masterVolume=.8;this.masterCurrent=.8;this.masterSmooth=1-Math.exp(-1/(.005*sampleRate));this.spotlight=false;this.spotlightGain=1;
    this.backingFX=new SharedFX(sampleRate);this.vocalFX=new SharedFX(sampleRate);this.vocalDSP=new TrackDSP(sampleRate,{volume:.85,highpass:65,compression:.3,reverb:.12});
    this.inputMixTarget={...this.vocalDSP.mix};this.inputMixQueue=[];
    this.metronome={enabled:false,bpm:100,beatsPerCycle:4,countInBeats:0,volume:.25};this.clickPhase=0;this.clickEnvelope=0;this.clickStep=0;this.clickDecay=Math.exp(-1/(.003*sampleRate));this.clickRemaining=0;this.lastClickClock=-Infinity;
    this.historyLength=Math.ceil(sampleRate)+2;this.backingL=new Float32Array(this.historyLength);this.backingR=new Float32Array(this.historyLength);this.masterHistory=new Float32Array(this.historyLength);this.masterHistory.fill(.8);
    this.inputPeak=0;this.outputPeak=0;this.inputSquares=0;this.meterFrames=0;this.meterInterval=Math.max(1,Math.round(sampleRate/20));this.missing=new Map();this.preview=null;this.audition=null;this.resetAfterCapture=false;
  }
  emit(type,detail={}){this.post({...detail,type,projectFrame:this.frame,transportFrame:this.frame,clockFrame:this.clock});}
  auditionState(){const a=this.audition;return a?{id:a.id,status:a.status,startFrame:a.startFrame,endFrame:a.endFrame,tailFrames:a.tailFrames}:null;}
  captureState(){const c=this.capture;return c?{id:c.id,captureId:c.id,kind:c.kind,status:c.status,startFrame:c.startFrame,elapsedFrames:c.raw.frames,targetFrames:c.lengthFrames||0,countInBeat:c.status==='counting'?Math.min(c.countInBeats,Math.floor((this.clock-c.countInStartClock)/c.countBeatFrames)+1):0,countInBeats:c.countInBeats||0,remainingFrames:c.status==='counting'?Math.max(0,c.startAtClock-this.clock):0}:null;}
  state(){this.emit('state',{playing:this.playing,baseFrames:this.baseFrames,metronome:{...this.metronome},audition:this.auditionState(),capture:this.captureState()});}
  command(message) {
    try {
      const m=message||{};
      if(m.type==='storage-port'){this.storage=m.port;this.storage.onmessage=e=>this.storageMessage(e.data);this.storage.start?.();return;}
      if(m.type==='pool'){for(const b of m.buffers||[])if(b instanceof ArrayBuffer&&b.byteLength>=this.pageFrames*8)this.pool.push(new Float32Array(b));return;}
      if(m.type==='page'){this.receivePage(m);return;}
      if(m.type==='configure'){
        if(Number.isFinite(m.baseFrames))this.baseFrames=integer(m.baseFrames);
        // An active capture keeps its own frozen offset; a changed setting applies next take.
        if(Number.isFinite(m.compensationFrames))this.compensationFrames=integer(m.compensationFrames,0,this.sampleRate);
        if(Number.isFinite(m.inputGain))this.inputGain=clamp(m.inputGain,0,4,1);
        if(typeof m.monitor==='boolean')this.monitor=m.monitor;
        if(Number.isFinite(m.masterVolume))this.masterVolume=clamp(m.masterVolume,0,2,.8);
        if(m.inputMix)this.setInputMix(m.inputMix);
        if(m.metronome){const next=m.metronome;this.metronome={enabled:typeof next.enabled==='boolean'?next.enabled:this.metronome.enabled,bpm:clamp(next.bpm,40,240,this.metronome.bpm),beatsPerCycle:integer(next.beatsPerCycle??this.metronome.beatsPerCycle,1,16),countInBeats:[0,4,8].includes(next.countInBeats)?next.countInBeats:this.metronome.countInBeats,volume:clamp(next.volume,0,1,this.metronome.volume)};if(!this.metronome.enabled&&this.capture?.status!=='counting')this.clickRemaining=0;}
      } else if(m.type==='track')this.addTrack(m.track);
      else if(m.type==='remove-track'){this.tracks.delete(m.id);this.trackList=Array.from(this.tracks.values());this.missing.delete(m.id);this.dropUnusedCaches();}
      else if(m.type==='mix'){const t=this.tracks.get(m.id);if(t){if(m.mix){t.track.mix={...t.track.mix,...m.mix};t.dsp.setMix(t.track.mix);}if(typeof m.muted==='boolean')t.track.muted=m.muted;if(typeof m.solo==='boolean')t.track.solo=m.solo;this.emit('automation',{action:'mix',id:m.id,mix:m.mix,muted:m.muted,solo:m.solo});}else if(this.audition?.id===m.id&&m.mix){this.audition.mix={...this.audition.mix,...m.mix};this.vocalDSP.setMix(this.audition.mix);}}
      else if(m.type==='play'){this.resetAfterCapture=false;if(this.audition?.status==='loading')this.refreshAudition();else this.playing=true;this.prefetch();}
      else if(m.type==='stop'){this.finishCapture(true);this.endAudition('stopped');this.playing=false;this.preview=null;this.monitor=false;this.clickRemaining=0;if(this.capture)this.resetAfterCapture=true;else this.resetDSP();this.dropUnusedCaches();}
      else if(m.type==='clear'){this.cancelCapture();this.endAudition('cleared');this.tracks.clear();this.trackList=[];this.caches.clear();this.cacheGroups.clear();this.missing.clear();this.baseFrames=0;this.frame=0;this.playing=false;this.pendingSection=null;this.preview=null;this.sourceEndFrame=Infinity;this.resetDSP();}
      else if(m.type==='seek'){if(this.capture)throw new Error('Finish or cancel the recording before returning to the start.');this.endAudition('seek');this.frame=0;this.preview=null;this.resetDSP();this.prefetch();}
      else if(m.type==='section'){const section=m.section;if(!section||typeof section.tracks!=='object')throw new Error('Invalid section.');if(this.playing&&this.baseFrames)this.pendingSection={section,frame:this.nextBoundary()};else this.applySection(section);}
      else if(m.type==='spotlight'){this.spotlight=!!m.active;this.emit('automation',{action:'spotlight',active:this.spotlight});}
      else if(m.type==='arm')this.arm(m.capture);
      else if(m.type==='finish')this.finishCapture(false);
      else if(m.type==='cancel')this.cancelCapture();
      else if(m.type==='interrupt')this.abortCapture(m.reason||'audio-interrupted');
      else if(m.type==='audition')this.startAudition(m.take,m.startFrame,m.tailFrames);
      else if(m.type==='preview-take'){this.endAudition('replaced');this.preview=m.take?{...m.take,position:0}:null;if(m.take)this.preview.cache=this.consumerCache(m.take.assetId,m.take.channels||1);this.dropUnusedCaches();}
      if(['configure','track','remove-track','mix','spotlight','play','stop'].includes(m.type)){const {type,...payload}=m;this.emit('command',{command:type,frame:this.frame,...payload});}
      this.state();
    }catch(error){this.emit('error',{message:error.message,requestId:message?.requestId});}
  }
  storageMessage(m){
    if(m.type==='recycle'){if(m.buffer?.byteLength>=this.pageFrames*8)this.pool.push(new Float32Array(m.buffer));}
    else if(m.type==='page'){if(this.caches.has(m.assetId))this.receivePage(m);}
    else if(m.type==='page-missing'){for(const cache of this.cacheGroups.get(m.assetId)||[])if(cache.pending.has(m.index))cache.pending.set(m.index,this.clock);if(m.retryable===false&&this.audition){this.emit('error',{message:'Part of this song is unavailable. Playback stopped; the original recordings were retained.',assetId:m.assetId});this.endAudition('missing-audio');}}
    else if(m.type==='sealed')this.emit('asset-sealed',m);
    else if(m.type==='storage-error'){this.emit('error',{message:m.message||'Audio storage failed.',assetId:m.assetId});if(this.capture&&(this.capture.assetId===m.assetId||this.capture.masterAssetId===m.assetId))this.abortCapture('storage-error');if(this.audition)this.endAudition('storage-error');}
  }
  ensureCache(assetId,channels=1){let c=this.caches.get(assetId);if(!c){c=new PageCache(this.pageFrames,channels);this.caches.set(assetId,c);this.cacheGroups.set(assetId,new Set([c]));}return c;}
  cacheUsed(cache){if(this.capture?.cache===cache||this.preview?.cache===cache||this.audition?.cache===cache)return true;for(const t of this.tracks.values())if(t.cache===cache)return true;return false;}
  consumerCache(assetId,channels=1){
    const original=this.ensureCache(assetId,channels),group=this.cacheGroups.get(assetId);
    for(const cache of group)if(!this.cacheUsed(cache))return cache;
    // Each reader has an independent rolling window, even when clips share a file.
    const cache=new PageCache(this.pageFrames,channels);
    for(let i=0;i<original.slots.length;i++)if(original.tags[i]>=0)cache.put(original.tags[i],original.slots[i].buffer,original.lengths[i],channels);
    group.add(cache);return cache;
  }
  dropUnusedCaches(){for(const [id,group]of this.cacheGroups){for(const cache of group)if(!this.cacheUsed(cache))group.delete(cache);if(group.size)this.caches.set(id,group.values().next().value);else{this.caches.delete(id);this.cacheGroups.delete(id);}}}
  trackResident(t){const total=Math.ceil(t.track.frames/this.pageFrames),page=Math.floor(positiveModulo(this.frame-t.track.offsetFrames,t.track.frames)/this.pageFrames);for(let i=0;i<Math.min(t.cache.headPages,total);i++)if(!t.cache.has(i))return false;return t.cache.has(page)&&t.cache.has((page+1)%total);}
  refreshReady(t){if(!t.ready&&this.trackResident(t)){t.ready=true;this.emit('track-ready',{id:t.track.id,assetId:t.track.assetId});}}
  receivePage(m){
    if(!m.buffer||!Number.isInteger(m.index)||m.index<0)return;this.ensureCache(m.assetId,m.channels||1);
    for(const cache of this.cacheGroups.get(m.assetId))if(cache.pending.has(m.index)||m.index<cache.headPages||!this.cacheUsed(cache))cache.put(m.index,m.buffer,m.frames,m.channels||1);
    for(const t of this.tracks.values())if(t.track.assetId===m.assetId)this.refreshReady(t);this.refreshAudition();
  }
  addTrack(track,cache=null){
    if(!track?.id||!track.assetId||!Number.isSafeInteger(track.frames)||track.frames<1)throw new Error('Track audio length is invalid.');
    const old=this.tracks.get(track.id);if(old){if(old.track.assetId!==track.assetId){old.cache=this.consumerCache(track.assetId,track.channels||1);old.ready=false;}old.track={...old.track,...track,mix:{...old.track.mix,...track.mix}};old.dsp.setMix(old.track.mix);this.dropUnusedCaches();this.prefetchTrack(old);this.refreshReady(old);return;}
    const c=cache||this.consumerCache(track.assetId,track.channels||1);c.totalFrames=track.frames;
    const t={track:{...track,offsetFrames:integer(track.offsetFrames??0,-Number.MAX_SAFE_INTEGER),mix:{...track.mix}},cache:c,dsp:new TrackDSP(this.sampleRate,track.mix),ready:false};this.tracks.set(track.id,t);this.trackList.push(t);this.prefetchTrack(t);this.refreshReady(t);
  }
  nextBoundary(){return this.baseFrames?(Math.floor(this.frame/this.baseFrames)+1)*this.baseFrames:this.frame;}
  clickSample(){
    const c=this.capture,counting=c?.status==='counting';
    if(!this.playing){this.clickRemaining=0;return 0;}
    if(counting||this.metronome.enabled){
      const elapsed=counting?this.clock-c.countInStartClock:this.frame,period=counting?c.countBeatFrames:this.baseFrames?this.baseFrames/this.metronome.beatsPerCycle:this.sampleRate*60/this.metronome.bpm;
      const beat=Math.floor((elapsed+.5)/period);
      // Never accumulate rounded intervals: every tick is derived from the
      // common origin. Extremely short loops cannot create a high-rate click storm.
      if(elapsed===Math.round(beat*period)&&this.clock-this.lastClickClock>=this.sampleRate*.05){
        const accent=beat%(counting?4:this.metronome.beatsPerCycle)===0;this.lastClickClock=this.clock;this.clickPhase=0;this.clickStep=2*Math.PI*(accent?1400:1000)/this.sampleRate;this.clickEnvelope=this.metronome.volume*(accent?1:.65);this.clickRemaining=Math.round(this.sampleRate*.018);
        this.emit(counting?'count-in':'click',{beat:beat+1,accent,monitorOnly:true,...(counting?{captureId:c.id,countInBeats:c.countInBeats,remainingFrames:c.startAtClock-this.clock}:{beatsPerCycle:this.metronome.beatsPerCycle})});
      }
    }
    if(!this.clickRemaining)return 0;const value=Math.sin(this.clickPhase)*this.clickEnvelope;this.clickPhase+=this.clickStep;this.clickEnvelope*=this.clickDecay;this.clickRemaining--;return value;
  }
  setInputMix(mix){
    const next=cleanMix({...this.inputMixTarget,...mix});let changed=false;for(const key of Object.keys(next))if(next[key]!==this.inputMixTarget[key]){changed=true;break;}if(!changed)return;
    if(this.audition){this.inputMixTarget=next;this.audition.restoreMix={...next};return;}
    const delay=this.capture?.kind==='vocal'?this.capture.compensation:0;
    if(delay){
      const targetClock=this.clock+delay,last=this.inputMixQueue[this.inputMixQueue.length-1];
      if(last?.clock===targetClock)last.mix=next;
      else{if(this.inputMixQueue.length>=256)throw new Error('Vocal controls are changing too quickly. Allow the current adjustment to settle.');this.inputMixQueue.push({clock:targetClock,mix:next});}
    }else{this.inputMixQueue.length=0;this.vocalDSP.setMix(next);}
    this.inputMixTarget=next;
  }
  flushInputMix(){this.inputMixQueue.length=0;this.vocalDSP.setMix(this.inputMixTarget);}
  startAudition(take,startFrame,tailFrames){
    if(this.capture)throw new Error('Finish or cancel the recording before listening to a take.');
    if(!take){this.endAudition('stopped');return;}
    if(!take.assetId||!Number.isSafeInteger(take.frames)||take.frames<1)throw new Error('This vocal take has no playable audio.');
    this.endAudition('replaced');this.preview=null;this.playing=false;this.pendingSection=null;
    const origin=integer(take.startFrame??startFrame??0);this.frame=integer(startFrame??origin,0,origin+take.frames-1);
    const cache=this.consumerCache(take.assetId,1);cache.totalFrames=take.frames;
    this.audition={...take,id:take.id||take.assetId,startFrame:origin,endFrame:origin+take.frames,tailFrames:integer(tailFrames??this.sampleRate*2,0,this.sampleRate*10),status:'loading',cache,mix:{...this.inputMixTarget,...take.mix},restoreMix:{...this.inputMixTarget},restoreSourceEnd:this.sourceEndFrame};
    this.sourceEndFrame=this.audition.endFrame;this.resetDSP();this.vocalDSP.setMix(this.audition.mix);
    for(const t of this.tracks.values())t.ready=this.trackResident(t);
    this.dropUnusedCaches();this.prefetch();this.refreshAudition();
  }
  refreshAudition(){
    const a=this.audition;if(!a||a.status!=='loading')return;
    for(const t of this.tracks.values())if(!this.trackResident(t))return;
    const total=Math.ceil(a.frames/this.pageFrames),position=Math.max(0,this.frame-a.startFrame),page=Math.floor(position/this.pageFrames);
    for(let i=0;i<Math.min(4,total);i++)if(!a.cache.has(i))return;
    if(!a.cache.has(page)||!a.cache.has(Math.min(total-1,page+1)))return;
    a.status='playing';this.playing=true;this.emit('audition-start',{id:a.id,startFrame:a.startFrame,endFrame:a.endFrame});this.state();
  }
  endAudition(reason='complete'){
    const a=this.audition;if(!a)return;this.audition=null;this.playing=false;this.sourceEndFrame=a.restoreSourceEnd;this.inputMixTarget={...a.restoreMix};this.flushInputMix();this.vocalDSP.reset();this.vocalFX.reset();this.missing.delete(a.id);this.dropUnusedCaches();this.emit('audition-end',{id:a.id,reason});this.state();
  }
  arm(capture){
    if(this.audition)throw new Error('Stop the take audition before starting a recording.');if(this.capture)throw new Error('A recording is already in progress.');if(!this.storage)throw new Error('Audio storage is not connected.');if(!capture?.assetId||!capture.id)throw new Error('A recording needs an audio asset.');
    if(this.pool.length<(capture.masterAssetId?2:1))throw new Error('Audio storage buffers are not ready.');
    const compensation=this.compensationFrames,minFrames=compensation+128+1,lengthFrames=integer(capture.lengthFrames||0);
    if(lengthFrames&&lengthFrames<minFrames)throw new Error(`This loop must be longer than ${Math.ceil(minFrames/this.sampleRate*1000)} ms for the selected alignment.`);
    const firstFreeLoop=capture.kind==='loop'&&!this.baseFrames&&!this.tracks.size&&!lengthFrames;
    if(capture.kind==='loop'&&!this.baseFrames&&!this.tracks.size)this.frame=0;
    const targetFrame=capture.quantized&&this.baseFrames&&this.playing?this.nextBoundary():this.frame;
    const cache=this.ensureCache(capture.assetId,1);
    // All capture-time memory and the future loop's DSP are reserved before process().
    const preparedTrack={track:{...capture.track,id:capture.track?.id||capture.id,assetId:capture.assetId,kind:'loop',channels:1,frames:1,offsetFrames:0,mix:{...capture.track?.mix}},cache,dsp:new TrackDSP(this.sampleRate,capture.track?.mix),ready:true};
    const countInBeats=firstFreeLoop?this.metronome.countInBeats:0,countBeatFrames=this.sampleRate*60/this.metronome.bpm;
    this.capture={...capture,compensation,lengthFrames,minFrames,targetFrame,status:countInBeats?'counting':'arming',countInBeats,countBeatFrames,countInStartClock:this.clock,startAtClock:this.clock+Math.round(countInBeats*countBeatFrames),startFrame:targetFrame,startClock:null,endFrame:null,endClock:null,raw:new CaptureWriter(this,capture.assetId,1),master:capture.masterAssetId?new CaptureWriter(this,capture.masterAssetId,2):null,cache,preparedTrack};
    if(countInBeats){this.clickRemaining=0;this.lastClickClock=-Infinity;}
    if(capture.kind==='vocal'&&capture.track?.mix)this.setInputMix(capture.track.mix);
    this.playing=true;this.prefetch();
  }
  startCapture(c){
    c.status='recording';c.startClock=this.clock;c.startFrame=this.frame;if(c.lengthFrames)c.targetEndFrame=c.startFrame+c.lengthFrames;
    const initialState={tracks:this.trackList.map(t=>({...t.track,mix:{...t.dsp.mix}})),baseFrames:this.baseFrames,master:{volume:this.masterVolume},input:{gain:this.inputGain,monitor:this.monitor,compensationMs:c.compensation*1000/this.sampleRate},inputMix:{...this.inputMixTarget},spotlight:this.spotlight,frame:this.frame,sampleRate:this.sampleRate,engineVersion:1};
    this.emit('capture-start',{captureId:c.id,kind:c.kind,startFrame:c.startFrame,assetId:c.assetId,masterAssetId:c.masterAssetId,compensationFrames:c.compensation,initialState});
  }
  finishCapture(stopping=false){
    const c=this.capture;if(!c)return;if(c.status==='arming'||c.status==='counting'){this.cancelCapture();return;}if(c.status==='finishing')return;
    if(stopping){this.endMusicalCapture(c,this.frame);return;}
    if(c.lengthFrames){c.targetEndFrame=c.startFrame+c.lengthFrames;return;}
    if(c.kind==='loop'&&this.baseFrames&&c.quantized)c.targetEndFrame=Math.max(this.nextBoundary(),c.startFrame+c.minFrames);
    else c.targetEndFrame=Math.max(this.frame,c.startFrame+c.minFrames);
    if(this.frame>=c.targetEndFrame)this.endMusicalCapture(c,this.frame);
  }
  endMusicalCapture(c,endFrame){
    c.endFrame=endFrame;c.endClock=this.clock;c.status='finishing';const frames=endFrame-c.startFrame;
    if(c.kind==='loop'&&frames>=c.minFrames){const t=c.preparedTrack;t.track.frames=frames;t.track.offsetFrames=positiveModulo(c.startFrame,frames);t.cache.totalFrames=frames;const old=this.tracks.get(t.track.id);this.tracks.set(t.track.id,t);if(old)this.trackList[this.trackList.indexOf(old)]=t;else this.trackList.push(t);if(!this.baseFrames){this.baseFrames=frames;c.createdBase=true;}this.emit('track-ready',{id:t.track.id,assetId:c.assetId,track:{...t.track}});}
  }
  completeCapture(status='complete',reason=null){
    const c=this.capture;if(!c)return;const frames=c.raw.frames;c.raw.end(status);c.master?.end(status);
    const track=c.kind==='loop'&&frames>=c.minFrames?{...c.preparedTrack.track,frames,offsetFrames:positiveModulo(c.startFrame,frames)}:null;
    if(c.kind==='loop'&&track){const t=this.tracks.get(track.id);if(t){t.track.frames=frames;t.cache.totalFrames=frames;}}
    this.capture=null;this.flushInputMix();if(this.resetAfterCapture){this.resetAfterCapture=false;this.resetDSP();}this.dropUnusedCaches();this.emit('capture-end',{captureId:c.id,kind:c.kind,status,reason,assetId:c.assetId,masterAssetId:c.masterAssetId,frames,startFrame:c.startFrame,endFrame:c.startFrame+frames,track,compensationFrames:c.compensation});this.state();
  }
  abortCapture(reason){const c=this.capture;if(!c)return;if(c.status==='counting'){this.playing=false;this.clickRemaining=0;}if(c.kind==='loop')this.tracks.delete(c.preparedTrack.track.id);this.trackList=Array.from(this.tracks.values());if(c.createdBase&&!this.tracks.size)this.baseFrames=0;this.completeCapture('interrupted',reason);}
  cancelCapture(){const c=this.capture;if(!c)return;if(c.status==='counting'){this.playing=false;this.clickRemaining=0;}this.tracks.delete(c.preparedTrack.track.id);this.trackList=Array.from(this.tracks.values());if(c.createdBase&&!this.tracks.size)this.baseFrames=0;c.raw.end('cancelled');c.master?.end('cancelled');this.capture=null;this.flushInputMix();if(this.resetAfterCapture){this.resetAfterCapture=false;this.resetDSP();}this.dropUnusedCaches();this.emit('capture-end',{captureId:c.id,kind:c.kind,status:'cancelled',assetId:c.assetId,masterAssetId:c.masterAssetId,frames:c.raw.frames,startFrame:c.startFrame,endFrame:c.startFrame+c.raw.frames});this.state();}
  applySection(section){for(const t of this.tracks.values()){const state=Object.hasOwn(section.tracks,t.track.id)?section.tracks[t.track.id]:null;t.track.muted=state?!!state.muted:true;t.track.solo=state?!!state.solo:false;if(state?.mix){t.track.mix={...t.track.mix,...state.mix};t.dsp.setMix(t.track.mix);}}this.pendingSection=null;this.emit('section',{id:section.id,section});}
  requestPage(assetId,cache,index){if(!this.storage||index<0||cache.has(index))return;const last=cache.pending.get(index);if(last!==undefined&&this.clock-last<this.sampleRate)return;if(!cache.pending.has(index)&&cache.pending.size>=32)cache.pending.delete(cache.pending.keys().next().value);cache.pending.set(index,this.clock);this.storage.postMessage({type:'read',assetId,index});}
  prefetchTrack(t){const {track,cache}=t,total=Math.ceil(track.frames/this.pageFrames);for(let i=0;i<Math.min(cache.headPages,total);i++)this.requestPage(track.assetId,cache,i);const position=positiveModulo(this.frame-track.offsetFrames,track.frames),page=Math.floor(position/this.pageFrames);for(let i=0;i<6;i++)this.requestPage(track.assetId,cache,(page+i)%total);}
  prefetch(){if(this.frame<this.sourceEndFrame)for(const t of this.tracks.values())this.prefetchTrack(t);if(this.preview){const p=this.preview,c=p.cache,total=Math.ceil(p.frames/this.pageFrames);if(c&&total)for(let i=0;i<6;i++)this.requestPage(p.assetId,c,Math.min(total-1,Math.floor(p.position/this.pageFrames)+i));}if(this.audition){const a=this.audition,total=Math.ceil(a.frames/this.pageFrames),position=Math.max(0,this.frame-a.startFrame);for(let i=0;i<Math.min(4,total);i++)this.requestPage(a.assetId,a.cache,i);if(position<a.frames)for(let i=0;i<6;i++)this.requestPage(a.assetId,a.cache,Math.min(total-1,Math.floor(position/this.pageFrames)+i));}}
  resetDSP(){this.backingFX.reset();this.vocalFX.reset();this.vocalDSP.reset();for(const t of this.tracks.values())t.dsp.reset();this.backingL.fill(0);this.backingR.fill(0);this.masterHistory.fill(this.masterVolume);this.masterCurrent=this.masterVolume;this.clickRemaining=0;}
  process(input,outputL,outputR){
    const size=outputL.length;this.prefetch();let anySolo=false;for(const t of this.tracks.values())if(t.track.solo)anySolo=true;
    for(let i=0;i<size;i++){
      // The microphone represents a musical instant C frames earlier. Match
      // vocal-control automation to that instant, just as the backing history
      // does. Monitoring these controls consequently carries the same offset.
      while(this.inputMixQueue.length&&this.inputMixQueue[0].clock<=this.clock)this.vocalDSP.setMix(this.inputMixQueue.shift().mix);
      if(this.audition?.status==='playing'&&this.frame>=this.audition.endFrame+this.audition.tailFrames)this.endAudition();
      let c=this.capture;
      if(c?.status==='counting'&&this.clock>=c.startAtClock){this.frame=0;c.status='arming';c.targetFrame=0;}
      // Sections and capture share one boundary. Snapshot the settings actually
      // used by the first sample, including a section queued for this boundary.
      if(this.pendingSection&&this.frame>=this.pendingSection.frame){this.applySection(this.pendingSection.section);anySolo=false;for(let ti=0;ti<this.trackList.length;ti++)if(this.trackList[ti].track.solo)anySolo=true;}
      if(c?.status==='arming'&&this.playing&&this.frame>=c.targetFrame)this.startCapture(c);
      if(c?.status==='recording'&&c.targetEndFrame!==undefined&&this.frame>=c.targetEndFrame)this.endMusicalCapture(c,this.frame);
      let dryL=0,dryR=0,roomL=0,roomR=0,echoL=0,echoR=0;
      for(let ti=0;ti<this.trackList.length;ti++){
        const t=this.trackList[ti];
        const track=t.track;let sample=0;
        if(this.playing&&t.ready&&this.frame<this.sourceEndFrame){const position=positiveModulo(this.frame-track.offsetFrames,track.frames);let s=t.cache.sample(position);
          // Loops use the mono voice channel, matching file import. Older stereo
          // loop archives are explicitly downmixed; stereo masters stay stereo.
          if(t.cache.channels===2)s=(s+t.cache.sample(position,1))*.5;
          if(Number.isNaN(s)){const page=Math.floor(position/this.pageFrames),last=this.missing.get(track.id);if(last===undefined||this.clock-last>this.sampleRate){this.missing.set(track.id,this.clock);this.emit('underrun',{id:track.id,assetId:track.assetId,index:page,frame:this.frame});} }else{
          // Destructive edits are avoided: a short playback-only edge taper prevents clicks.
          const edge=Math.min(64,Math.floor(track.frames/8));sample=s*(edge?Math.min(1,position/edge,(track.frames-1-position)/edge):1);
        }}
        t.dsp.process(sample,this.playing&&!track.muted&&(!anySolo||track.solo));dryL+=t.dsp.left;dryR+=t.dsp.right;roomL+=t.dsp.left*t.dsp.mix.reverb;roomR+=t.dsp.right*t.dsp.mix.reverb;echoL+=t.dsp.left*t.dsp.mix.delay;echoR+=t.dsp.right*t.dsp.mix.delay;
      }
      this.backingFX.process(roomL,roomR,echoL,echoR);dryL=this.playing?dryL+this.backingFX.left:0;dryR=this.playing?dryR+this.backingFX.right:0;
      this.spotlightGain+=((this.spotlight?.35:1)-this.spotlightGain)*this.masterSmooth;dryL*=this.spotlightGain;dryR*=this.spotlightGain;
      const historyIndex=this.clock%this.historyLength;this.backingL[historyIndex]=dryL;this.backingR[historyIndex]=dryR;this.masterCurrent+=(this.masterVolume-this.masterCurrent)*this.masterSmooth;this.masterHistory[historyIndex]=this.masterCurrent;
      const compensation=c?.compensation??this.compensationFrames,delayedIndex=positiveModulo(this.clock-compensation,this.historyLength),recordL=this.clock>=compensation?this.backingL[delayedIndex]:0,recordR=this.clock>=compensation?this.backingR[delayedIndex]:0,recordGain=this.clock>=compensation?this.masterHistory[delayedIndex]:this.masterCurrent;
      const raw=Number.isFinite(input?.[i])?input[i]*this.inputGain:0;this.inputPeak=Math.max(this.inputPeak,Math.abs(raw));this.inputSquares+=raw*raw;
      let voiceInput=raw;
      if(this.audition){const a=this.audition,position=this.frame-a.startFrame;voiceInput=0;if(this.playing&&position>=0&&position<a.frames){const value=a.cache.sample(position);if(Number.isFinite(value))voiceInput=value;else{const last=this.missing.get(a.id);if(last===undefined||this.clock-last>this.sampleRate){this.missing.set(a.id,this.clock);this.emit('underrun',{id:a.id,assetId:a.assetId,index:Math.floor(position/this.pageFrames),frame:this.frame});}}}}
      this.vocalDSP.process(voiceInput,true);this.vocalFX.process(this.vocalDSP.left*this.vocalDSP.mix.reverb,this.vocalDSP.right*this.vocalDSP.mix.reverb,this.vocalDSP.left*this.vocalDSP.mix.delay,this.vocalDSP.right*this.vocalDSP.mix.delay);const voiceL=this.vocalDSP.left+this.vocalFX.left,voiceR=this.vocalDSP.right+this.vocalFX.right;
      let previewL=0,previewR=0;if(this.preview){const p=this.preview,cache=p.cache;if(p.position<p.frames){const value=cache?.sample(p.position);if(Number.isFinite(value)){previewL=value*.6;previewR=value*.6;}p.position++;}else{this.preview=null;this.dropUnusedCaches();this.emit('preview-end');}}
      const masterL=softCeiling((recordL+voiceL)*recordGain),masterR=softCeiling((recordR+voiceR)*recordGain);
      // The dry click enters only the monitor branch, after the capture tap.
      const click=this.clickSample(),hearVoice=this.monitor||this.audition?.status==='playing';const l=softCeiling((dryL+(hearVoice?voiceL:0)+previewL+click)*this.masterCurrent),r=softCeiling((dryR+(hearVoice?voiceR:0)+previewR+click)*this.masterCurrent);outputL[i]=l;if(outputR)outputR[i]=r;this.outputPeak=Math.max(this.outputPeak,Math.abs(l),Math.abs(r));
      c=this.capture;
      if(c&&c.startClock!==null&&this.clock>=c.startClock+c.compensation){
        if(c.endClock!==null&&this.clock>=c.endClock+c.compensation){this.completeCapture(c.endFrame-c.startFrame<c.minFrames?'interrupted':'complete');}
        else if(!c.raw.reserve()||(c.master&&!c.master.reserve())){this.emit('error',{message:'Recording stopped because storage could not keep up. The recorded prefix was retained.',captureId:c.id});this.abortCapture('write-buffer-exhausted');}
        else{c.cache.write(c.raw.frames,raw);c.raw.write(raw);c.master?.write(masterL,masterR);}
      }
      if(this.playing&&this.capture?.status!=='counting')this.frame++;this.clock++;this.meterFrames++;
      if(this.meterFrames>=this.meterInterval){this.emit('meter',{inputLevel:this.inputPeak,inputRms:Math.sqrt(this.inputSquares/this.meterFrames),outputLevel:this.outputPeak,playing:this.playing,baseFrames:this.baseFrames,audition:this.auditionState(),capture:this.captureState()});this.inputPeak=0;this.outputPeak=0;this.inputSquares=0;this.meterFrames=0;}
    }
    return true;
  }
}

const WorkletBase=globalThis.AudioWorkletProcessor||class {constructor(){this.port={postMessage(){},onmessage:null};}};
export class FeedMusicProcessor extends WorkletBase {
  constructor(options={}) {super();const p=options.processorOptions||{};this.engine=new LoopEngine({sampleRate:globalThis.sampleRate||p.sampleRate||48000,pageFrames:p.pageFrames||16384,post:m=>this.port.postMessage(m)});this.port.onmessage=e=>this.engine.command(e.data);}
  process(inputs,outputs){const out=outputs[0];if(!out?.[0])return true;return this.engine.process(inputs[0]?.[0],out[0],out[1]||out[0]);}
}
if(typeof globalThis.registerProcessor==='function')globalThis.registerProcessor('fml-engine',FeedMusicProcessor);
