// Picture-look fingerprints for PXC wallpapers.
//
// SHA-256 catches byte-identical files. It cannot catch the same picture stored twice: an X3
// master (528x792) and its X4 re-encode (480x800) differ in size and bytes, and a re-dither or
// a slightly different crop shifts pixels without changing the picture. This module reduces a
// wallpaper to a size-independent 32x32 thumbnail so those twins can be compared.
//
// The thumbnail is contrast-normalised (mean 0, standard deviation 1) and pairs are scored by
// normalised cross-correlation. Plain pixel difference fails badly on these wallpapers: most
// are ink-on-white line art, so two unrelated drawings are both ~90% white and look close by
// difference alone. Measured on the 3,190-file gallery, unrelated pairs of that kind score
// around 0.33 to 0.58 while true twins score 0.88 upward, which is the gap MIN_CORRELATION
// sits in.
//
// Flat pages are excluded: with no detail their normalised thumbnails are noise, and matching
// them would silently drop distinct wallpapers. Exact-byte comparison still covers those.

const LEVELS = [0, 85, 170, 255];

export const THUMB_SIZE = 32;
// Chosen from a full scan of the seeded gallery: every sampled pair at 0.88 and up was the same
// picture re-processed, and the nearest unrelated pairs sat near 0.58. 0.90 leaves headroom on
// the side that matters, since a false match silently loses a wallpaper.
export const MIN_CORRELATION = 0.9;
// Standard deviation, in gray levels, below which a page carries too little detail to compare.
export const MIN_DETAIL = 1;

// Decodes a PXC buffer to grayscale. Mirrors parsePxc in the lector site's index.html:
// uint16 LE width, uint16 LE height, then 2 bits per pixel, rows padded to whole bytes.
export function decodePxc(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return null;
  const stride = (width + 3) >> 2;
  if (bytes.length < 4 + stride * height) return null;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = 4 + y * stride;
    for (let x = 0; x < width; x++) {
      gray[y * width + x] = LEVELS[(bytes[row + (x >> 2)] >> (6 - ((x & 3) << 1))) & 3];
    }
  }
  return { width, height, gray };
}

// Box-average downscale to a fixed grid. This is what makes the comparison size-independent:
// 528x792 and 480x800 land on the same shape.
function downscale(image, size) {
  const { width, height, gray } = image;
  const out = new Float64Array(size * size);
  for (let oy = 0; oy < size; oy++) {
    const y0 = Math.floor((oy * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / size));
    for (let ox = 0; ox < size; ox++) {
      const x0 = Math.floor((ox * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / size));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) sum += gray[y * width + x];
      }
      out[oy * size + ox] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// Returns null for anything that does not decode, so callers fall back to bytes only.
// `thumb` is the normalised thumbnail; `flat` marks a page with no usable detail.
export function signature(bytes) {
  const image = decodePxc(bytes);
  if (!image) return null;
  const thumb = downscale(image, THUMB_SIZE);
  let mean = 0;
  for (const value of thumb) mean += value;
  mean /= thumb.length;
  let variance = 0;
  for (const value of thumb) variance += (value - mean) ** 2;
  const deviation = Math.sqrt(variance / thumb.length);
  if (deviation < MIN_DETAIL) return { thumb: null, flat: true };
  return { thumb: Array.from(thumb, value => (value - mean) / deviation), flat: false };
}

// Normalised cross-correlation: 1 is the same picture, 0 is unrelated.
export function correlation(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum / a.length;
}

export function looksSame(a, b) {
  if (!a || !b || a.flat || b.flat) return false;
  return correlation(a.thumb, b.thumb) >= MIN_CORRELATION;
}

// Test helper: packs grays back into the PXC layout, snapping to the nearest of the 4 levels.
export function encodePxcForTest(width, height, gray) {
  const stride = (width + 3) >> 2;
  const bytes = new Uint8Array(4 + stride * height);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, width, true);
  view.setUint16(2, height, true);
  for (let y = 0; y < height; y++) {
    const row = 4 + y * stride;
    for (let x = 0; x < width; x++) {
      const value = gray[y * width + x];
      let best = 0;
      for (let q = 1; q < 4; q++) {
        if (Math.abs(LEVELS[q] - value) < Math.abs(LEVELS[best] - value)) best = q;
      }
      bytes[row + (x >> 2)] |= best << (6 - ((x & 3) << 1));
    }
  }
  return bytes;
}
