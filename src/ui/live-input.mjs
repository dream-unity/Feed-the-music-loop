const SVG_NS = 'http://www.w3.org/2000/svg';
const SAMPLE_LIMIT = 96;
const WIDTH = 720;
const CENTER = 36;
const MAX_HEIGHT = 33;
const level = value => Number.isFinite(value) ? Math.max(0, value) : 0;

// Square-root scaling makes quiet microphone input visible without animating
// silence. These are peak/RMS envelopes from real 50 ms worklet meter windows.
const height = value => Math.sqrt(Math.min(1, value)) * MAX_HEIGHT;
const envelopePath = (samples, key) => samples.map((sample, index) => {
  const x = ((SAMPLE_LIMIT - samples.length + index + .5) * WIDTH / SAMPLE_LIMIT).toFixed(2);
  const amplitude = height(sample[key]);
  return `M${x},${(CENTER - amplitude).toFixed(2)}V${(CENTER + amplitude).toFixed(2)}`;
}).join('');

/** A bounded live mic history. Call update only when a real meter event arrives. */
export class LiveInputWaveform {
  constructor(svg, levelText) {
    this.svg = svg;
    this.levelText = levelText;
    this.samples = [];
    svg.classList.add('live-input-waveform');
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${CENTER * 2}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = (className, d = '') => {
      const element = svg.ownerDocument.createElementNS(SVG_NS, 'path');
      element.setAttribute('class', className);
      element.setAttribute('d', d);
      element.setAttribute('fill', 'none');
      svg.append(element);
      return element;
    };
    path('live-input-baseline', `M0,${CENTER}H${WIDTH}`);
    this.peakPath = path('live-input-peak');
    this.rmsPath = path('live-input-rms');
    this.reset();
  }

  reset() {
    this.samples.length = 0;
    this.peakPath.setAttribute('d', '');
    this.rmsPath.setAttribute('d', '');
    this.svg.setAttribute('data-clipping', 'false');
    this.svg.setAttribute('data-samples', '0');
    if (this.levelText) this.levelText.textContent = '−∞ dB';
  }

  update({inputLevel = 0, inputRms = 0} = {}) {
    const peak = level(inputLevel), rms = Math.min(peak, level(inputRms));
    this.samples.push({peak, rms});
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
    this.peakPath.setAttribute('d', envelopePath(this.samples, 'peak'));
    this.rmsPath.setAttribute('d', envelopePath(this.samples, 'rms'));
    this.svg.setAttribute('data-samples', String(this.samples.length));
    this.svg.setAttribute('data-clipping', String(peak >= 1));
    if (this.levelText) {
      const decibels = peak > 0 ? Math.round(20 * Math.log10(peak)) : null;
      this.levelText.textContent = decibels === null ? '−∞ dB' : `${decibels > 0 ? '+' : ''}${decibels} dB${peak >= 1 ? ' · clipping' : ''}`;
    }
  }
}
