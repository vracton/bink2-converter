# Bink2 Converter

A fully client-side Bink 2 (`.bk2`) converter that decodes Bink2 in WebAssembly and produces transparent VP9/WebM for browser playback and download.

## How it works

The browser pipeline is:

`BK2 -> Bink2 decoder (WASM) -> YUVA420P -> libvpx VP9 alpha -> WebM -> <video>`

The decoder is built from FFmpeg 7.1.2 plus SharpEmu's Bink2 patch. The build also applies the alpha-flag fix needed for alpha-bearing Bink2 files and includes FFmpeg's `vp9_superframe` bitstream filter required by the WebM muxer.

All conversion happens locally in the browser. Files are never uploaded to a conversion server.

## Repository layout

- `index.html` - converter UI and transparent WebM preview
- `bink2-worker.js` - browser worker that owns the WASM runtime and conversion
- `src/bink2_transcode.c` - compact FFmpeg/libvpx transcoder entry point
- `.github/workflows/pages.yml` - builds FFmpeg/libvpx with Emscripten and deploys the assembled site to GitHub Pages

The generated `bink2-core.js` and `bink2-core.wasm` are produced by CI and included in the Pages artifact under `core/`; generated binaries are not committed to `main`.

## Verified sample

The WASM pipeline has been tested end-to-end on a 3200x1500, 30 fps, 98-frame Bink2 file with alpha. It decoded and encoded all 98 frames, produced VP9/WebM with `ALPHA_MODE=1`, and preserved the full 0-255 alpha range.

## GitHub Pages

CI deploys the site from `main` using GitHub's Pages artifact/deployment actions. For a newly created repository, GitHub may require enabling **Settings -> Pages -> Source -> GitHub Actions** once before the first deployment can succeed.

## Licenses

The Pages/build artifact includes FFmpeg's LGPL 2.1 license text and the libvpx license alongside the generated WASM core.
