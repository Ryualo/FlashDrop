import { decodePacket, DecodePacketResult, DropFlashPacket } from './packetProtocol';
import {
  getFrameRawCapacity,
  getGridLayoutPlan,
  GRAY4_SYNC_WORD,
  GridLayoutPlan,
  LEVEL_TO_VALUE,
  OPTICAL_SYNC_WORD,
  OpticalMode,
  unwhitenInPlace,
  whiteningMask,
} from './opticalEncoder';
import { PACKET_MAGIC_0, PACKET_MAGIC_1, PACKET_OVERHEAD_BYTES } from './packetProtocol';
import {
  binarizeBrightModules,
  FinderCandidate,
  FinderTriple,
  findBottomRightFiducials,
  findFinderPatterns,
  isConfirmedFinder,
  rgbaToLuma,
  selectFinderTriples,
  smoothLuma,
} from './vision/finderPatterns';
import { applyHomography, computeHomography, Homography, Point2D } from './vision/homography';

export type { Point2D };

export interface QuadCorners {
  topLeft: Point2D;
  topRight: Point2D;
  bottomLeft: Point2D;
  bottomRight: Point2D;
}

/** Grid sizes the sender can emit. Every size must fit a MANIFEST packet (see fileChunker). */
export const SUPPORTED_GRID_SIZES = [48, 64, 96, 128, 192, 256, 384] as const;

export type DecodeHint =
  | 'ok'
  | 'no_pattern'
  | 'partial_pattern'
  | 'too_small'
  | 'too_close'
  | 'low_contrast'
  | 'blurred_or_torn'
  | 'incompatible_version';

export interface OpticalDecodeResult {
  status: 'valid' | 'crc_error' | 'no_sync';
  /** First valid packet (kept for compatibility). */
  packet?: DropFlashPacket;
  /** All valid packets in the frame (grayscale frames carry up to two). */
  packets?: DropFlashPacket[];
  /** Frame encoding detected from the sync word. */
  mode?: OpticalMode;
  /** Cells corrected by least-reliable-cell search (each correction verified by CRC-32). */
  correctedCells?: number;
  /** Fraction of fixed (fiducial / timing / sync) cells read correctly, 0..1. */
  syncQuality: number;
  /** Mean binarisation threshold (luma 0..255) used for data cells. */
  thresholdUsed: number;
  /** Outer corners of the matrix in input-image pixel coordinates. */
  detectedBounds?: QuadCorners;
  gridSizeUsed?: number;
  syncWordRead?: number;
  deTornRecovered?: boolean;
  locator: 'finder' | 'tracked' | 'bounds' | 'manual' | 'none';
  finderCount: number;
  mirrored: boolean;
  /** Approximate size of one module in input pixels. */
  modulePx: number;
  /** White-minus-black luma separation of fixed cells. */
  contrast: number;
  hint: DecodeHint;
}

export interface DecodeOptions {
  expectedGridSize?: number;
  /** Manual outer corners (pixel coordinates of the matrix outline, excluding the quiet zone). */
  customCorners?: QuadCorners | null;
}

interface Candidate {
  H: Homography;
  gridSize: number;
  locator: OpticalDecodeResult['locator'];
  mirrored: boolean;
}

interface SyncEval {
  score: number;
  /** Match ratio of the row-8 calibration + sync-word strip (not transpose-symmetric). */
  stripScore: number;
  /** Same strip compared with the grayscale sync word. */
  stripScoreGray: number;
  whiteMean: number;
  blackMean: number;
}

const SYNC_ACCEPT = 0.8;
const STRIP_ACCEPT = 0.8;
const SYNC_REFINE = 0.5;
const MAX_TRIPLES = 4;
const MAX_SIZES_PER_TRIPLE = 3;

// ---------------------------------------------------------------------------------------------
// Pixel sampling helpers
// ---------------------------------------------------------------------------------------------

function sampleBilinear(luma: Uint8Array, w: number, h: number, x: number, y: number): number {
  // Pixel centres sit at integer + 0.5
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  if (fy < 0) fy = 0;
  if (fx > w - 1) fx = w - 1;
  if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0;
  const ay = fy - y0;
  const r0 = y0 * w;
  const r1 = y1 * w;
  const top = luma[r0 + x0] + (luma[r0 + x1] - luma[r0 + x0]) * ax;
  const bot = luma[r1 + x0] + (luma[r1 + x1] - luma[r1 + x0]) * ax;
  return top + (bot - top) * ay;
}

function sampleAtGrid(luma: Uint8Array, w: number, h: number, H: Homography, u: number, v: number): number {
  const d = H[6] * u + H[7] * v + H[8];
  const id = d !== 0 ? 1 / d : 0;
  const x = (H[0] * u + H[1] * v + H[2]) * id;
  const y = (H[3] * u + H[4] * v + H[5]) * id;
  return sampleBilinear(luma, w, h, x, y);
}

/** Box-averaged downscale (scale = 2 or 4) for multi-scale fiducial detection. */
function downscaleLuma(luma: Uint8Array, w: number, h: number, scale: number): { l: Uint8Array; w: number; h: number } {
  const W = Math.floor(w / scale);
  const Hh = Math.floor(h / scale);
  const out = new Uint8Array(W * Hh);
  const area = scale * scale;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let dy = 0; dy < scale; dy++) {
        const row = (y * scale + dy) * w + x * scale;
        for (let dx = 0; dx < scale; dx++) sum += luma[row + dx];
      }
      out[y * W + x] = (sum / area) | 0;
    }
  }
  return { l: out, w: W, h: Hh };
}

function modulePixelSize(H: Homography, gridSize: number): number {
  const c = gridSize / 2;
  const p = applyHomography(H, c, c);
  const px = applyHomography(H, c + 1, c);
  const py = applyHomography(H, c, c + 1);
  return (Math.hypot(px.x - p.x, px.y - p.y) + Math.hypot(py.x - p.x, py.y - p.y)) / 2;
}

function outerCorners(H: Homography, gs: number): QuadCorners {
  return {
    topLeft: applyHomography(H, 0, 0),
    topRight: applyHomography(H, gs, 0),
    bottomLeft: applyHomography(H, 0, gs),
    bottomRight: applyHomography(H, gs, gs),
  };
}

function homographyFromFiducialCentres(
  gs: number,
  tl: Point2D,
  tr: Point2D,
  bl: Point2D,
  br: Point2D
): Homography | null {
  const a = 3.5;
  const b = gs - 3.5;
  return computeHomography(
    [
      { x: a, y: a },
      { x: b, y: a },
      { x: a, y: b },
      { x: b, y: b },
    ],
    [tl, tr, bl, br]
  );
}

function homographyFromOuterCorners(gs: number, q: QuadCorners): Homography | null {
  return computeHomography(
    [
      { x: 0, y: 0 },
      { x: gs, y: 0 },
      { x: 0, y: gs },
      { x: gs, y: gs },
    ],
    [q.topLeft, q.topRight, q.bottomLeft, q.bottomRight]
  );
}

// ---------------------------------------------------------------------------------------------
// Sync evaluation, fiducial refinement, full sampling
// ---------------------------------------------------------------------------------------------

function evaluateSync(luma: Uint8Array, w: number, h: number, H: Homography, plan: GridLayoutPlan): SyncEval {
  const idx = plan.reservedCellIndices;
  const expected = plan.reservedExpected;
  const gs = plan.gridSize;
  const n = idx.length;
  const values = new Float32Array(n);
  let wSum = 0;
  let wN = 0;
  let bSum = 0;
  let bN = 0;
  for (let i = 0; i < n; i++) {
    const cell = idx[i];
    const r = (cell / gs) | 0;
    const c = cell - r * gs;
    const v = sampleAtGrid(luma, w, h, H, c + 0.5, r + 0.5);
    values[i] = v;
    if (r === 8 && c >= 9 && c <= 24) continue; // sync cells differ per mode: not used for levels
    if (expected[i] === 1) {
      wSum += v;
      wN++;
    } else {
      bSum += v;
      bN++;
    }
  }
  const whiteMean = wN ? wSum / wN : 0;
  const blackMean = bN ? bSum / bN : 0;
  if (whiteMean - blackMean < 8) return { score: 0, stripScore: 0, stripScoreGray: 0, whiteMean, blackMean };
  const t = (whiteMean + blackMean) / 2;
  const stripEnd = Math.min(24, gs - 2);
  let fixedOk = 0;
  let calibN = 0;
  let calibOk = 0;
  let syncN = 0;
  let syncMono = 0;
  let syncGray = 0;
  for (let i = 0; i < n; i++) {
    const bit = values[i] > t ? 1 : 0;
    const cell = idx[i];
    const r = (cell / gs) | 0;
    const c = cell - r * gs;
    if (r === 8 && c >= 9 && c <= stripEnd) {
      syncN++;
      if (bit === ((OPTICAL_SYNC_WORD >>> (15 - (c - 9))) & 1)) syncMono++;
      if (bit === ((GRAY4_SYNC_WORD >>> (15 - (c - 9))) & 1)) syncGray++;
      continue;
    }
    const ok = bit === expected[i];
    if (ok) fixedOk++;
    if (r === 8 && c >= 1 && c <= 8) {
      calibN++;
      if (ok) calibOk++;
    }
  }
  const stripN = calibN + syncN;
  return {
    score: (fixedOk + Math.max(syncMono, syncGray)) / n,
    stripScore: stripN ? (calibOk + syncMono) / stripN : 0,
    stripScoreGray: stripN ? (calibOk + syncGray) / stripN : 0,
    whiteMean,
    blackMean,
  };
}

/** 9×9-cell template (7×7 fiducial plus dark separator / quiet-zone ring) for each corner. */
function fiducialTemplate(plan: GridLayoutPlan, r0: number, c0: number): Float32Array {
  const gs = plan.gridSize;
  const t = new Float32Array(81);
  let sum = 0;
  for (let j = 0; j < 9; j++) {
    for (let i = 0; i < 9; i++) {
      const r = r0 - 1 + j;
      const c = c0 - 1 + i;
      const inside = r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7;
      const bit = inside && r >= 0 && c >= 0 && r < gs && c < gs ? plan.templateCells[r * gs + c] : 0;
      t[j * 9 + i] = bit ? 1 : -1;
      sum += t[j * 9 + i];
    }
  }
  const mean = sum / 81;
  for (let k = 0; k < 81; k++) t[k] -= mean;
  return t;
}

function correlateFiducial(
  luma: Uint8Array,
  w: number,
  h: number,
  H: Homography,
  r0: number,
  c0: number,
  template: Float32Array,
  du: number,
  dv: number
): number {
  let s = 0;
  for (let j = 0; j < 9; j++) {
    const v = r0 - 1 + j + 0.5 + dv;
    for (let i = 0; i < 9; i++) {
      const u = c0 - 1 + i + 0.5 + du;
      s += template[j * 9 + i] * sampleAtGrid(luma, w, h, H, u, v);
    }
  }
  return s;
}

function searchFiducial(
  luma: Uint8Array,
  w: number,
  h: number,
  H: Homography,
  r0: number,
  c0: number,
  template: Float32Array,
  range: number,
  step: number,
  centreU = 0,
  centreV = 0
): { du: number; dv: number; score: number } {
  let best = -Infinity;
  let bu = centreU;
  let bv = centreV;
  const n = Math.round(range / step);
  for (let iy = -n; iy <= n; iy++) {
    const dv = centreV + iy * step;
    for (let ix = -n; ix <= n; ix++) {
      const du = centreU + ix * step;
      const sc = correlateFiducial(luma, w, h, H, r0, c0, template, du, dv);
      if (sc > best) {
        best = sc;
        bu = du;
        bv = dv;
      }
    }
  }
  return { du: bu, dv: bv, score: best };
}

/**
 * Refines the four fiducial centres by template correlation in grid space and recomputes the
 * homography. `bottomRightRange` (modules) widens the bottom-right search, whose initial position is
 * only an affine guess (TR + BL − TL) and can be many modules off under perspective.
 * Bounded: at most 3 passes.
 */
function refineHomography(
  luma: Uint8Array,
  w: number,
  h: number,
  H: Homography,
  plan: GridLayoutPlan,
  bottomRightRange: number,
  cornerRange = 1.5
): Homography {
  const gs = plan.gridSize;
  const corners: Array<[number, number]> = [
    [0, 0],
    [0, gs - 7],
    [gs - 7, 0],
    [gs - 7, gs - 7],
  ];
  const templates = corners.map(([r0, c0]) => fiducialTemplate(plan, r0, c0));
  let current = H;
  for (let pass = 0; pass < 3; pass++) {
    const centres: Point2D[] = [];
    let maxMove = 0;
    for (let k = 0; k < 4; k++) {
      const [r0, c0] = corners[k];
      const wide = pass === 0 && k === 3 && bottomRightRange > cornerRange;
      const range = pass === 0 ? (wide ? bottomRightRange : cornerRange) : 0.75;
      const coarseStep = range > 2 ? 0.5 : 0.25;
      const coarse = searchFiducial(luma, w, h, current, r0, c0, templates[k], range, coarseStep);
      const fine = searchFiducial(luma, w, h, current, r0, c0, templates[k], coarseStep, coarseStep / 4, coarse.du, coarse.dv);
      maxMove = Math.max(maxMove, Math.hypot(fine.du, fine.dv));
      centres.push(applyHomography(current, c0 + 3.5 + fine.du, r0 + 3.5 + fine.dv));
    }
    const next = homographyFromFiducialCentres(gs, centres[0], centres[1], centres[2], centres[3]);
    if (!next) break;
    current = next;
    if (pass >= 1 && maxMove < 0.1) break;
  }
  return current;
}

/** Samples every cell; uses a 5-point average when modules are large enough to resist noise. */
function sampleAllCells(luma: Uint8Array, w: number, h: number, H: Homography, gs: number, modulePx: number): Float32Array {
  const S = new Float32Array(gs * gs);
  const multi = modulePx >= 4;
  const o = 0.22;
  for (let r = 0; r < gs; r++) {
    const v = r + 0.5;
    for (let c = 0; c < gs; c++) {
      const u = c + 0.5;
      let val = sampleAtGrid(luma, w, h, H, u, v);
      if (modulePx >= 9) {
        // Large cells: 3×3 area average over the central half of the cell — robust to the display's
        // pixel-grid texture that the camera resolves when held close.
        let acc = 0;
        for (const dv of [-0.22, 0, 0.22]) for (const du of [-0.22, 0, 0.22]) acc += sampleAtGrid(luma, w, h, H, u + du, v + dv);
        val = acc / 9;
      } else if (multi) {
        val =
          (val * 2 +
            sampleAtGrid(luma, w, h, H, u - o, v) +
            sampleAtGrid(luma, w, h, H, u + o, v) +
            sampleAtGrid(luma, w, h, H, u, v - o) +
            sampleAtGrid(luma, w, h, H, u, v + o)) /
          6;
      }
      S[r * gs + c] = val;
    }
  }
  return S;
}

/**
 * Tile-adaptive threshold surface. Whitened data is ~50 % white, so a two-cluster midpoint per
 * tile tracks glare, vignetting and display brightness gradients across the matrix.
 */
function thresholdSurface(S: Float32Array, gs: number, fallback: number): { T: Float32Array; mean: number } {
  const tile = Math.max(6, Math.round(gs / 8));
  const tilesPerSide = Math.ceil(gs / tile);
  const tileT = new Float32Array(tilesPerSide * tilesPerSide);
  const valid = new Uint8Array(tilesPerSide * tilesPerSide);
  for (let ty = 0; ty < tilesPerSide; ty++) {
    for (let tx = 0; tx < tilesPerSide; tx++) {
      const r0 = ty * tile;
      const c0 = tx * tile;
      const r1 = Math.min(gs, r0 + tile);
      const c1 = Math.min(gs, c0 + tile);
      let sum = 0;
      let n = 0;
      let mn = 255;
      let mx = 0;
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const v = S[r * gs + c];
          sum += v;
          n++;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      let t = n ? sum / n : fallback;
      for (let it = 0; it < 4; it++) {
        let hs = 0;
        let hn = 0;
        let ls = 0;
        let ln = 0;
        for (let r = r0; r < r1; r++) {
          for (let c = c0; c < c1; c++) {
            const v = S[r * gs + c];
            if (v > t) {
              hs += v;
              hn++;
            } else {
              ls += v;
              ln++;
            }
          }
        }
        if (!hn || !ln) break;
        t = (hs / hn + ls / ln) / 2;
      }
      const idx = ty * tilesPerSide + tx;
      tileT[idx] = t;
      valid[idx] = mx - mn >= 12 ? 1 : 0;
    }
  }
  // Fill low-contrast tiles from valid neighbours (or the global fallback)
  for (let i = 0; i < tileT.length; i++) {
    if (valid[i]) continue;
    const ty = (i / tilesPerSide) | 0;
    const tx = i % tilesPerSide;
    let s = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const yy = ty + dy;
        const xx = tx + dx;
        if (yy < 0 || xx < 0 || yy >= tilesPerSide || xx >= tilesPerSide) continue;
        const j = yy * tilesPerSide + xx;
        if (valid[j]) {
          s += tileT[j];
          n++;
        }
      }
    }
    tileT[i] = n ? s / n : fallback;
  }
  // Bilinear interpolation between tile centres
  const T = new Float32Array(gs * gs);
  let total = 0;
  for (let r = 0; r < gs; r++) {
    let fy = (r + 0.5) / tile - 0.5;
    if (fy < 0) fy = 0;
    if (fy > tilesPerSide - 1) fy = tilesPerSide - 1;
    const y0 = fy | 0;
    const y1 = Math.min(tilesPerSide - 1, y0 + 1);
    const ay = fy - y0;
    for (let c = 0; c < gs; c++) {
      let fx = (c + 0.5) / tile - 0.5;
      if (fx < 0) fx = 0;
      if (fx > tilesPerSide - 1) fx = tilesPerSide - 1;
      const x0 = fx | 0;
      const x1 = Math.min(tilesPerSide - 1, x0 + 1);
      const ax = fx - x0;
      const top = tileT[y0 * tilesPerSide + x0] * (1 - ax) + tileT[y0 * tilesPerSide + x1] * ax;
      const bot = tileT[y1 * tilesPerSide + x0] * (1 - ax) + tileT[y1 * tilesPerSide + x1] * ax;
      const t = top * (1 - ay) + bot * ay;
      T[r * gs + c] = t;
      total += t;
    }
  }
  return { T, mean: total / (gs * gs) };
}

function extractBytes(S: Float32Array, T: Float32Array, plan: GridLayoutPlan, offset: number): Uint8Array {
  const idx = plan.dataCellIndices;
  const out = new Uint8Array(plan.rawByteCapacity);
  let p = 0;
  for (let byte = 0; byte < out.length; byte++) {
    let b = 0;
    for (let bit = 7; bit >= 0; bit--) {
      const cell = idx[p++];
      if (S[cell] > T[cell] + offset) b |= 1 << bit;
    }
    out[byte] = b;
  }
  unwhitenInPlace(out);
  return out;
}

function readSyncWord(S: Float32Array, T: Float32Array, gs: number): number {
  let word = 0;
  const maxCol = Math.min(24, gs - 2);
  for (let c = 9; c <= maxCol; c++) {
    const cell = 8 * gs + c;
    if (S[cell] > T[cell]) word |= 1 << (15 - (c - 9));
  }
  return word;
}

// ---------------------------------------------------------------------------------------------
// Bounding-box fallback (clean digital renders, manual-less fallback when fiducials are clipped)
// ---------------------------------------------------------------------------------------------

function detectBrightBounds(luma: Uint8Array, w: number, h: number): QuadCorners[] {
  let mn = 255;
  let mx = 0;
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const v = luma[y * w + x];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (mx - mn < 35) return [];
  const t = mn + (mx - mn) * 0.48;

  // If the frame border is mostly bright (bezel/room), search inside the dark quiet-zone moat.
  let bright = 0;
  let samples = 0;
  for (let x = 0; x < w; x += 8) {
    samples += 2;
    if (luma[x] > t) bright++;
    if (luma[(h - 1) * w + x] > t) bright++;
  }
  for (let y = 0; y < h; y += 8) {
    samples += 2;
    if (luma[y * w] > t) bright++;
    if (luma[y * w + w - 1] > t) bright++;
  }
  let wx0 = 0;
  let wx1 = w - 1;
  let wy0 = 0;
  let wy1 = h - 1;
  if (bright > samples * 0.1) {
    const cx = w >> 1;
    const cy = h >> 1;
    const band = Math.max(8, Math.floor(Math.min(w, h) * 0.18));
    const rowDark = (y: number): boolean => {
      for (let x = Math.max(0, cx - band); x <= Math.min(w - 1, cx + band); x += 2) if (luma[y * w + x] > t) return false;
      return true;
    };
    const colDark = (x: number): boolean => {
      for (let y = Math.max(0, cy - band); y <= Math.min(h - 1, cy + band); y += 2) if (luma[y * w + x] > t) return false;
      return true;
    };
    const scan = (from: number, to: number, step: number, dark: (i: number) => boolean): number => {
      let seen = false;
      let run = 0;
      for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
        if (!dark(i)) {
          seen = true;
          run = 0;
        } else if (seen && ++run >= 4) return i;
      }
      return to;
    };
    wy0 = scan(cy, 0, -1, rowDark);
    wy1 = scan(cy, h - 1, 1, rowDark);
    wx0 = scan(cx, 0, -1, colDark);
    wx1 = scan(cx, w - 1, 1, colDark);
  }

  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  let tl: Point2D = { x: 0, y: 0 };
  let tr: Point2D = { x: 0, y: 0 };
  let bl: Point2D = { x: 0, y: 0 };
  let br: Point2D = { x: 0, y: 0 };
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;
  for (let y = wy0; y <= wy1; y++) {
    const row = y * w;
    for (let x = wx0; x <= wx1; x++) {
      if (luma[row + x] <= t) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const s = x + y;
      const d = x - y;
      if (s < minSum) {
        minSum = s;
        tl = { x, y };
      }
      if (s > maxSum) {
        maxSum = s;
        br = { x: x + 1, y: y + 1 };
      }
      if (d > maxDiff) {
        maxDiff = d;
        tr = { x: x + 1, y };
      }
      if (d < minDiff) {
        minDiff = d;
        bl = { x, y: y + 1 };
      }
    }
  }
  if (maxX <= minX + 16 || maxY <= minY + 16) return [];
  const box: QuadCorners = {
    topLeft: { x: minX, y: minY },
    topRight: { x: maxX + 1, y: minY },
    bottomLeft: { x: minX, y: maxY + 1 },
    bottomRight: { x: maxX + 1, y: maxY + 1 },
  };
  return [box, { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br }];
}


// ---------------------------------------------------------------------------------------------
// Four-level grayscale calibration and the shared frame reader
// ---------------------------------------------------------------------------------------------

const dataMaskCache = new Map<number, Uint8Array>();
function dataMask(plan: GridLayoutPlan): Uint8Array {
  let m = dataMaskCache.get(plan.gridSize);
  if (!m) {
    m = new Uint8Array(plan.gridSize * plan.gridSize);
    for (const i of plan.dataCellIndices) m[i] = 1;
    dataMaskCache.set(plan.gridSize, m);
  }
  return m;
}

/**
 * Per-tile 4-cluster calibration. Whitened data uses the four levels equally often, so in every
 * tile the sorted cell brightnesses split into quartiles; a few Lloyd (k-means) iterations then
 * place the three thresholds midway between the four observed level clusters. This adapts to
 * camera exposure, gamma/tone curve, white balance (we use luma), display brightness and glare
 * gradients without any fixed calibration values.
 */
function lloyd4(v: Float32Array | number[], init: number[], iterations: number): { centres: number[]; counts: number[] } {
  const centres = init.slice();
  let counts = [0, 0, 0, 0];
  for (let it = 0; it < iterations; it++) {
    const th = [(centres[0] + centres[1]) / 2, (centres[1] + centres[2]) / 2, (centres[2] + centres[3]) / 2];
    const sums = [0, 0, 0, 0];
    counts = [0, 0, 0, 0];
    for (let k = 0; k < v.length; k++) {
      const x = v[k];
      const l = (x > th[0] ? 1 : 0) + (x > th[1] ? 1 : 0) + (x > th[2] ? 1 : 0);
      sums[l] += x;
      counts[l]++;
    }
    for (let l = 0; l < 4; l++) if (counts[l]) centres[l] = sums[l] / counts[l];
  }
  return { centres, counts };
}

/**
 * Two-stage grayscale calibration.
 * 1. GLOBAL: the four level brightnesses are learned from all data cells of the frame (whitened
 *    data uses each level ~25 % of the time). This captures the camera/display tone curve, exposure
 *    and white balance — the levels need not be evenly spaced.
 * 2. LOCAL: per tile, only an offset and gain relative to the global levels are fitted (least
 *    squares over the populated clusters), which follows glare and vignetting without being fooled
 *    by tiles where some level happens to be rare.
 */
function grayThresholdSurfaces(S: Float32Array, plan: GridLayoutPlan, black: number, white: number): Float32Array[] {
  const gs = plan.gridSize;
  const mask = dataMask(plan);
  const all = new Float32Array(plan.dataCellIndices.length);
  plan.dataCellIndices.forEach((cell, k) => (all[k] = S[cell]));
  const sorted = all.slice().sort();
  const n = sorted.length;
  const q = (f: number) => sorted[Math.min(n - 1, Math.floor(f * n))];
  const G = lloyd4(all, [q(0.125), q(0.375), q(0.625), q(0.875)], 6).centres;

  const tile = Math.max(8, Math.round(gs / 6));
  const tps = Math.ceil(gs / tile);
  const tileT = [new Float32Array(tps * tps), new Float32Array(tps * tps), new Float32Array(tps * tps)];
  const valid = new Uint8Array(tps * tps);
  const buf: number[] = [];
  for (let ty = 0; ty < tps; ty++) {
    for (let tx = 0; tx < tps; tx++) {
      buf.length = 0;
      // Use a 3×3-tile neighbourhood for statistics, apply to the centre tile
      for (let r = Math.max(0, (ty - 1) * tile); r < Math.min(gs, (ty + 2) * tile); r++)
        for (let c = Math.max(0, (tx - 1) * tile); c < Math.min(gs, (tx + 2) * tile); c++) {
          const i = r * gs + c;
          if (mask[i]) buf.push(S[i]);
        }
      if (buf.length < 24) continue;
      const { centres, counts } = lloyd4(buf, G, 3);
      // Least-squares fit centres ≈ a·G + b over clusters with enough members
      let sw = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let l = 0; l < 4; l++) {
        if (counts[l] < 4) continue;
        const wgt = counts[l];
        sw += wgt;
        sx += wgt * G[l];
        sy += wgt * centres[l];
        sxx += wgt * G[l] * G[l];
        sxy += wgt * G[l] * centres[l];
      }
      const det = sw * sxx - sx * sx;
      let a = 1;
      let bOff = 0;
      if (sw > 0 && Math.abs(det) > 1e-6) {
        a = (sw * sxy - sx * sy) / det;
        bOff = (sy - a * sx) / sw;
      } else if (sw > 0) {
        bOff = (sy - sx) / sw;
      }
      if (!(a > 0.4 && a < 2.5)) {
        a = 1;
        bOff = sw > 0 ? (sy - sx) / sw : 0;
      }
      const C = G.map((g) => a * g + bOff);
      const id = ty * tps + tx;
      tileT[0][id] = (C[0] + C[1]) / 2;
      tileT[1][id] = (C[1] + C[2]) / 2;
      tileT[2][id] = (C[2] + C[3]) / 2;
      valid[id] = 1;
    }
  }
  const fallback = [(G[0] + G[1]) / 2, (G[1] + G[2]) / 2, (G[2] + G[3]) / 2];
  void black;
  void white;
  return tileT.map((tt, k) => interpolateTiles(tt, valid, tps, tile, gs, fallback[k]));
}

function interpolateTiles(tileT: Float32Array, valid: Uint8Array, tps: number, tile: number, gs: number, fallback: number): Float32Array {
  const filled = new Float32Array(tileT.length);
  for (let i = 0; i < tileT.length; i++) {
    if (valid[i]) {
      filled[i] = tileT[i];
      continue;
    }
    const ty = (i / tps) | 0;
    const tx = i % tps;
    let s = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const yy = ty + dy;
        const xx = tx + dx;
        if (yy < 0 || xx < 0 || yy >= tps || xx >= tps) continue;
        const j = yy * tps + xx;
        if (valid[j]) {
          s += tileT[j];
          n++;
        }
      }
    filled[i] = n ? s / n : fallback;
  }
  const T = new Float32Array(gs * gs);
  for (let r = 0; r < gs; r++) {
    let fy = Math.min(tps - 1, Math.max(0, (r + 0.5) / tile - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(tps - 1, y0 + 1);
    fy -= y0;
    for (let c = 0; c < gs; c++) {
      let fx = Math.min(tps - 1, Math.max(0, (c + 0.5) / tile - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(tps - 1, x0 + 1);
      fx -= x0;
      const top = filled[y0 * tps + x0] * (1 - fx) + filled[y0 * tps + x1] * fx;
      const bot = filled[y1 * tps + x0] * (1 - fx) + filled[y1 * tps + x1] * fx;
      T[r * gs + c] = top * (1 - fy) + bot * fy;
    }
  }
  return T;
}

/** Symbol levels, their reliability and the "other side of the nearest threshold" alternative. */
interface CellReading {
  mode: OpticalMode;
  levels: Uint8Array; // per data cell (in data order)
  alt: Uint8Array;
  conf: Float32Array; // distance to the nearest threshold (luma units)
  cellsPerByte: number;
  capacity: number;
}

function readCells(S: Float32Array, plan: GridLayoutPlan, mode: OpticalMode, T: Float32Array[], offset = 0): CellReading {
  const idx = plan.dataCellIndices;
  const n = idx.length;
  const levels = new Uint8Array(n);
  const alt = new Uint8Array(n);
  const conf = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const cell = idx[k];
    const v = S[cell];
    if (mode === 'mono') {
      const t = T[0][cell] + offset;
      levels[k] = v > t ? 1 : 0;
      alt[k] = 1 - levels[k];
      conf[k] = Math.abs(v - t);
    } else {
      const t1 = T[0][cell];
      const t2 = T[1][cell];
      const t3 = T[2][cell];
      const l = (v > t1 ? 1 : 0) + (v > t2 ? 1 : 0) + (v > t3 ? 1 : 0);
      levels[k] = l;
      const d1 = Math.abs(v - t1);
      const d2 = Math.abs(v - t2);
      const d3 = Math.abs(v - t3);
      const dmin = Math.min(d1, d2, d3);
      conf[k] = dmin;
      const tk = dmin === d1 ? t1 : dmin === d2 ? t2 : t3;
      alt[k] = v > tk ? l - 1 : l + 1;
    }
  }
  const cellsPerByte = mode === 'mono' ? 8 : 4;
  return { mode, levels, alt, conf, cellsPerByte, capacity: mode === 'mono' ? plan.rawByteCapacity : getFrameRawCapacity(plan.gridSize, 'gray4') };
}

function byteAt(rd: CellReading, i: number): number {
  const L = rd.levels;
  let w = 0;
  if (rd.mode === 'mono') {
    const o = i * 8;
    for (let b = 0; b < 8; b++) w = (w << 1) | L[o + b];
  } else {
    const o = i * 4;
    w = (LEVEL_TO_VALUE[L[o]] << 6) | (LEVEL_TO_VALUE[L[o + 1]] << 4) | (LEVEL_TO_VALUE[L[o + 2]] << 2) | LEVEL_TO_VALUE[L[o + 3]];
  }
  return w ^ whiteningMask(i);
}

function readingBytes(rd: CellReading): Uint8Array {
  const out = new Uint8Array(rd.capacity);
  for (let i = 0; i < out.length; i++) out[i] = byteAt(rd, i);
  return out;
}

/** Image-space row (sensor scan line) of every data cell centre — rolling-shutter tears follow it. */
function cellImageRows(H: Homography, plan: GridLayoutPlan): Float32Array {
  const idx = plan.dataCellIndices;
  const gs = plan.gridSize;
  const out = new Float32Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const r = (idx[k] / gs) | 0;
    const c = idx[k] - r * gs;
    out[k] = applyHomography(H, c + 0.5, r + 0.5).y;
  }
  return out;
}

const CHASE_CANDIDATES = 10; // → 10 single + 45 pair hypotheses, each verified by CRC-32

/**
 * Error correction by least-reliable-cell search ("Chase" decoding): when a packet fails CRC, the
 * cells read closest to a threshold are the likeliest errors. Their alternative readings are tried
 * alone and in pairs; a hypothesis is accepted only if the packet's CRC-32 then verifies.
 * Corrects up to two marginal cells per packet. Bounded work: 55 CRC checks per failed packet.
 */
function chaseCorrect(rd: CellReading, bytes: Uint8Array, start: number, len: number): { result: DecodePacketResult; flips: number } | null {
  const cpb = rd.cellsPerByte;
  const c0 = start * cpb;
  const c1 = Math.min(rd.levels.length, (start + len) * cpb);
  const cand: number[] = [];
  for (let k = c0; k < c1; k++) {
    if (cand.length < CHASE_CANDIDATES) {
      cand.push(k);
      cand.sort((a, b) => rd.conf[a] - rd.conf[b]);
    } else if (rd.conf[k] < rd.conf[cand[cand.length - 1]]) {
      cand[cand.length - 1] = k;
      cand.sort((a, b) => rd.conf[a] - rd.conf[b]);
    }
  }
  const work = bytes.slice(start, start + len);
  const tryFlips = (flips: number[]): DecodePacketResult | null => {
    const saved = flips.map((k) => rd.levels[k]);
    flips.forEach((k) => (rd.levels[k] = rd.alt[k]));
    const touched = new Set(flips.map((k) => Math.floor(k / cpb)));
    for (const b of touched) work[b - start] = byteAt(rd, b);
    const r = decodePacket(work);
    flips.forEach((k, i) => (rd.levels[k] = saved[i]));
    for (const b of touched) work[b - start] = bytes[b];
    return r.ok ? r : null;
  };
  for (let a = 0; a < cand.length; a++) {
    const r = tryFlips([cand[a]]);
    if (r) return { result: r, flips: 1 };
  }
  for (let a = 0; a < cand.length; a++)
    for (let b = a + 1; b < cand.length; b++) {
      const r = tryFlips([cand[a], cand[b]]);
      if (r) return { result: r, flips: 2 };
    }
  return null;
}

/** Parses up to `maxPackets` consecutive packets from a frame, correcting marginal cells. */
function readPackets(
  rd: CellReading,
  bytes: Uint8Array,
  maxPackets: number,
  allowChase = true
): { packets: DropFlashPacket[]; corrected: number; versionMismatch: boolean; sawPacketHeader: boolean } {
  const packets: DropFlashPacket[] = [];
  let corrected = 0;
  let versionMismatch = false;
  let sawPacketHeader = false;
  let off = 0;
  for (let k = 0; k < maxPackets; k++) {
    if (bytes.length - off < PACKET_OVERHEAD_BYTES) break;
    if (bytes[off] !== PACKET_MAGIC_0 || bytes[off + 1] !== PACKET_MAGIC_1) {
      if (k > 0) break; // padding after the last packet
    }
    const payloadLen = (bytes[off + 18] << 8) | bytes[off + 19];
    const len = Math.min(bytes.length - off, PACKET_OVERHEAD_BYTES + payloadLen);
    if (bytes[off] === PACKET_MAGIC_0 && bytes[off + 1] === PACKET_MAGIC_1) sawPacketHeader = true;
    const r = decodePacket(bytes.subarray(off, off + len));
    if (r.ok && r.packet) packets.push(r.packet);
    else if (r.error === 'version_mismatch') versionMismatch = true;
    else {
      const fixed = allowChase ? chaseCorrect(rd, bytes, off, len) : null;
      if (fixed && fixed.result.packet) {
        packets.push(fixed.result.packet);
        corrected += fixed.flips;
      } else if (r.error === 'magic_mismatch' || r.error === 'length_invalid') break;
    }
    off += PACKET_OVERHEAD_BYTES + payloadLen;
  }
  return { packets, corrected, versionMismatch, sawPacketHeader };
}

// ---------------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------------

function estimateGridSizes(triple: { topLeft: FinderCandidate; topRight: FinderCandidate; bottomLeft: FinderCandidate }, expected?: number): number[] {
  const m = (triple.topLeft.moduleSize + triple.topRight.moduleSize + triple.bottomLeft.moduleSize) / 3;
  const dTop = Math.hypot(triple.topRight.x - triple.topLeft.x, triple.topRight.y - triple.topLeft.y);
  const dLeft = Math.hypot(triple.bottomLeft.x - triple.topLeft.x, triple.bottomLeft.y - triple.topLeft.y);
  const est = (dTop + dLeft) / 2 / m + 7;
  const ranked = [...SUPPORTED_GRID_SIZES]
    .map((g) => ({ g, d: Math.abs(Math.log(g / est)) }))
    .filter((x) => x.d < 0.4)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.g as number);
  if (expected && Math.abs(Math.log(expected / est)) < 0.55) {
    return [expected, ...ranked.filter((g) => g !== expected)].slice(0, MAX_SIZES_PER_TRIPLE);
  }
  return ranked.slice(0, MAX_SIZES_PER_TRIPLE);
}

/**
 * Candidate positions for the bottom-right fiducial centre. Under perspective the parallelogram
 * prediction TR + BL − TL can be several modules off, so nearby (even weak) finder detections — the
 * bottom-right fiducial's ring rows also trigger the 1:1:3:1:1 detector — are offered as well.
 */
function bottomRightCandidates(
  tl: FinderCandidate,
  tr: FinderCandidate,
  bl: FinderCandidate,
  all: FinderCandidate[],
  bin?: Uint8Array,
  w = 0,
  h = 0
): Point2D[] {
  const pred = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };
  const m = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3;
  const radius = Math.max(12 * m, 0.35 * Math.hypot(tr.x - bl.x, tr.y - bl.y));
  const out: Point2D[] = [];
  if (bin) {
    for (const c of findBottomRightFiducials(bin, w, h, pred, m, radius)) out.push({ x: c.x, y: c.y });
  }
  out.push(pred);
  const near = all.filter(
    (c) =>
      c !== tl &&
      c !== tr &&
      c !== bl &&
      c.moduleSize > m * 0.45 &&
      c.moduleSize < m * 2.2 &&
      Math.hypot(c.x - pred.x, c.y - pred.y) < radius
  );
  for (let i = 0; i < near.length && out.length < 16; i++) {
    out.push({ x: near[i].x, y: near[i].y });
    for (let j = i + 1; j < near.length; j++) {
      const d = Math.hypot(near[i].x - near[j].x, near[i].y - near[j].y);
      if (d < 3.5 * Math.max(near[i].moduleSize, near[j].moduleSize)) {
        out.push({ x: (near[i].x + near[j].x) / 2, y: (near[i].y + near[j].y) / 2 });
      }
    }
  }
  return out.slice(0, 20);
}

function buildRowStartBytes(plan: GridLayoutPlan): number[] {
  // Byte offsets where each matrix row's data begins (rolling-shutter tears follow sensor rows).
  const starts: number[] = [];
  const rows = plan.dataCellRows;
  let lastRow = -1;
  for (let i = 0; i < rows.length; i += 8) {
    if (rows[i] !== lastRow) {
      lastRow = rows[i];
      starts.push(i >> 3);
    }
  }
  return starts;
}

const rowStartCache = new Map<number, number[]>();

export class OpticalFrameDecoder {
  private tornBytesByGrid = new Map<number, Uint8Array>();
  /**
   * Motion tracking state: the last two poses (outer corners) of the pattern. The next pose is
   * predicted at constant velocity and re-aligned by fiducial correlation, so hand movement,
   * rotation, tilt and distance changes between frames are followed without a full re-detection.
   * The lock survives up to LOCK_MAX_MISSES consecutive failed frames (blur, glare, a frame
   * boundary), which keeps synchronisation through brief detection losses.
   */
  private lock: { H: Homography; prev: QuadCorners | null; cur: QuadCorners; gridSize: number; mirrored: boolean; misses: number } | null = null;
  private static readonly LOCK_MAX_MISSES = 15;
  private lastFinders: FinderCandidate[] = [];
  /** Last CRC-failed reading (cell levels + their sensor rows) for rolling-shutter splicing. */
  private prevReading: { gs: number; mode: OpticalMode; levels: Uint8Array; rows: Float32Array } | null = null;

  /**
   * Rolling-shutter splice in SENSOR coordinates: a capture taken while the sender switched frames
   * holds frame A above some scan line and frame B below it. Combining the current and previous
   * failed captures cell-by-cell on either side of candidate scan lines rebuilds whole packets,
   * whatever the phone's rotation relative to the screen. Bounded: 2 × 24 candidate lines.
   */
  private trySensorSplice(rd: CellReading, rows: Float32Array, gs: number): DropFlashPacket[] {
    const prev = this.prevReading;
    if (!prev || prev.gs !== gs || prev.mode !== rd.mode || prev.levels.length !== rd.levels.length) return [];
    const sorted = rows.slice().sort();
    const n = sorted.length;
    const cur = rd.levels;
    const mixed = new Uint8Array(cur.length);
    const view: CellReading = { ...rd, levels: mixed };
    const found = new Map<string, DropFlashPacket>();
    for (let k = 1; k < 24; k++) {
      const Y = sorted[Math.floor((k * n) / 24)];
      for (const curOnTop of [true, false]) {
        for (let i = 0; i < mixed.length; i++) mixed[i] = (rows[i] < Y) === curOnTop ? cur[i] : prev.levels[i];
        const got = readPackets(view, readingBytes(view), rd.mode === 'gray4' ? 2 : 1, false);
        for (const p of got.packets) if (p.gridSize === gs) found.set(`${p.packetType}:${p.packetIndex}`, p);
      }
      if (found.size >= (rd.mode === 'gray4' ? 2 : 1)) break;
    }
    return [...found.values()];
  }

  private rememberLock(H: Homography, gridSize: number, mirrored: boolean): void {
    const cur = outerCorners(H, gridSize);
    const sameGrid = this.lock && this.lock.gridSize === gridSize;
    this.lock = { H, prev: sameGrid ? this.lock!.cur : null, cur, gridSize, mirrored, misses: 0 };
  }

  private predictedLockH(): Homography | null {
    const l = this.lock;
    if (!l) return null;
    if (!l.prev || l.misses > 3) return l.H; // no reliable velocity
    const k = 1 + Math.min(l.misses, 3); // frames since the last good pose
    const p = (key: keyof QuadCorners) => ({
      x: l.cur[key].x + (l.cur[key].x - l.prev![key].x) * k,
      y: l.cur[key].y + (l.cur[key].y - l.prev![key].y) * k,
    });
    return homographyFromOuterCorners(l.gridSize, { topLeft: p('topLeft'), topRight: p('topRight'), bottomLeft: p('bottomLeft'), bottomRight: p('bottomRight') }) ?? l.H;
  }

  /** True while the decoder is following a pattern (for UI: movement ≠ lost transfer). */
  isTracking(): boolean {
    return this.lock !== null;
  }

  reset(): void {
    this.tornBytesByGrid.clear();
    this.prevReading = null;
    this.lock = null;
  }

  decodeRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, options: DecodeOptions = {}): OpticalDecodeResult {
    const luma = rgbaToLuma(rgba, width, height);
    return this.decodeLuma(luma, width, height, options);
  }

  decodeLuma(luma: Uint8Array, w: number, h: number, options: DecodeOptions = {}): OpticalDecodeResult {
    const r = this.decodeLumaInner(luma, w, h, options);
    if (r.status === 'valid') return r;
    // Pattern partly outside the camera view (too close / moved off-frame)? Then the cells under the
    // missing corner are physically not captured — say so instead of a generic "not found".
    const quad = this.lock ? outerCorners(this.predictedLockH() ?? this.lock.H, this.lock.gridSize) : r.detectedBounds;
    if (quad) {
      const m = Math.max(2, r.modulePx * 0.5);
      const pts = [quad.topLeft, quad.topRight, quad.bottomLeft, quad.bottomRight];
      if (pts.some((p) => p.x < -m || p.y < -m || p.x > w + m || p.y > h + m)) return { ...r, hint: 'too_close' };
    }
    if ((r.hint === 'no_pattern' || r.hint === 'partial_pattern') && this.impliedCornersOffFrame(luma, w, h)) return { ...r, hint: 'too_close' };
    return r;
  }

  /**
   * Two visible corner markers fix the pattern's scale and one edge; the remaining corners must lie
   * one edge-length away on either side. If every such placement leaves the frame, the pattern is
   * clipped by the camera view (too close / moved off-frame).
   */
  private impliedCornersOffFrame(luma: Uint8Array, w: number, h: number): boolean {
    const confirmed = this.lastFinders.filter(isConfirmedFinder);
    const top = confirmed.reduce((m, c) => Math.max(m, c.count), 0);
    // Real markers are hit on ~3 module-heights of scan rows; data look-alikes on far fewer.
    const f = confirmed.filter((c) => c.count >= top * 0.6);
    if (f.length !== 2) return false; // exactly two strong markers visible: one edge of the pattern
    // Texture (luma standard deviation) in a window: the data area is busy, the background is not.
    const texture = (cx: number, cy: number, r: number): number => {
      let n = 0;
      let sum = 0;
      let sq = 0;
      const step = Math.max(1, Math.floor(r / 8));
      for (let y = Math.round(cy - r); y <= cy + r; y += step)
        for (let x = Math.round(cx - r); x <= cx + r; x += step) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const v = luma[y * w + x];
          sum += v;
          sq += v * v;
          n++;
        }
      return n > 4 ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) : 0;
    };
    const outside = (x: number, y: number, m: number) => x < -m || y < -m || x > w + m || y > h + m;
    for (let i = 0; i < f.length; i++)
      for (let j = i + 1; j < f.length; j++) {
        const A = f[i];
        const B = f[j];
        const mod = (A.moduleSize + B.moduleSize) / 2;
        if (Math.abs(A.moduleSize - B.moduleSize) > mod * 0.5) continue;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const d = Math.hypot(dx, dy);
        const gsEst = d / mod + 7;
        if (!SUPPORTED_GRID_SIZES.some((g) => Math.abs(Math.log(g / gsEst)) < 0.3)) continue; // not an edge pair
        const px = -dy;
        const py = dx; // perpendicular, same length as the edge
        const margin = 2 * mod;
        const mx = (A.x + B.x) / 2;
        const my = (A.y + B.y) / 2;
        const r = Math.max(4, d * 0.12);
        const sgn = texture(mx + px * 0.3, my + py * 0.3, r) >= texture(mx - px * 0.3, my - py * 0.3, r) ? 1 : -1;
        if (outside(A.x + sgn * px, A.y + sgn * py, margin) || outside(B.x + sgn * px, B.y + sgn * py, margin)) return true;
      }
    return false;
  }

  private decodeLumaInner(luma: Uint8Array, w: number, h: number, options: DecodeOptions = {}): OpticalDecodeResult {
    const { expectedGridSize, customCorners } = options;
    let finderCount = 0;
    let best: { cand: Candidate; sync: SyncEval } | null = null;
    let sawCrc: OpticalDecodeResult | null = null;
    let crcRank = -1;
    let crcBytes: Uint8Array | null = null;

    const consider = (cand: Candidate, wideBr: boolean, trackRange = 0): OpticalDecodeResult | null => {
      const plan = getGridLayoutPlan(cand.gridSize);
      let H = cand.H;
      let sync = evaluateSync(luma, w, h, H, plan);
      if (sync.score < 0.999 && (sync.score >= SYNC_REFINE || wideBr || trackRange > 0)) {
        const brRange = wideBr ? Math.min(10, Math.max(4, Math.round(cand.gridSize * 0.12))) : Math.max(1.5, trackRange);
        const refined = refineHomography(luma, w, h, H, plan, brRange, trackRange > 0 ? trackRange : 1.5);
        const s2 = evaluateSync(luma, w, h, refined, plan);
        if (s2.score >= sync.score) {
          H = refined;
          sync = s2;
        }
      }
      const finalCand = { ...cand, H };
      const strip = Math.max(sync.stripScore, sync.stripScoreGray);
      const rank = sync.score + strip * 0.25;
      if (!best || rank > best.sync.score + Math.max(best.sync.stripScore, best.sync.stripScoreGray) * 0.25) best = { cand: finalCand, sync };
      if (sync.score < SYNC_ACCEPT || strip < STRIP_ACCEPT) return null;
      const res = this.decodeCandidate(luma, w, h, finalCand, sync, finderCount);
      if (res.result.status === 'valid') return res.result;
      if (!sawCrc || rank > crcRank) {
        sawCrc = res.result;
        crcRank = rank;
        crcBytes = res.bytes;
      }
      return null;
    };

    // 1. Manual corners
    if (customCorners) {
      const sizes = expectedGridSize ? [expectedGridSize] : [...SUPPORTED_GRID_SIZES];
      for (const gs of sizes) {
        const H = homographyFromOuterCorners(gs, customCorners);
        if (!H) continue;
        const r = consider({ H, gridSize: gs, locator: 'manual', mirrored: false }, false);
        if (r) return r;
      }
      this.rememberTorn(crcBytes, sawCrc);
      return this.failure(best, sawCrc, finderCount, 'manual');
    }

    // 2. Tracking: reuse last frame's lock (cheap when the phone is held steady)
    if (this.lock) {
      const predicted = this.predictedLockH();
      if (predicted) {
        const r = consider({ H: predicted, gridSize: this.lock.gridSize, locator: 'tracked', mirrored: this.lock.mirrored }, false, this.lock.misses > 0 ? 6 : 4);
        if (r) return r;
      }
      if (this.lock && ++this.lock.misses > OpticalFrameDecoder.LOCK_MAX_MISSES) this.lock = null;
    }

    // 3. Finder-pattern localisation anywhere in the frame (rotation / perspective / mirroring).
    // Multi-scale: close to the screen the camera resolves the display's own pixel grid, whose dark
    // gaps chop the fiducials' run patterns. A 2×/4× box-averaged copy blurs that texture away;
    // markers found there are mapped back and refined/sampled at full resolution.
    const lockModule = this.lock ? modulePixelSize(this.lock.H, this.lock.gridSize) : 0;
    const scales = lockModule >= 12 ? [2, 1, 4] : [1, 2, 4];
    let allFinders: FinderCandidate[] = [];
    for (const scale of scales) {
      if (scale > 1 && (w / scale < 160 || h / scale < 120)) continue;
      const level = scale === 1 ? { l: luma, w, h } : downscaleLuma(luma, w, h, scale);
      const bin = binarizeBrightModules(smoothLuma(level.l, level.w, level.h), level.w, level.h);
      const found = findFinderPatterns(bin, level.w, level.h);
      if (scale === 1 || allFinders.length === 0) {
        allFinders = found.map((c) => ({ ...c, x: c.x * scale, y: c.y * scale, moduleSize: c.moduleSize * scale }));
        this.lastFinders = allFinders;
      }
      const toFull = (c: FinderCandidate): FinderCandidate => ({ ...c, x: c.x * scale, y: c.y * scale, moduleSize: c.moduleSize * scale });
      const triples: FinderTriple[] = selectFinderTriples(found, MAX_TRIPLES);
      finderCount = Math.max(finderCount, found.filter(isConfirmedFinder).length);
      for (const tripleLevel of triples) {
        const triple = { topLeft: toFull(tripleLevel.topLeft), topRight: toFull(tripleLevel.topRight), bottomLeft: toFull(tripleLevel.bottomLeft) };
        const sizes = estimateGridSizes(triple, expectedGridSize);
        let bestUnmirroredStrip = 0;
        for (const mirrored of [false, true]) {
          if (mirrored && bestUnmirroredStrip >= 0.95) continue; // orientation already unambiguous
          const tl = triple.topLeft;
          const tr = mirrored ? triple.bottomLeft : triple.topRight;
          const bl = mirrored ? triple.topRight : triple.bottomLeft;
          const toLevel = (c: FinderCandidate): FinderCandidate => ({ ...c, x: c.x / scale, y: c.y / scale, moduleSize: c.moduleSize / scale });
          const brCands = bottomRightCandidates(toLevel(tl), toLevel(tr), toLevel(bl), found, bin, level.w, level.h).map((p) => ({ x: p.x * scale, y: p.y * scale }));
          for (const gs of sizes) {
            // Pick the bottom-right hypothesis whose homography best explains the fixed cells.
            const plan = getGridLayoutPlan(gs);
            let bestH: Homography | null = null;
            let bestScore = -1;
            for (const br of brCands) {
              const H = homographyFromFiducialCentres(gs, tl, tr, bl, br);
              if (!H) continue;
              const sc = evaluateSync(luma, w, h, H, plan).score;
              if (sc > bestScore) {
                bestScore = sc;
                bestH = H;
              }
            }
            if (!bestH) continue;
            const r = consider({ H: bestH, gridSize: gs, locator: 'finder', mirrored }, true);
            if (r) return r;
            if (!mirrored && best) bestUnmirroredStrip = Math.max(bestUnmirroredStrip, Math.max((best as { sync: SyncEval }).sync.stripScore, (best as { sync: SyncEval }).sync.stripScoreGray));
          }
        }
      }
      if (best && (best as { sync: SyncEval }).sync.score >= SYNC_ACCEPT) break; // located: CRC failure is not a scale problem
    }

    // 4. Fallback: bright bounding box of the matrix inside its dark quiet zone
    if (!best || (best as { sync: SyncEval }).sync.score < SYNC_ACCEPT) {
      const quads = detectBrightBounds(luma, w, h);
      const sizes = expectedGridSize
        ? [expectedGridSize, ...SUPPORTED_GRID_SIZES.filter((s) => s !== expectedGridSize)]
        : [...SUPPORTED_GRID_SIZES];
      for (const q of quads) {
        for (const gs of sizes) {
          const H = homographyFromOuterCorners(gs, q);
          if (!H) continue;
          const r = consider({ H, gridSize: gs, locator: 'bounds', mirrored: false }, false);
          if (r) return r;
        }
      }
    }

    this.rememberTorn(crcBytes, sawCrc);
    return this.failure(best, sawCrc, finderCount, allFinders.length > 0 ? 'finder' : 'none');
  }

  private rememberTorn(bytes: Uint8Array | null, res: OpticalDecodeResult | null): void {
    if (bytes && res && res.gridSizeUsed && res.hint !== 'incompatible_version') {
      this.tornBytesByGrid.set(res.gridSizeUsed, bytes);
    }
  }

  private failure(
    best: { cand: Candidate; sync: SyncEval } | null,
    sawCrc: OpticalDecodeResult | null,
    finderCount: number,
    locator: OpticalDecodeResult['locator']
  ): OpticalDecodeResult {
    if (sawCrc) return sawCrc;
    if (!best) {
      return {
        status: 'no_sync',
        syncQuality: 0,
        thresholdUsed: 0,
        locator: 'none',
        finderCount,
        mirrored: false,
        modulePx: 0,
        contrast: 0,
        hint: finderCount > 0 ? 'partial_pattern' : 'no_pattern',
      };
    }
    const { cand, sync } = best;
    const modulePx = modulePixelSize(cand.H, cand.gridSize);
    const contrast = sync.whiteMean - sync.blackMean;
    let hint: DecodeHint = finderCount >= 3 ? 'partial_pattern' : finderCount > 0 ? 'partial_pattern' : 'no_pattern';
    if (sync.score > 0.6 && modulePx < 2) hint = 'too_small';
    else if (sync.score > 0.6 && contrast < 30) hint = 'low_contrast';
    return {
      status: 'no_sync',
      syncQuality: sync.score,
      thresholdUsed: (sync.whiteMean + sync.blackMean) / 2,
      detectedBounds: outerCorners(cand.H, cand.gridSize),
      gridSizeUsed: cand.gridSize,
      locator: cand.locator === 'tracked' ? 'tracked' : locator,
      finderCount,
      mirrored: cand.mirrored,
      modulePx,
      contrast,
      hint,
    };
  }

  private decodeCandidate(
    luma: Uint8Array,
    w: number,
    h: number,
    cand: Candidate,
    sync: SyncEval,
    finderCount: number
  ): { result: OpticalDecodeResult; bytes: Uint8Array | null } {
    const gs = cand.gridSize;
    const plan = getGridLayoutPlan(gs);
    const mode: OpticalMode = sync.stripScoreGray > sync.stripScore ? 'gray4' : 'mono';
    const modulePx = modulePixelSize(cand.H, gs);
    const contrast = sync.whiteMean - sync.blackMean;
    const S = sampleAllCells(luma, w, h, cand.H, gs, modulePx);
    const mono = thresholdSurface(S, gs, (sync.whiteMean + sync.blackMean) / 2);
    const T = mode === 'mono' ? [mono.T] : grayThresholdSurfaces(S, plan, sync.blackMean, sync.whiteMean);
    const base: Omit<OpticalDecodeResult, 'status'> = {
      syncQuality: sync.score,
      thresholdUsed: mono.mean,
      detectedBounds: outerCorners(cand.H, gs),
      gridSizeUsed: gs,
      syncWordRead: readSyncWord(S, mono.T, gs),
      locator: cand.locator,
      finderCount,
      mirrored: cand.mirrored,
      modulePx,
      contrast,
      hint: 'ok',
      mode,
    };
    const maxPackets = mode === 'gray4' ? 2 : 1;

    const finish = (packets: DropFlashPacket[], corrected: number, extra: Partial<OpticalDecodeResult> = {}): OpticalDecodeResult | null => {
      const good = packets.filter((p) => p.gridSize === gs); // header must agree with sampled geometry
      if (!good.length) return null;
      this.tornBytesByGrid.delete(gs);
      this.rememberLock(cand.H, gs, cand.mirrored);
      return { ...base, ...extra, status: 'valid', packet: good[0], packets: good, correctedCells: corrected };
    };

    const rd = readCells(S, plan, mode, T);
    const primary = readingBytes(rd);
    const first = readPackets(rd, primary, maxPackets);
    const ok = finish(first.packets, first.corrected);
    if (ok) return { result: ok, bytes: null };
    if (first.versionMismatch) return { result: { ...base, status: 'crc_error', hint: 'incompatible_version' }, bytes: null };

    if (mode === 'mono') {
      // Marginal contrast: retry with the threshold nudged toward white / black (bounded: 4 tries).
      const step = Math.max(3, contrast * 0.08);
      for (const k of [-1, 1, -2, 2]) {
        const rk = readCells(S, plan, 'mono', T, k * step);
        const got = readPackets(rk, readingBytes(rk), 1);
        const alt = finish(got.packets, got.corrected, { thresholdUsed: mono.mean + k * step });
        if (alt) return { result: alt, bytes: null };
      }
      // Rolling-shutter tear: splice with the previous CRC-failed capture at matrix-row boundaries.
      const prev = this.tornBytesByGrid.get(gs);
      if (prev && prev.byteLength === primary.byteLength) {
        const spliced = this.trySplice(primary, prev, plan);
        if (spliced && spliced.packet) {
          const r = finish([spliced.packet], 0, { deTornRecovered: true });
          if (r) {
            this.tornBytesByGrid.set(gs, primary);
            return { result: r, bytes: null };
          }
        }
      }
    }
    const rows = cellImageRows(cand.H, plan);
    const spliced = this.trySensorSplice(rd, rows, gs);
    this.prevReading = { gs, mode, levels: rd.levels.slice(), rows };
    if (spliced.length) {
      const r = finish(spliced, 0, { deTornRecovered: true });
      if (r) return { result: r, bytes: null };
    }
    return { result: { ...base, status: 'crc_error', hint: 'blurred_or_torn' }, bytes: mode === 'mono' ? primary : null };
  }

  private trySplice(current: Uint8Array, previous: Uint8Array, plan: GridLayoutPlan): DecodePacketResult | null {
    let starts = rowStartCache.get(plan.gridSize);
    if (!starts) {
      starts = buildRowStartBytes(plan);
      rowStartCache.set(plan.gridSize, starts);
    }
    // Bound the work: at most 96 split rows × 2 orientations.
    const stride = Math.max(1, Math.ceil(starts.length / 96));
    const candidate = new Uint8Array(current.byteLength);
    for (let i = 1; i < starts.length; i += stride) {
      const s = starts[i];
      if (s <= 24 || s >= current.byteLength - 4) continue;
      candidate.set(current.subarray(0, s), 0);
      candidate.set(previous.subarray(s), s);
      let r = decodePacket(candidate);
      if (r.ok) return r;
      candidate.set(previous.subarray(0, s), 0);
      candidate.set(current.subarray(s), s);
      r = decodePacket(candidate);
      if (r.ok) return r;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Backwards-compatible functional API (single shared decoder instance)
// ---------------------------------------------------------------------------------------------

const sharedDecoder = new OpticalFrameDecoder();

export function resetDecoderDeTearBuffer(): void {
  sharedDecoder.reset();
}

export function decodeMatrixFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  expectedGridSize?: number,
  customCorners?: QuadCorners | null
): OpticalDecodeResult {
  return sharedDecoder.decodeRgba(rgba, width, height, { expectedGridSize, customCorners });
}

export { OPTICAL_SYNC_WORD };

/** Internal building blocks, exported for unit tests and diagnostics only. */
export const __decoderInternals = {
  evaluateSync,
  refineHomography,
  homographyFromFiducialCentres,
  bottomRightCandidates,
  sampleAllCells,
  grayThresholdSurfaces,
  readCells,
  modulePixelSize,
};
