/**
 * Planar projective transform (homography) utilities.
 *
 * A homography maps grid/module coordinates (u, v) onto image pixel coordinates (x, y):
 *   x = (h0 u + h1 v + h2) / (h6 u + h7 v + 1)
 *   y = (h3 u + h4 v + h5) / (h6 u + h7 v + 1)
 * Unlike bilinear quad interpolation, this models true camera perspective, so cell centres stay
 * aligned across the whole matrix even when the screen is tilted toward or away from the camera.
 */

export interface Point2D {
  x: number;
  y: number;
}

export type Homography = Float64Array; // length 9, row-major, h8 === 1

/**
 * Solves the 8 unknowns of a homography from four point correspondences.
 * Returns null when the configuration is degenerate (three collinear points, etc.).
 */
export function computeHomography(src: readonly Point2D[], dst: readonly Point2D[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  // Build A (8x8) and b (8)
  const A = new Float64Array(64);
  const b = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = src[i];
    const { x, y } = dst[i];
    const r0 = i * 2;
    const r1 = r0 + 1;
    A.set([u, v, 1, 0, 0, 0, -u * x, -v * x], r0 * 8);
    A.set([0, 0, 0, u, v, 1, -u * y, -v * y], r1 * 8);
    b[r0] = x;
    b[r1] = y;
  }
  const h = solveLinearSystem(A, b, 8);
  if (!h) return null;
  const H = new Float64Array(9);
  H.set(h, 0);
  H[8] = 1;
  for (let i = 0; i < 9; i++) {
    if (!Number.isFinite(H[i])) return null;
  }
  return H;
}

/** Gaussian elimination with partial pivoting. A is n×n row-major and is modified in place. */
function solveLinearSystem(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[pivot * n + c];
        A[pivot * n + c] = t;
      }
      const tb = b[col];
      b[col] = b[pivot];
      b[pivot] = tb;
    }
    const diag = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / diag;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
    x[r] = s / A[r * n + r];
  }
  return x;
}

export function applyHomography(H: Homography, u: number, v: number): Point2D {
  const w = H[6] * u + H[7] * v + H[8];
  const iw = w !== 0 ? 1 / w : 0;
  return {
    x: (H[0] * u + H[1] * v + H[2]) * iw,
    y: (H[3] * u + H[4] * v + H[5]) * iw,
  };
}

/** Inverse of a 3×3 homography (normalised so H[8] === 1 when possible). */
export function invertHomography(H: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const inv = new Float64Array([
    A,
    -(b * i - c * h),
    b * f - c * e,
    B,
    a * i - c * g,
    -(a * f - c * d),
    C,
    -(a * h - b * g),
    a * e - b * d,
  ]);
  const s = inv[8] !== 0 ? 1 / inv[8] : 1 / det;
  for (let k = 0; k < 9; k++) inv[k] *= s;
  return inv;
}
