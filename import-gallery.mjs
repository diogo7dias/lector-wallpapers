// Adds PXC wallpapers to gallery/, skipping any that are already there.
//
//   node import-gallery.mjs <folder-of-pxc-files> [--gallery <dir>] [--dry-run]
//
// Files already in the gallery are never renamed, moved or dropped: the gallery is the
// record, and the import only ever appends. Two passes decide what is new:
//
//   1. bytes  — SHA-256 of the file. Catches the same file under a different name.
//   2. looks  — a size-independent normalised thumbnail, compared by cross-correlation
//               (see pxc-signature.mjs). Catches the same picture stored twice: an X3
//               master and its X4 re-encode, or a re-dithered copy.
//
// Filenames are ignored entirely by both passes.

import { createHash } from "node:crypto";
import { access, chmod, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { looksSame, signature } from "./pxc-signature.mjs";

const MANIFEST_NOTE = "Ready-made Lector / CrossPoint wallpapers. Files keep their original PXC bytes and use stable sequential gallery names. X3 and X4 masters are decoded in-browser and converted to other device formats only when requested.";

const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async target => { try { await access(target); return true; } catch { return false; } };

export function parseArgs(argv) {
  const positional = [];
  const options = { gallery: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--gallery") options.gallery = argv[++i];
    else positional.push(argv[i]);
  }
  return { source: positional[0], ...options };
}

async function findPxcFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    // A zip made on macOS carries a __MACOSX tree of AppleDouble sidecars named "._<file>".
    // They end in .pxc but hold resource-fork metadata, so every one would be reported as a
    // broken wallpaper. Skip them by name, at both levels.
    if (entry.name === "__MACOSX" || entry.name.startsWith("._")) continue;
    if (entry.isDirectory()) found.push(...await findPxcFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pxc")) found.push(fullPath);
  }
  return found;
}

// A wallpaper the device can actually show. A bad file is reported, not imported: one
// corrupt download should not stop the other few thousand from landing.
function validate(bytes) {
  if (bytes.length < 4) return "file shorter than a PXC header";
  const width = bytes.readUInt16LE(0), height = bytes.readUInt16LE(2);
  if (!((width === 528 && height === 792) || (width === 480 && height === 800))) {
    return `unsupported size ${width}x${height}, expected 528x792 (X3) or 480x800 (X4)`;
  }
  const expected = 4 + Math.ceil(width / 4) * height;
  if (bytes.length !== expected) return `length ${bytes.length}, expected ${expected}`;
  return null;
}

export async function importGallery({ source, galleryDir, dryRun = false, log = () => {} }) {
  const kept = [];            // what the gallery holds, in file order
  const hashes = new Set();
  const signatures = [];      // { file, signature } for everything kept so far

  if (await exists(galleryDir)) {
    const names = (await readdir(galleryDir)).filter(name => /^\d+\.pxc$/i.test(name)).sort();
    for (const file of names) {
      const bytes = await readFile(path.join(galleryDir, file));
      const sha256 = hashBytes(bytes);
      kept.push({ file, sha256 });
      hashes.add(sha256);
      signatures.push({ file, signature: signature(bytes) });
    }
    log(`gallery holds ${kept.length} wallpapers`);
  }

  const sources = (await findPxcFiles(source)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  log(`scanning ${sources.length} source files`);

  const added = [], skippedBytes = [], skippedLooks = [], rejected = [];
  let nextId = kept.reduce((highest, item) => Math.max(highest, Number.parseInt(item.file, 10) || 0), 0);

  for (const sourcePath of sources) {
    const bytes = await readFile(sourcePath);
    const problem = validate(bytes);
    if (problem) { rejected.push({ source: sourcePath, reason: problem }); continue; }

    const sha256 = hashBytes(bytes);
    if (hashes.has(sha256)) { skippedBytes.push(sourcePath); continue; }

    const sig = signature(bytes);
    const twin = sig ? signatures.find(entry => looksSame(entry.signature, sig)) : null;
    if (twin) { skippedLooks.push({ source: sourcePath, matches: twin.file }); continue; }

    const file = `${String(++nextId).padStart(4, "0")}.pxc`;
    added.push({ file, source: sourcePath, sha256 });
    kept.push({ file, sha256 });
    hashes.add(sha256);
    signatures.push({ file, signature: sig });
  }

  if (!dryRun && added.length) {
    for (const item of added) {
      const target = path.join(galleryDir, item.file);
      await copyFile(item.source, target);
      await chmod(target, 0o644);
      // The gallery promises byte-for-byte masters, so prove the copy before listing it.
      if (hashBytes(await readFile(target)) !== item.sha256) {
        throw new Error(`Copy verification failed: ${item.file}`);
      }
    }
  }

  if (!dryRun) {
    const manifest = { note: MANIFEST_NOTE, wallpapers: kept.map(({ file }) => ({ file })) };
    await writeFile(path.join(galleryDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(galleryDir, "hashes.json"),
                    `${JSON.stringify(kept.map(({ file, sha256 }) => ({ file, sha256 })), null, 2)}\n`);
  }

  return {
    sourceFiles: sources.length,
    added: added.length,
    total: kept.length,
    skippedDuplicateBytes: skippedBytes.length,
    skippedDuplicateLooks: skippedLooks.length,
    rejected,
    skippedLooks,
  };
}

// Only runs when executed directly, so the tests can import the functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { source, gallery, dryRun } = parseArgs(process.argv.slice(2));
  if (!source) {
    console.error("usage: node import-gallery.mjs <folder-of-pxc-files> [--gallery <dir>] [--dry-run]");
    process.exit(2);
  }
  const result = await importGallery({
    source: path.resolve(source),
    galleryDir: path.resolve(gallery ?? new URL("./gallery/", import.meta.url).pathname),
    dryRun,
    log: message => console.error(message),
  });
  console.log(JSON.stringify({
    ...result,
    skippedLooks: result.skippedLooks.slice(0, 20),
    skippedLooksShown: Math.min(20, result.skippedLooks.length),
  }, null, 2));
}
