# Physical two-device test protocol

Everything in the automated test suite uses **generated images** (pixel-exact renders, a synthetic
camera model, or a generated fake-camera video played to Chrome). None of it measures a real camera
filming a real screen. Until the table at the bottom is filled in with real results, DropFlash's
optical throughput and reliability are **unverified**.

## Setup

1. Deploy to HTTPS (Netlify deploy preview is fine). Open the same URL on both devices.
2. Sender: a laptop or tablet, brightness at maximum, auto-brightness and night-shift/true-tone off,
   “Full screen” pressed on the transmission view.
3. Receiver: a phone on a stand or held steadily 15–30 cm from the screen, pattern filling most of
   the camera view. Use the rear camera.
4. Test files: the in-app “24 KB test file” and “1 MB test file”, plus one real file (photo/PDF).

## Matrix of runs (each run: start the receiver, then the sender, stop at “SHA-256 verified”)

| Variable | Values |
| Encoding | Auto, Monochrome, Grayscale |
| Holding | phone on a stand; hand-held, natural sway |
|---|---|
| Grid | 48, 64, 96, 128 |
| Sender FPS | 5, 10, 15 |
| Receiver processing resolution | 1280, 1600 |
| Lighting | normal room light; bright window/lamp reflecting on the screen |
| Angle | straight on; ~25° tilt |
| Join point | receiver starts before sender; receiver starts mid-loop |

## What to record (from the receiver UI)

- Time from first valid packet to “SHA-256 verified” (stopwatch or screen recording timestamps).
- Measured file data rate (receiver panel), camera frames/s, decoded/s, valid packets/s.
- CRC errors, “no lock” frames, parity recoveries, number of carousel loops needed (sender panel).
- Cell size on screen (sender) and px/cell (receiver).
- Final status: verified / integrity error / storage error / gave up (> 10 min).
- Device models, OS and browser versions.

## Pass criteria for calling a configuration “working”

- 5 of 5 consecutive runs reach “SHA-256 verified” on the 1 MB file.
- No integrity errors in 20 runs.
- Reported throughput is taken from the receiver's measured value, never from the sender's ceiling.

## Results (fill in)

| Date | Sender device / browser | Receiver device / browser | Grid | FPS | File | Time | Measured rate | CRC err | Loops | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |
