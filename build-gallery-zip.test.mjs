import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertZipLimits, buildGalleryZip, writeZip, ZIP32_MAX_BYTES, ZIP32_MAX_ENTRIES } from "./build-gallery-zip.mjs";

// The archive is written by hand rather than by a zip binary, so the tests that matter are the
// ones an ordinary user's unzip tool would run: does a real ZIP reader accept it, and does what
// comes out match what went in byte-for-byte. python3 is the reader on hand here.
function unzipWithPython(zipPath, intoDir) {
  execFileSync("python3", ["-c", `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
if bad is not None:
    raise SystemExit("corrupt entry: " + bad)
z.extractall(sys.argv[2])
`, zipPath, intoDir]);
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "gallery-zip-"));
  return dir;
}

test("a real ZIP reader accepts the archive and the files survive byte-for-byte", () => {
  const dir = fixtureDir();
  try {
    // Compressible bytes and incompressible bytes, so both deflate paths are exercised.
    const files = [
      { name: "0001.pxc", data: Buffer.alloc(5000, 0x55) },
      { name: "0002.pxc", data: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) % 256)) },
      { name: "manifest.json", data: Buffer.from('{"wallpapers":[]}') },
      { name: "empty.pxc", data: Buffer.alloc(0) },
    ];
    for (const file of files) writeFileSync(join(dir, file.name), file.data);

    const zipPath = join(dir, "out.zip");
    writeZip(zipPath, files.map(f => ({ name: f.name, path: join(dir, f.name) })));

    const out = join(dir, "unpacked");
    mkdirSync(out);
    unzipWithPython(zipPath, out);
    for (const file of files) {
      assert.deepEqual(readFileSync(join(out, file.name)), file.data, `${file.name} differs`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same gallery always produces the same bytes", () => {
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "0001.pxc"), Buffer.alloc(1000, 7));
    const entries = [{ name: "0001.pxc", path: join(dir, "0001.pxc") }];
    writeZip(join(dir, "a.zip"), entries);
    writeZip(join(dir, "b.zip"), entries);
    // No timestamps and no random padding, so a rebuild that changes nothing uploads nothing new.
    assert.deepEqual(readFileSync(join(dir, "a.zip")), readFileSync(join(dir, "b.zip")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gallery is refused before it silently overflows a plain ZIP", () => {
  // No ZIP64 here: the gallery is ~6,600 files and ~210 MB, far inside both caps. If it ever
  // grows past one, the build must stop loudly rather than write an archive that unpacks short.
  assert.doesNotThrow(() => assertZipLimits(6600, 210 * 1024 * 1024));
  assert.throws(() => assertZipLimits(ZIP32_MAX_ENTRIES + 1, 1), /entries/);
  assert.throws(() => assertZipLimits(1, ZIP32_MAX_BYTES + 1), /4 GB/);
});

test("the build zips every wallpaper plus the manifest, and reports what it wrote", () => {
  const dir = fixtureDir();
  try {
    const gallery = join(dir, "gallery");
    mkdirSync(gallery);
    writeFileSync(join(gallery, "0002.pxc"), Buffer.alloc(400, 3));
    writeFileSync(join(gallery, "0001.pxc"), Buffer.alloc(400, 4));
    writeFileSync(join(gallery, "manifest.json"), Buffer.from("{}"));
    // hashes.json is importer bookkeeping, not something a reader wants on its SD card.
    writeFileSync(join(gallery, "hashes.json"), Buffer.from("{}"));

    const zipPath = join(dir, "out.zip");
    const report = buildGalleryZip(gallery, zipPath);
    assert.equal(report.wallpapers, 2);
    assert.ok(report.zipBytes > 0);

    const out = join(dir, "unpacked");
    mkdirSync(out);
    unzipWithPython(zipPath, out);
    assert.deepEqual(readFileSync(join(out, "0001.pxc")), Buffer.alloc(400, 4));
    assert.deepEqual(readFileSync(join(out, "manifest.json")), Buffer.from("{}"));
    assert.throws(() => readFileSync(join(out, "hashes.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
