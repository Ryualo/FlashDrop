/**
 * Generates tests/browser/fake-camera.y4m: a SYNTHETIC camera recording of a complete DropFlash
 * carousel (perspective, noise, blur, plus blended frames that straddle a display refresh).
 * Chrome can play it as a webcam:  --use-fake-device-for-media-stream
 *                                  --use-file-for-fake-video-capture=tests/browser/fake-camera.y4m
 * Usage: npx tsx scripts/make-fake-camera-video.ts
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { StreamingFileCarousel } from '../src/engine/fileChunker';
import { encodeFrameToMatrix } from '../src/engine/opticalEncoder';
import { frameModeFor } from '../src/engine/transferManager';
import { renderSyntheticCameraFrame } from '../src/engine/syntheticCamera';

const W = 640;
const H = 480;
const GS = 48;
const OUT = 'tests/browser/fake-camera.y4m';

function toI420(rgba: Uint8ClampedArray): Buffer {
  const y = new Uint8Array(W * H);
  const u = new Uint8Array((W * H) / 4);
  const v = new Uint8Array((W * H) / 4);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const p = (j * W + i) * 4;
      y[j * W + i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
    }
  for (let j = 0; j < H / 2; j++)
    for (let i = 0; i < W / 2; i++) {
      const p = (j * 2 * W + i * 2) * 4;
      const [r, g, b] = [rgba[p], rgba[p + 1], rgba[p + 2]];
      u[(j * W) / 2 + i] = Math.max(0, Math.min(255, Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128)));
      v[(j * W) / 2 + i] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128)));
    }
  return Buffer.concat([Buffer.from(y), Buffer.from(u), Buffer.from(v)]);
}

const size = 12000;
const data = new Uint8Array(size);
let s = 77;
for (let i = 0; i < size; i++) {
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  data[i] = s >>> 24;
}
const carousel = new StreamingFileCarousel(new File([data], 'fake-camera.bin'), 'fake-camera.bin', 'application/octet-stream', {
  gridSize: GS,
  erasureBlockSize: 4,
  manifestIntervalFrames: 6,
  startPacketOffset: 11,
});
const manifest = await carousel.prepare();
const fd = fs.openSync(OUT, 'w');
fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
let prev: Uint8ClampedArray | null = null;
let frames = 0;
const loop = manifest.totalSourcePackets + Math.ceil(manifest.totalSourcePackets / 4) + Math.ceil(manifest.totalSourcePackets / 5) + 4;
for (let k = 0; k < Math.ceil(loop * 1.4); k++) {
  const pkt = await carousel.nextPacket();
  const mode = frameModeFor('auto', pkt.loopCycle); // grayscale loop, then monochrome loop
  const packets = mode === 'gray4' ? [pkt, await carousel.nextPacket()] : [pkt];
  // Hand-held sway with matching motion blur and rolling-shutter skew
  const t = k * 0.35;
  const t2 = t + 0.35;
  const cx = 320 + 25 * Math.sin(t * 0.7) + 6 * Math.sin(t * 2.3);
  const cy = 240 + 15 * Math.sin(t * 0.9 + 1);
  const cx2 = 320 + 25 * Math.sin(t2 * 0.7) + 6 * Math.sin(t2 * 2.3);
  const cy2 = 240 + 15 * Math.sin(t2 * 0.9 + 1);
  const f = renderSyntheticCameraFrame(encodeFrameToMatrix(packets.map((p) => p.rawBytes), GS, mode), {
    width: W,
    height: H,
    matrixSidePx: 400 + 20 * Math.sin(t * 0.4),
    centerX: cx,
    centerY: cy,
    rotationDeg: 7 + 5 * Math.sin(t * 0.5),
    perspectiveTilt: 0.08,
    noiseAmplitude: 4,
    blurRadius: 1,
    motionBlurPx: Math.hypot(cx2 - cx, cy2 - cy) * 0.3,
    motionBlurAngleDeg: (Math.atan2(cy2 - cy, cx2 - cx) * 180) / Math.PI,
    rollingShutterPx: (cx2 - cx) * 0.6,
    toneGamma: 1.2,
    seed: k + 1,
  });
  const seq: Uint8ClampedArray[] = [];
  if (prev) {
    const blend = new Uint8ClampedArray(f.data.length);
    for (let i = 0; i < blend.length; i++) blend[i] = (prev[i] + f.data[i]) >> 1;
    seq.push(blend); // exposure straddling a display refresh: must be rejected by CRC
  }
  seq.push(f.data, f.data); // 10 FPS display captured by a 30 FPS camera
  for (const fr of seq) {
    fs.writeSync(fd, 'FRAME\n');
    fs.writeSync(fd, toI420(fr));
    frames++;
  }
  prev = f.data;
}
fs.closeSync(fd);
fs.writeFileSync(
  'tests/browser/fake-camera.json',
  JSON.stringify({ sha: createHash('sha256').update(data).digest('hex'), size, totalSourcePackets: manifest.totalSourcePackets, frames })
);
console.log(`Wrote ${OUT}: ${frames} frames, ${manifest.totalSourcePackets} packets`);
