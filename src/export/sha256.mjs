// Incremental SHA-256 (FIPS 180-4). Unlike SubtleCrypto.digest this does not
// require an entire recording in memory. This checksum detects damage, not trust.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (value, count) => (value >>> count) | (value << (32 - count));

export class SHA256 {
  constructor() {
    this.state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.words = new Uint32Array(64);
    this.pending = new Uint8Array(64);
    this.pendingBytes = 0;
    this.bytes = 0;
    this.finished = false;
  }

  update(data) {
    if (this.finished) throw new Error('A finished checksum cannot be updated.');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!Number.isSafeInteger(this.bytes + bytes.byteLength)) throw new RangeError('Checksum input is too large.');
    this.bytes += bytes.byteLength;
    let offset = 0;
    if (this.pendingBytes) {
      const count = Math.min(64 - this.pendingBytes, bytes.byteLength);
      this.pending.set(bytes.subarray(0, count), this.pendingBytes);
      this.pendingBytes += count;
      offset += count;
      if (this.pendingBytes === 64) { this._block(this.pending, 0); this.pendingBytes = 0; }
    }
    while (offset + 64 <= bytes.byteLength) { this._block(bytes, offset); offset += 64; }
    if (offset < bytes.byteLength) {
      this.pending.set(bytes.subarray(offset), 0);
      this.pendingBytes = bytes.byteLength - offset;
    }
    return this;
  }

  _block(bytes, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const a = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const b = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + a + w[i - 7] + b) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + K[i] + w[i]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    const next = [a,b,c,d,e,f,g,h];
    for (let i = 0; i < 8; i++) this.state[i] = (this.state[i] + next[i]) >>> 0;
  }

  digest() {
    if (!this.finished) {
      let end = this.pendingBytes;
      this.pending[end++] = 0x80;
      if (end > 56) { this.pending.fill(0, end); this._block(this.pending, 0); end = 0; }
      this.pending.fill(0, end, 56);
      const view = new DataView(this.pending.buffer);
      view.setUint32(56, Math.floor(this.bytes / 0x20000000), false);
      view.setUint32(60, (this.bytes * 8) >>> 0, false);
      this._block(this.pending, 0);
      this.finished = true;
    }
    const result = new Uint8Array(32);
    const view = new DataView(result.buffer);
    for (let i = 0; i < 8; i++) view.setUint32(i * 4, this.state[i], false);
    return result;
  }

  hex() { return bytesToHex(this.digest()); }
}

export const bytesToHex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');

export async function hashBlob(blob, { signal, onProgress, validateFloat32 = false, chunkBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4 || chunkBytes % 4) throw new RangeError('Checksum block must be a multiple of four bytes.');
  if (validateFloat32 && blob.size % 4) throw new Error('Audio payload ends in a partial sample.');
  const hash = new SHA256();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    signal?.throwIfAborted();
    const buffer = await blob.slice(offset, Math.min(blob.size, offset + chunkBytes)).arrayBuffer();
    if (validateFloat32) {
      const samples = new DataView(buffer);
      for (let i = 0; i < buffer.byteLength; i += 4) {
        if (!Number.isFinite(samples.getFloat32(i, true))) throw new Error('Audio payload contains a non-finite sample.');
      }
    }
    hash.update(buffer);
    onProgress?.(Math.min(blob.size, offset + chunkBytes), blob.size);
  }
  signal?.throwIfAborted();
  return hash.hex();
}
