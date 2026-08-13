import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { importGallery, parseArgs } from "./import-gallery.mjs";
import { encodePxcForTest } from "./pxc-signature.mjs";

function pxc(width, height, shade) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = shade(x, y);
  }
  return Buffer.from(encodePxcForTest(width, height, pixels));
}

const rings = (w, h) => pxc(w, h, (x, y) => (Math.sin(x / w * 9) + Math.cos(y / h * 7)) > 0 ? 255 : 0);
const bars = (w, h) => pxc(w, h, (x, y) => (Math.floor(x / w * 11) + Math.floor(y / h * 3)) % 2 ? 255 : 0);
const wedge = (w, h) => pxc(w, h, (x, y) => ((x / w) * 0.7 + (y / h) * 0.3) * 255);

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "gallery-import-"));
  const galleryDir = path.join(root, "gallery");
  const sourceDir = path.join(root, "incoming");
  await mkdir(galleryDir);
  await mkdir(sourceDir);
  return { galleryDir, sourceDir };
}

const run = (dirs, options = {}) =>
  importGallery({ source: dirs.sourceDir, galleryDir: dirs.galleryDir, ...options });

test("parseArgs reads the source folder, gallery override and dry run", () => {
  assert.deepEqual(parseArgs(["/in", "--gallery", "/out", "--dry-run"]),
                   { source: "/in", gallery: "/out", dryRun: true });
  assert.deepEqual(parseArgs(["/in"]), { source: "/in", gallery: null, dryRun: false });
});

test("appends new wallpapers after the existing ones and never renames them", async () => {
  const dirs = await scratch();
  await writeFile(path.join(dirs.galleryDir, "0001.pxc"), rings(528, 792));
  await writeFile(path.join(dirs.galleryDir, "0002.pxc"), bars(528, 792));
  const before = await readFile(path.join(dirs.galleryDir, "0001.pxc"));

  await writeFile(path.join(dirs.sourceDir, "sunset-wallpaper.pxc"), wedge(528, 792));
  const result = await run(dirs);

  assert.equal(result.added, 1);
  assert.equal(result.total, 3);
  const files = (await readdir(dirs.galleryDir)).filter(name => name.endsWith(".pxc")).sort();
  assert.deepEqual(files, ["0001.pxc", "0002.pxc", "0003.pxc"]);
  assert.deepEqual(await readFile(path.join(dirs.galleryDir, "0001.pxc")), before);
  // The imported master is byte-for-byte the source, only renamed.
  assert.deepEqual(await readFile(path.join(dirs.galleryDir, "0003.pxc")), wedge(528, 792));
});

test("skips a file already in the gallery even under a different name", async () => {
  const dirs = await scratch();
  await writeFile(path.join(dirs.galleryDir, "0001.pxc"), rings(528, 792));
  await writeFile(path.join(dirs.sourceDir, "totally-different-name.pxc"), rings(528, 792));

  const result = await run(dirs);
  assert.equal(result.added, 0);
  assert.equal(result.skippedDuplicateBytes, 1);
  assert.equal(result.total, 1);
});

test("skips duplicates inside the incoming folder itself", async () => {
  const dirs = await scratch();
  await mkdir(path.join(dirs.sourceDir, "nested"));
  await writeFile(path.join(dirs.sourceDir, "a.pxc"), rings(528, 792));
  await writeFile(path.join(dirs.sourceDir, "nested", "copy-of-a.pxc"), rings(528, 792));

  const result = await run(dirs);
  assert.equal(result.sourceFiles, 2);
  assert.equal(result.added, 1);
  assert.equal(result.skippedDuplicateBytes, 1);
});

test("skips the same picture stored at the other device size", async () => {
  // Different dimensions and different bytes, so only the look pass can catch this.
  const dirs = await scratch();
  await writeFile(path.join(dirs.galleryDir, "0001.pxc"), rings(528, 792));
  await writeFile(path.join(dirs.sourceDir, "same-art-x4.pxc"), rings(480, 800));

  const result = await run(dirs);
  assert.equal(result.added, 0);
  assert.equal(result.skippedDuplicateLooks, 1);
  assert.equal(result.skippedLooks[0].matches, "0001.pxc");
});

test("keeps genuinely different pictures", async () => {
  const dirs = await scratch();
  await writeFile(path.join(dirs.galleryDir, "0001.pxc"), rings(528, 792));
  await writeFile(path.join(dirs.sourceDir, "b.pxc"), bars(528, 792));
  await writeFile(path.join(dirs.sourceDir, "c.pxc"), wedge(528, 792));

  const result = await run(dirs);
  assert.equal(result.added, 2);
  assert.equal(result.skippedDuplicateLooks, 0);
});

test("reports a broken file instead of importing it or stopping the run", async () => {
  const dirs = await scratch();
  await writeFile(path.join(dirs.sourceDir, "truncated.pxc"), rings(528, 792).subarray(0, 500));
  await writeFile(path.join(dirs.sourceDir, "wrong-size.pxc"), rings(300, 400));
  await writeFile(path.join(dirs.sourceDir, "good.pxc"), bars(480, 800));

  const result = await run(dirs);
  assert.equal(result.added, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected.map(item => item.reason).join(" "), /unsupported size 300x400/);
});

test("rewrites the manifest and hash snapshot to match the folder", async () => {
  const dirs = await scratch();
  await writeFile(path.join(dirs.galleryDir, "0001.pxc"), rings(528, 792));
  await writeFile(path.join(dirs.sourceDir, "new.pxc"), bars(528, 792));
  await run(dirs);

  const manifest = JSON.parse(await readFile(path.join(dirs.galleryDir, "manifest.json"), "utf8"));
  const hashes = JSON.parse(await readFile(path.join(dirs.galleryDir, "hashes.json"), "utf8"));
  assert.deepEqual(manifest.wallpapers, [{ file: "0001.pxc" }, { file: "0002.pxc" }]);
  assert.deepEqual(hashes.map(entry => entry.file), ["0001.pxc", "0002.pxc"]);
  assert.ok(hashes.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)));
});

test("dry run reports what would happen and writes nothing", async () => {
  const dirs = await scratch();
  await writeFile(path.join(dirs.sourceDir, "new.pxc"), bars(528, 792));

  const result = await run(dirs, { dryRun: true });
  assert.equal(result.added, 1);
  assert.deepEqual(await readdir(dirs.galleryDir), []);
});
