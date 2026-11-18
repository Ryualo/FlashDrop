/**
 * Camera-image primitives for locating DropFlash matrices anywhere in a full camera frame.
 *
 * DropFlash renders bright (white = 1) modules on a dark quiet zone, i.e. the inverse polarity of a
 * printed QR code. The three orientation fiducials (top-left, top-right, bottom-left) therefore show
 * a bright–dark–BRIGHT–dark–bright 1:1:3:1:1 run pattern along any line through their centre, with a
 * dark separator on both sides. The bottom-right fiducial deliberately has a dark centre
 * (1:1:1:1:1:1:1) so orientation and mirroring can be resolved.
 */

export function rgbaToLuma(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  out?: Uint8Array
): Uint8Array {
  const n = width * height;
  const luma = out && out.length >= n ? out : new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    luma[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >>> 8;
  }
  return luma;
}

const BLOCK_POWER = 3;
const BLOCK = 1 << BLOCK_POWER; // 8 px
const MIN_DYNAMIC_RANGE = 24;

/**
 * Local (block-adaptive) binarisation, adapted from the well-known hybrid binariser used by QR
 * readers, operating on inverted luminance so that *bright* screen modules come out as 1.
 * Robust to glare, vignetting and illumination gradients because each 8×8 block is thresholded
 * against the average of its 5×5 block neighbourhood.
 */
export function binarizeBrightModules(luma: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (width < BLOCK * 5 || height < BLOCK * 5) {
    // Too small for local statistics: global midpoint threshold.
    let min = 255;
    let max = 0;
    for (let i = 0; i < luma.length; i++) {
      const v = luma[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const t = (min + max) >>> 1;
    for (let i = 0; i < luma.length; i++) out[i] = luma[i] > t ? 1 : 0;
    return out;
  }

  const subW = Math.ceil(width / BLOCK);
  const subH = Math.ceil(height / BLOCK);
  const maxYOffset = height - BLOCK;
  const maxXOffset = width - BLOCK;
  const blackPoints = new Int32Array(subW * subH);

  // Inverted luminance I = 255 - L: bright screen modules become "dark ink".
  for (let by = 0; by < subH; by++) {
    const yoff = Math.min(by << BLOCK_POWER, maxYOffset);
    for (let bx = 0; bx < subW; bx++) {
      const xoff = Math.min(bx << BLOCK_POWER, maxXOffset);
      let sum = 0;
      let min = 255;
      let max = 0;
      for (let yy = 0; yy < BLOCK; yy++) {
        const row = (yoff + yy) * width + xoff;
        for (let xx = 0; xx < BLOCK; xx++) {
          const v = 255 - luma[row + xx];
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      let average = sum >> (BLOCK_POWER * 2);
      if (max - min <= MIN_DYNAMIC_RANGE) {
        // Uniform block: assume background (dark on screen => light in inverted space)
        average = min >> 1;
        if (by > 0 && bx > 0) {
          const neighbour =
            (blackPoints[(by - 1) * subW + bx] +
              2 * blackPoints[by * subW + bx - 1] +
              blackPoints[(by - 1) * subW + bx - 1]) >>
            2;
          if (min < neighbour) average = neighbour;
        }
      }
      blackPoints[by * subW + bx] = average;
    }
  }

  for (let by = 0; by < subH; by++) {
    const yoff = Math.min(by << BLOCK_POWER, maxYOffset);
    const top = Math.min(Math.max(by, 2), subH - 3);
    for (let bx = 0; bx < subW; bx++) {
      const xoff = Math.min(bx << BLOCK_POWER, maxXOffset);
      const left = Math.min(Math.max(bx, 2), subW - 3);
      let sum = 0;
      for (let z = -2; z <= 2; z++) {
        const rowBase = (top + z) * subW + left;
        sum +=
          blackPoints[rowBase - 2] +
          blackPoints[rowBase - 1] +
          blackPoints[rowBase] +
          blackPoints[rowBase + 1] +
          blackPoints[rowBase + 2];
      }
      const threshold = (sum / 25) | 0;
      for (let yy = 0; yy < BLOCK; yy++) {
        const row = (yoff + yy) * width + xoff;
        for (let xx = 0; xx < BLOCK; xx++) {
          out[row + xx] = 255 - luma[row + xx] <= threshold ? 1 : 0;
        }
      }
    }
  }
  return out;
}

export interface FinderCandidate {
  x: number;
  y: number;
  moduleSize: number;
  /** Number of scan rows that confirmed this fiducial (horizontal + vertical cross-check). */
  count: number;
  /** How many of those rows also passed the (advisory) diagonal cross-check. */
  diagonalHits: number;
}

/**
 * Light [1 2 1]⊗[1 2 1] smoothing. Suppresses single-pixel sensor noise that would otherwise create
 * speckle "fiducials" in uniform background areas, while preserving ≥2 px modules.
 */
export function smoothLuma(luma: Uint8Array, width: number, height: number): Uint8Array {
  const tmp = new Uint16Array(width * height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const l = luma[row + (x > 0 ? x - 1 : x)];
      const r = luma[row + (x < width - 1 ? x + 1 : x)];
      tmp[row + x] = l + 2 * luma[row + x] + r;
    }
  }
  for (let y = 0; y < height; y++) {
    const up = (y > 0 ? y - 1 : y) * width;
    const row = y * width;
    const dn = (y < height - 1 ? y + 1 : y) * width;
    for (let x = 0; x < width; x++) {
      out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x] + 8) >> 4;
    }
  }
  return out;
}

/**
 * Checks a bright:dark:BRIGHT:dark:bright run window for the 1:1:3:1:1 fiducial ratio.
 * The module size is estimated from the inner three runs because blur often merges the outer
 * ring with an adjacent bright data module (or the frame edge clips it); the outer runs are
 * therefore only required to be at least ~half a module and at most ~2.5 modules.
 */
function foundPatternCross(c: Int32Array | number[]): boolean {
  const inner = c[1] + c[2] + c[3];
  if (inner < 5) return false;
  const m = inner / 5;
  const v = m * 0.6;
  return (
    // The 3-module centre must be clearly wider than the dark rings: this rejects the
    // bottom-right fiducial, whose profile through a ring row is 1:1:1:1:1 vertically.
    c[2] >= 1.8 * ((c[1] + c[3]) / 2) &&
    Math.abs(m - c[1]) < v &&
    Math.abs(3 * m - c[2]) < 3 * v &&
    Math.abs(m - c[3]) < v &&
    c[0] > m * 0.4 &&
    c[4] > m * 0.4 &&
    c[0] < m * 2.5 &&
    c[4] < m * 2.5
  );
}

function innerModule(c: Int32Array | number[]): number {
  return (c[1] + c[2] + c[3]) / 5;
}

function centerFromEnd(c: Int32Array | number[], end: number): number {
  return end - c[4] - c[3] - c[2] / 2;
}

/** Measures the 5-run pattern along a line through (x, y) in direction (dx, dy). Returns centre offset along the line. */
function crossCheck(
  bin: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  maxCount: number,
  originalTotal: number
): { center: number; total: number } | null {
  const c = [0, 0, 0, 0, 0];
  const at = (k: number): number => {
    const px = x + dx * k;
    const py = y + dy * k;
    if (px < 0 || py < 0 || px >= width || py >= height) return -1;
    return bin[py * width + px];
  };

  let k = 0;
  while (at(k) === 1) {
    c[2]++;
    k--;
  }
  if (at(k) === -1) return null;
  while (at(k) === 0 && c[1] <= maxCount) {
    c[1]++;
    k--;
  }
  if (at(k) === -1 || c[1] > maxCount) return null;
  while (at(k) === 1 && c[0] <= maxCount) {
    c[0]++;
    k--;
  }
  if (c[0] > maxCount) return null;

  k = 1;
  while (at(k) === 1) {
    c[2]++;
    k++;
  }
  if (at(k) === -1) return null;
  while (at(k) === 0 && c[3] < maxCount) {
    c[3]++;
    k++;
  }
  if (at(k) === -1 || c[3] >= maxCount) return null;
  while (at(k) === 1 && c[4] < maxCount) {
    c[4]++;
    k++;
  }
  if (c[4] >= maxCount) return null;

  // Compare inner (module-defining) widths; 0 disables (diagonal runs scale by up to √2 with rotation)
  const total = innerModule(c) * 7;
  if (originalTotal > 0 && 5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return null;
  if (!foundPatternCross(c)) return null;
  return { center: centerFromEnd(c, k), total };
}

/**
 * Finds candidate orientation fiducials anywhere in the binarised frame.
 * Bounded: at most `maxCandidates` clustered results are returned (highest hit count first).
 */
export function findFinderPatterns(
  bin: Uint8Array,
  width: number,
  height: number,
  maxCandidates = 48
): FinderCandidate[] {
  const clusters: FinderCandidate[] = [];
  const MAX_CLUSTERS = 256; // hard bound against pathological (e.g. checkerboard) scenes
  const rowStep = 1;
  const counts = new Int32Array(5);

  const addCandidate = (cx: number, cy: number, moduleSize: number, diagonalOk: boolean): void => {
    for (const cl of clusters) {
      if (
        Math.abs(cl.x - cx) <= Math.max(cl.moduleSize, moduleSize) &&
        Math.abs(cl.y - cy) <= Math.max(cl.moduleSize, moduleSize) &&
        Math.abs(cl.moduleSize - moduleSize) <= Math.max(cl.moduleSize, moduleSize) * 0.5
      ) {
        const n = cl.count;
        cl.x = (cl.x * n + cx) / (n + 1);
        cl.y = (cl.y * n + cy) / (n + 1);
        cl.moduleSize = (cl.moduleSize * n + moduleSize) / (n + 1);
        cl.count = n + 1;
        if (diagonalOk) cl.diagonalHits++;
        return;
      }
    }
    if (clusters.length < MAX_CLUSTERS) {
      clusters.push({ x: cx, y: cy, moduleSize, count: 1, diagonalHits: diagonalOk ? 1 : 0 });
    }
  };

  for (let y = 0; y < height; y += rowStep) {
    const row = y * width;
    counts.fill(0);
    // state index: 0 bright, 1 dark, 2 bright, 3 dark, 4 bright
    let state = 0;
    for (let x = 0; x < width; x++) {
      if (bin[row + x] === 1) {
        if ((state & 1) === 1) state++;
        counts[state]++;
      } else if ((state & 1) === 0) {
        if (state === 4) {
          // Completed a bright,dark,bright,dark,bright window followed by dark
          if (foundPatternCross(counts)) {
            const total = innerModule(counts) * 7;
            const cx = Math.round(centerFromEnd(counts, x));
            const maxRun = Math.ceil(innerModule(counts) * 2.6);
            const v = crossCheck(bin, width, height, cx, y, 0, 1, maxRun, total);
            if (v) {
              const cy = Math.round(y + v.center);
              const h = crossCheck(bin, width, height, cx, cy, 1, 0, maxRun, total);
              if (h) {
                const fx = cx + h.center;
                const d = crossCheck(
                  bin,
                  width,
                  height,
                  Math.round(fx),
                  cy,
                  1,
                  1,
                  maxRun * 2,
                  0
                );
                // The diagonal check is advisory: blur rounds ring corners off, so a failed diagonal
                // only lowers confidence (weight) instead of rejecting the candidate.
                const moduleSize = (h.total + v.total) / 14;
                addCandidate(fx + 0.5, cy + 0.5, moduleSize, d !== null);
              }
            }
          }
          // Shift window by two runs: keep (bright, dark) as new (bright, dark)
          counts[0] = counts[2];
          counts[1] = counts[3];
          counts[2] = counts[4];
          counts[3] = 1;
          counts[4] = 0;
          state = 3;
        } else {
          state++;
          counts[state]++;
        }
      } else {
        counts[state]++;
      }
    }
  }

  // Returned unfiltered (strongest first); selectFinderTriples() applies the confirmation filter.
  // Weak clusters are still useful as bottom-right fiducial hints.
  return clusters.sort((a, b) => b.count - a.count).slice(0, maxCandidates);
}

/**
 * A real fiducial is confirmed on several consecutive scan rows crossing its 3-module centre;
 * isolated sensor-noise speckles are confirmed on one or two rows only.
 */
export function isConfirmedFinder(c: FinderCandidate): boolean {
  // The 3-module centre is crossed by ≈3·module scan rows; require a fraction of that.
  return c.count >= Math.max(3, Math.round(c.moduleSize * 0.75));
}

export interface FinderTriple {
  topLeft: FinderCandidate;
  topRight: FinderCandidate;
  bottomLeft: FinderCandidate;
  score: number;
}

/**
 * Chooses plausible (top-left, top-right, bottom-left) triples. The corner with the ~90° angle is
 * top-left; the cross-product sign gives orientation, so any in-plane rotation is handled.
 * Larger triangles are preferred because the real fiducials span the whole matrix while false
 * positives from data cells lie inside it.
 */
export function selectFinderTriples(all: FinderCandidate[], maxTriples = 4): FinderTriple[] {
  const triples: FinderTriple[] = [];
  const cands = all.filter(isConfirmedFinder);
  const n = Math.min(cands.length, 16);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const pts = [cands[i], cands[j], cands[k]];
        const mMin = Math.min(pts[0].moduleSize, pts[1].moduleSize, pts[2].moduleSize);
        const mMax = Math.max(pts[0].moduleSize, pts[1].moduleSize, pts[2].moduleSize);
        if (mMax > mMin * 2.2) continue;
        // Try each point as the right-angle corner
        for (let c = 0; c < 3; c++) {
          const A = pts[c];
          const B = pts[(c + 1) % 3];
          const C = pts[(c + 2) % 3];
          const abx = B.x - A.x;
          const aby = B.y - A.y;
          const acx = C.x - A.x;
          const acy = C.y - A.y;
          const lab = Math.hypot(abx, aby);
          const lac = Math.hypot(acx, acy);
          const mAvg = (A.moduleSize + B.moduleSize + C.moduleSize) / 3;
          if (lab < mAvg * 8 || lac < mAvg * 8) continue; // smallest grid is 48 → ≥41 modules apart
          const ratio = lab / lac;
          if (ratio < 0.55 || ratio > 1.8) continue;
          const cos = (abx * acx + aby * acy) / (lab * lac);
          if (Math.abs(cos) > 0.5) continue; // 60°..120°
          const cross = abx * acy - aby * acx;
          const topRight = cross > 0 ? B : C;
          const bottomLeft = cross > 0 ? C : B;
          const area = Math.abs(cross) / 2;
          const shapePenalty = Math.abs(cos) + Math.abs(Math.log(ratio)) + (mMax / mMin - 1) * 0.5;
          const minCount = Math.min(A.count, B.count, C.count);
          const diag = (A.diagonalHits > 0 ? 1 : 0) + (B.diagonalHits > 0 ? 1 : 0) + (C.diagonalHits > 0 ? 1 : 0);
          const score = Math.sqrt(area) / mAvg - shapePenalty * 20 + 8 * Math.log(minCount) + 4 * diag;
          triples.push({ topLeft: A, topRight, bottomLeft, score });
        }
      }
    }
  }
  triples.sort((a, b) => b.score - a.score);
  return triples.slice(0, maxTriples);
}

function alternatingRunsOk(runs: number[], mRef: number): number {
  // Returns the per-run module estimate if 7 runs are each ≈ one module, else 0.
  let total = 0;
  for (const r of runs) total += r;
  const m = total / 7;
  if (m < mRef * 0.45 || m > mRef * 2.2) return 0;
  const tol = Math.max(1.01, m * 0.6);
  for (const r of runs) if (Math.abs(r - m) > tol) return 0;
  return m;
}

/**
 * Locates the bottom-right orientation fiducial (bright/dark rings around a DARK centre, i.e. seven
 * alternating one-module runs through its centre) inside a window around a predicted position.
 * Needed because under perspective the parallelogram prediction TR + BL − TL can be tens of
 * modules away from the real corner. Work is bounded by the window size.
 */
export function findBottomRightFiducials(
  bin: Uint8Array,
  width: number,
  height: number,
  predicted: { x: number; y: number },
  moduleSize: number,
  radius: number,
  maxResults = 12
): FinderCandidate[] {
  const x0 = Math.max(0, Math.floor(predicted.x - radius));
  const x1 = Math.min(width - 1, Math.ceil(predicted.x + radius));
  const y0 = Math.max(0, Math.floor(predicted.y - radius));
  const y1 = Math.min(height - 1, Math.ceil(predicted.y + radius));
  if (x1 - x0 < 8 || y1 - y0 < 8) return [];
  const found: FinderCandidate[] = [];
  const runs: number[] = [];
  const colors: number[] = [];

  const verticalCheck = (cx: number, cy: number, mRef: number): { y: number; m: number } | null => {
    // Expect: centre dark run, then bright, dark, bright both up and down.
    const at = (y: number): number => (y < 0 || y >= height ? -1 : bin[y * width + cx]);
    if (at(cy) !== 0) return null;
    const limit = Math.ceil(mRef * 2.5);
    let up = cy;
    let c3 = 0;
    while (at(up) === 0 && c3 <= limit) {
      c3++;
      up--;
    }
    let dn = cy + 1;
    while (at(dn) === 0 && c3 <= limit) {
      c3++;
      dn++;
    }
    const seq: number[] = [];
    let y = up;
    for (const want of [1, 0, 1]) {
      let n = 0;
      while (at(y) === want && n <= limit) {
        n++;
        y--;
      }
      if (n === 0 || n > limit) return null;
      seq.unshift(n);
    }
    seq.push(c3);
    y = dn;
    for (const want of [1, 0, 1]) {
      let n = 0;
      while (at(y) === want && n <= limit) {
        n++;
        y++;
      }
      if (n === 0 || n > limit) return null;
      seq.push(n);
    }
    const m = alternatingRunsOk(seq, mRef);
    if (!m) return null;
    const centreTop = up + 1;
    return { y: centreTop + c3 / 2, m };
  };

  for (let y = y0; y <= y1; y++) {
    runs.length = 0;
    colors.length = 0;
    const row = y * width;
    let cur = bin[row + x0];
    let len = 0;
    const flush = (endX: number): void => {
      runs.push(len);
      colors.push(cur);
      if (runs.length > 9) {
        runs.shift();
        colors.shift();
      }
      // Need: dark, [B D B D B D B], dark  → check the 7 runs preceding the latest dark run
      if (runs.length >= 8 && colors[colors.length - 1] === 0 && colors[colors.length - 8] === 1) {
        const seven = runs.slice(runs.length - 8, runs.length - 1);
        const m = alternatingRunsOk(seven, moduleSize);
        if (m) {
          // centre run is index 3 of the seven
          const startOfSeven = endX - len - seven.reduce((a, b) => a + b, 0);
          const cx = Math.round(startOfSeven + seven[0] + seven[1] + seven[2] + seven[3] / 2);
          const v = verticalCheck(cx, y, m);
          if (v) {
            const fy = v.y;
            const fm = (m + v.m) / 2;
            let merged = false;
            for (const f of found) {
              if (Math.abs(f.x - cx) <= fm * 1.5 && Math.abs(f.y - fy) <= fm * 1.5) {
                f.x = (f.x * f.count + cx + 0.5) / (f.count + 1);
                f.y = (f.y * f.count + fy) / (f.count + 1);
                f.moduleSize = (f.moduleSize * f.count + fm) / (f.count + 1);
                f.count++;
                merged = true;
                break;
              }
            }
            if (!merged && found.length < 64) found.push({ x: cx + 0.5, y: fy, moduleSize: fm, count: 1, diagonalHits: 0 });
          }
        }
      }
    };
    for (let x = x0; x <= x1; x++) {
      const b = bin[row + x];
      if (b === cur) len++;
      else {
        flush(x);
        cur = b;
        len = 1;
      }
    }
    flush(x1 + 1); // the window edge terminates the last run (e.g. a quiet zone running past it)
  }
  // Rank by closeness to the prediction (in modules) with a small bonus for repeated confirmation;
  // false detections inside the data area are typically far from the predicted corner.
  const rank = (c: FinderCandidate): number =>
    Math.hypot(c.x - predicted.x, c.y - predicted.y) / Math.max(1, moduleSize) - 2 * Math.min(c.count, 6);
  return found.sort((a, b) => rank(a) - rank(b)).slice(0, maxResults);
}
