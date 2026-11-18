import type { DropFlashPacket } from './packetProtocol';
import { DecodeHint, OpticalDecodeResult, OpticalFrameDecoder, QuadCorners } from './opticalDecoder';
import { describeCameraError, LoopbackFrame, OpticalLoopbackFeed, openCameraStream } from './cameraCapture';
import type { DecodeRequest, DecodeResponse } from '../workers/decoderProtocol';

export type ScanSource = 'camera' | 'loopback';

export interface ScanTelemetry {
  source: ScanSource | 'idle';
  running: boolean;
  /** New frames offered per second (camera frames presented, or loopback frames generated). */
  inputFps: number;
  /** Frames actually decoded per second (≤ inputFps; the rest were skipped while busy). */
  processedFps: number;
  /** CRC-valid packets per second. */
  validFps: number;
  framesProcessed: number;
  framesSkippedBusy: number;
  validPackets: number;
  crcErrors: number;
  noSync: number;
  simulatedDrops: number;
  avgDecodeMs: number;
  syncQuality: number;
  threshold: number;
  hint: DecodeHint | 'idle' | 'searching' | 'tracking';
  /** Encoding of the most recent decoded frame. */
  frameMode: 'mono' | 'gray4' | null;
  grayPackets: number;
  monoPackets: number;
  correctedCells: number;
  locator: string;
  gridSize: number | null;
  modulePx: number;
  processingSize: { w: number; h: number } | null;
  videoSize: { w: number; h: number } | null;
  workerRestarts: number;
  /** Where frames are decoded. 'main' = worker unavailable/failed (e.g. offline load failure). */
  decoderThread: 'worker' | 'main' | 'none';
}

export interface CameraControls {
  zoom: { min: number; max: number; step: number; value: number } | null;
  torch: boolean;
  torchOn: boolean;
  tapToFocus: boolean;
  /** Manual short exposure supported (freezes hand motion; screens are bright enough). */
  shortExposure: boolean;
  shortExposureOn: boolean;
}

export interface ScanSessionCallbacks {
  onPacket: (packet: DropFlashPacket) => void;
  onTelemetry: (t: ScanTelemetry) => void;
  /** Latest decode result with the processing frame size (for overlays). */
  onResult?: (r: OpticalDecodeResult, procWidth: number, procHeight: number) => void;
  /** Loopback frame about to be decoded (for preview). */
  onLoopbackFrame?: (frame: LoopbackFrame) => void;
  onError: (message: string) => void;
}

export interface ScanSessionConfig {
  getExpectedGridSize: () => number | undefined;
  /** Manual corners in normalised [0,1] frame coordinates, or null for automatic localisation. */
  getManualCorners: () => QuadCorners | null;
  /** Longest side of the frame given to the decoder (larger = finer modules, slower). */
  maxProcessLongSide?: number;
  workerFactory?: () => Worker;
  /** A decode taking longer than this is treated as hung and the worker is restarted. */
  decodeTimeoutMs?: number;
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const MAX_WORKER_RESTARTS = 3;

function emptyTelemetry(): ScanTelemetry {
  return {
    source: 'idle',
    running: false,
    inputFps: 0,
    processedFps: 0,
    validFps: 0,
    framesProcessed: 0,
    framesSkippedBusy: 0,
    validPackets: 0,
    crcErrors: 0,
    noSync: 0,
    simulatedDrops: 0,
    avgDecodeMs: 0,
    syncQuality: 0,
    threshold: 0,
    hint: 'idle',
    locator: 'none',
    gridSize: null,
    modulePx: 0,
    processingSize: null,
    videoSize: null,
    workerRestarts: 0,
    frameMode: null,
    grayPackets: 0,
    monoPackets: 0,
    correctedCells: 0,
    decoderThread: 'none',
  };
}

/** A valid packet within this window keeps the status at "receiving"/"tracking" (no flicker). */
const HINT_HOLD_MS = 1500;

/**
 * Framework-agnostic scanning loop.
 *
 * - Camera frames are pulled with requestVideoFrameCallback (one callback per NEW camera frame;
 *   requestAnimationFrame + currentTime polling as fallback) so duplicate frames are not counted.
 * - At most ONE frame is in flight to the decode worker; frames arriving meanwhile are skipped and
 *   counted (bounded memory, no unbounded queue).
 * - A decode that does not return within `decodeTimeoutMs` restarts the worker (max 3 times).
 */
export class ScanSession {
  private readonly cb: ScanSessionCallbacks;
  private readonly cfg: Required<Omit<ScanSessionConfig, 'workerFactory'>> & { workerFactory?: () => Worker };
  private worker: Worker | null = null;
  private fallbackDecoder: OpticalFrameDecoder | null = null;
  private useBitmaps = typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
  private stream: MediaStream | null = null;
  private video: VideoWithRvfc | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCtx: CanvasRenderingContext2D | null = null;
  private running = false;
  private inFlight = false;
  private inFlightTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private pendingId = 0;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private lastVideoTime = -1;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private t: ScanTelemetry = emptyTelemetry();
  private window = { start: 0, input: 0, processed: 0, valid: 0, decodeMs: 0 };
  private loopbackFeed: OpticalLoopbackFeed | null = null;
  private loopbackUnpaced = false;
  private lastValidAt = -Infinity;
  /** Set once the worker has answered at least once; a failure before that means it never loaded. */
  private workerAnswered = false;

  constructor(callbacks: ScanSessionCallbacks, config: ScanSessionConfig) {
    this.cb = callbacks;
    this.cfg = {
      getExpectedGridSize: config.getExpectedGridSize,
      getManualCorners: config.getManualCorners,
      maxProcessLongSide: config.maxProcessLongSide ?? 1600,
      decodeTimeoutMs: config.decodeTimeoutMs ?? 2500,
      workerFactory: config.workerFactory,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  getTelemetry(): ScanTelemetry {
    return { ...this.t };
  }

  // ------------------------------------------------------------------ worker management

  private ensureWorker(): void {
    if (this.worker || this.fallbackDecoder) return;
    if (this.cfg.workerFactory && typeof Worker !== 'undefined') {
      try {
        this.worker = this.cfg.workerFactory();
        this.worker.onmessage = (e: MessageEvent<DecodeResponse>) => this.onWorkerMessage(e.data);
        this.worker.onerror = (e) => {
          e.preventDefault?.();
          // A worker that never answered failed to LOAD (typically offline with a stale cache, or a
          // browser without module workers). Retrying cannot help: decode on the main thread at once.
          if (!this.workerAnswered) this.switchToMainThread();
          else this.restartWorker(`Decoder worker error: ${e.message || 'unknown'}`);
        };
        this.worker.onmessageerror = () => this.switchToMainThread();
        this.t.decoderThread = 'worker';
        return;
      } catch {
        this.worker = null;
      }
    }
    // No worker support: decode on the main thread (slower, still bounded to one frame at a time)
    this.fallbackDecoder = new OpticalFrameDecoder();
    this.useBitmaps = false;
    this.t.decoderThread = 'main';
  }

  /** Permanently move decoding to the main thread; scanning keeps running (no network needed). */
  private switchToMainThread(): void {
    this.clearInFlight();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.fallbackDecoder = new OpticalFrameDecoder();
    this.useBitmaps = false;
    this.t.decoderThread = 'main';
    if (this.running) this.continueLoopback();
  }

  private restartWorker(reason: string): void {
    this.clearInFlight();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.t.workerRestarts++;
    if (this.t.workerRestarts > MAX_WORKER_RESTARTS) {
      // Bounded: after 3 restarts stop using the worker, but keep scanning on the main thread.
      console.warn(`${reason}. Worker restarted ${MAX_WORKER_RESTARTS} times; decoding on the main thread.`);
      this.switchToMainThread();
      return;
    }
    if (this.running) {
      this.ensureWorker();
      this.continueLoopback();
    }
  }

  private clearInFlight(): void {
    this.inFlight = false;
    this.pendingId = 0;
    if (this.inFlightTimer) {
      clearTimeout(this.inFlightTimer);
      this.inFlightTimer = null;
    }
  }

  private submit(req: Extract<DecodeRequest, { type: 'decode' }>, transfer: Transferable[]): void {
    this.inFlight = true;
    this.pendingId = req.id;
    if (this.fallbackDecoder) {
      const t0 = performance.now();
      const rgba = new Uint8ClampedArray(req.buffer!);
      const corners = req.customCornersNormalized;
      const scaled = corners
        ? {
            topLeft: { x: corners.topLeft.x * req.width, y: corners.topLeft.y * req.height },
            topRight: { x: corners.topRight.x * req.width, y: corners.topRight.y * req.height },
            bottomLeft: { x: corners.bottomLeft.x * req.width, y: corners.bottomLeft.y * req.height },
            bottomRight: { x: corners.bottomRight.x * req.width, y: corners.bottomRight.y * req.height },
          }
        : null;
      const result = this.fallbackDecoder.decodeRgba(rgba, req.width, req.height, {
        expectedGridSize: req.expectedGridSize,
        customCorners: scaled,
      });
      const resp: DecodeResponse = { type: 'result', id: req.id, result, decodeMs: performance.now() - t0, procWidth: req.width, procHeight: req.height };
      // Yield before handling so the UI can paint between main-thread decodes
      setTimeout(() => this.onWorkerMessage(resp), 0);
      return;
    }
    this.worker!.postMessage(req, transfer);
    this.inFlightTimer = setTimeout(() => this.restartWorker('Decoder did not respond in time'), this.cfg.decodeTimeoutMs);
  }

  private onWorkerMessage(msg: DecodeResponse): void {
    if (msg.id !== this.pendingId) return; // stale (after restart/stop)
    if (!this.fallbackDecoder) this.workerAnswered = true;
    this.clearInFlight();
    if (!this.running) return;
    if (msg.type === 'error') {
      if (this.useBitmaps && /OffscreenCanvas/i.test(msg.message)) {
        this.useBitmaps = false; // fall back to main-thread pixel readback
      } else {
        this.cb.onError(`Decoder error: ${msg.message}`);
      }
      this.continueLoopback();
      return;
    }
    const r = msg.result;
    this.t.framesProcessed++;
    this.window.processed++;
    this.window.decodeMs += msg.decodeMs;
    this.t.syncQuality = r.syncQuality;
    this.t.threshold = r.thresholdUsed;
    const now = performance.now();
    if (r.status === 'valid') {
      this.lastValidAt = now;
      this.t.hint = 'ok';
    } else if (now - this.lastValidAt < HINT_HOLD_MS) {
      // Brief losses while the hand moves are normal: keep showing tracking, not an error.
      this.t.hint = r.syncQuality >= 0.6 || r.locator === 'tracked' ? 'ok' : 'tracking';
    } else {
      this.t.hint = r.hint;
    }
    this.t.locator = r.locator;
    this.t.gridSize = r.gridSizeUsed ?? null;
    this.t.modulePx = r.modulePx;
    this.t.processingSize = { w: msg.procWidth, h: msg.procHeight };
    if (r.status === 'valid' && r.packet) {
      const packets = r.packets && r.packets.length ? r.packets : [r.packet];
      this.t.frameMode = r.mode ?? 'mono';
      this.t.correctedCells += r.correctedCells ?? 0;
      for (const p of packets) {
        this.t.validPackets++;
        this.window.valid++;
        if (r.mode === 'gray4') this.t.grayPackets++;
        else this.t.monoPackets++;
        this.cb.onPacket(p);
      }
    } else if (r.status === 'crc_error') {
      this.t.crcErrors++;
    } else {
      this.t.noSync++;
    }
    this.cb.onResult?.(r, msg.procWidth, msg.procHeight);
    this.continueLoopback();
  }

  // ------------------------------------------------------------------ telemetry

  private startTelemetry(source: ScanSource): void {
    this.t = { ...emptyTelemetry(), source, running: true, hint: 'searching', workerRestarts: this.t.workerRestarts, decoderThread: this.t.decoderThread };
    this.window = { start: performance.now(), input: 0, processed: 0, valid: 0, decodeMs: 0 };
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = setInterval(() => this.flushTelemetry(), 500);
  }

  private flushTelemetry(): void {
    const now = performance.now();
    const sec = Math.max(0.001, (now - this.window.start) / 1000);
    this.t.inputFps = this.window.input / sec;
    this.t.processedFps = this.window.processed / sec;
    this.t.validFps = this.window.valid / sec;
    this.t.avgDecodeMs = this.window.processed ? this.window.decodeMs / this.window.processed : this.t.avgDecodeMs;
    this.window = { start: now, input: 0, processed: 0, valid: 0, decodeMs: 0 };
    this.cb.onTelemetry({ ...this.t });
  }

  // ------------------------------------------------------------------ camera

  async startCamera(video: HTMLVideoElement, deviceId: string | undefined, targetFps: number): Promise<void> {
    this.stop();
    try {
      const stream = await openCameraStream(deviceId, targetFps);
      this.stream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
    } catch (e) {
      this.stop();
      throw new Error(describeCameraError(e));
    }
    this.video = video as VideoWithRvfc;
    this.ensureWorker();
    this.running = true;
    this.startTelemetry('camera');
    this.scheduleCameraFrame();
  }

  private scheduleCameraFrame(): void {
    const v = this.video;
    if (!this.running || !v) return;
    if (typeof v.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = v.requestVideoFrameCallback(() => this.onCameraFrame(true));
    } else {
      this.rafHandle = requestAnimationFrame(() => this.onCameraFrame(false));
    }
  }

  private onCameraFrame(isNewFrame: boolean): void {
    const v = this.video;
    if (!this.running || !v) return;
    this.scheduleCameraFrame();
    if (!isNewFrame) {
      if (v.currentTime === this.lastVideoTime) return; // rAF fallback: same camera frame
      this.lastVideoTime = v.currentTime;
    }
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
    this.window.input++;
    if (this.inFlight) {
      this.t.framesSkippedBusy++;
      return;
    }
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    this.t.videoSize = { w: vw, h: vh };
    const scale = Math.min(1, this.cfg.maxProcessLongSide / Math.max(vw, vh));
    const pw = Math.max(1, Math.round(vw * scale));
    const ph = Math.max(1, Math.round(vh * scale));
    const id = this.nextId++;
    const base = {
      type: 'decode' as const,
      id,
      width: pw,
      height: ph,
      procWidth: pw,
      procHeight: ph,
      expectedGridSize: this.cfg.getExpectedGridSize(),
      customCornersNormalized: this.cfg.getManualCorners(),
    };
    if (this.useBitmaps && this.worker) {
      this.inFlight = true; // reserve the slot while the bitmap is created
      this.pendingId = id;
      createImageBitmap(v)
        .then((bitmap) => {
          if (!this.running || this.pendingId !== id) {
            bitmap.close();
            return;
          }
          this.submit({ ...base, bitmap }, [bitmap]);
        })
        .catch(() => {
          this.clearInFlight();
          this.useBitmaps = false;
        });
      return;
    }
    if (!this.captureCanvas) {
      this.captureCanvas = document.createElement('canvas');
    }
    if (this.captureCanvas.width !== pw || this.captureCanvas.height !== ph) {
      this.captureCanvas.width = pw;
      this.captureCanvas.height = ph;
      this.captureCtx = this.captureCanvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.captureCtx ?? this.captureCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      this.cb.onError('Canvas 2D is unavailable; cannot read camera frames.');
      this.stop();
      return;
    }
    this.captureCtx = ctx;
    ctx.drawImage(v, 0, 0, pw, ph);
    const img = ctx.getImageData(0, 0, pw, ph);
    this.submit({ ...base, buffer: img.data.buffer as ArrayBuffer }, [img.data.buffer as ArrayBuffer]);
  }

  // ------------------------------------------------------------------ camera controls

  private track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /** Zoom / torch / focus support of the active camera (non-standard constraints; feature-detected). */
  getCameraControls(): CameraControls {
    const track = this.track();
    const caps = (track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as Record<string, unknown>;
    const settings = (track ? track.getSettings() : {}) as Record<string, unknown>;
    const zoom = caps.zoom as { min: number; max: number; step?: number } | undefined;
    const focusModes = (caps.focusMode as string[] | undefined) ?? [];
    return {
      zoom: zoom && zoom.max > zoom.min ? { min: zoom.min, max: zoom.max, step: zoom.step || 0.1, value: Number(settings.zoom ?? zoom.min) } : null,
      torch: caps.torch === true,
      torchOn: settings.torch === true,
      tapToFocus: focusModes.includes('single-shot') || focusModes.includes('manual') || 'pointsOfInterest' in caps,
      shortExposure: Boolean(caps.exposureTime) && ((caps.exposureMode as string[] | undefined) ?? []).includes('manual'),
      shortExposureOn: settings.exposureMode === 'manual',
    };
  }

  async setZoom(value: number): Promise<void> {
    await this.track()?.applyConstraints({ advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet] });
  }

  /**
   * Short exposure (~2 ms) freezes hand movement: at 30 fps an auto exposure of 15–30 ms smears
   * cells by several pixels when the phone moves. Exposure time is in 100 µs units (Image Capture).
   */
  async setShortExposure(on: boolean): Promise<void> {
    const t = this.track();
    if (!t) return;
    if (!on) {
      await t.applyConstraints({ advanced: [{ exposureMode: 'continuous' } as unknown as MediaTrackConstraintSet] });
      return;
    }
    const caps = t.getCapabilities() as Record<string, unknown>;
    const range = caps.exposureTime as { min: number; max: number } | undefined;
    if (!range) return;
    const target = Math.min(range.max, Math.max(range.min, 20));
    await t.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: target } as unknown as MediaTrackConstraintSet] });
  }

  async setTorch(on: boolean): Promise<void> {
    await this.track()?.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] });
  }

  /** Focus on a point (normalised 0..1). Falls back to re-triggering autofocus. Best effort. */
  async focusAt(x: number, y: number): Promise<void> {
    const t = this.track();
    if (!t) return;
    const attempts: MediaTrackConstraintSet[] = [
      { pointsOfInterest: [{ x, y }], focusMode: 'single-shot' } as unknown as MediaTrackConstraintSet,
      { focusMode: 'single-shot' } as unknown as MediaTrackConstraintSet,
      { focusMode: 'continuous' } as unknown as MediaTrackConstraintSet,
    ];
    for (const a of attempts) {
      try {
        await t.applyConstraints({ advanced: [a] });
        return;
      } catch {
        // try the next, more widely supported form
      }
    }
  }

  // ------------------------------------------------------------------ loopback

  /**
   * Software loopback (no camera). `unpaced` decodes frames back-to-back to measure decoder
   * throughput; otherwise frames are paced by requestAnimationFrame.
   */
  startLoopback(feed: OpticalLoopbackFeed, unpaced = false): void {
    this.stop();
    this.loopbackFeed = feed;
    this.loopbackUnpaced = unpaced;
    this.ensureWorker();
    this.running = true;
    this.startTelemetry('loopback');
    this.pumpLoopback();
  }

  private continueLoopback(): void {
    if (!this.running || !this.loopbackFeed) return;
    if (this.loopbackUnpaced) this.pumpLoopback();
  }

  private pumpLoopback(): void {
    if (!this.running || !this.loopbackFeed) return;
    if (!this.loopbackUnpaced) {
      this.rafHandle = requestAnimationFrame(() => {
        this.pumpLoopback();
      });
    }
    if (this.inFlight) {
      this.t.framesSkippedBusy++;
      return;
    }
    const feed = this.loopbackFeed;
    this.inFlight = true;
    const id = this.nextId++;
    this.pendingId = id;
    void feed
      .next()
      .then((frame) => {
        if (!this.running || this.pendingId !== id) return;
        this.window.input++;
        if (frame.dropped) {
          this.t.simulatedDrops++;
          this.clearInFlight();
          this.continueLoopback();
          return;
        }
        this.cb.onLoopbackFrame?.(frame);
        this.submit(
          {
            type: 'decode',
            id,
            buffer: frame.data.buffer as ArrayBuffer,
            width: frame.width,
            height: frame.height,
            procWidth: frame.width,
            procHeight: frame.height,
            expectedGridSize: this.cfg.getExpectedGridSize(),
            customCornersNormalized: this.cfg.getManualCorners(),
          },
          [frame.data.buffer as ArrayBuffer]
        );
      })
      .catch((e: unknown) => {
        this.clearInFlight();
        this.cb.onError(e instanceof Error ? e.message : String(e));
        this.stop();
      });
  }

  // ------------------------------------------------------------------ lifecycle

  /** Clears decoder tracking / de-tear state (e.g. when a new transfer starts). */
  resetDecoder(): void {
    this.worker?.postMessage({ type: 'reset' } satisfies DecodeRequest);
    this.fallbackDecoder?.reset();
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.clearInFlight();
    if (this.rvfcHandle !== null && this.video?.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.rvfcHandle);
    this.rvfcHandle = null;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    if (this.stream) {
      this.stream.getTracks().forEach((tr) => tr.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.loopbackFeed = null;
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    if (wasRunning) {
      this.t = { ...this.t, running: false, source: 'idle', inputFps: 0, processedFps: 0, validFps: 0, hint: 'idle' };
      this.cb.onTelemetry({ ...this.t });
    }
  }

  /** Stops scanning and terminates the worker. */
  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }
}
