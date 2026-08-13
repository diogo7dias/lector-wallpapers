import assert from "node:assert/strict";
import test from "node:test";

import { decodePxc, encodePxcForTest, looksSame, signature } from "./pxc-signature.mjs";

// Builds a PXC buffer from a pixel function returning 0..255 grays.
function makePxc(width, height, shade) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = shade(x, y);
  }
  return encodePxcForTest(width, height, pixels);
}

const gradient = (w, h) => makePxc(w, h, x => (x / w) * 255);
const diagonal = (w, h) => makePxc(w, h, (x, y) => ((x / w + y / h) / 2) * 255);

test("decodePxc reads the header and unpacks 2-bit pixels to 0..255 grays", () => {
  // 5 wide forces a padded stride: ceil(5 / 4) = 2 bytes per row.
  const bytes = makePxc(5, 3, x => [0, 85, 170, 255, 0][x]);
  assert.equal(bytes.length, 4 + 2 * 3);
  const image = decodePxc(bytes);
  assert.equal(image.width, 5);
  assert.equal(image.height, 3);
  assert.deepEqual([...image.gray.slice(0, 5)], [0, 85, 170, 255, 0]);
});

test("decodePxc rejects a truncated or malformed file", () => {
  assert.equal(decodePxc(new Uint8Array(3)), null);
  const short = makePxc(8, 4, () => 0).subarray(0, 8);
  assert.equal(decodePxc(short), null);
});

test("identical pictures at different device sizes look the same", () => {
  // The X3 master and its X4 re-encode are different bytes and different dimensions,
  // so the SHA-256 pass cannot catch them. The look pass must.
  const x3 = signature(gradient(528, 792));
  const x4 = signature(gradient(480, 800));
  assert.ok(looksSame(x3, x4), "same gradient at both device sizes should match");
});

test("different pictures do not look the same", () => {
  assert.equal(looksSame(signature(gradient(528, 792)), signature(diagonal(528, 792))), false);
});

test("a re-encoded picture with light noise still looks the same", () => {
  const clean = signature(makePxc(528, 792, x => (x / 528) * 255));
  // One quantisation step off on a scattering of pixels, as a re-encode would give.
  const noisy = signature(makePxc(528, 792, (x, y) => {
    const base = (x / 528) * 255;
    return (x * 7 + y * 13) % 97 === 0 ? Math.min(255, base + 85) : base;
  }));
  assert.ok(looksSame(clean, noisy));
});

test("flat images never match on looks alone", () => {
  // An all-black and an all-white page both have no detail to compare, and every
  // near-flat picture would otherwise collapse onto one entry and get dropped.
  const black = signature(makePxc(528, 792, () => 0));
  const white = signature(makePxc(528, 792, () => 255));
  assert.equal(black.flat, true);
  assert.equal(black.thumb, null);
  assert.equal(looksSame(black, black), false);
  assert.equal(looksSame(black, white), false);
});

test("signature is stable across runs and serialisable", () => {
  const a = signature(gradient(528, 792));
  const b = signature(gradient(528, 792));
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});
