# Tiltak WASM provenance

Fetched 2026-11-07 from the author's own deployment of tiltak-wasm, not rebuilt locally.

| file | bytes | sha256 | source |
|---|---|---|---|
| `tiltak_wasm_bg.wasm` | 546489 (gzip −9: 186789) | `7b70bdb0b5daae92dbd33bf6024efe60a4836761c553dd39633aad30385b2377` | https://tiltak-wasm.vercel.app/static/media/tiltak_wasm_bg.201235625bd629172bb2.wasm (saved without the content hash) |
| `tiltak_wasm.js` | 19873 | `718fbbb6996a48761c0bd3d6e7b2571c4439d58e13487b49b673c9df79b83767` | `sourcesContent` entry `../tiltak-wasm/wasm-build/tiltak_wasm.js` in https://tiltak-wasm.vercel.app/static/js/calc.worker.683f9d56.worker.js.map (sha256 of the map: `c5c4666a2fd529882212b508dec74dd08945388e6b4c7829ae8a336becd81058`), unmodified |
| `COPYING` | 35149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` | `LICENSE` from github.com/MortenLohne/tiltak-wasm (GPL-3.0 text) |
| `worker.js`, `../tiltak.js` | — | — | ours |

The glue is the stock `wasm-pack build --target web` output (wasm-bindgen 0.2.100) for this exact binary.
Its 50 `wbg` imports match the binary's imports one-for-one (checked with `WebAssembly.Module.imports`).

## Which commit

- **tiltak-wasm**: `3e116108631bacedaac1d3d679e8a0c05e63b46e` (2025-08-01, "Update to latest tiltak version, to get some tei fixes"), HEAD of `main` at fetch time.
- **tiltak** (engine): `532caa3f028848f7013cbaf4fd9f6e93ded8478d`, as pinned in that commit's `tiltak-wasm/Cargo.lock`.
- **dlmalloc-rs**: `1463e22a64002db7a0d37ca7149a624309da99a1`, likewise pinned.

Evidence: the binary's panic strings embed the Cargo checkout paths
`/vercel/.cargo/git/checkouts/tiltak-84976490a3106536/532caa3/…` and `…/dlmalloc-rs-51f235850c07bc2c/1463e22/…`,
which match the pins in tiltak-wasm `3e11610`'s Cargo.lock. Rust toolchain: rustc commit `6b00bc3880198600130e1cf62b8f8a93494488cc`
(from the same panic paths). Built on Vercel, so this is the author's CI build of that commit rather than a byte-reproducible
local build.

Source for this exact build (GPL-3.0 §6(d) "corresponding source", offered by link):
- https://github.com/MortenLohne/tiltak-wasm/tree/3e116108631bacedaac1d3d679e8a0c05e63b46e
- https://github.com/MortenLohne/tiltak/tree/532caa3f028848f7013cbaf4fd9f6e93ded8478d

## Not used

PTN Ninja's copy (`gruppler/PTN-Ninja` `public/tiltak-wasm/`, 948523 bytes, sha256 `babff972…98d4`) is a different build:
it adds `is_tak` / `is_tinue` / `annotate_ptn` exports that are not in MortenLohne/tiltak-wasm, so it has no published
commit to point at, and it is ~400 KB larger.

## What this build accepts (measured in Chromium, 2026-11-07)

- Sizes 4, 5, 6. `teinewgame 7` / `8` panics (`tei.rs:189 Unsupported size`).
- Komi 0 and 2 only (`HalfKomi` 0 / 4). `setoption` accepts −10…10, but any other value panics at the first search
  (`position/mod.rs:1159 not implemented: 2.5 komi not supported in 6s`): there are trained weights only for those two.
- No `wdl` in `info` (added to Tiltak later), no `MultiPV`, no `Hash` option.
