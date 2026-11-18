# DropFlash audit report

Scope: the uploaded `flashdrop-github-ready` repository (v0.1.0). Result: v0.2.0 in this repository.
Status: **experimental — not production-ready until the physical two-device tests in
[PHYSICAL_TEST_PROTOCOL.md](PHYSICAL_TEST_PROTOCOL.md) pass.**

## 1. Bugs found and fixed

### Camera and scanner
| # | Problem (root cause) | Fix |
|---|---|---|
| C1 | Receiver cropped the camera to its **centre square and downscaled it to 476 px**, destroying cells of grids ≥ ~96 and ignoring patterns not centred. | Full camera frame is processed (default long side 1600 px, configurable 1280/1920). |
| C2 | Localisation was a **bright-pixel bounding box**; any bright object (lamp, window, paper, bezel) broke it. No rotation support. | New finder-pattern localiser (`src/engine/vision/finderPatterns.ts`): block-adaptive binarisation, 1:1:3:1:1 run detection with cross-checks, triple selection by geometry, rotation via orientation vector, mirrored-camera detection. Old detector kept only as fallback. |
| C3 | Sampling used **bilinear quad interpolation**, which is not a perspective model — cells drift under tilt. | True 4-point homography (`vision/homography.ts`) + template-correlation refinement of all four fiducials, dedicated bottom-right fiducial search (its parallelogram prediction can be 20+ modules off under perspective). |
| C4 | Single global threshold (+4 corner hack). | Tile-adaptive two-cluster threshold surface (glare/vignetting), plus bounded ±threshold retries. |
| C5 | The mirrored/transposed hypothesis scored ~0.97 on fixed cells (fiducials are symmetric), doubling decode work and **overwriting the rolling-shutter splice buffer**. | Separate row-8 strip score (not transpose-symmetric) required for acceptance; only the best failed candidate feeds the splice buffer. |
| C6 | Decoding ran **synchronously on the main thread** inside `requestAnimationFrame`, so the UI janked and the same camera frame was decoded repeatedly (`cameraFps` counted rAF ticks, not camera frames). | `ScanSession` + Web Worker: `requestVideoFrameCallback` (one callback per new camera frame), `createImageBitmap` hand-off, exactly one frame in flight, skipped frames counted, worker watchdog (2.5 s, max 3 restarts). |
| C7 | Manual-calibration toggle and corner sliders were captured in a **stale closure** at scan start, so they had no effect while scanning. | Values read through refs; corners normalised to the frame (0–100 %). |
| C8 | Generic camera errors. | `describeCameraError` maps NotAllowed/NotFound/NotReadable/Overconstrained/Security; constraints relaxed over 3 bounded attempts; continuous-focus hint. |
| C9 | Decoder tried 9 grid sizes × 2 quads per frame (incl. 32/80 the sender can't emit). | Grid size estimated from fiducial spacing (≤ 3 candidates per triple), frame-to-frame geometry tracking. |

### Optical engine / protocol
| # | Problem | Fix |
|---|---|---|
| P1 | JSON manifest (up to ~450 B) **did not fit a 48×48 frame** (209 B payload) → `RangeError` and no transfer at grid 48. | Binary manifest (60 B + MIME + name), name truncated UTF-8-safely to the frame capacity; protocol version 2. |
| P2 | Manifest fields unvalidated (untrusted optical input). | Size/chunk/packet-count consistency, SHA format, grid range checked; DATA/PARITY lengths validated against the manifest; inconsistent packets counted and rejected. |
| P3 | Version checked before CRC, so a frame from another app version looked like noise. | CRC first, then version → UI hint “incompatible version”. |
| P4 | Packets decoded with a grid size different from their header were accepted. | Header `gridSize` must equal the sampled geometry. |

### Recovery, reconstruction, storage
| # | Problem | Fix |
|---|---|---|
| R1 | XOR recovery **kept every received chunk of every incomplete block in RAM** — for a lossy multi-GB transfer, close to the whole file. | Running XOR accumulator per block (chunkSize+2 B) under a 48 MiB budget with LRU eviction; evicted blocks are never reconstructed from partial state. |
| R2 | Concurrent `ingestPacket` calls could interleave storage writes with **finalisation** (late write after hashing). | All ingestion serialised through one promise chain; bounded queue (16) with counted backpressure drops. |
| R3 | OPFS: `createWritable({keepExistingData:true})` **per 4 MB batch** copies the whole file every time (quadratic I/O). | One writable stream per transfer with positioned writes; committed once. Verified in Chrome: 64 MB written out-of-order at ~21 MB/s (headless). |
| R4 | OPFS failure mid-transfer silently switched to memory; earlier batches were then missing → guaranteed SHA mismatch. | Storage errors surface as `storage_error` with a message; no silent backend switching. |
| R5 | IndexedDB opened/closed a connection **per chunk**; fallback path assembled the whole file in RAM; chunks never deleted. | Cached connection, batched transactions, cursor reads in batches, Blob per batch, chunks deleted after finalisation. |
| R6 | No quota check; partial OPFS files from abandoned transfers leaked forever. | `navigator.storage.estimate()` check before receiving, `persist()` request for large files, cleanup of stale partials and legacy root files. |
| R7 | Integrity-error state had no way out; “resume” claimed data was “safely persisted” although it was RAM-only. | Start-over action; wording states what is kept and that reloads discard it. |
| R8 | A new transfer on screen was ignored forever once a manifest was locked. | Auto-follow if nothing was received yet, otherwise a “switch transfer” prompt. |

### Sender / UI
| # | Problem | Fix |
|---|---|---|
| U1 | Sender canvas was a fixed 776 px bitmap scaled by CSS to ≤ 460 px → **non-integer resampling dropped/merged cell rows on screen**. | Canvas sized in device pixels with an integer number of pixels per cell (ResizeObserver, DPR, fullscreen), redrawn on resize; warns when < 2 px/cell. |
| U2 | “Raw” throughput displayed `bytes × target FPS` (not measured); 120 FPS offered; 60 FPS default (faster than a 30 FPS camera can sample cleanly). | Only measured values shown; FPS options 5–60, default 10 with guidance; “best case” time labelled as a ceiling. |
| U3 | Home page ran the full audit (incl. 384×384 renders) on every load, freezing phones; the audit printed fabricated numbers (“simulated link speed”, `recoveredViaCarouselWrap = missed − 1`). | Audit runs on request, yields to the UI, and reports only measured outcomes; decoder CPU cost explicitly labelled “not a transfer speed”. |
| U4 | Settings from `localStorage` merged without validation (stale 120 FPS / 384 values). | `sanitizeSettings`. |
| U5 | Wake lock lost when the tab was hidden; fullscreen state not synced with Esc. | Re-acquired on `visibilitychange`; `fullscreenchange` listener; CSS fallback for iPhone. |
| U6 | Navigation state lost on reload; buttons lacked state semantics. | Hash routes with back/forward; `aria-pressed`, `role=alert/status`, labelled sliders. |

### Build, offline, deployment
| # | Problem | Fix |
|---|---|---|
| B1 | `tsconfig` had no `strict`, `types: ["vite/client"]` only — `npm run lint` could not type-check `vite.config.ts` (`fs`, `path`) or the `node:test` file. | Split `tsconfig.json` (app, strict) / `tsconfig.node.json` (config, tests, scripts, Node types). |
| B2 | Service Worker: fixed cache name (`v1.3.0`) never pruned old assets; `skipWaiting()` on install while deleting old caches could break open tabs; registered in dev (stale modules); cached any response. | Per-build cache ID injected at build time, no automatic `skipWaiting` (user-confirmed reload), production-only registration, only `ok` same-origin `basic` responses cached, offline navigation fallback with explicit 503. |
| B3 | Google Fonts loaded from a third party (privacy, offline gaps). | System font stack; CSP `default-src 'self'`. |
| B4 | AI-Studio leftovers in `vite.config.ts` (copying non-existent `src/assets`, HMR env switches); Vercel-only docs. | Removed; Netlify config + headers. |

## 2. Security findings

- **Dependencies:** `vite ^8.3.0` allowed 8.3.0–8.3.2, affected by a dev-server directory-traversal
  advisory fixed in 8.3.3 (Snyk SNYK-JS-VITE-21282039); floor raised to `^8.3.3`. These Vite
  advisories affect the **dev server only**, not the static production build. Build tools moved to
  `devDependencies`; unused `esbuild` and `autoprefixer` removed. No `--force`, no blind upgrades.
- **No lockfile** was included. Run `npm install` once and commit `package-lock.json` so builds are
  reproducible and `npm audit` is meaningful. `npm audit` could **not** be run in this audit
  environment (no registry access) — run it after installing.
- **Untrusted optical input:** manifest and packets are validated (sizes, counts, lengths, grid);
  every frame is CRC-32 checked; the file is SHA-256 verified. CRC-32 is an error check, not
  authentication — anyone who can show a screen to the camera can send data. SHA-256 only proves the
  file equals what *that* sender hashed.
- **File names** from the sender are sanitised (path separators, control and bidi-override
  characters, reserved names, length) before use as the download name.
- **Headers** (`public/_headers`): strict CSP (`script-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`), `Permissions-Policy: camera=(self)`, `Referrer-Policy: no-referrer`,
  `nosniff`, HSTS. `style-src` keeps `'unsafe-inline'` for React style attributes.
- **Dev server** listens on the LAN (`host: true`) for phone testing — do not run it on untrusted networks.
- `BroadcastChannel` completion signal only reaches tabs of the same browser profile; it is
  informational (pauses the sender) and carries no file data.

## 3. Test results (this audit environment)

Environment: Linux, Node 22.23, 2-core Xeon 2.1 GHz, TypeScript 6.0.2 from the npm cache, Chrome for
Testing 153 headless. **`npm install`, `npm run build` and `npm audit` could not be run here** because the
npm registry is not reachable from this sandbox and React/Vite/Tailwind are not cached.

| Check | Result |
|---|---|
| Strict type-check, engine + storage + utils + workers (tsc 6.0.2) | pass, 0 errors |
| Strict type-check, whole app incl. React components (tsc 6.0.2 + a local React API stub, not `@types/react`) | pass, 0 errors |
| Node test suite (same files as `npm test`, compiled with tsc, run with `node --test`) | **44 / 44 pass** |
| Randomised synthetic-camera sweep, 200 frames, 1280×720, grids 48–192, random rotation/tilt/yaw/mirror/glare/blur/noise | ≥ 3.5 px/cell: **110/110**; 2.5–3.5: 35/46; < 2.5: 21/44; **0 false decodes**; decode p50 25 ms, p90 45 ms (Node, 1 core) |
| Headless Chrome: OPFS, 64 MB, chunks written in shuffled order | verified, temp file removed |
| Headless Chrome: IndexedDB backend, 16 MB shuffled | verified |
| Headless Chrome: quota guard | rejects correctly |
| Headless Chrome: reconstructor → OPFS, 3 MB at grid 384, 1 in 7 frames dropped | verified, 16 parity recoveries |
| Headless Chrome: decode worker, buffer and ImageBitmap paths | both decode; 18 ms (tracked) |
| Headless Chrome: **generated** fake-camera video → getUserMedia → worker → reconstruct | 6 KB verified in 4.5 s; 44 refresh-straddling frames rejected by CRC |

The browser harness was executed against tsc-compiled modules; the copy in `tests/browser/` is the same
code with Vite import paths and has not itself been run under Vite here.

**Run on your machine:** `npm install && npm run check`, then the browser harness (README).

## 4. Remaining limitations

- **No physical two-device measurement yet.** Throughput and reliability with real cameras are unknown.
- Decoder reliability drops below ~3.5 camera pixels per cell; dense grids (192+) need a large,
  sharp, close setup. Lens distortion is not modelled (single homography).
- Display refresh vs. camera exposure is unsynchronised: a sender FPS above about half the camera
  frame rate wastes frames. Rolling-shutter splicing only rescues simple two-frame tears.
- Incomplete transfers are kept for the page session only; reload loses them (no cross-reload resume).
- Very large files: OPFS needs free quota ≥ file size; Safari before OPFS writables uses IndexedDB,
  where the final download Blob is assembled in batches and may need substantial memory.
  Multi-GB transfers are impractical over an optical link at these rates anyway.
- One-way link: the sender cannot know a separate device finished; stop it manually.
- iOS: no element fullscreen on iPhone (CSS fallback), wake lock needs iOS 16.4+, and Safari may
  pause the camera when the page is backgrounded.
- `@types/react`-level type checking of the components could not run offline (a stub was used).

## 5. v0.3.0 — UI and smart transmission

**Packet tracking and scheduling**
- The receiver already remembered every received packet (bitmap), skipped duplicates instantly,
  buffered packets that arrive before the manifest, and finished the moment the last packet (or the
  parity that rebuilds it) arrived. v0.3 surfaces this: the scanner shows exactly which packets are
  still missing and how many blocks will be rebuilt by their next parity frame.
- **Interleaved carousel (sender).** Parity blocks are unchanged (K consecutive indices, same packet
  format), but frames are now sent column-wise across groups of K blocks, followed by the group's
  parity frames. A burst of up to K lost frames (shake, refocus, glare) costs at most one packet per
  block, and the parity rebuilds it in the same pass instead of waiting for the next loop.
  Measured on 300 packets (grid 64, K = 8), 20 seeds each, frames until the file is verified:

  | Loss pattern | v0.2 sequential | v0.3 interleaved |
  |---|---|---|
  | 4-frame bursts, 2 % | 924 | 710 (−23 %) |
  | 8-frame bursts, 1 % | 811 | 594 (−27 %) |
  | 10 % isolated drops | 793 | 778 (−2 %) |

- **What is not possible over a one-way optical link:** the sender cannot learn which packets a
  separate receiver is missing, so it cannot re-send only those. (A same-browser return channel
  exists but only reaches tabs on the same device.) The interleaving and parity above are the
  honest way to reduce extra loops without a back channel.

**UI**
- Receive starts the camera immediately (no start screen); full-width camera view with a scanning
  reticle, live status, progress ring, missing-packet list, zoom slider, torch and tap-to-focus
  (shown only when the camera reports support), and a completion dialog with Save.
- Start transmission enters full screen in the same click; the pattern fills the shortest screen
  side at an integer number of device pixels per cell, with a minimal fading control bar.

**Tests:** 47/47 Node tests (new: burst loss rebuilt within the first pass; every packet and parity
block exactly once per loop for any start offset; missing-range reporting). Headless Chrome with a
generated fake-camera video of the new sender: verified transfer; OPFS/IndexedDB/worker checks pass.
`npm install`, `npm run lint` and `npm run build` still could not be run in this sandbox (no npm
registry); the app type-checks under strict mode against a React API stub. Physical two-device
testing remains outstanding.

## 6. v0.4.0 — DropFlash: grayscale and motion tolerance

Renamed to **DropFlash** (visible name; internal storage keys unchanged so existing data stays valid).
The Sender no longer pre-selects a generated `.txt` file and has no sample-file buttons.

**Four-level grayscale (2 bits per cell)**
- Levels 0 / 96 / 176 / 255, Gray-coded so a one-level misread flips one bit. Fixed cells stay
  pure black/white, so detection and tracking are identical to monochrome.
- Each frame announces its mode through its sync word (mono `0xFD4F`, grayscale `0x96A5`) and is
  decoded accordingly. There is no receiver mode state, so nothing to switch, flicker or reset.
- A grayscale frame carries **two complete packets**, each with its own CRC-32, so packet IDs, chunk
  size, manifest, parity and reconstruction are unchanged and both modes mix in one transfer.
- Calibration: the four level brightnesses are learned from the frame's own data cells (captures
  exposure, tone curve/gamma, white balance, display), then a per-tile gain/offset follows glare.
  An earlier per-tile-only version failed on tiles where a level happened to be rare. That was
  found by measuring symbol errors against ground truth and replaced.
- Error correction (both modes): when a packet fails CRC, the 10 cells read closest to a
  threshold are tried alone and in pairs (55 hypotheses), accepted only when CRC-32 verifies.
  Plus the existing XOR parity across packets. There is no Reed–Solomon code.
- Modes: **Auto** (alternate a grayscale loop and a monochrome loop; a receiver that cannot read
  grayscale still gets every packet from the monochrome loops), **Monochrome**, **Grayscale**.
  Over a one-way link the sender cannot learn that a receiver struggles, so "fallback" is this
  alternation plus per-frame mode detection on the receiver.

Synthetic benchmark (generated 1280×720 camera frames, random rotation/tilt/glare/noise/tone curve,
90 frames per mode; **not physical measurements**), packets decoded per frame:

| Camera px per cell | Monochrome | Grayscale |
|---|---|---|
| < 4 | 0.89 | 0.11 |
| 4 – 6 | 0.88 | 1.24 |
| 6 – 9 | 0.97 | 1.94 |
| ≥ 9 | 0.87 | 1.73 |

Grayscale only pays off at ≈ 6+ camera pixels per cell; below 4 it is unusable, hence Auto.

**Motion-tolerant scanning**
- The decoder keeps the pattern's last two poses, predicts the next pose at constant velocity and
  re-aligns all four fiducials with a ±4 module search (±6 after a miss). Rotation, tilt and scale
  changes are re-estimated each frame by homography.
- The lock survives 15 consecutive failed frames; full re-detection runs in parallel, so losing
  the lock never restarts the transfer. Received packets are remembered by packet ID regardless.
- Rolling shutter under steady motion produces a shear, which the homography models; a
  constant-velocity shear is therefore compensated. Non-linear distortion from jerky motion is not.
- Motion blur: thresholds adapt per tile and marginal cells are corrected (above); heavy blur
  still loses frames, and those packets are picked up later.
- The UI keeps "Receiving / Tracking" for 1.5 s after the last valid frame instead of flashing
  errors on brief losses.

Synthetic hand-held sequence (60 frames: sway, rotation drift, distance change, matching motion blur
and rolling-shutter skew). Frame-to-frame tracking decodes as reliably as full re-detection while
costing 8 ms instead of 20 ms per frame at moderate motion; at 3× the motion both decode 48/60 (blur
limited).

**QR vs custom decoding:** DropFlash contains no QR decoder; all frames use its own pattern. The
"mode switching" concern is addressed by per-frame mode identification (above).

**Tests:** 52/52 Node tests. New tests cover grayscale at all grids, calibration under tone
curves/glare/noise, CRC-verified cell correction, a moving-hand sequence (≥29/30 decoded, ≥25/30
by tracking) and Auto-mode transfers including a gray-blind receiver. Headless Chrome with a
generated moving Auto-mode fake-camera video: 12 KB / 58 packets verified in 5.1 s. Lint and
production build still require `npm install` (no registry access here); strict type-check passes
against a React API stub. **Physical multi-device testing (devices, lighting, angles, rates) has not
been done** — use PHYSICAL_TEST_PROTOCOL.md and add grayscale/Auto and hand-held runs to it.

## 7. v0.4.1 — large/fast pattern handling and speed

**Reported:** corner detection "glitched" when the pattern was large in the view or moving fast; slow.

**Root causes (reproduced on synthetic frames):**
- Large patterns with all four corner markers inside the view decode reliably (48/64 grids at
  10–18 px per cell: all in-frame cases decoded). Failures occur when the pattern is so large, or
  the hand moves so far, that a corner marker leaves the camera frame: the cells there are
  physically not captured, so no decoder can read that frame. The old UI reported this as
  "partial pattern", which looked like a corner mix-up.
- Fast movement with ~16 ms auto exposure smears cells by ~12 px: grid 96 decoded 0/16, grid 64
  10/16 frames.

**Fixes**
- `too_close` detection: from the tracker's predicted pose, or (when only two strong markers are
  visible) from the geometry those two markers imply, choosing the pattern side by image texture.
  The UI says "move back a little so all four corners are visible".
- **Freeze motion:** ~2 ms manual exposure via Image Capture constraints, turned on
  automatically where the camera supports it (mainly Android Chrome) and reverted if the image is
  too dark for 2 s. Synthetic, same frames: grid 64 10/16 → 16/16, grid 96 0/16 → 16/16 (with
  doubled sensor noise to model the shorter exposure).
- Camera requested at 60 FPS (more captures per sender frame; tracking keeps decode ≈ 8–20 ms).
- Manifest frames every 12 instead of 6 frames (manifests carry no file data).
- Speed presets with computed ceilings (if every frame is captured; real rates are lower):
  Reliable 64 mono 10 FPS ≈ 3.4 KiB/s · Balanced 96 Auto 15 FPS ≈ 25 KiB/s on grayscale loops ·
  Fast 128 grayscale 30 FPS ≈ 92 KiB/s. Default is Balanced.

**Speed vs Bluetooth, honestly:** typical phone Bluetooth file transfer moves roughly
100 KB/s–1 MB/s. A screen-to-camera link is bounded by camera frame rate × bits a camera can
resolve per frame; even the Fast preset's ceiling (~92 KiB/s) assumes every frame is captured. An
optical link is unlikely to beat Bluetooth on phones; its value is needing no pairing, radio or
network. Physical measurements are still outstanding.

**Tests:** 54/54 (new: large in-frame patterns at 1600×900; tracked pattern pushed off-frame
reports `too_close`). Headless Chrome fake-camera pipeline still verifies (58 packets, 5.2 s).

## 8. v0.4.2 — offline scanning, big patterns, frame speed

**Reported:** some features (the "intelligent" pattern selection / tracking) seemed to work only
online; big patterns still failed; high frame speeds failed.

### "Works only online" — root cause and fix
No part of the app uses the network (verified: no `fetch`, remote URL or remote import anywhere
in `src/`). Detection, tracking and decoding all run locally. The real fault was the
**decoder worker**: when the worker script could not load (typical offline with a stale or
partial cache, or a browser without module workers), the scan session retried it 3 times and then
**stopped scanning**. On screen this looked like tracking only worked online.

- A worker that fails before its first answer is treated as a load failure: the session switches
  at once to the same decoder on the main thread. Scanning, tracking and lock-on carry on.
- After 3 runtime restarts the session also falls back to the main thread instead of stopping.
- The HUD shows "decoding on main thread" when this happens.
- The worker chunk is in the service-worker precache (the build lists every emitted file).
- **Verified:** Node test with a worker that never loads, and real headless Chrome with a worker
  URL that does not exist. Both switch to the main thread (Chrome: 0.7 s) and decode every packet
  with no errors. Before the fix, the same Chrome case stopped scanning.

### Big patterns — root cause and fix
Reproduced: at ~19 px per cell (pattern filling a 1080p view) the camera resolves the sender
screen's own **pixel grid** inside every module (screen-door). Full-resolution finder detection
then saw stripes, not markers: 2/6 decoded, 0 finders found. The synthetic camera now models this
(`screenPixelsPerCell`, `screenDoorDepth`).

- **Multi-scale finder search:** markers are searched at full, ½ and ¼ resolution (box-averaged,
  which removes the pixel grid), starting at the coarse level when the tracked pattern is already
  large. Stops at the first level with a confident sync.
- **Area sampling:** cells of ≥9 px are read as a 3×3 average, not a single point.
- Result: screen-door cases 2/6 → 6/6 at 2 and 3 display pixels per cell; earlier large-pattern
  tests unchanged.

### Frame speed — root cause and fix
Timed simulation: sender frames on a 60 Hz vsync, a 30 FPS camera with 0.3% clock drift, 22 ms
rolling-shutter readout, every capture phase swept. Unique packets out of those shown in 3 s:

| Sender | Camera | mono 64 (4 phases) | gray 96 (4 phases) |
|---|---|---|---|
| 20 FPS | 30 FPS | 60, 60, 60, 59 of 60 | 120 of 120 in every phase |
| 30 FPS | 30 FPS | 83, 68, 12, 29 of 90 | 154, 144, 77, 91 of 180 |

At equal sender and camera rates most captures straddle a frame change, so results depend on
luck of phase (13–92%). At 20 FPS every phase gets essentially everything. On gray 96, 20 FPS
averages the same throughput as 30 FPS (≈ 41 vs ≈ 40 KiB/s) but without the collapses.

- **Fast preset is now 20 FPS** (gray 128; ceiling 61 KiB/s instead of 92 KiB/s, which a
  30 FPS camera could not reach).
- The receiver shows its measured camera rate and the highest safe sender FPS (≤ ~⅔ of it).
- The sender warns when 30 or 60 FPS is chosen.
- **Rolling-shutter splice in sensor coordinates:** a capture that holds frame A above a scan line
  and frame B below it is combined cell by cell with the previous failed capture along candidate
  sensor lines (bounded: 2 × 24 tries), then checked by CRC. This works at any phone rotation and
  in grayscale. Synthetic, every capture torn: mono 0 → 19 (upright) and 0 → 15 (sideways) of
  40; gray sideways 0 → 38 of 80.

**Tests:** 57/57 (new: screen-door big patterns at 1920×1080; torn captures on a sideways phone;
worker load failure keeps scanning). App type-check clean. Headless Chrome fake-camera e2e: 58/58
packets, SHA-256 verified, 5.1 s. `npm install` / `lint` / `build` still cannot run here (no npm
registry access). All results are synthetic or fake-camera; physical two-device testing remains
outstanding.
