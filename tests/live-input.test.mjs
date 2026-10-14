import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveInputWaveform} from '../src/ui/live-input.mjs';

function waveform() {
  const element = () => ({
    attributes: {}, children: [], classList: {add() {}},
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) { this.children.push(child); },
  });
  const svg = element(), text = {textContent: ''};
  svg.ownerDocument = {createElementNS: element};
  const live = new LiveInputWaveform(svg, text);
  return {live, svg, text};
}

const segments = path => [...path.matchAll(/M([\d.]+),([\d.]+)V([\d.]+)/g)].map(([,x,top,bottom]) => ({x:Number(x), top:Number(top), bottom:Number(bottom)}));

test('live microphone history begins empty and silence stays exactly on the center line', () => {
  const {live, svg, text} = waveform();
  assert.equal(live.samples.length, 0);
  assert.equal(live.peakPath.attributes.d, '');
  assert.equal(text.textContent, '−∞ dB');
  for (let i = 0; i < 20; i++) live.update({inputLevel:0, inputRms:0});
  assert.equal(live.samples.length, 20);
  assert(segments(live.peakPath.attributes.d).every(({top,bottom}) => top === 36 && bottom === 36));
  assert(segments(live.rmsPath.attributes.d).every(({top,bottom}) => top === 36 && bottom === 36));
  assert.equal(svg.attributes['data-clipping'], 'false');
});

test('quiet and loud real input produce increasing centered peaks with separate RMS levels', () => {
  const {live, text} = waveform();
  live.update({inputLevel:.01, inputRms:.0025});
  assert.equal(text.textContent, '-40 dB');
  live.update({inputLevel:.64, inputRms:.16});
  const peak = segments(live.peakPath.attributes.d), rms = segments(live.rmsPath.attributes.d);
  assert(peak[0].bottom > 36);
  assert(peak[1].bottom > peak[0].bottom);
  assert(peak.every(({top,bottom}) => Math.abs(top + bottom - 72) < .001));
  assert(rms.every((point,index) => point.bottom < peak[index].bottom));
  assert.equal(text.textContent, '-4 dB');
  assert.deepEqual(live.samples, [{peak:.01,rms:.0025},{peak:.64,rms:.16}]);
});

test('the rolling history is bounded and only measured samples enter the graph', () => {
  const {live, svg} = waveform();
  for (let i = 0; i < 120; i++) live.update({inputLevel:i/120, inputRms:i/240});
  assert.equal(live.samples.length, 96);
  assert.equal(live.samples[0].peak, 24/120);
  assert.equal(live.samples.at(-1).peak, 119/120);
  assert.equal(svg.attributes['data-samples'], '96');
  const peak = segments(live.peakPath.attributes.d);
  assert.equal(peak.length, 96);
  assert.equal(peak[0].x, 3.75);
  assert.equal(peak.at(-1).x, 716.25);
  assert.equal(svg.children.length, 3);
});

test('clipping saturates the graphic safely while preserving the measured peak and warning', () => {
  const {live, svg, text} = waveform();
  live.update({inputLevel:2, inputRms:1.5});
  assert.equal(svg.attributes['data-clipping'], 'true');
  assert.equal(text.textContent, '+6 dB · clipping');
  assert.deepEqual(live.samples, [{peak:2,rms:1.5}]);
  assert.deepEqual(segments(live.peakPath.attributes.d).map(({top,bottom}) => [top,bottom]), [[3,69]]);
  live.update({inputLevel:.5, inputRms:.25});
  assert.equal(svg.attributes['data-clipping'], 'false');
  assert.equal(text.textContent, '-6 dB');
});

test('reset clears the previous capture and malformed levels never create an invalid path', () => {
  const {live, svg, text} = waveform();
  live.update({inputLevel:1,inputRms:.5});
  live.reset();
  assert.equal(live.samples.length, 0);
  assert.equal(live.peakPath.attributes.d, '');
  assert.equal(live.rmsPath.attributes.d, '');
  assert.equal(svg.attributes['data-samples'], '0');
  assert.equal(svg.attributes['data-clipping'], 'false');
  assert.equal(text.textContent, '−∞ dB');
  for (const inputLevel of [NaN,Infinity,-Infinity,-1,undefined]) live.update({inputLevel,inputRms:NaN});
  assert(live.samples.every(sample => sample.peak === 0 && sample.rms === 0));
  assert(!/NaN|Infinity/.test(live.peakPath.attributes.d));
  live.update({inputLevel:.25,inputRms:4});
  assert.equal(live.samples.at(-1).rms, .25);
});
