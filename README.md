# lector-wallpapers

PXC sleep wallpapers for [lector](https://github.com/diogo7dias/lector) on the Xteink X3 and X4.

Files live in `gallery/`, listed by `gallery/manifest.json`. The browsable gallery is the **Gallery** tab of the [lector site](https://diogo7dias.github.io/lector-web/#gallery); this repo only serves the files, over GitHub Pages with CORS open.

Add more with `node import-gallery.mjs <folder-of-pxc-files>`: it hashes, de-duplicates, renames sequentially and rewrites the manifest.

## Adding wallpapers

```
node import-gallery.mjs <folder-of-pxc-files> [--dry-run]
```

The gallery only ever grows: existing files are never renamed or removed. Incoming files are
matched two ways, both ignoring filenames:

- **bytes** — SHA-256 of the file, so the same file under another name is skipped;
- **looks** — a size-independent normalised thumbnail compared by cross-correlation, so an X3
  master and its X4 re-encode, or a re-dithered copy, are skipped as well (`pxc-signature.mjs`).

Broken or wrongly sized files are reported and left out rather than stopping the run. Use
`--dry-run` first to see the counts without writing anything.
