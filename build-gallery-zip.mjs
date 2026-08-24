// Builds the one-click "download every wallpaper" archive for the lector site's Gallery tab.
//
// The gallery is ~6,600 PXC files and ~672 MB. Zipping it in the browser would mean 6,600
// fetches and the whole set in memory, and committing the archive would put a ~210 MB blob in
// this repo and in every Pages deploy. So it is built here, once, and uploaded as a GitHub
// release asset (release assets allow up to 2 GB and live outside the git history):
//
//   node build-gallery-zip.mjs
//   gh release create gallery-latest lector-wallpapers-gallery.zip --repo diogo7dias/lector-wallpapers \
//     --title "Gallery archive" --notes "Every wallpaper in gallery/, as one zip."
//   # on later rebuilds, replace the asset in place so the site's link never changes:
//   gh release upload gallery-latest lector-wallpapers-gallery.zip --repo diogo7dias/lector-wallpapers --clobber
//
// The ZIP is written by hand because there is no zip binary on the build box and Node ships no
// archiver, only the deflate codec this needs. Entries are flat, so a reader can drop the lot
// straight into its sleep folder without an extra directory level in the way.

import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const VERSION_NEEDED = 20;          // 2.0: deflate, no ZIP64, no encryption
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
// A fixed 1980-01-01 00:00 timestamp. Real mtimes would make every rebuild a different file even
// when no wallpaper changed, and nothing downstream reads them.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

// Plain ZIP counts entries in 16 bits and offsets in 32. Past either, an archive needs ZIP64,
// which this writer does not emit.
export const ZIP32_MAX_ENTRIES = 0xffff;
export const ZIP32_MAX_BYTES = 0xffffffff;

export function assertZipLimits(entryCount, totalBytes) {
  if (entryCount > ZIP32_MAX_ENTRIES) {
    throw new Error(`${entryCount} entries exceeds the ${ZIP32_MAX_ENTRIES} a plain ZIP can hold; this writer emits no ZIP64`);
  }
  if (totalBytes > ZIP32_MAX_BYTES) {
    throw new Error(`archive would pass 4 GB; this writer emits no ZIP64`);
  }
}

// One entry, deflated unless deflating makes it bigger (already-dense or empty files).
function packEntry(name, data) {
  const deflated = deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  return {
    name: Buffer.from(name, "utf8"),
    method: stored ? METHOD_STORED : METHOD_DEFLATED,
    crc: crc32(data),
    body: stored ? data : deflated,
    size: data.length,
  };
}

function localHeader(entry) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL_HEADER_SIG, 0);
  head.writeUInt16LE(VERSION_NEEDED, 4);
  head.writeUInt16LE(0, 6);                  // no flags: sizes are known before writing
  head.writeUInt16LE(entry.method, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.body.length, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(entry.name.length, 26);
  head.writeUInt16LE(0, 28);                 // no extra field
  return head;
}

function centralHeader(entry, offset) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
  head.writeUInt16LE(VERSION_NEEDED, 4);     // made by MS-DOS (high byte 0), version 2.0
  head.writeUInt16LE(VERSION_NEEDED, 6);
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(entry.method, 10);
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.body.length, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(0, 30);                 // extra
  head.writeUInt16LE(0, 32);                 // comment
  head.writeUInt16LE(0, 34);                 // disk number
  head.writeUInt16LE(0, 36);                 // internal attributes
  head.writeUInt32LE(0, 38);                 // external attributes
  head.writeUInt32LE(offset, 42);
  return head;
}

function endOfCentralDir(count, size, offset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                  // no archive comment
  return end;
}

// Writes `entries` ({name, path}) to `zipPath`. Files are read and compressed one at a time, so
// the whole gallery never sits in memory at once. Returns the archive size in bytes.
export function writeZip(zipPath, entries) {
  assertZipLimits(entries.length, entries.reduce((total, e) => total + statSync(e.path).size, 0));
  const fd = openSync(zipPath, "w");
  try {
    let offset = 0;
    const central = [];
    const write = buffer => { writeSync(fd, buffer); offset += buffer.length; };
    for (const { name, path } of entries) {
      const entry = packEntry(name, readFileSync(path));
      central.push({ head: centralHeader(entry, offset), name: entry.name });
      write(localHeader(entry));
      write(entry.name);
      write(entry.body);
    }
    const centralOffset = offset;
    for (const { head, name } of central) { write(head); write(name); }
    write(endOfCentralDir(central.length, offset - centralOffset, centralOffset));
    return offset;
  } finally {
    closeSync(fd);
  }
}

export function buildGalleryZip(galleryDir, zipPath) {
  const wallpapers = readdirSync(galleryDir).filter(name => name.endsWith(".pxc")).sort();
  // The manifest rides along so an offline copy still knows each wallpaper's title and credit.
  // hashes.json is importer bookkeeping and is left behind.
  const names = [...wallpapers, "manifest.json"];
  const zipBytes = writeZip(zipPath, names.map(name => ({ name, path: join(galleryDir, name) })));
  return { wallpapers: wallpapers.length, zipBytes };
}

if (process.argv[1] && basename(process.argv[1]) === "build-gallery-zip.mjs") {
  const galleryDir = process.argv[2] || "gallery";
  const zipPath = process.argv[3] || "lector-wallpapers-gallery.zip";
  const { wallpapers, zipBytes } = buildGalleryZip(galleryDir, zipPath);
  const megabytes = (zipBytes / (1024 * 1024)).toFixed(0);
  console.log(`${zipPath}: ${wallpapers} wallpapers plus manifest.json, ${megabytes} MB`);
}
