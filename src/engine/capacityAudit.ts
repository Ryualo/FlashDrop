import { PACKET_CRC_SIZE, PACKET_HEADER_SIZE, PACKET_OVERHEAD_BYTES, encodePacket, PacketType } from './packetProtocol';
import { encodePacketToMatrix, getGridLayoutPlan, isReservedCell, renderMatrixToImageData } from './opticalEncoder';
import { OpticalFrameDecoder } from './opticalDecoder';
import { renderSyntheticCameraFrame } from './syntheticCamera';
import { StreamingFileCarousel } from './fileChunker';
import { IncrementalFileReconstructor } from './fileReconstructor';
import { computeSha256Bytes } from '../utils/integrity';

export const XOR_LENGTH_PREFIX_RESERVE_BYTES = 2;
export const TOTAL_PACKET_FRAMING_OVERHEAD_BYTES = PACKET_OVERHEAD_BYTES + XOR_LENGTH_PREFIX_RESERVE_BYTES; // 30 B

export interface GridCapacityAuditRow {
  gridSize: number;
  totalGridCells: number;
  cornerFiducialCells: number;
  timingBorderCells: number;
  row8SyncAndCalibrationCells: number;
  totalReservedCells: number;
  independentBinaryDataCells: number;
  unusedTailBits: number;
  rawEncodedFrameBytes: number;
  packetHeaderBytes: number;
  packetCrcBytes: number;
  erasureLengthReserveBytes: number;
  totalFramingOverheadBytes: number;
  usefulPayloadBytesPerDataFrame: number;
  manifestIntervalFrames: number;
  erasureBlockSize: number;
  /** Fraction of emitted frames that carry new DATA (manifest + parity frames excluded). */
  carouselStreamEfficiency: number;
  effectiveUsefulBytesPerEmittedFrame: number;
  netCellEfficiencyPercent: number;
}

export interface Claimed700KbAuditSummary {
  claimedBytesPerFrame: number;
  claimedBitsPerFrame: number;
  requiredGridDimensionFor700Kb: number;
  requiredTotalCellsFor700Kb: number;
  actualDefault64UsefulBytes: number;
  actualMax384UsefulBytes: number;
  ratio700KbTo64Grid: number;
  ratio700KbTo384Grid: number;
  rootCauseExplanation: string;
}

/** Exact per-frame cell accounting, counted from the encoder's own layout. */
export function auditGridCapacity(gridSize: number, erasureBlockSize = 8, manifestIntervalFrames = 6): GridCapacityAuditRow {
  const plan = getGridLayoutPlan(gridSize);
  const totalGridCells = gridSize * gridSize;
  let cornerFiducialCells = 0;
  let timingBorderCells = 0;
  let row8SyncAndCalibrationCells = 0;
  let independentBinaryDataCells = 0;

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const inTop = r < 8;
      const inBottom = r >= gridSize - 8;
      const inLeft = c < 8;
      const inRight = c >= gridSize - 8;
      if ((inTop && inLeft) || (inTop && inRight) || (inBottom && inLeft) || (inBottom && inRight)) cornerFiducialCells++;
      else if (r === 0 || r === gridSize - 1 || c === 0 || c === gridSize - 1) timingBorderCells++;
      else if (r === 8 && c >= 1 && c <= Math.min(24, gridSize - 2)) row8SyncAndCalibrationCells++;
      else if (!isReservedCell(r, c, gridSize)) independentBinaryDataCells++;
    }
  }
  const totalReservedCells = cornerFiducialCells + timingBorderCells + row8SyncAndCalibrationCells;
  const rawEncodedFrameBytes = Math.floor(independentBinaryDataCells / 8);
  if (independentBinaryDataCells !== plan.dataCellIndices.length || rawEncodedFrameBytes !== plan.rawByteCapacity) {
    throw new Error(`Grid audit mismatch for ${gridSize}x${gridSize}`);
  }
  const usefulPayloadBytesPerDataFrame = rawEncodedFrameBytes - TOTAL_PACKET_FRAMING_OVERHEAD_BYTES;
  const manifestEfficiency = manifestIntervalFrames > 1 ? (manifestIntervalFrames - 1) / manifestIntervalFrames : 1;
  const fecEfficiency = erasureBlockSize > 1 ? erasureBlockSize / (erasureBlockSize + 1) : 1;
  const carouselStreamEfficiency = manifestEfficiency * fecEfficiency;
  const effectiveUsefulBytesPerEmittedFrame = usefulPayloadBytesPerDataFrame * carouselStreamEfficiency;
  return {
    gridSize,
    totalGridCells,
    cornerFiducialCells,
    timingBorderCells,
    row8SyncAndCalibrationCells,
    totalReservedCells,
    independentBinaryDataCells,
    unusedTailBits: independentBinaryDataCells % 8,
    rawEncodedFrameBytes,
    packetHeaderBytes: PACKET_HEADER_SIZE,
    packetCrcBytes: PACKET_CRC_SIZE,
    erasureLengthReserveBytes: XOR_LENGTH_PREFIX_RESERVE_BYTES,
    totalFramingOverheadBytes: TOTAL_PACKET_FRAMING_OVERHEAD_BYTES,
    usefulPayloadBytesPerDataFrame,
    manifestIntervalFrames,
    erasureBlockSize,
    carouselStreamEfficiency,
    effectiveUsefulBytesPerEmittedFrame,
    netCellEfficiencyPercent: (effectiveUsefulBytesPerEmittedFrame / (totalGridCells / 8)) * 100,
  };
}

export const AUDIT_GRID_SIZES = [48, 64, 96, 128, 192, 256, 384] as const;

export function auditAllGridResolutions(erasureBlockSize = 8, manifestIntervalFrames = 6): GridCapacityAuditRow[] {
  return AUDIT_GRID_SIZES.map((g) => auditGridCapacity(g, erasureBlockSize, manifestIntervalFrames));
}

export function auditClaimed700KbCapacity(): Claimed700KbAuditSummary {
  const claimedBytesPerFrame = 700 * 1024;
  const claimedBitsPerFrame = claimedBytesPerFrame * 8;
  const required = (claimedBytesPerFrame + TOTAL_PACKET_FRAMING_OVERHEAD_BYTES) * 8;
  let g = Math.ceil(Math.sqrt(required));
  while (g * g - 4 * g - 216 < required) g++; // data cells = G² − (4G + 216)
  const row64 = auditGridCapacity(64);
  const row384 = auditGridCapacity(384);
  return {
    claimedBytesPerFrame,
    claimedBitsPerFrame,
    requiredGridDimensionFor700Kb: g,
    requiredTotalCellsFor700Kb: g * g,
    actualDefault64UsefulBytes: row64.usefulPayloadBytesPerDataFrame,
    actualMax384UsefulBytes: row384.usefulPayloadBytesPerDataFrame,
    ratio700KbTo64Grid: claimedBytesPerFrame / row64.usefulPayloadBytesPerDataFrame,
    ratio700KbTo384Grid: claimedBytesPerFrame / row384.usefulPayloadBytesPerDataFrame,
    rootCauseExplanation:
      `A 1-bit-per-cell frame cannot carry 700 KB (5,734,400 bits): that needs at least ${g}×${g} cells, ` +
      `more than the pixel height of a 4K display and far beyond what a phone camera can resolve. ` +
      `DropFlash's 64×64 grid carries ${row64.usefulPayloadBytesPerDataFrame} B of file data per DATA frame and the ` +
      `384×384 grid ${row384.usefulPayloadBytesPerDataFrame.toLocaleString()} B. Real throughput depends on how many ` +
      `frames per second the receiving camera captures cleanly — it must be measured on two physical devices.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Live software checks (synthetic; clearly labelled as such in the UI)
// ---------------------------------------------------------------------------------------------

export interface SyntheticFrameCheck {
  gridSize: number;
  frameSize: string;
  pixelsPerModule: number;
  description: string;
  status: 'valid' | 'crc_error' | 'no_sync';
  bitExact: boolean;
  decodeMs: number;
}

export interface DecoderCostMeasurement {
  gridSize: number;
  frameSize: string;
  framesDecoded: number;
  avgDecodeMs: number;
  /** Upper bound if decoding were the only limit: payload bytes / avg decode time. NOT a link speed. */
  decoderComputeCeilingBytesPerSec: number;
}

export interface FaultInjectionResult {
  framesEmitted: number;
  framesDropped: number;
  corruptedFramesInjected: number;
  corruptedFramesAccepted: number;
  joinedAtPacket: number | null;
  parityRecoveries: number;
  duplicatesIgnored: number;
  sha256Matches: boolean;
  completed: boolean;
}

export interface CompleteOpticalAuditReport {
  timestampIso: string;
  claimed700KbAudit: Claimed700KbAuditSummary;
  gridCapacityTable: GridCapacityAuditRow[];
  syntheticFrameChecks: SyntheticFrameCheck[];
  decoderCost: DecoderCostMeasurement[];
  faultInjection: FaultInjectionResult;
}

function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function testPacket(gs: number, seed: number) {
  const n = getGridLayoutPlan(gs).payloadByteCapacity - 2;
  const payload = new Uint8Array(n);
  for (let i = 0; i < n; i++) payload[i] = (i * 73 + gs * 19 + seed) & 0xff;
  const bytes = encodePacket({
    packetType: PacketType.DATA,
    transferId: 0x99887766,
    fileId: 1,
    packetIndex: seed,
    totalSourcePackets: 1000,
    erasureBlockSize: 8,
    gridSize: gs,
    flags: 0,
    payload,
  });
  return { bytes, payload };
}

export async function verifySyntheticCameraFrames(): Promise<SyntheticFrameCheck[]> {
  const configs = [
    { gs: 48, side: 420, rot: 12, tilt: 0.1, desc: 'Rotated, tilted, glare, blur, noise' },
    { gs: 64, side: 480, rot: 200, tilt: 0.15, desc: 'Upside-down + perspective' },
    { gs: 96, side: 600, rot: -8, tilt: 0.12, desc: 'Tilted, glare, noise' },
    { gs: 128, side: 660, rot: 5, tilt: 0.08, desc: 'Dense grid, slight tilt' },
    { gs: 192, side: 640, rot: 3, tilt: 0.05, desc: 'Very dense: ~3.3 px/module' },
  ];
  const out: SyntheticFrameCheck[] = [];
  for (const c of configs) {
    const { bytes, payload } = testPacket(c.gs, 3);
    const f = renderSyntheticCameraFrame(encodePacketToMatrix(bytes, c.gs), {
      width: 1280,
      height: 720,
      matrixSidePx: c.side,
      rotationDeg: c.rot,
      perspectiveTilt: c.tilt,
      glareDelta: 40,
      blurRadius: 1,
      noiseAmplitude: 6,
      seed: c.gs,
    });
    const t0 = performance.now();
    const r = new OpticalFrameDecoder().decodeRgba(f.data, f.width, f.height);
    const ms = performance.now() - t0;
    let bitExact = false;
    if (r.status === 'valid' && r.packet && r.packet.payload.length === payload.length) {
      bitExact = r.packet.payload.every((v, i) => v === payload[i]);
    }
    out.push({
      gridSize: c.gs,
      frameSize: '1280×720',
      pixelsPerModule: Number(f.pixelsPerModule.toFixed(2)),
      description: c.desc,
      status: r.status,
      bitExact,
      decodeMs: Number(ms.toFixed(1)),
    });
    await yieldToUi();
  }
  return out;
}

/** Measures decoder CPU time on this device. It does NOT measure an optical link. */
export async function measureDecoderCost(frames = 5): Promise<DecoderCostMeasurement[]> {
  const out: DecoderCostMeasurement[] = [];
  for (const gs of [64, 128, 384]) {
    const dim = (gs + 4) * Math.max(2, Math.floor(800 / (gs + 4)));
    const dec = new OpticalFrameDecoder();
    let total = 0;
    for (let i = 0; i < frames; i++) {
      const { bytes } = testPacket(gs, i);
      const img = renderMatrixToImageData(encodePacketToMatrix(bytes, gs), dim, dim, 2);
      const t0 = performance.now();
      dec.decodeRgba(img.data, dim, dim, { expectedGridSize: gs });
      total += performance.now() - t0;
      await yieldToUi();
    }
    const avg = total / frames;
    out.push({
      gridSize: gs,
      frameSize: `${dim}×${dim}`,
      framesDecoded: frames,
      avgDecodeMs: Number(avg.toFixed(1)),
      decoderComputeCeilingBytesPerSec: Math.round((getGridLayoutPlan(gs).payloadByteCapacity - 2) / (avg / 1000)),
    });
  }
  return out;
}

/** Runs the real pipeline with injected drops and bit errors, counting what actually happened. */
export async function runFaultInjection(): Promise<FaultInjectionResult> {
  const gs = 64;
  const chunk = getGridLayoutPlan(gs).payloadByteCapacity - 2;
  const size = chunk * 24 - 37;
  const original = new Uint8Array(size);
  for (let i = 0; i < size; i++) original[i] = (i * 97 + 43) & 0xff;
  const expectedSha = computeSha256Bytes(original);
  const file = new File([original as BlobPart], 'fault-injection.bin', { type: 'application/octet-stream' });
  const carousel = new StreamingFileCarousel(file, file.name, file.type, {
    gridSize: gs,
    erasureBlockSize: 4,
    manifestIntervalFrames: 6,
    startPacketOffset: 13,
  });
  await carousel.prepare();
  await carousel.nextPacket(); // receiver joins after the first manifest
  const rec = new IncrementalFileReconstructor();
  const dec = new OpticalFrameDecoder();
  const plan = getGridLayoutPlan(gs);
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  let emitted = 0;
  let dropped = 0;
  let corrupted = 0;
  let corruptedAccepted = 0;
  const dim = (gs + 4) * 4;
  while (emitted < 400) {
    emitted++;
    const p = await carousel.nextPacket();
    if (rnd() < 0.15) {
      dropped++;
      continue;
    }
    const m = encodePacketToMatrix(p.rawBytes, gs);
    const corrupt = p.packetType === PacketType.DATA && rnd() < 0.1;
    if (corrupt) {
      corrupted++;
      for (let k = 0; k < 3; k++) m.cells[plan.dataCellIndices[(rnd() * plan.dataCellIndices.length) | 0]] ^= 1;
    }
    const img = renderMatrixToImageData(m, dim, dim, 2);
    const r = dec.decodeRgba(img.data, dim, dim, { expectedGridSize: gs });
    if (r.status === 'valid' && r.packet) {
      if (corrupt) corruptedAccepted++;
      const st = await rec.ingestPacket(r.packet);
      if (st.status !== 'receiving' && st.status !== 'waiting_manifest') break;
    }
    if (emitted % 20 === 0) await yieldToUi();
  }
  const st = await rec.drain();
  return {
    framesEmitted: emitted,
    framesDropped: dropped,
    corruptedFramesInjected: corrupted,
    corruptedFramesAccepted: corruptedAccepted,
    joinedAtPacket: st.joinedAtPacketIndex,
    parityRecoveries: st.parityRecoveredPackets,
    duplicatesIgnored: st.duplicatePackets,
    sha256Matches: st.verified === true && st.computedSha256 === expectedSha,
    completed: st.status === 'completed',
  };
}

export async function runCompleteOpticalAudit(): Promise<CompleteOpticalAuditReport> {
  const claimed700KbAudit = auditClaimed700KbCapacity();
  const gridCapacityTable = auditAllGridResolutions(8, 6);
  const syntheticFrameChecks = await verifySyntheticCameraFrames();
  const decoderCost = await measureDecoderCost();
  const faultInjection = await runFaultInjection();
  return {
    timestampIso: new Date().toISOString(),
    claimed700KbAudit,
    gridCapacityTable,
    syntheticFrameChecks,
    decoderCost,
    faultInjection,
  };
}
