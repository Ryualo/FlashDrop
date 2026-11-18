/**
 * Optical decoder tests.
 *
 * Two clearly separated groups:
 *  1. DIGITAL: pixel-exact renders of the sender canvas (no camera model).
 *  2. SYNTHETIC CAMERA: generated camera-like frames (perspective, rotation, mirroring, room
 *     clutter, glare, blur, noise). These are NOT physical-camera results — see
 *     docs/PHYSICAL_TEST_PROTOCOL.md for the two-device procedure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePacket, PacketType, PROTOCOL_VERSION } from './packetProtocol';
import { encodePacketToMatrix, getGridPayloadCapacityBytes, renderMatrixToImageData } from './opticalEncoder';
import { OpticalFrameDecoder, SUPPORTED_GRID_SIZES } from './opticalDecoder';
import { renderSyntheticCameraFrame, SyntheticCameraConfig } from './syntheticCamera';
import { crc32 } from '../utils/integrity';

function makePacket(gs: number, index: number, transferId = 0x1234) {
  const n = getGridPayloadCapacityBytes(gs) - 2;
  const payload = new Uint8Array(n);
  for (let i = 0; i < n; i++) payload[i] = (i * 131 + index * 7 + 3) & 0xff;
  const bytes = encodePacket({
    packetType: PacketType.DATA,
    transferId,
    fileId: 1,
    packetIndex: index,
    totalSourcePackets: 999,
    erasureBlockSize: 8,
    gridSize: gs,
    flags: 0,
    payload,
  });
  return { bytes, payload };
}

// ------------------------------------------------------------------ 1. DIGITAL

test('DIGITAL: every supported grid size decodes bit-exactly from a pixel-exact render', () => {
  for (const gs of SUPPORTED_GRID_SIZES) {
    const { bytes, payload } = makePacket(gs, 1);
    const dim = (gs + 4) * 2; // 2 px per module, the minimum the sender uses
    const img = renderMatrixToImageData(encodePacketToMatrix(bytes, gs), dim, dim, 2);
    const r = new OpticalFrameDecoder().decodeRgba(img.data, dim, dim);
    assert.equal(r.status, 'valid', `grid ${gs}: ${r.hint} sync=${r.syncQuality}`);
    assert.equal(r.gridSizeUsed, gs);
    assert.equal(r.syncWordRead, 0xfd4f);
    assert.deepEqual(r.packet!.payload, payload);
  }
});

test('DIGITAL: random noise and blank frames never yield a valid packet', () => {
  const dec = new OpticalFrameDecoder();
  let s = 99;
  for (let k = 0; k < 6; k++) {
    const w = 320;
    const h = 240;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      data[i] = k % 3 === 0 ? 0 : (s >>> 24) & 0xff;
    }
    assert.notEqual(dec.decodeRgba(data, w, h).status, 'valid');
  }
});

test('DIGITAL: corrupted cells are rejected by CRC-32 (never returned as valid)', () => {
  const gs = 64;
  const { bytes } = makePacket(gs, 2);
  const m = encodePacketToMatrix(bytes, gs);
  // Flip three data cells
  let flipped = 0;
  for (let i = 0; i < m.cells.length && flipped < 3; i += 997) {
    const r = Math.floor(i / gs);
    const c = i % gs;
    if (r > 9 && r < gs - 9 && c > 9 && c < gs - 9) {
      m.cells[i] ^= 1;
      flipped++;
    }
  }
  const dim = (gs + 4) * 4;
  const img = renderMatrixToImageData(m, dim, dim, 2);
  const r = new OpticalFrameDecoder().decodeRgba(img.data, dim, dim, { expectedGridSize: gs });
  assert.equal(r.status, 'crc_error');
});

test('DIGITAL: frames from an incompatible protocol version are reported, not silently dropped', () => {
  const gs = 64;
  const { bytes } = makePacket(gs, 3);
  bytes[2] = PROTOCOL_VERSION + 1;
  new DataView(bytes.buffer).setUint32(bytes.length - 4, crc32(bytes, 0, bytes.length - 4));
  const dim = (gs + 4) * 4;
  const img = renderMatrixToImageData(encodePacketToMatrix(bytes, gs), dim, dim, 2);
  const r = new OpticalFrameDecoder().decodeRgba(img.data, dim, dim);
  assert.equal(r.status, 'crc_error');
  assert.equal(r.hint, 'incompatible_version');
});

test('DIGITAL: rolling-shutter tear across two captures is spliced and verified by CRC', () => {
  const gs = 48;
  const a = makePacket(gs, 1);
  const b = makePacket(gs, 2);
  const cellPx = 6;
  const dim = (gs + 4) * cellPx;
  const imgA = new Uint8ClampedArray(renderMatrixToImageData(encodePacketToMatrix(a.bytes, gs), dim, dim, 2).data);
  const imgB = new Uint8ClampedArray(renderMatrixToImageData(encodePacketToMatrix(b.bytes, gs), dim, dim, 2).data);
  const tear = (top: Uint8ClampedArray, bottom: Uint8ClampedArray, row: number) => {
    const split = (2 + row) * cellPx * dim * 4;
    const out = new Uint8ClampedArray(top.length);
    out.set(top.subarray(0, split), 0);
    out.set(bottom.subarray(split), split);
    return out;
  };
  const dec = new OpticalFrameDecoder();
  assert.equal(dec.decodeRgba(tear(imgA, imgB, 30), dim, dim, { expectedGridSize: gs }).status, 'crc_error');
  const r = dec.decodeRgba(tear(imgB, imgA, 20), dim, dim, { expectedGridSize: gs });
  assert.equal(r.status, 'valid');
  assert.equal(r.deTornRecovered, true);
  assert.deepEqual(r.packet!.payload, a.payload);
});

test('DIGITAL: manual corner calibration decodes when automatic localisation is bypassed', () => {
  const gs = 64;
  const { bytes, payload } = makePacket(gs, 4);
  const cell = 5;
  const dim = (gs + 4) * cell;
  const img = renderMatrixToImageData(encodePacketToMatrix(bytes, gs), dim, dim, 2);
  const o = 2 * cell;
  const e = (gs + 2) * cell;
  const r = new OpticalFrameDecoder().decodeRgba(img.data, dim, dim, {
    expectedGridSize: gs,
    customCorners: { topLeft: { x: o, y: o }, topRight: { x: e, y: o }, bottomLeft: { x: o, y: e }, bottomRight: { x: e, y: e } },
  });
  assert.equal(r.status, 'valid');
  assert.equal(r.locator, 'manual');
  assert.deepEqual(r.packet!.payload, payload);
});

// ------------------------------------------------------------------ 2. SYNTHETIC CAMERA

function synth(gs: number, index: number, cfg: Omit<SyntheticCameraConfig, 'width' | 'height'> & { width?: number; height?: number }) {
  const p = makePacket(gs, index);
  const frame = renderSyntheticCameraFrame(encodePacketToMatrix(p.bytes, gs), { width: 1280, height: 720, ...cfg });
  return { ...p, frame };
}

const GEOMETRIES: Array<{ name: string; gs: number; cfg: Omit<SyntheticCameraConfig, 'width' | 'height'> }> = [
  { name: 'upright 48', gs: 48, cfg: { matrixSidePx: 420 } },
  { name: 'rotated 17°', gs: 64, cfg: { matrixSidePx: 500, rotationDeg: 17 } },
  { name: 'rotated 45°, small, off-centre', gs: 64, cfg: { matrixSidePx: 300, rotationDeg: 45, centerX: 350, centerY: 250 } },
  { name: 'rotated 90° + tilt', gs: 64, cfg: { matrixSidePx: 500, rotationDeg: 90, perspectiveTilt: 0.15 } },
  { name: 'upside-down + tilt + yaw', gs: 64, cfg: { matrixSidePx: 520, rotationDeg: 200, perspectiveTilt: 0.2, perspectiveYaw: 0.15 } },
  { name: 'mirrored (front camera)', gs: 64, cfg: { matrixSidePx: 480, mirror: true } },
  { name: '96 tilted', gs: 96, cfg: { matrixSidePx: 640, rotationDeg: -8, perspectiveTilt: 0.12 } },
  { name: '128 rotated + tilted', gs: 128, cfg: { matrixSidePx: 680, rotationDeg: 5, perspectiveTilt: 0.1 } },
  { name: '128 strong perspective', gs: 128, cfg: { matrixSidePx: 520, rotationDeg: 33, perspectiveTilt: 0.15, perspectiveYaw: 0.1 } },
  { name: 'heavy glare', gs: 64, cfg: { matrixSidePx: 450, rotationDeg: -20, glareDelta: 90 } },
  { name: 'low contrast display', gs: 64, cfg: { matrixSidePx: 400, rotationDeg: 10, blackLevel: 60, whiteLevel: 140 } },
  { name: 'strong blur', gs: 64, cfg: { matrixSidePx: 400, rotationDeg: 10, blurRadius: 2 } },
  { name: 'high sensor noise', gs: 64, cfg: { matrixSidePx: 450, noiseAmplitude: 14 } },
  { name: '192 slight tilt', gs: 192, cfg: { matrixSidePx: 600, rotationDeg: 7, perspectiveTilt: 0.08 } },
];

for (const g of GEOMETRIES) {
  test(`SYNTHETIC CAMERA 1280×720: ${g.name} (grid ${g.gs})`, () => {
    const { frame, payload } = synth(g.gs, 5, { ...g.cfg, seed: 9 });
    const r = new OpticalFrameDecoder().decodeRgba(frame.data, frame.width, frame.height);
    assert.equal(r.status, 'valid', `${g.name}: ${r.status}/${r.hint} sync=${r.syncQuality.toFixed(2)} ppm=${frame.pixelsPerModule.toFixed(2)}`);
    assert.equal(r.gridSizeUsed, g.gs);
    assert.deepEqual(r.packet!.payload, payload);
  });
}

test('SYNTHETIC CAMERA 1920×1080: grid size is detected without a hint', () => {
  for (const gs of [64, 96, 128]) {
    const { frame, payload } = synth(gs, 6, { width: 1920, height: 1080, matrixSidePx: 820, rotationDeg: 12, perspectiveTilt: 0.1, seed: 4 });
    const r = new OpticalFrameDecoder().decodeRgba(frame.data, frame.width, frame.height);
    assert.equal(r.status, 'valid', `grid ${gs}: ${r.hint}`);
    assert.equal(r.gridSizeUsed, gs);
    assert.deepEqual(r.packet!.payload, payload);
  }
});

test('SYNTHETIC CAMERA: a matrix cut off by the frame edge fails gracefully with a hint', () => {
  const { frame } = synth(64, 7, { matrixSidePx: 500, centerX: 1180, centerY: 360, seed: 3 });
  const r = new OpticalFrameDecoder().decodeRgba(frame.data, frame.width, frame.height);
  assert.notEqual(r.status, 'valid');
  assert.equal(r.hint, 'too_close'); // clipped pattern is recognised as such
});

test('SYNTHETIC CAMERA: frame-to-frame lock tracking reuses the previous geometry', () => {
  const dec = new OpticalFrameDecoder();
  const first = synth(64, 1, { matrixSidePx: 480, rotationDeg: 8, seed: 1 });
  const r1 = dec.decodeRgba(first.frame.data, 1280, 720);
  assert.equal(r1.status, 'valid');
  const second = synth(64, 2, { matrixSidePx: 480, rotationDeg: 8, seed: 2 });
  const r2 = dec.decodeRgba(second.frame.data, 1280, 720);
  assert.equal(r2.status, 'valid');
  assert.equal(r2.locator, 'tracked');
  assert.deepEqual(r2.packet!.payload, second.payload);
});

test('SYNTHETIC CAMERA: randomized sweep (≥4.5 px/module) decodes reliably with zero false decodes', () => {
  let state = 2024;
  const rnd = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  let ok = 0;
  let wrong = 0;
  let n = 0;
  while (n < 24) {
    const gs = [48, 64, 96][Math.floor(rnd() * 3)];
    const rot = rnd() * 360;
    const side = 380 + rnd() * 220;
    const ppm = side / (gs + 4);
    if (ppm < 4.5) continue;
    const tilt = rnd() * 0.18;
    const p = makePacket(gs, n);
    const frame = renderSyntheticCameraFrame(encodePacketToMatrix(p.bytes, gs), {
      width: 1280,
      height: 720,
      matrixSidePx: side,
      rotationDeg: rot,
      perspectiveTilt: tilt,
      perspectiveYaw: rnd() * 0.12,
      mirror: rnd() < 0.15,
      blurRadius: ppm > 6 ? 1 : 0,
      noiseAmplitude: 2 + rnd() * 8,
      glareDelta: rnd() * 50,
      seed: n + 11,
    });
    const inside = Object.values(frame.trueCorners).every((q) => q.x > 6 && q.y > 6 && q.x < 1274 && q.y < 714);
    if (!inside) continue;
    n++;
    const r = new OpticalFrameDecoder().decodeRgba(frame.data, 1280, 720);
    if (r.status === 'valid') {
      if (r.packet!.packetIndex === n - 1 && Buffer.compare(Buffer.from(r.packet!.payload), Buffer.from(p.payload)) === 0) ok++;
      else wrong++;
    }
  }
  assert.equal(wrong, 0, 'no CRC-valid but wrong packets');
  assert.ok(ok >= 22, `decoded ${ok}/24 synthetic frames`);
});

// ------------------------------------------------------------------ 3. GRAYSCALE + MOTION

import { encodeFrameToMatrix } from './opticalEncoder';

test('DIGITAL gray4: every grid carries two packets per frame, mode detected from the sync word', () => {
  for (const gs of SUPPORTED_GRID_SIZES) {
    const a = makePacket(gs, 1);
    const b = makePacket(gs, 2);
    const dim = (gs + 4) * 3;
    const img = renderMatrixToImageData(encodeFrameToMatrix([a.bytes, b.bytes], gs, 'gray4'), dim, dim, 2);
    const r = new OpticalFrameDecoder().decodeRgba(img.data, dim, dim);
    assert.equal(r.status, 'valid', `grid ${gs}`);
    assert.equal(r.mode, 'gray4');
    assert.equal(r.packets!.length, 2);
    assert.deepEqual(r.packets![0].payload, a.payload);
    assert.deepEqual(r.packets![1].payload, b.payload);
  }
});

test('SYNTHETIC CAMERA gray4: calibration adapts to camera tone curve, glare and noise', () => {
  let ok = 0;
  let n = 0;
  for (const toneGamma of [0.6, 1, 1.5])
    for (const glareDelta of [0, 50])
      for (const noiseAmplitude of [2, 10]) {
        const a = makePacket(48, n);
        const b = makePacket(48, n + 100);
        const f = renderSyntheticCameraFrame(encodeFrameToMatrix([a.bytes, b.bytes], 48, 'gray4'), {
          width: 1280,
          height: 720,
          matrixSidePx: 520,
          rotationDeg: n * 29,
          toneGamma,
          glareDelta,
          noiseAmplitude,
          seed: n + 3,
        });
        const r = new OpticalFrameDecoder().decodeRgba(f.data, 1280, 720);
        n++;
        if (r.status === 'valid' && r.packets!.length === 2 && Buffer.from(r.packets![1].payload).equals(Buffer.from(b.payload))) ok++;
      }
  assert.equal(ok, n, `${ok}/${n} grayscale frames fully decoded`);
});

test('Least-reliable-cell correction repairs marginal cells (verified by CRC)', () => {
  const gs = 64;
  const { bytes, payload } = makePacket(gs, 9);
  const m = encodePacketToMatrix(bytes, gs);
  const cell = 5;
  const dim = (gs + 4) * cell;
  const img = renderMatrixToImageData(m, dim, dim, 2);
  // Make two data cells ambiguous: paint them mid-grey, slightly toward the WRONG value
  let painted = 0;
  for (let r = 20; r < 40 && painted < 2; r += 13) {
    const c = 30;
    const wrong = m.cells[r * gs + c] ? 110 : 145;
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const p = (((r + 2) * cell + y) * dim + (c + 2) * cell + x) * 4;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = wrong;
      }
    painted++;
  }
  const r = new OpticalFrameDecoder().decodeRgba(img.data, dim, dim, { expectedGridSize: gs });
  assert.equal(r.status, 'valid');
  assert.ok((r.correctedCells ?? 0) >= 1);
  assert.deepEqual(r.packet!.payload, payload);
});

test('MOTION: hand-held sway, motion blur and rolling shutter keep decoding; tracking follows the pattern', () => {
  const dec = new OpticalFrameDecoder();
  let ok = 0;
  let tracked = 0;
  const pose = (t: number) => ({
    cx: 640 + 60 * Math.sin(t * 0.35) + 14 * Math.sin(t * 2.1),
    cy: 360 + 35 * Math.sin(t * 0.5 + 1) + 10 * Math.sin(t * 2.7),
    rot: 8 * Math.sin(t * 0.3),
    side: 470 + 50 * Math.sin(t * 0.22),
    tilt: 0.06 + 0.05 * Math.sin(t * 0.4),
  });
  for (let f = 0; f < 30; f++) {
    const p = pose(f * 0.4);
    const q = pose(f * 0.4 + 0.4);
    const { bytes, payload } = makePacket(64, f);
    const fr = renderSyntheticCameraFrame(encodePacketToMatrix(bytes, 64), {
      width: 1280,
      height: 720,
      matrixSidePx: p.side,
      centerX: p.cx,
      centerY: p.cy,
      rotationDeg: p.rot,
      perspectiveTilt: p.tilt,
      motionBlurPx: Math.hypot(q.cx - p.cx, q.cy - p.cy) * 0.25,
      motionBlurAngleDeg: (Math.atan2(q.cy - p.cy, q.cx - p.cx) * 180) / Math.PI,
      rollingShutterPx: (q.cx - p.cx) * 0.6,
      noiseAmplitude: 5,
      glareDelta: 25,
      seed: f + 1,
    });
    const r = dec.decodeRgba(fr.data, 1280, 720);
    if (r.status === 'valid' && Buffer.from(r.packet!.payload).equals(Buffer.from(payload))) ok++;
    if (r.locator === 'tracked') tracked++;
  }
  assert.ok(ok >= 29, `decoded ${ok}/30 moving frames`);
  assert.ok(tracked >= 25, `${tracked}/30 frames followed by frame-to-frame tracking`);
});

test('LARGE pattern filling the view (10–18 px/cell, 1600×900) decodes when all corners are visible', () => {
  let ok = 0;
  let n = 0;
  for (const gs of [48, 64]) {
    for (const frac of [0.6, 0.8, 0.95]) {
      for (const rot of [-8, 0, 6]) {
        const { bytes, payload } = makePacket(gs, n);
        const f = renderSyntheticCameraFrame(encodePacketToMatrix(bytes, gs), {
          width: 1600,
          height: 900,
          matrixSidePx: 900 * frac,
          rotationDeg: rot,
          perspectiveTilt: 0.05,
          blurRadius: 2,
          noiseAmplitude: 5,
          seed: n + 1,
        });
        if (!Object.values(f.trueCorners).every((q) => q.x > 2 && q.y > 2 && q.x < 1598 && q.y < 898)) continue;
        n++;
        const r = new OpticalFrameDecoder().decodeRgba(f.data, 1600, 900);
        if (r.status === 'valid' && Buffer.from(r.packet!.payload).equals(Buffer.from(payload))) ok++;
      }
    }
  }
  assert.ok(n >= 12);
  assert.equal(ok, n, `${ok}/${n} large patterns decoded`);
});

test('Pattern pushed past the frame edge while tracking reports too_close (not a corner mix-up)', () => {
  const dec = new OpticalFrameDecoder();
  const mk = (cx: number, i: number) =>
    renderSyntheticCameraFrame(encodePacketToMatrix(makePacket(64, i).bytes, 64), { width: 1280, height: 720, matrixSidePx: 560, centerX: cx, seed: i + 1 });
  assert.equal(dec.decodeRgba(mk(640, 1).data, 1280, 720).status, 'valid');
  assert.equal(dec.decodeRgba(mk(760, 2).data, 1280, 720).status, 'valid');
  const r = dec.decodeRgba(mk(1100, 3).data, 1280, 720); // right side now outside the view
  assert.notEqual(r.status, 'valid');
  assert.equal(r.hint, 'too_close');
});

test('LARGE pattern with the display pixel grid resolved (screen-door, 1920×1080) decodes via multi-scale detection', () => {
  // Reproduces the "big QR fails" report: at ~19 px/cell the camera sees the sender's own
  // pixel grid inside every module, which breaks full-resolution finder detection.
  let ok = 0;
  let n = 0;
  for (const spc of [2, 3]) {
    for (const [gs, side] of [[48, 920], [64, 1000]] as const) {
      for (const rot of [-5, 4]) {
        const { bytes, payload } = makePacket(gs, n);
        const f = renderSyntheticCameraFrame(encodePacketToMatrix(bytes, gs), {
          width: 1920,
          height: 1080,
          matrixSidePx: side,
          rotationDeg: rot,
          perspectiveTilt: 0.04,
          blurRadius: 1,
          noiseAmplitude: 4,
          screenPixelsPerCell: spc,
          screenDoorDepth: 0.55,
          seed: n + 11,
        });
        n++;
        const r = new OpticalFrameDecoder().decodeRgba(f.data, 1920, 1080);
        if (r.status === 'valid' && Buffer.from(r.packet!.payload).equals(Buffer.from(payload))) ok++;
      }
    }
  }
  assert.equal(ok, n, `${ok}/${n} screen-door large patterns decoded`);
});

test('Rolling-shutter tears on a ROTATED phone are spliced in sensor coordinates (CRC-verified)', () => {
  // Phone held sideways: the tear line runs along the sensor rows, i.e. down the pattern's columns.
  const W = 1280, H = 720;
  const frames = [0, 1, 2, 3, 4, 5].map((i) =>
    renderSyntheticCameraFrame(encodePacketToMatrix(makePacket(64, i).bytes, 64), { width: W, height: H, matrixSidePx: 600, rotationDeg: 93, noiseAmplitude: 4, seed: 7 }).data
  );
  const dec = new OpticalFrameDecoder();
  const fresh = new Set<number>();
  const spliced = new Set<number>();
  for (let c = 0; c < 5; c++) {
    const y = [300, 420, 250, 380, 330][c];
    const cap = new Uint8ClampedArray(frames[c]);
    cap.set(frames[c + 1].subarray(y * W * 4), y * W * 4);
    for (const p of new OpticalFrameDecoder().decodeRgba(cap, W, H).packets ?? []) fresh.add(p.packetIndex);
    for (const p of dec.decodeRgba(cap, W, H).packets ?? []) spliced.add(p.packetIndex);
  }
  assert.equal(fresh.size, 0, 'every capture is torn, so a single capture alone decodes nothing');
  assert.ok(spliced.size >= 2, `splice recovered ${spliced.size} packets`);
  for (const i of spliced) assert.ok(i >= 0 && i <= 5);
});
