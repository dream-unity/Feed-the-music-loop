import test from 'node:test';
import assert from 'node:assert/strict';
import { Biquad, TrackDSP } from '../src/audio/dsp.mjs';

const SR = 48000;
function silence(dsp, frames, audible = true) { for (let i = 0; i < frames; i++) dsp.process(0, audible); }

test('a naturally decayed high-pass tail reaches exact zero instead of a subnormal plateau', () => {
  const filter = new Biquad(SR); filter.set('highpass', 40); silence(filter, 1000); filter.process(1);
  silence(filter, SR * 2);
  assert.equal(filter.z1, 0); assert.equal(filter.z2, 0); assert.equal(filter.process(0), 0);
});

test('flushing inaudible states preserves meaningful filter state at a zero crossing', () => {
  const filter = new Biquad(SR);
  filter.b0 = 1; filter.b1 = 0; filter.b2 = 0; filter.a1 = -1; filter.a2 = .25;
  filter.z1 = -.5; filter.z2 = .75;
  assert.equal(filter.process(.5), 0);
  assert.equal(filter.z1, .75); assert.equal(filter.process(0), .75);
});

test('subnormal biquad states are removed without an audible output', () => {
  const filter = new Biquad(SR); filter.set('highpass', 40); silence(filter, 1000);
  filter.z1 = -3.36e-322; filter.z2 = 3.3e-322;
  assert.equal(filter.process(0), 0); assert.equal(filter.z1, 0); assert.equal(filter.z2, 0);
});

test('compressor envelope and filter states become exact zero after a quiet tail', () => {
  const dsp = new TrackDSP(SR);
  for (let i = 0; i < SR; i++) dsp.process(.25 * Math.sin(i * .037));
  assert.ok(dsp.envelope > .01);
  silence(dsp, SR * 12);
  assert.equal(dsp.envelope, 0); assert.ok(dsp.filters.every(filter => filter.z1 === 0 && filter.z2 === 0));
  assert.equal(dsp.left, 0); assert.equal(dsp.right, 0);
});

for (const mode of ['muted', 'zero volume', 'hard left']) {
  test(`gain smoothing reaches exact zero when ${mode}`, () => {
    const dsp = new TrackDSP(SR); silence(dsp, SR);
    if (mode === 'zero volume') dsp.setMix({ volume: 0 });
    if (mode === 'hard left') dsp.setMix({ pan: -1 });
    silence(dsp, SR * 2, mode !== 'muted');
    assert.equal(dsp.gainR, 0);
    if (mode !== 'hard left') assert.equal(dsp.gainL, 0); else assert.ok(dsp.gainL > .7);
    dsp.setMix({ volume: .8, pan: 0 });
    dsp.process(.2, true);
    assert.ok(dsp.gainL > 0 && dsp.gainR > 0, 'unmute and rebalancing still ramp up normally');
  });
}

test('active EQ and compression match the pre-flush reference trace', () => {
  // Numerical checkpoints from the preceding implementation, with every EQ
  // band and compression active. The fix must only affect inaudible tails.
  const expected = new Map([
    [239, [.26459910696145006, .1708494792201722, .19503129964962782]],
    [1000, [-.10283358971719833, -.06639880780884061, .4726058126721678]],
    [4095, [.1563860238794527, .1009771765443282, .5794410108148031]],
    [11999, [.16912661267345452, .10920367052388205, .5908590013819991]],
  ]);
  const dsp = new TrackDSP(SR, { volume: .73, pan: -.27, highpass: 93, low: 5, mid: -3, high: 4, compression: .6 });
  for (let i = 0; i < 12000; i++) {
    dsp.process(.53 * Math.sin(i * .031) + .17 * Math.sin(i * .193));
    if (!expected.has(i)) continue;
    [dsp.left, dsp.right, dsp.envelope].forEach((actual, field) => assert.ok(Math.abs(actual - expected.get(i)[field]) < 1e-12));
  }
});
