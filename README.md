# DropFlash

DropFlash is an experimental, client-side screen-to-camera file-transfer web app. The sender shows a
file as a looping sequence of black-and-white patterns; the receiver films the screen, can join at
any point in the loop, rebuilds occasional missed frames from parity frames, and verifies the
result with SHA-256. Nothing is uploaded; there is no backend.

> **Status: experimental.** The protocol, decoder and storage are covered by automated tests on
> generated (synthetic) images and in a real browser with a *generated* fake-camera video. Real
> two-device optical throughput and reliability have **not** been measured yet — see
> [docs/PHYSICAL_TEST_PROTOCOL.md](docs/PHYSICAL_TEST_PROTOCOL.md). Do not rely on it for important
> data until you have tested your own devices.

## What it does

- Encodings: **Auto** (alternating grayscale and monochrome loops), **Monochrome** (1 bit/cell) and
  **Grayscale** (4 levels, 2 bits/cell, two packets per frame; needs ≈6+ camera pixels per cell).
- Motion-tolerant scanning: the receiver tracks the pattern frame to frame (predicted pose +
  re-alignment), keeps its lock through brief losses and never restarts a transfer when it moves.

- Custom monochrome matrix (not QR): four corner fiducials (the bottom-right one has a dark centre
  for orientation), timing borders, a calibration strip and a 16-bit sync word.
- Receiver locates the pattern **anywhere in the full camera frame**, handles any in-plane rotation,
  mirrored (front) cameras and perspective tilt (true homography), and thresholds adaptively for
  glare and uneven brightness. Decoding runs in a Web Worker.
- Packets: 24-byte header, CRC-32, periodic manifest (binary, fits the smallest grid), XOR parity
  per block of K packets, join-anywhere reception.
- Storage: small files in memory, large files streamed to OPFS (one writable stream) or IndexedDB
  (batched), with a quota check before receiving. SHA-256 is computed by streaming.
- Works offline after the first visit (Service Worker precache) at the same HTTPS address. All detection, tracking and decoding run on the device; if the background decoder cannot start offline, decoding continues on the main thread.
- Sender speed: keep the sender FPS at or below about two thirds of the receiver camera's rate (20 FPS for a typical 30 FPS phone camera). The receiver shows the safe rate for its camera.

## Realistic expectations

| Grid | File data per DATA frame | Ceiling at 10 FPS if *every* frame is captured |
|---|---|---|
| 48×48 | 207 B | ≈ 1.5 KiB/s |
| 64×64 | 423 B | ≈ 3.1 KiB/s |
| 96×96 | 1,047 B | ≈ 7.6 KiB/s |
| 128×128 | 1,927 B | ≈ 13.9 KiB/s |
| 192×192 | 4,455 B | ≈ 32 KiB/s |
| 384×384 | 18,183 B | ≈ 132 KiB/s (needs ≥ 3.5 camera px per cell — rarely achievable with a phone) |

(Ceilings account for one manifest frame in six and one parity frame per eight data frames; computed by `auditGridCapacity`.) A single frame cannot carry
700 KB — that would need ≈ 2400×2400 cells. Actual speed is lower than these ceilings and depends
on the camera, focus, distance, lighting and display. In synthetic tests the decoder is reliable
at ≥ 3.5 camera pixels per cell and degrades below that.

**Practical settings:** sender 10 FPS (≤ half the receiver camera's frame rate), grid 48–96,
full-screen pattern, maximum screen brightness, receiver held steady 15–30 cm away.

## Requirements

- Node.js 20.19+ or 22.12+ (Vite 8). npm.
- Browsers: current Chrome/Edge (desktop, Android), Safari 16.4+ (iOS/macOS), Firefox 115+.
  Camera access requires **HTTPS** (or `localhost`).

## Run locally

```bash
npm install          # creates package-lock.json — commit it
npm run dev          # http://localhost:3000 (also exposed on your LAN)
```

Phones only allow the camera over HTTPS, so for two-device tests use a Netlify deploy preview or an
HTTPS tunnel to the dev server. The Service Worker is only registered in production builds
(`npm run build && npm run preview`).

## Checks

```bash
npm run lint    # tsc --noEmit for the app (tsconfig.json) and Node-side code/tests (tsconfig.node.json)
npm test        # protocol, decoder (digital + synthetic camera), end-to-end transfer tests
npm run build   # production build + Service Worker precache injection
npm run check   # all three
```

Browser integration tests (real OPFS, IndexedDB, Worker and the camera pipeline fed by a generated
fake-camera video):

```bash
npx tsx scripts/make-fake-camera-video.ts      # optional; enables the camera test
npm run dev
CHROME_PATH=/path/to/chrome node scripts/run-browser-tests.mjs http://localhost:3000
# or open http://localhost:3000/tests/browser/index.html and press “Run tests”
```

## Deploy to Netlify

1. Push the repository to GitHub (commit `package-lock.json` after `npm install`).
2. Netlify → **Add new site → Import an existing project** → choose the repository.
3. Netlify reads `netlify.toml`: build command `npm run check`, publish directory `dist`,
   Node 22. (Netlify installs dependencies automatically before the build.)
4. Deploy. HTTPS is enabled by default, which the camera requires.
5. Security headers (CSP, `Permissions-Policy: camera=(self)`, no-cache for the Service Worker,
   immutable caching for hashed assets) come from `public/_headers`.

Manual deploy without Git: `npm run build`, then drag the `dist/` folder onto
<https://app.netlify.com/drop>.

After a new deploy, open tabs show “A new version is ready — Reload now”; the new Service Worker
takes over only when the user reloads, so a running transfer is never interrupted.

## Project structure

```text
public/                 Service Worker, manifest, icons, Netlify _headers
src/engine/             Protocol, encoder, decoder, recovery, reconstruction, scan session
src/engine/vision/      Finder-pattern localisation, binarisation, homography
src/workers/            Decode Web Worker
src/storage/            OPFS / IndexedDB / memory chunk storage
src/components/         React UI
tests/browser/          In-browser integration tests
scripts/                Fake-camera video generator, headless Chrome test runner
docs/                   Audit report, physical test protocol
```

## Security and privacy

Files are processed locally. Received files are verified for integrity (SHA-256 of what the sender
hashed) — that is not a safety check: only open files from senders you trust. File names from the
sender are sanitised before download. The app makes no network requests besides loading itself.
See [docs/AUDIT_REPORT.md](docs/AUDIT_REPORT.md) for the full audit.
