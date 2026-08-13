# lector-wallpapers

PXC sleep wallpapers for [lector](https://github.com/diogo7dias/lector) on the Xteink X3 and X4.

Files live in `gallery/`, listed by `gallery/manifest.json`. The browsable gallery is the **Gallery** tab of the [lector site](https://diogo7dias.github.io/lector-xteink-firmware/#gallery); this repo only serves the files, over GitHub Pages with CORS open.

Add more with `node import-gallery.mjs <folder-of-pxc-files>`: it hashes, de-duplicates, renames sequentially and rewrites the manifest.
