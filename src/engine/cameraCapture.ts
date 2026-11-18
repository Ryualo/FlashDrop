import { encodePacketToMatrix, getGridLayoutPlan, renderMatrixToImageData } from './opticalEncoder';
import { renderSyntheticCameraFrame } from './syntheticCamera';
import { StreamingFileCarousel } from './fileChunker';
import { PacketType } from './packetProtocol';

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export async function listCameraDevices(): Promise<CameraDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, idx) => ({ deviceId: d.deviceId, label: d.label || `Camera ${idx + 1}` }));
  } catch {
    return [];
  }
}

/** Maps getUserMedia failures to actionable messages. */
export function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was denied. Allow camera access for this site in the browser’s site settings, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is in use by another app or tab, or the hardware failed to start. Close other camera apps and retry.';
    case 'OverconstrainedError':
      return 'The selected camera does not support the requested mode. Choose “Default rear camera” in Settings.';
    case 'SecurityError':
      return 'Camera access is blocked. The page must be served over HTTPS (or localhost) and not inside a restricted iframe.';
    case 'AbortError':
      return 'Camera start was interrupted. Please try again.';
    default:
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        return 'Camera access requires HTTPS (or localhost). Open the site over https://.';
      }
      return err instanceof Error && err.message ? err.message : 'Camera unavailable in this browser.';
  }
}

/**
 * Opens the camera with progressively relaxed constraints (bounded: 3 attempts) so devices that
 * reject a specific resolution/frame-rate still start.
 */
export async function openCameraStream(deviceId?: string, targetFps = 30): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    const e = new Error('Camera API is unavailable. Use a current browser over HTTPS.');
    e.name = typeof window !== 'undefined' && !window.isSecureContext ? 'SecurityError' : 'NotFoundError';
    throw e;
  }
  const device: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
  const fps = Math.min(60, Math.max(15, targetFps));
  const attempts: MediaStreamConstraints[] = [
    { audio: false, video: { ...device, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: fps } } },
    { audio: false, video: { ...device, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: false, video: deviceId ? { deviceId: { ideal: deviceId } } : true },
  ];
  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getVideoTracks()[0];
      if (track && typeof track.applyConstraints === 'function') {
        // Non-standard but widely supported focus hints; ignored where unsupported.
        const advanced = [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet];
        void track.applyConstraints({ advanced }).catch(() => undefined);
      }
      return stream;
    } catch (e) {
      lastError = e;
      const name = e instanceof Error ? e.name : '';
      // Permission/security errors will not change with other constraints.
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') break;
    }
  }
  throw lastError ?? new Error('Camera unavailable');
}

export interface LoopbackFeedOptions {
  /** Edge length (px) of each generated frame. */
  canvasDimension?: number;
  /** Drop this fraction of frames (simulated missed exposures). */
  simulatedDropProbability?: number;
  /** Flip three data cells every Nth frame (CRC rejection demo). */
  corruptEveryNthFrame?: number;
  /** Render through the synthetic camera model instead of pixel-exact. */
  syntheticCamera?: boolean;
  /** Skip exactly one DATA packet early on to demonstrate XOR recovery. */
  skipOnePacketForXorDemo?: boolean;
}

export interface LoopbackFrame {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  dropped: boolean;
  corrupted: boolean;
  packetIndex: number;
  loopCycle: number;
}

/**
 * Software loopback: renders the sender's frames directly into RGBA buffers for the decoder.
 * No camera is involved — this verifies the protocol/decoder/storage pipeline only.
 */
export class OpticalLoopbackFeed {
  private readonly carousel: StreamingFileCarousel;
  private readonly gridSize: number;
  private readonly dim: number;
  private readonly opts: Required<LoopbackFeedOptions>;
  private frameCounter = 0;
  private skipped = false;
  private rand = 0x9e3779b9;

  constructor(carousel: StreamingFileCarousel, gridSize: number, options: LoopbackFeedOptions = {}) {
    this.carousel = carousel;
    this.gridSize = gridSize;
    const requested = options.canvasDimension ?? 476;
    const cellPx = Math.max(2, Math.floor(requested / (gridSize + 4)));
    this.dim = cellPx * (gridSize + 4);
    this.opts = {
      canvasDimension: this.dim,
      simulatedDropProbability: options.simulatedDropProbability ?? 0,
      corruptEveryNthFrame: options.corruptEveryNthFrame ?? 0,
      syntheticCamera: options.syntheticCamera ?? false,
      skipOnePacketForXorDemo: options.skipOnePacketForXorDemo ?? false,
    };
  }

  getDimension(): number {
    return this.opts.syntheticCamera ? Math.max(480, this.dim) : this.dim;
  }

  private random(): number {
    this.rand = (Math.imul(this.rand, 1103515245) + 12345) >>> 0;
    return this.rand / 4294967296;
  }

  async next(): Promise<LoopbackFrame> {
    this.frameCounter++;
    let pkt = await this.carousel.nextPacket();
    if (this.opts.skipOnePacketForXorDemo && !this.skipped && pkt.packetType === PacketType.DATA && this.frameCounter > 2) {
      this.skipped = true;
      pkt = await this.carousel.nextPacket();
    }
    const dim = this.getDimension();
    if (this.opts.simulatedDropProbability > 0 && this.random() < this.opts.simulatedDropProbability) {
      return { data: new Uint8ClampedArray(dim * dim * 4), width: dim, height: dim, dropped: true, corrupted: false, packetIndex: pkt.packetIndex, loopCycle: pkt.loopCycle };
    }
    const matrix = encodePacketToMatrix(pkt.rawBytes, this.gridSize);
    const corrupted = this.opts.corruptEveryNthFrame > 0 && this.frameCounter % this.opts.corruptEveryNthFrame === 0;
    if (corrupted) {
      const plan = getGridLayoutPlan(this.gridSize);
      for (const k of [220, 228, 236]) matrix.cells[plan.dataCellIndices[k % plan.dataCellIndices.length]] ^= 1;
    }
    if (this.opts.syntheticCamera) {
      const f = renderSyntheticCameraFrame(matrix, {
        width: dim,
        height: dim,
        matrixSidePx: dim * 0.8,
        rotationDeg: 4,
        perspectiveTilt: 0.06,
        noiseAmplitude: 5,
        seed: this.frameCounter,
      });
      return { data: f.data, width: dim, height: dim, dropped: false, corrupted, packetIndex: pkt.packetIndex, loopCycle: pkt.loopCycle };
    }
    // renderMatrixToImageData reuses its buffer: copy so the frame can be transferred to a worker
    const r = renderMatrixToImageData(matrix, dim, dim, 2);
    return { data: new Uint8ClampedArray(r.data), width: dim, height: dim, dropped: false, corrupted, packetIndex: pkt.packetIndex, loopCycle: pkt.loopCycle };
  }
}
