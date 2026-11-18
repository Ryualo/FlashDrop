import { GRAY4_LEVELS, OpticalMatrixFrame } from './opticalEncoder';
import { applyHomography, computeHomography, invertHomography, Point2D } from './vision/homography';

/**
 * SYNTHETIC camera-frame generator used by automated tests and the in-app audit.
 *
 * It models a phone camera looking at a sender screen: true perspective (homography), in-plane
 * rotation, optional mirroring (front cameras), a lit room with bright clutter, a dark screen bezel,
 * non-zero display black level, glare/vignetting gradients, optical blur, 2×2 supersampled
 * anti-aliasing and sensor noise.
 *
 * It is NOT a substitute for physical two-device testing: it does not model moiré against the
 * display's sub-pixel grid, motion blur, autofocus hunting, auto-exposure changes, rolling-shutter
 * timing against the display refresh, or video compression.
 */
export interface SyntheticCameraConfig {
  width: number;
  height: number;
  /** Side length (px) of the matrix INCLUDING its quiet zone before perspective. */
  matrixSidePx: number;
  centerX?: number;
  centerY?: number;
  rotationDeg?: number;
  /** 0..0.5: top edge shrinks by this fraction relative to the bottom (screen tilted back). */
  perspectiveTilt?: number;
  /** 0..0.5: left edge shrinks relative to the right (screen turned sideways). */
  perspectiveYaw?: number;
  mirror?: boolean;
  quietZoneCells?: number;
  backgroundLuma?: number;
  clutter?: boolean;
  blackLevel?: number;
  whiteLevel?: number;
  glareDelta?: number;
  blurRadius?: 0 | 1 | 2;
  noiseAmplitude?: number;
  seed?: number;
  /** Camera/display tone curve applied to grayscale levels (1 = linear, <1 lifts mid-tones, >1 crushes them). */
  toneGamma?: number;
  /** Length (px) of linear motion blur from hand movement during exposure. */
  motionBlurPx?: number;
  motionBlurAngleDeg?: number;
  /** Horizontal skew (px) between the first and last sensor row: rolling shutter during motion. */
  rollingShutterPx?: number;
  /**
   * Screen-door effect seen when the camera is close: the display's own pixel grid. Number of
   * display pixels per matrix cell (0 = off); gaps between display pixels darken by screenDoorDepth.
   */
  screenPixelsPerCell?: number;
  screenDoorDepth?: number;
}

export interface SyntheticCameraFrame {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** Outer matrix corners (excluding quiet zone) in image pixels. */
  trueCorners: { topLeft: Point2D; topRight: Point2D; bottomLeft: Point2D; bottomRight: Point2D };
  pixelsPerModule: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      const add = Math.min(w - 1, x + r + 1);
      const sub = Math.max(0, x - r);
      acc += src[row + add] - src[row + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      acc += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

export function renderSyntheticCameraFrame(
  matrix: OpticalMatrixFrame,
  config: SyntheticCameraConfig
): SyntheticCameraFrame {
  const {
    width: w,
    height: h,
    matrixSidePx,
    rotationDeg = 0,
    perspectiveTilt = 0,
    perspectiveYaw = 0,
    mirror = false,
    quietZoneCells = 2,
    backgroundLuma = 150,
    clutter = true,
    blackLevel = 24,
    whiteLevel = 225,
    glareDelta = 30,
    blurRadius = 1,
    noiseAmplitude = 6,
    seed = 1234,
    toneGamma = 1,
    motionBlurPx = 0,
    motionBlurAngleDeg = 0,
    rollingShutterPx = 0,
    screenPixelsPerCell = 0,
    screenDoorDepth = 0.55,
  } = config;
  const levelLum = (v: number): number => {
    if (matrix.mode !== 'gray4') return v ? 1 : 0;
    return Math.pow(GRAY4_LEVELS[v] / 255, toneGamma);
  };
  const cx = config.centerX ?? w / 2;
  const cy = config.centerY ?? h / 2;
  const gs = matrix.gridSize;
  const rand = mulberry32(seed);

  // Quad of the quiet-zone square in the image
  const half = matrixSidePx / 2;
  const topHalf = half * (1 - perspectiveTilt); // top edge shorter: screen leaning back
  const leftHalf = half * (1 - perspectiveYaw); // left edge shorter: screen turned away
  const local: Point2D[] = [
    { x: -topHalf, y: -leftHalf }, // TL
    { x: topHalf, y: -half }, // TR
    { x: -half, y: leftHalf }, // BL
    { x: half, y: half }, // BR
  ];
  const th = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const placed = local.map((p) => {
    const x = mirror ? -p.x : p.x;
    return { x: cx + x * cos - p.y * sin, y: cy + x * sin + p.y * cos };
  });
  // When mirrored, left/right swap visually; keep grid orientation mapping consistent.
  const q = -quietZoneCells;
  const e = gs + quietZoneCells;
  const H = computeHomography(
    [
      { x: q, y: q },
      { x: e, y: q },
      { x: q, y: e },
      { x: e, y: e },
    ],
    placed
  );
  if (!H) throw new Error('Degenerate synthetic camera geometry');
  const Hinv = invertHomography(H);
  if (!Hinv) throw new Error('Non-invertible synthetic camera geometry');

  // Screen bezel (dark, slightly larger than the quiet zone square)
  const bezelPad = quietZoneCells + Math.max(2, Math.round(gs * 0.04));
  const lum = new Float32Array(w * h);

  // Background: lit room gradient + bright clutter rectangles (window, paper, lamp)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      lum[y * w + x] = backgroundLuma + 30 * (x / w - 0.5) - 20 * (y / h - 0.5);
    }
  }
  if (clutter) {
    for (let k = 0; k < 7; k++) {
      const rw = 20 + rand() * w * 0.2;
      const rh = 20 + rand() * h * 0.2;
      const rx = rand() * (w - rw);
      const ry = rand() * (h - rh);
      const v = rand() < 0.5 ? 245 : 40;
      for (let y = ry | 0; y < ry + rh && y < h; y++) {
        for (let x = rx | 0; x < rx + rw && x < w; x++) lum[y * w + x] = v;
      }
    }
  }

  const SS = 2; // supersampling for lens-like anti-aliasing
  const invSS = 1 / (SS * SS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      let insideAny = false;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const py = y + (sy + 0.5) / SS;
          const px = x + (sx + 0.5) / SS - rollingShutterPx * (py / h - 0.5);
          const g = applyHomography(Hinv, px, py);
          if (g.x < -bezelPad || g.y < -bezelPad || g.x >= gs + bezelPad || g.y >= gs + bezelPad) {
            acc += lum[y * w + x];
            continue;
          }
          insideAny = true;
          let bit = 0;
          if (g.x >= 0 && g.y >= 0 && g.x < gs && g.y < gs) {
            bit = matrix.cells[Math.floor(g.y) * gs + Math.floor(g.x)];
          }
          let f = levelLum(bit);
          if (screenPixelsPerCell > 0) {
            // Gap between display pixels (and between RGB stripes) — ~30 % of each pixel pitch
            const sx = (g.x * screenPixelsPerCell) % 1;
            const sy = (g.y * screenPixelsPerCell) % 1;
            const sub = ((g.x * screenPixelsPerCell * 3) % 1) < 0.25 ? 0.25 : 0;
            if (sx < 0.3 || sy < 0.3) f *= 1 - screenDoorDepth;
            else f *= 1 - sub * screenDoorDepth;
          }
          const u = g.x / gs;
          const v = g.y / gs;
          const glare = glareDelta * (0.5 - 0.5 * u - 0.5 * v) - 12 * ((u - 0.5) ** 2 + (v - 0.5) ** 2);
          const base = g.x < -quietZoneCells || g.y < -quietZoneCells || g.x >= gs + quietZoneCells || g.y >= gs + quietZoneCells
            ? blackLevel * 0.6 // bezel
            : blackLevel + (whiteLevel - blackLevel) * f;
          acc += base + glare;
        }
      }
      if (insideAny) lum[y * w + x] = acc * invSS;
    }
  }

  let blurred = boxBlur(lum, w, h, blurRadius);
  if (motionBlurPx > 0.5) {
    const steps = Math.max(2, Math.round(motionBlurPx));
    const ang = (motionBlurAngleDeg * Math.PI) / 180;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = 0; k < steps; k++) {
          const t = (k / (steps - 1) - 0.5) * motionBlurPx;
          const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t)));
          const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
          acc += blurred[yy * w + xx];
        }
        out[y * w + x] = acc / steps;
      }
    blurred = out;
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = noiseAmplitude > 0 ? (rand() + rand() + rand() - 1.5) * 2 * noiseAmplitude : 0;
    const v = Math.max(0, Math.min(255, Math.round(blurred[i] + n)));
    const p = i << 2;
    // Slight colour cast like a real sensor
    data[p] = Math.min(255, v + 3);
    data[p + 1] = v;
    data[p + 2] = Math.max(0, v - 4);
    data[p + 3] = 255;
  }

  const corners = {
    topLeft: applyHomography(H, 0, 0),
    topRight: applyHomography(H, gs, 0),
    bottomLeft: applyHomography(H, 0, gs),
    bottomRight: applyHomography(H, gs, gs),
  };
  const c0 = applyHomography(H, gs / 2, gs / 2);
  const c1 = applyHomography(H, gs / 2 + 1, gs / 2);
  return {
    data,
    width: w,
    height: h,
    trueCorners: corners,
    pixelsPerModule: Math.hypot(c1.x - c0.x, c1.y - c0.y),
  };
}
