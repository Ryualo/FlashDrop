import { PACKET_MAGIC_0, PACKET_MAGIC_1, PACKET_OVERHEAD_BYTES } from './packetProtocol';

/**
 * DropFlash High-Throughput Custom Monochrome Optical Binary Matrix Encoder (Non-QR)
 *
 * Performance Architecture:
 * - Precomputes the grid layout and reusable pixel buffers to reduce per-frame allocation and drawing overhead.
 * - Theoretical bytes per frame are not a measured optical link speed; physical camera/display tests are required.
 */

export const FIDUCIAL_SIZE = 7;
export const OPTICAL_SYNC_WORD = (PACKET_MAGIC_0 << 8) | PACKET_MAGIC_1; // 0xFD4F

export type OpticalMode = 'mono' | 'gray4';

export interface OpticalMatrixFrame {
  gridSize: number;
  /** mono: 0/1 per cell. gray4: level 0..3 per cell (fixed cells use 0 or 3). */
  cells: Uint8Array;
  syncWord: number;
  mode?: OpticalMode;
}

/**
 * Grayscale frames use a different 16-bit sync word so the receiver identifies the mode of EVERY
 * frame from its fixed cells — no mode state to switch, flicker or reset.
 */
export const GRAY4_SYNC_WORD = 0x96a5;
/** Display luminance (sRGB 0..255) of the four grayscale levels. */
export const GRAY4_LEVELS = [0, 96, 176, 255] as const;
/** 2-bit value → level using Gray code, so a one-level misread corrupts only ONE bit. */
export const VALUE_TO_LEVEL = [0, 1, 3, 2] as const;
export const LEVEL_TO_VALUE = [0, 1, 3, 2] as const;

export function whiteningMask(byteIndex: number): number {
  return LFSR_MASK_TABLE[byteIndex & 0xffff];
}

/** Bytes a frame can carry: mono 1 bit per data cell, gray4 2 bits per data cell. */
export function getFrameRawCapacity(gridSize: number, mode: OpticalMode): number {
  const plan = getGridLayoutPlan(gridSize);
  return mode === 'gray4' ? Math.floor((plan.dataCellIndices.length * 2) / 8) : plan.rawByteCapacity;
}

/**
 * Encodes one frame. mono carries one packet; gray4 carries up to TWO consecutive packets (each a
 * complete, independently CRC-checked packet), so packet IDs, chunk size, manifest and parity are
 * identical in both modes and can be mixed freely in one transfer.
 */
export function encodeFrameToMatrix(packets: Uint8Array[], gridSize: number, mode: OpticalMode): OpticalMatrixFrame {
  if (mode === 'mono') {
    if (packets.length !== 1) throw new RangeError('A monochrome frame carries exactly one packet');
    return { ...encodePacketToMatrix(packets[0], gridSize), mode: 'mono' };
  }
  if (packets.length < 1 || packets.length > 2) throw new RangeError('A grayscale frame carries one or two packets');
  const plan = getGridLayoutPlan(gridSize);
  const cap = getFrameRawCapacity(gridSize, 'gray4');
  const total = packets.reduce((a, p) => a + p.byteLength, 0);
  if (total > cap) throw new RangeError(`Packets (${total} B) exceed the ${cap} B grayscale frame capacity`);
  const bytes = new Uint8Array(cap);
  let o = 0;
  for (const p of packets) {
    bytes.set(p, o);
    o += p.byteLength;
  }
  const cells = new Uint8Array(gridSize * gridSize);
  // Fixed cells: 0 → level 0, 1 → level 3, with the grayscale sync word
  for (let i = 0; i < plan.reservedCellIndices.length; i++) cells[plan.reservedCellIndices[i]] = plan.reservedExpected[i] ? 3 : 0;
  const maxSyncCol = Math.min(24, gridSize - 2);
  for (let c = 9; c <= maxSyncCol; c++) cells[8 * gridSize + c] = ((GRAY4_SYNC_WORD >>> (15 - (c - 9))) & 1) * 3;
  const idx = plan.dataCellIndices;
  let cell = 0;
  for (let i = 0; i < cap; i++) {
    const w = bytes[i] ^ LFSR_MASK_TABLE[i & 0xffff]; // whitening also randomises unused padding
    cells[idx[cell++]] = VALUE_TO_LEVEL[(w >>> 6) & 3];
    cells[idx[cell++]] = VALUE_TO_LEVEL[(w >>> 4) & 3];
    cells[idx[cell++]] = VALUE_TO_LEVEL[(w >>> 2) & 3];
    cells[idx[cell++]] = VALUE_TO_LEVEL[w & 3];
  }
  return { gridSize, cells, syncWord: GRAY4_SYNC_WORD, mode: 'gray4' };
}

export interface GridLayoutPlan {
  gridSize: number;
  templateCells: Uint8Array;
  dataCellIndices: Uint32Array;
  dataCellRows: Uint16Array;
  dataCellCols: Uint16Array;
  rawByteCapacity: number;
  payloadByteCapacity: number;
  /** Cell indices of every fixed (fiducial, separator, timing, calibration, sync) cell. */
  reservedCellIndices: Uint32Array;
  /** Expected bit (0/1) for each entry of reservedCellIndices. */
  reservedExpected: Uint8Array;
}

// Precompute 64 KB of deterministic Fibonacci LFSR whitening bytes once at module load
const MAX_WHITENING_BYTES = 65536;
const LFSR_MASK_TABLE = new Uint8Array(MAX_WHITENING_BYTES);
{
  let lfsr = 0xace1;
  for (let i = 0; i < MAX_WHITENING_BYTES; i++) {
    const bit = ((lfsr >>> 0) ^ (lfsr >>> 2) ^ (lfsr >>> 3) ^ (lfsr >>> 5)) & 1;
    lfsr = ((lfsr >>> 1) | (bit << 15)) & 0xffff;
    LFSR_MASK_TABLE[i] = lfsr & 0xff;
  }
}

/** Removes (or applies — XOR is symmetric) the whitening mask in place. */
export function unwhitenInPlace(data: Uint8Array): Uint8Array {
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    data[i] ^= LFSR_MASK_TABLE[i & 0xffff];
  }
  return data;
}

export function applyOpticalWhitening(data: Uint8Array): Uint8Array {
  const len = data.byteLength;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = data[i] ^ LFSR_MASK_TABLE[i & 0xffff];
  }
  return out;
}

export function isReservedCell(row: number, col: number, gridSize: number): boolean {
  const inTop = row < 8;
  const inBottom = row >= gridSize - 8;
  const inLeft = col < 8;
  const inRight = col >= gridSize - 8;

  if ((inTop && inLeft) || (inTop && inRight) || (inBottom && inLeft) || (inBottom && inRight)) {
    return true;
  }

  if (row === 0 || row === gridSize - 1 || col === 0 || col === gridSize - 1) {
    return true;
  }

  if (row === 8 && col >= 1 && col <= Math.min(24, gridSize - 2)) {
    return true;
  }

  return false;
}

function writeCornerFiducial(
  cells: Uint8Array,
  gridSize: number,
  startRow: number,
  startCol: number,
  isBottomRightOrientationMarker: boolean
): void {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const dist = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      let bit = 0;
      if (dist === 3) {
        bit = 1;
      } else if (dist === 2) {
        bit = 0;
      } else if (dist === 1) {
        bit = 1;
      } else {
        bit = isBottomRightOrientationMarker ? 0 : 1;
      }
      cells[(startRow + r) * gridSize + (startCol + c)] = bit;
    }
  }
}

const layoutCache = new Map<number, GridLayoutPlan>();

export const MIN_GRID_SIZE = 40;
export const MAX_GRID_SIZE = 512;

export function getGridLayoutPlan(gridSize: number): GridLayoutPlan {
  const cached = layoutCache.get(gridSize);
  if (cached) return cached;
  if (!Number.isInteger(gridSize) || gridSize < MIN_GRID_SIZE || gridSize > MAX_GRID_SIZE) {
    throw new RangeError(`Unsupported grid size ${gridSize}; expected an integer between ${MIN_GRID_SIZE} and ${MAX_GRID_SIZE}.`);
  }

  const totalCells = gridSize * gridSize;
  const templateCells = new Uint8Array(totalCells);

  // 1. 4 Corner Detection Fiducials
  writeCornerFiducial(templateCells, gridSize, 0, 0, false);
  writeCornerFiducial(templateCells, gridSize, 0, gridSize - 7, false);
  writeCornerFiducial(templateCells, gridSize, gridSize - 7, 0, false);
  writeCornerFiducial(templateCells, gridSize, gridSize - 7, gridSize - 7, true);

  // 2. Timing / Clock Borders
  for (let i = 8; i < gridSize - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    templateCells[0 * gridSize + i] = bit;
    templateCells[(gridSize - 1) * gridSize + i] = bit;
    templateCells[i * gridSize + 0] = bit;
    templateCells[i * gridSize + (gridSize - 1)] = bit;
  }

  // 3. Row 8 Calibration Reference Strip (cols 1..8) + 16-bit Sync Word 0xFD4F (cols 9..24)
  for (let c = 1; c <= 4; c++) {
    templateCells[8 * gridSize + c] = 1;
  }
  for (let c = 5; c <= 8; c++) {
    templateCells[8 * gridSize + c] = 0;
  }
  const maxSyncCol = Math.min(24, gridSize - 2);
  for (let c = 9; c <= maxSyncCol; c++) {
    const syncBitIdx = 15 - (c - 9);
    templateCells[8 * gridSize + c] = (OPTICAL_SYNC_WORD >>> syncBitIdx) & 1;
  }

  // 4. Collect unreserved data cell indices and pre-fill balanced checkerboard padding
  const indices: number[] = [];
  const rows: number[] = [];
  const cols: number[] = [];
  for (let r = 0; r < gridSize; r++) {
    const rowOff = r * gridSize;
    for (let c = 0; c < gridSize; c++) {
      if (!isReservedCell(r, c, gridSize)) {
        const idx = rowOff + c;
        const cellSeq = indices.length;
        indices.push(idx);
        rows.push(r);
        cols.push(c);
        templateCells[idx] =
          (LFSR_MASK_TABLE[(cellSeq >>> 3) & 0xffff] >>> (7 - (cellSeq & 7))) & 1;
      }
    }
  }

  const reservedIdx: number[] = [];
  const reservedBits: number[] = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (isReservedCell(r, c, gridSize)) {
        reservedIdx.push(r * gridSize + c);
        reservedBits.push(templateCells[r * gridSize + c]);
      }
    }
  }

  const dataCellIndices = new Uint32Array(indices);
  const dataCellRows = new Uint16Array(rows);
  const dataCellCols = new Uint16Array(cols);
  const rawByteCapacity = Math.floor(dataCellIndices.length / 8);
  const payloadByteCapacity = rawByteCapacity - PACKET_OVERHEAD_BYTES;

  const plan: GridLayoutPlan = {
    gridSize,
    templateCells,
    dataCellIndices,
    dataCellRows,
    dataCellCols,
    rawByteCapacity,
    payloadByteCapacity,
    reservedCellIndices: new Uint32Array(reservedIdx),
    reservedExpected: new Uint8Array(reservedBits),
  };
  layoutCache.set(gridSize, plan);
  return plan;
}

export function getGridRawByteCapacity(gridSize: number): number {
  return getGridLayoutPlan(gridSize).rawByteCapacity;
}

export function getGridPayloadCapacityBytes(gridSize: number): number {
  return getGridLayoutPlan(gridSize).payloadByteCapacity;
}

export function encodePacketToMatrix(packetBytes: Uint8Array, gridSize: number): OpticalMatrixFrame {
  const plan = getGridLayoutPlan(gridSize);
  const cells = new Uint8Array(plan.templateCells);
  const dataIndices = plan.dataCellIndices;
  if (packetBytes.byteLength > plan.rawByteCapacity) {
    throw new RangeError(
      `Packet is ${packetBytes.byteLength} bytes, but a ${gridSize}×${gridSize} frame can encode at most ${plan.rawByteCapacity} bytes. Reduce the chunk size or increase the matrix resolution.`
    );
  }

  const maxBytes = packetBytes.byteLength;
  let cellPtr = 0;
  for (let byteIdx = 0; byteIdx < maxBytes; byteIdx++) {
    const whitened = packetBytes[byteIdx] ^ LFSR_MASK_TABLE[byteIdx & 0xffff];
    cells[dataIndices[cellPtr++]] = (whitened >>> 7) & 1;
    cells[dataIndices[cellPtr++]] = (whitened >>> 6) & 1;
    cells[dataIndices[cellPtr++]] = (whitened >>> 5) & 1;
    cells[dataIndices[cellPtr++]] = (whitened >>> 4) & 1;
    cells[dataIndices[cellPtr++]] = (whitened >>> 3) & 1;
    cells[dataIndices[cellPtr++]] = (whitened >>> 2) & 1;
    cells[dataIndices[cellPtr++]] = (whitened >>> 1) & 1;
    cells[dataIndices[cellPtr++]] = whitened & 1;
  }

  return { gridSize, cells, syncWord: OPTICAL_SYNC_WORD };
}

/**
 * Integer-pixel layout for the sender canvas: every module is exactly `cellPx` device pixels, so the
 * browser never resamples the pattern (fractional scaling blurs or drops module rows on screen).
 */
export function computeIntegerCanvasLayout(
  gridSize: number,
  quietZoneCells: number,
  availableDevicePx: number
): { cellPx: number; canvasPx: number; totalUnits: number } {
  const totalUnits = gridSize + quietZoneCells * 2;
  const cellPx = Math.max(1, Math.floor(availableDevicePx / totalUnits));
  return { cellPx, canvasPx: cellPx * totalUnits, totalUnits };
}

// Single reusable buffer per target (bounded memory even when the canvas is resized repeatedly).
let canvasBuffer: { key: string; imageData: ImageData; u32: Uint32Array } | null = null;
let rawBuffer: { key: string; data: Uint8ClampedArray; u32: Uint32Array } | null = null;

/**
 * Fast 32-bit rasteriser into an RGBA pixel buffer (avoids per-cell fillRect calls on dense grids).
 * Pixels are written as opaque black / opaque white; byte order is irrelevant for those two values.
 */
function rasterizeMatrixToU32Buffer(
  matrix: OpticalMatrixFrame,
  u32: Uint32Array,
  width: number,
  height: number,
  quietZoneCells: number
): void {
  const { gridSize, cells } = matrix;
  const totalUnits = gridSize + quietZoneCells * 2;
  const side = Math.min(width, height);
  const cellSize = Math.max(1, Math.floor(side / totalUnits));
  const renderedSide = cellSize * totalUnits;
  const offsetX = Math.floor((width - renderedSide) / 2);
  const offsetY = Math.floor((height - renderedSide) / 2);

  u32.fill(0xff000000);
  const WHITE_PIXEL = 0xffffffff;
  const gray = matrix.mode === 'gray4';
  const palette = new Uint32Array(4);
  for (let l = 0; l < 4; l++) {
    const v = GRAY4_LEVELS[l];
    palette[l] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
  }

  for (let r = 0; r < gridSize; r++) {
    const startY = offsetY + (r + quietZoneCells) * cellSize;
    const rowOffset = r * gridSize;
    for (let c = 0; c < gridSize; c++) {
      const v = cells[rowOffset + c];
      if (v === 0) continue;
      const color = gray ? palette[v] : WHITE_PIXEL;
      const startX = offsetX + (c + quietZoneCells) * cellSize;
      for (let py = 0; py < cellSize; py++) {
        const rowBase = (startY + py) * width + startX;
        u32.fill(color, rowBase, rowBase + cellSize);
      }
    }
  }
}

export function renderMatrixToCanvas(
  matrix: OpticalMatrixFrame,
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  quietZoneCells = 2
): void {
  if (typeof ImageData === 'undefined') return;
  const key = `${canvasWidth}x${canvasHeight}`;
  if (!canvasBuffer || canvasBuffer.key !== key) {
    const imageData = ctx.createImageData(canvasWidth, canvasHeight);
    canvasBuffer = { key, imageData, u32: new Uint32Array(imageData.data.buffer) };
  }
  rasterizeMatrixToU32Buffer(matrix, canvasBuffer.u32, canvasWidth, canvasHeight, quietZoneCells);
  ctx.putImageData(canvasBuffer.imageData, 0, 0);
}

/**
 * Renders into a reusable RGBA buffer. The returned `data` is overwritten by the next call; copy it
 * if it must outlive the next render (e.g. before transferring it to a worker).
 */
export function renderMatrixToImageData(
  matrix: OpticalMatrixFrame,
  imageWidth: number,
  imageHeight: number,
  quietZoneCells = 2
): { data: Uint8ClampedArray; width: number; height: number } {
  const key = `${imageWidth}x${imageHeight}`;
  if (!rawBuffer || rawBuffer.key !== key) {
    const data = new Uint8ClampedArray(imageWidth * imageHeight * 4);
    rawBuffer = { key, data, u32: new Uint32Array(data.buffer) };
  }
  rasterizeMatrixToU32Buffer(matrix, rawBuffer.u32, imageWidth, imageHeight, quietZoneCells);
  return { data: rawBuffer.data, width: imageWidth, height: imageHeight };
}
