import React, { useCallback, useEffect, useRef, useState } from 'react';
import { OpticalLoopbackFeed } from '../engine/cameraCapture';
import type { OpticalDecodeResult, QuadCorners } from '../engine/opticalDecoder';
import { StreamingFileCarousel } from '../engine/fileChunker';
import { IncrementalFileReconstructor, ReconstructorState } from '../engine/fileReconstructor';
import { CameraControls, ScanSession, ScanTelemetry } from '../engine/scanSession';
import { CheckCircle2, Download, X } from 'lucide-react';
import type { LoopbackFrame } from '../engine/cameraCapture';
import { createSampleDiagnosticFile, LocalReturnChannel, TransferSettings } from '../engine/transferManager';
import { listTransferMetadata, StoredTransferRecord } from '../storage/indexedDB';
import { formatBytes } from '../utils/integrity';
import { requestScreenWakeLock } from '../utils/browserSupport';
import { sanitizeDownloadName } from '../utils/fileNames';
import { CameraPreview } from './CameraPreview';
import { TransferProgress } from './TransferProgress';

interface ReceiverProps {
  settings: TransferSettings;
  autoStartLoopback?: boolean;
  onAutoStartConsumed?: () => void;
}

export type ReceiverMode = 'idle' | 'camera' | 'loopback' | 'benchmark';

const DEFAULT_CORNERS: QuadCorners = {
  topLeft: { x: 0.2, y: 0.15 },
  topRight: { x: 0.8, y: 0.15 },
  bottomLeft: { x: 0.2, y: 0.85 },
  bottomRight: { x: 0.8, y: 0.85 },
};

const IDLE_TELEMETRY: ScanTelemetry = {
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

function createDecoderWorker(): Worker {
  return new Worker(new URL('../workers/decoder.worker.ts', import.meta.url), { type: 'module' });
}

export const Receiver: React.FC<ReceiverProps> = ({ settings, autoStartLoopback, onAutoStartConsumed }) => {
  const reconstructorRef = useRef<IncrementalFileReconstructor>(new IncrementalFileReconstructor());
  const [recState, setRecState] = useState<ReconstructorState>(() => reconstructorRef.current.getState());
  const [telemetry, setTelemetry] = useState<ScanTelemetry>(IDLE_TELEMETRY);
  const [mode, setMode] = useState<ReceiverMode>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCalibration, setManualCalibration] = useState(false);
  const [corners, setCorners] = useState<QuadCorners>(DEFAULT_CORNERS);
  const [history, setHistory] = useState<StoredTransferRecord[]>([]);
  const [controls, setControls] = useState<CameraControls | null>(null);
  const [missing, setMissing] = useState<{ ranges: Array<[number, number]>; awaitingParity: number }>({ ranges: [], awaitingParity: 0 });
  const [showDone, setShowDone] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<ScanSession | null>(null);
  const returnChannelRef = useRef<LocalReturnChannel | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const manualRef = useRef<boolean>(false);
  const cornersRef = useRef<QuadCorners>(DEFAULT_CORNERS);
  const settingsRef = useRef<TransferSettings>(settings);
  const modeRef = useRef<ReceiverMode>('idle');
  const lastStatePush = useRef(0);
  const overlayPending = useRef<{ r: OpticalDecodeResult; w: number; h: number } | null>(null);
  const loopbackFramePending = useRef<LoopbackFrame | null>(null);
  const drawScheduled = useRef(false);
  const lowContrastSince = useRef<number | null>(null);

  // Keep refs in sync so the scanning loop always reads current values (no stale closures).
  manualRef.current = manualCalibration;
  cornersRef.current = corners;
  settingsRef.current = settings;
  modeRef.current = mode;

  const refreshHistory = useCallback(async () => {
    setHistory((await listTransferMetadata()).slice(0, 5));
  }, []);

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
    }
  };

  const stopScanner = useCallback(() => {
    sessionRef.current?.stop();
    setControls(null);
    releaseWakeLock();
    setMode('idle');
  }, []);

  const drawOverlay = useCallback(() => {
    drawScheduled.current = false;
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const frame = loopbackFramePending.current;
    if (frame) {
      loopbackFramePending.current = null;
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    } else if (modeRef.current === 'camera') {
      const v = videoRef.current;
      if (v && v.videoWidth && (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight)) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    const pending = overlayPending.current;
    const quad = manualRef.current
      ? cornersRef.current
      : pending?.r.detectedBounds
        ? {
            topLeft: { x: pending.r.detectedBounds.topLeft.x / pending.w, y: pending.r.detectedBounds.topLeft.y / pending.h },
            topRight: { x: pending.r.detectedBounds.topRight.x / pending.w, y: pending.r.detectedBounds.topRight.y / pending.h },
            bottomLeft: { x: pending.r.detectedBounds.bottomLeft.x / pending.w, y: pending.r.detectedBounds.bottomLeft.y / pending.h },
            bottomRight: { x: pending.r.detectedBounds.bottomRight.x / pending.w, y: pending.r.detectedBounds.bottomRight.y / pending.h },
          }
        : null;
    if (quad) {
      const W = canvas.width;
      const H = canvas.height;
      ctx.save();
      ctx.lineWidth = Math.max(2, W / 300);
      ctx.strokeStyle = manualRef.current ? '#F59E0B' : pending?.r.status === 'valid' ? '#22C55E' : pending && pending.r.syncQuality >= 0.8 ? '#38BDF8' : '#F59E0B';
      ctx.beginPath();
      ctx.moveTo(quad.topLeft.x * W, quad.topLeft.y * H);
      ctx.lineTo(quad.topRight.x * W, quad.topRight.y * H);
      ctx.lineTo(quad.bottomRight.x * W, quad.bottomRight.y * H);
      ctx.lineTo(quad.bottomLeft.x * W, quad.bottomLeft.y * H);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (drawScheduled.current) return;
    drawScheduled.current = true;
    requestAnimationFrame(drawOverlay);
  }, [drawOverlay]);

  const handleState = useCallback(
    (state: ReconstructorState, force = false) => {
      const now = performance.now();
      if (force || state.status !== 'receiving' || now - lastStatePush.current > 200) {
        lastStatePush.current = now;
        setRecState(state);
        setMissing(reconstructorRef.current.getMissingSummary());
      }
      if (state.status === 'completed' && state.manifest && state.computedSha256) {
        returnChannelRef.current?.emitCompletionSignal(state.manifest.transferId, state.computedSha256, settingsRef.current.returnChannelMode);
        setShowDone(true);
        stopScanner();
        void refreshHistory();
      } else if (state.status === 'integrity_error' || state.status === 'storage_error') {
        stopScanner();
        void refreshHistory();
      }
    },
    [refreshHistory, stopScanner]
  );

  // Created lazily (and re-created after disposal, e.g. React StrictMode remounts)
  const getSession = (): ScanSession => {
    if (sessionRef.current) return sessionRef.current;
    sessionRef.current = new ScanSession(
      {
        onPacket: (packet) => {
          void reconstructorRef.current.ingestPacket(packet).then((s) => handleState(s));
        },
        onTelemetry: (t) => {
          setTelemetry(t);
          // If short exposure makes the image too dark to read for 2 s, return to auto exposure.
          const s = sessionRef.current;
          if (t.hint === 'low_contrast' && s?.getCameraControls().shortExposureOn) {
            const now = performance.now();
            if (lowContrastSince.current === null) lowContrastSince.current = now;
            else if (now - lowContrastSince.current > 2000) {
              lowContrastSince.current = null;
              void s.setShortExposure(false).then(() => setControls(s.getCameraControls()));
            }
          } else lowContrastSince.current = null;
        },
        onResult: (r, w, h) => {
          overlayPending.current = { r, w, h };
          scheduleDraw();
        },
        onLoopbackFrame: (frame) => {
          // Copy: the frame buffer is transferred to the worker right after this callback
          loopbackFramePending.current = { ...frame, data: new Uint8ClampedArray(frame.data) };
          scheduleDraw();
        },
        onError: (message) => {
          setCameraError(message);
          releaseWakeLock();
          setMode('idle');
        },
      },
      {
        getExpectedGridSize: () => reconstructorRef.current.getState().manifest?.gridSize ?? settingsRef.current.gridSize,
        getManualCorners: () => (manualRef.current ? cornersRef.current : null),
        maxProcessLongSide: settingsRef.current.processingResolution,
        workerFactory: createDecoderWorker,
      }
    );
    return sessionRef.current;
  };

  useEffect(() => {
    void refreshHistory();
    returnChannelRef.current = new LocalReturnChannel();
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      returnChannelRef.current?.close();
      releaseWakeLock();
    };
  }, [refreshHistory]);

  // A new processing resolution takes effect with a fresh session
  useEffect(() => {
    if (sessionRef.current && !sessionRef.current.isRunning()) {
      sessionRef.current.dispose();
      sessionRef.current = null;
    }
  }, [settings.processingResolution]);

  useEffect(() => {
    if (manualCalibration) scheduleDraw();
  }, [manualCalibration, corners, scheduleDraw]);

  const beginNewTransfer = (preserve: boolean) => {
    reconstructorRef.current.reset(preserve);
    if (!preserve) getSession().resetDecoder();
    handleState(reconstructorRef.current.getState(), true);
    setMissing(reconstructorRef.current.getMissingSummary());
  };

  const startCameraScan = async (preserve = false) => {
    setCameraError(null);
    beginNewTransfer(preserve);
    const video = videoRef.current;
    const session = getSession();
    if (!video) return;
    setMode('camera');
    try {
      await session.startCamera(video, settings.selectedCameraId || undefined, 60); // higher capture rate = more chances per sender frame
      // Capabilities become available once the track is live. Short exposure is enabled
      // automatically where supported (sharper frames while the hand moves).
      setTimeout(() => {
        const c = getSession().getCameraControls();
        setControls(c);
        if (c.shortExposure && !c.shortExposureOn) {
          lowContrastSince.current = null;
          void getSession()
            .setShortExposure(true)
            .then(() => setControls(getSession().getCameraControls()))
            .catch(() => undefined);
        }
      }, 400);
      wakeLockRef.current = await requestScreenWakeLock();
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
      setMode('idle');
    }
  };

  const startLoopback = async (benchmark: boolean) => {
    setCameraError(null);
    beginNewTransfer(false);
    const gridSize = benchmark ? 384 : settings.gridSize <= 128 ? settings.gridSize : 64;
    const sample = createSampleDiagnosticFile(benchmark ? 720 * 1024 : 16 * 1024, benchmark ? 'decoder-benchmark-720kb.txt' : 'loopback-sample.txt');
    const carousel = new StreamingFileCarousel(sample, sample.name, sample.type, {
      gridSize,
      erasureBlockSize: settings.erasureBlockSize || 4,
      manifestIntervalFrames: 6,
      startPacketOffset: 8,
    });
    try {
      await carousel.prepare();
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
      return;
    }
    const feed = new OpticalLoopbackFeed(carousel, gridSize, {
      canvasDimension: benchmark ? 776 : 480,
      skipOnePacketForXorDemo: !benchmark,
    });
    setMode(benchmark ? 'benchmark' : 'loopback');
    getSession().startLoopback(feed, benchmark);
  };

  // Opening Receive starts scanning immediately — no extra confirmation step.
  useEffect(() => {
    if (autoStartLoopback) {
      onAutoStartConsumed?.();
      void startLoopback(false);
    } else {
      void startCameraScan(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartLoopback]);

  const handleDownloadFile = () => {
    const { downloadBlob, manifest } = recState;
    if (!downloadBlob || !manifest) return;
    const url = URL.createObjectURL(downloadBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeDownloadName(manifest.fileName);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleReset = () => {
    stopScanner();
    beginNewTransfer(false);
  };

  const handleSwitchTransfer = () => {
    const wasScanning = mode === 'camera';
    beginNewTransfer(false);
    if (!wasScanning) void startCameraScan(false);
  };

  const doneModal =
    showDone && recState.status === 'completed' && recState.manifest ? (
      <div role="dialog" aria-modal="true" aria-labelledby="done-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-[#0B101B] p-6 shadow-2xl flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <CheckCircle2 className="w-10 h-10 text-emerald-400" />
            <button type="button" aria-label="Close" onClick={() => setShowDone(false)} className="text-slate-400 hover:text-slate-200">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div>
            <h2 id="done-title" className="text-lg font-semibold text-slate-100">File received and verified</h2>
            <p className="text-sm text-slate-300 mt-1 break-all">{recState.manifest.fileName}</p>
            <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
              {formatBytes(recState.manifest.fileSize)} · {recState.parityRecoveredPackets} packets rebuilt from parity · {recState.duplicatePackets} duplicates skipped
            </p>
            <p className="text-[11px] text-slate-500 mt-2">SHA-256 matches the sender. Only open files from senders you trust.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={handleDownloadFile} className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white">
              <Download className="w-4 h-4" />
              Save file
            </button>
            <button
              type="button"
              onClick={() => {
                setShowDone(false);
                handleReset();
                void startCameraScan(false);
              }}
              className="px-4 py-3 rounded-xl text-sm border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            >
              Receive another
            </button>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      {doneModal}
      <div className="grid grid-cols-1 gap-6 items-start">
        <div>
          <CameraPreview
            videoRef={videoRef}
            overlayRef={overlayRef}
            mode={mode}
            telemetry={telemetry}
            state={recState}
            missing={missing}
            controls={controls}
            onZoom={(v) => void getSession().setZoom(v).catch(() => undefined)}
            onTorch={(on) =>
              void getSession()
                .setTorch(on)
                .then(() => setControls(getSession().getCameraControls()))
                .catch(() => undefined)
            }
            onFocusAt={(x, y) => void getSession().focusAt(x, y)}
            onShortExposure={(on) =>
              void getSession()
                .setShortExposure(on)
                .then(() => setControls(getSession().getCameraControls()))
                .catch(() => undefined)
            }
            cameraError={cameraError}
            manualCalibration={manualCalibration}
            corners={corners}
            onToggleManualCalibration={() => setManualCalibration((p) => !p)}
            onUpdateCorner={(corner, axis, value) =>
              setCorners((prev) => ({ ...prev, [corner]: { ...prev[corner], [axis]: value } }))
            }
            onStartCameraScan={() => void startCameraScan(recState.status === 'receiving')}
            onStartLoopback={() => void startLoopback(false)}
            onStartBenchmark={() => void startLoopback(true)}
            onStopScan={stopScanner}
          />
        </div>

        <div className="flex flex-col gap-6">
          <TransferProgress
            state={recState}
            telemetry={telemetry}
            mode={mode}
            onDownload={handleDownloadFile}
            onContinueScanning={() => void startCameraScan(true)}
            onReset={handleReset}
            onSwitchTransfer={handleSwitchTransfer}
          />

          {history.length > 0 && (
            <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-5">
              <h4 className="text-xs font-semibold text-slate-300 mb-3">Recent transfers on this device</h4>
              <div className="divide-y divide-slate-800/80 text-xs font-mono tabular-nums">
                {history.map((item) => (
                  <div key={item.transferId} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-slate-200 min-w-0">
                      <span className="font-sans font-medium truncate max-w-[16rem]">{item.fileName}</span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-400">{formatBytes(item.fileSize)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-400">
                      <span>
                        {item.receivedCount}/{item.totalSourcePackets} pkts
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className={item.verified ? 'text-emerald-400' : item.completed ? 'text-rose-400' : 'text-amber-400'}>
                        {item.verified ? 'SHA-256 verified' : item.completed ? 'Failed verification' : 'Incomplete'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                Only metadata is kept. Received files must be saved with the download button; incomplete transfers cannot be resumed after reloading the page.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
