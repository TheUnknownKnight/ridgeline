const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 4096 * 4096;

const toBytes = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
};

const hasSignature = (buf) => {
  if (!buf || buf.byteLength < 8) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) return false;
  return true;
};

const concatBytes = (parts) => {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

const inflateZlib = async (chunks) => {
  let idx = 0;
  const stream = new ReadableStream({
    pull(controller) {
      while (idx < chunks.length && chunks[idx].byteLength === 0) idx++;
      if (idx < chunks.length) controller.enqueue(chunks[idx++]);
      else controller.close();
    },
  }).pipeThrough(new DecompressionStream('deflate'));

  const reader = stream.getReader();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  return concatBytes(out);
};

/**
 * Minimal PNG decoder for map-service images: 8-bit (or lower) indexed,
 * grey, RGB or RGBA, non-interlaced. Returns { width, height, rgba(x, y) }.
 * Throws on anything else rather than guessing.
 */
export const decodePng = async (input) => {
  const buf = toBytes(input);
  if (!hasSignature(buf)) throw new Error('not a PNG');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (p + 8 <= buf.byteLength) {
    const len = view.getUint32(p, false);
    if (p + 8 + len > buf.byteLength) throw new Error('truncated PNG');
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('truncated PNG');
      width = view.getUint32(p + 8, false);
      height = view.getUint32(p + 12, false);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12]) throw new Error('interlaced PNG not supported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || !bitDepth || bitDepth > 8 || !width || !height || width * height > MAX_PIXELS) throw new Error('unsupported PNG');
  if (colorType === 3 && !palette) throw new Error('indexed PNG without a palette');
  if (idat.length === 0) throw new Error('truncated PNG');

  const raw = await inflateZlib(idat);
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  if (raw.byteLength < (stride + 1) * height) throw new Error('truncated PNG');
  const px = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 255;
    }
    prev = out;
  }

  const rgba = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    if (colorType === 3) {
      let idx;
      if (bitDepth === 8) idx = px[y * stride + x];
      else {
        const bit = x * bitDepth;
        idx = (px[y * stride + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
      }
      return [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2], trns && idx < trns.length ? trns[idx] : 255];
    }
    const o = y * stride + x * channels;
    if (channels === 4) return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    if (channels === 3) return [px[o], px[o + 1], px[o + 2], 255];
    if (channels === 2) return [px[o], px[o], px[o], px[o + 1]];
    return [px[o], px[o], px[o], 255];
  };
  return { width, height, rgba };
};
