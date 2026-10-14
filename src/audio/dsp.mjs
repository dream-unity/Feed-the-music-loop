/** Small, allocation-free DSP primitives shared by the worklet and Node tests. */
export const clamp = (x, lo, hi, fallback = lo) => Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : fallback;
export const DEFAULT_MIX = Object.freeze({volume:0.8,pan:0,low:0,mid:0,high:0,highpass:40,compression:0.25,reverb:0.08,delay:0});
export function cleanMix(m = {}) {
  return {volume:clamp(m.volume,0,2,0.8),pan:clamp(m.pan,-1,1,0),low:clamp(m.low,-18,18,0),mid:clamp(m.mid,-18,18,0),high:clamp(m.high,-18,18,0),highpass:clamp(m.highpass,0,2000,40),compression:clamp(m.compression,0,1,0.25),reverb:clamp(m.reverb,0,1,0.08),delay:clamp(m.delay,0,.75,0)};
}

/** RBJ cookbook biquads, transposed direct form II. Coefficients ramp over 5 ms. */
export class Biquad {
  constructor(sr) { this.sr=sr;this.b0=1;this.b1=0;this.b2=0;this.a1=0;this.a2=0;this.z1=0;this.z2=0;this.target=new Float64Array([1,0,0,0,0]);this.remaining=0; }
  set(type,freq,gain=0) {
    if (type==='highpass' && freq<=0) { this.target.set([1,0,0,0,0]);this.remaining=Math.ceil(this.sr*.005);return; }
    const w=2*Math.PI*clamp(freq,5,this.sr*.45,40)/this.sr, c=Math.cos(w),s=Math.sin(w),A=Math.pow(10,gain/40),alpha=s/(2*Math.SQRT1_2),sqrtA=Math.sqrt(A);
    let b0,b1,b2,a0,a1,a2;
    if(type==='highpass') { b0=(1+c)/2;b1=-(1+c);b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha; }
    else if(type==='peak') { b0=1+alpha*A;b1=-2*c;b2=1-alpha*A;a0=1+alpha/A;a1=b1;a2=1-alpha/A; }
    else if(type==='low') { const t=2*sqrtA*alpha;b0=A*((A+1)-(A-1)*c+t);b1=2*A*((A-1)-(A+1)*c);b2=A*((A+1)-(A-1)*c-t);a0=(A+1)+(A-1)*c+t;a1=-2*((A-1)+(A+1)*c);a2=(A+1)+(A-1)*c-t; }
    else { const t=2*sqrtA*alpha;b0=A*((A+1)+(A-1)*c+t);b1=-2*A*((A-1)+(A+1)*c);b2=A*((A+1)+(A-1)*c-t);a0=(A+1)-(A-1)*c+t;a1=2*((A-1)-(A+1)*c);a2=(A+1)-(A-1)*c-t; }
    this.target[0]=b0/a0;this.target[1]=b1/a0;this.target[2]=b2/a0;this.target[3]=a1/a0;this.target[4]=a2/a0;this.remaining=Math.ceil(this.sr*.005);
  }
  process(x) {
    if(this.remaining) { const n=this.remaining--;this.b0+=(this.target[0]-this.b0)/n;this.b1+=(this.target[1]-this.b1)/n;this.b2+=(this.target[2]-this.b2)/n;this.a1+=(this.target[3]-this.a1)/n;this.a2+=(this.target[4]-this.a2)/n; }
    const y=this.b0*x+this.z1;this.z1=this.b1*x-this.a1*y+this.z2;this.z2=this.b2*x-this.a2*y;
    if(!Number.isFinite(y)) {this.z1=this.z2=0;return 0;} return Math.abs(y)<1e-20?0:y;
  }
  reset() {this.z1=this.z2=0;}
}

export class TrackDSP {
  constructor(sr,mix) { this.sr=sr;this.filters=[new Biquad(sr),new Biquad(sr),new Biquad(sr),new Biquad(sr)];this.envelope=0;this.attack=Math.exp(-1/(.006*sr));this.release=Math.exp(-1/(.13*sr));this.smooth=1-Math.exp(-1/(.005*sr));this.gainL=0;this.gainR=0;this.left=0;this.right=0;this.setMix(mix||{}); }
  setMix(m) { this.mix=cleanMix({...this.mix,...m});const v=this.mix;this.filters[0].set('highpass',v.highpass);this.filters[1].set('low',180,v.low);this.filters[2].set('peak',1500,v.mid);this.filters[3].set('high',5500,v.high);this.threshold=Math.pow(10,(-24*v.compression)/20);this.ratio=1+5*v.compression;this.makeup=Math.pow(10,3*v.compression/20);const angle=(v.pan+1)*Math.PI*.25;this.targetL=v.volume*Math.cos(angle);this.targetR=v.volume*Math.sin(angle); }
  process(x,audible=true) {
    x=Number.isFinite(x)?x:0;
    for(let i=0;i<4;i++)x=this.filters[i].process(x);
    const p=Math.abs(x), k=p>this.envelope?this.attack:this.release;this.envelope=k*this.envelope+(1-k)*p;
    if(this.envelope>this.threshold) x*=Math.pow(this.envelope/this.threshold,1/this.ratio-1);
    this.gainL+=((audible?this.targetL:0)-this.gainL)*this.smooth;this.gainR+=((audible?this.targetR:0)-this.gainR)*this.smooth;
    const y=x*this.makeup;this.left=y*this.gainL;this.right=y*this.gainR;return y;
  }
  reset() {for(const f of this.filters)f.reset();this.envelope=0;this.gainL=0;this.gainR=0;}
}

class Comb { constructor(length,feedback) {this.buffer=new Float32Array(length);this.pos=0;this.feedback=feedback;this.damp=0;} process(x) {const y=this.buffer[this.pos];this.damp=.72*y+.28*this.damp;this.buffer[this.pos]=x+this.damp*this.feedback;if(++this.pos===this.buffer.length)this.pos=0;return y;} reset(){this.buffer.fill(0);this.damp=0;this.pos=0;} }
class Allpass { constructor(length) {this.buffer=new Float32Array(length);this.pos=0;} process(x) {const d=this.buffer[this.pos],y=d-x;this.buffer[this.pos]=x+d*.5;if(++this.pos===this.buffer.length)this.pos=0;return y;} reset(){this.buffer.fill(0);this.pos=0;} }
/** Shared room and echo buses: fixed memory regardless of number of tracks. */
export class SharedFX {
  constructor(sr) {this.combL=[.0297,.0371,.0411,.0437].map((s,i)=>new Comb(Math.max(2,Math.round(s*sr)),.71+i*.018));this.combR=[.0307,.0383,.0423,.0451].map((s,i)=>new Comb(Math.max(2,Math.round(s*sr)),.71+i*.018));this.apL=[new Allpass(Math.round(.005*sr)),new Allpass(Math.round(.0017*sr))];this.apR=[new Allpass(Math.round(.0053*sr)),new Allpass(Math.round(.0019*sr))];this.delayL=new Float32Array(Math.round(.375*sr));this.delayR=new Float32Array(Math.round(.5*sr));this.dl=0;this.dr=0;this.left=0;this.right=0;}
  process(roomL,roomR,echoL,echoR) {let l=0,r=0;for(let i=0;i<4;i++){l+=this.combL[i].process(roomL*.22);r+=this.combR[i].process(roomR*.22);}for(let i=0;i<2;i++){l=this.apL[i].process(l);r=this.apR[i].process(r);}const a=this.delayL[this.dl],b=this.delayR[this.dr];this.delayL[this.dl]=echoL+b*.32;this.delayR[this.dr]=echoR+a*.32;if(++this.dl===this.delayL.length)this.dl=0;if(++this.dr===this.delayR.length)this.dr=0;this.left=l*.45+a*.6;this.right=r*.45+b*.6;}
  reset(){for(const f of [...this.combL,...this.combR,...this.apL,...this.apR])f.reset();this.delayL.fill(0);this.delayR.fill(0);this.dl=this.dr=0;}
}

/** Safety soft ceiling, not a certified true-peak limiter. Linear below -0.45 dBFS. */
export function softCeiling(x) {if(!Number.isFinite(x))return 0;const a=Math.abs(x);return a<=.95?x:Math.sign(x)*(.95+.05*(1-Math.exp(-20*(a-.95))));}
