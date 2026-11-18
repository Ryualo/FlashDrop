import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, Play, Trash2 } from 'lucide-react';
import { auditGridCapacity } from '../engine/capacityAudit';
import { PacketType, TransferManifest } from '../engine/packetProtocol';
import { encodeFrameToMatrix, OpticalMatrixFrame, renderMatrixToCanvas } from '../engine/opticalEncoder';
import { StreamingFileCarousel } from '../engine/fileChunker';
import {
  frameModeFor,
  GRID_RESOLUTIONS,
  SPEED_PRESETS,
  TRANSMISSION_MODES,
  LocalReturnChannel,
  SenderTelemetry,
  TARGET_FPS_OPTIONS,
  TransferSettings,
} from '../engine/transferManager';
import { formatBytes, formatSpeed } from '../utils/integrity';
import { requestScreenWakeLock } from '../utils/browserSupport';
import { TransmissionDisplay } from './TransmissionDisplay';

interface SenderProps {
  settings: TransferSettings;
  onUpdateSettings: (partial: Partial<TransferSettings>) => void;
}

interface PreparedFrame {
  packetType: PacketType;
  packetIndex: number;
  loopCycle: number;
  matrix: OpticalMatrixFrame;
  payloadLen: number;
  crc: number;
}

const IDLE: SenderTelemetry = {
  isTransmitting: false,
  isPaused: false,
  displayFps: 0,
  dataBytesShownPerSec: 0,
  packetsTransmitted: 0,
  currentPacketIndex: 0,
  totalSourcePackets: 0,
  loopCycles: 0,
  returnChannelConfirmed: false,
  returnChannelSource: null,
  modulePx: 0,
};

export const Sender: React.FC<SenderProps> = ({ settings, onUpdateSettings }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isHashing, setIsHashing] = useState(false);
  const [hashProgress, setHashProgress] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<TransferManifest | null>(null);
  const [activeType, setActiveType] = useState<PacketType>(PacketType.MANIFEST);
  const [activeCrcHex, setActiveCrcHex] = useState('00000000');
  const [activePayloadBytes, setActivePayloadBytes] = useState(0);
  const [startMidLoop, setStartMidLoop] = useState(false);
  const [telemetry, setTelemetry] = useState<SenderTelemetry>(IDLE);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const transmittingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const returnChannelRef = useRef<LocalReturnChannel | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentFrameRef = useRef<PreparedFrame | null>(null);
  const cellPxRef = useRef(0);
  const hashAbortRef = useRef(false);

  const audit = auditGridCapacity(settings.gridSize, settings.erasureBlockSize, 12);
  const ceilingFor = (gs: number, fps: number, mode: string) =>
    auditGridCapacity(gs, settings.erasureBlockSize, 12).effectiveUsefulBytesPerEmittedFrame * fps * (mode === 'mono' ? 1 : 2);
  const estimatedPackets = selectedFile ? Math.max(1, Math.ceil(selectedFile.size / audit.usefulPayloadBytesPerDataFrame)) : 0;
  const ceilingAtTarget = ceilingFor(settings.gridSize, settings.targetFps, settings.transmissionMode);
  const bestCaseSeconds = selectedFile && ceilingAtTarget > 0 ? selectedFile.size / ceilingAtTarget : 0;

  const drawFrame = (frame: PreparedFrame | null) => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    renderMatrixToCanvas(frame.matrix, ctx, canvas.width, canvas.height, settings.quietZoneCells);
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => undefined);
      wakeLockRef.current = null;
    }
  };

  const stopTransmission = useCallback(() => {
    transmittingRef.current = false;
    pausedRef.current = false;
    hashAbortRef.current = true;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    releaseWakeLock();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    returnChannelRef.current?.close();
    returnChannelRef.current = null;
    setTelemetry((prev) => ({ ...prev, isTransmitting: false, isPaused: false, displayFps: 0, dataBytesShownPerSec: 0 }));
  }, []);

  useEffect(() => () => stopTransmission(), [stopTransmission]);

  // The screen wake lock is released whenever the tab is hidden; re-acquire it on return.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && transmittingRef.current && !wakeLockRef.current) {
        void requestScreenWakeLock().then((l) => {
          wakeLockRef.current = l;
        });
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const handleLayout = useCallback(
    (cellPx: number) => {
      cellPxRef.current = cellPx;
      drawFrame(currentFrameRef.current); // redraw immediately after a resize
      setTelemetry((p) => (p.modulePx === cellPx ? p : { ...p, modulePx: cellPx }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.quietZoneCells]
  );

  const selectFile = (file: File | null) => {
    stopTransmission();
    setSelectedFile(file);
    setManifest(null);
    setStartError(null);
  };

  const startTransmission = async () => {
    if (!selectedFile) return;
    // Enter full screen within the click (user activation); the pattern then fills the screen.
    if (!document.fullscreenElement && typeof document.documentElement.requestFullscreen === 'function') {
      void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    }
    stopTransmission();
    setStartError(null);
    setIsHashing(true);
    setHashProgress(0);
    hashAbortRef.current = false;
    try {
      const carousel = new StreamingFileCarousel(selectedFile, selectedFile.name, selectedFile.type || 'application/octet-stream', {
        gridSize: settings.gridSize,
        erasureBlockSize: settings.erasureBlockSize,
        manifestIntervalFrames: 12, // manifests carry no file data: keep them rare (join still < 1 s at 15 FPS)
        startPacketOffset: startMidLoop ? Math.floor(estimatedPackets * 0.45) : 0,
      });
      const prepared = await carousel.prepare((done, total) => {
        setHashProgress(total > 0 ? Math.round((done / total) * 100) : 100);
      });
      if (hashAbortRef.current) return;
      setManifest(prepared);
      setIsHashing(false);
      wakeLockRef.current = await requestScreenWakeLock();

      returnChannelRef.current = new LocalReturnChannel((payload) => {
        if (payload.transferId === prepared.transferId) {
          pausedRef.current = true;
          setTelemetry((prev) => ({ ...prev, isPaused: true, returnChannelConfirmed: true, returnChannelSource: 'same-browser channel' }));
        }
      });

      const txMode = settings.transmissionMode;
      const nextFrame = async (): Promise<PreparedFrame> => {
        const first = await carousel.nextPacket();
        const mode = frameModeFor(txMode, first.loopCycle);
        const pkts = [first];
        if (mode === 'gray4') pkts.push(await carousel.nextPacket()); // two packets per grayscale frame
        const view = new DataView(first.rawBytes.buffer, first.rawBytes.byteOffset, first.rawBytes.byteLength);
        const firstLen = view.getUint16(18, false);
        let dataBytes = 0;
        for (const p of pkts) {
          if (p.packetType === PacketType.DATA) dataBytes += new DataView(p.rawBytes.buffer, p.rawBytes.byteOffset).getUint16(18, false);
        }
        return {
          packetType: first.packetType,
          packetIndex: pkts[pkts.length - 1].packetIndex,
          loopCycle: first.loopCycle,
          matrix: encodeFrameToMatrix(pkts.map((p) => p.rawBytes), prepared.gridSize, mode),
          payloadLen: dataBytes,
          crc: view.getUint32(24 + firstLen, false),
        };
      };

      transmittingRef.current = true;
      pausedRef.current = false;
      setTelemetry({ ...IDLE, isTransmitting: true, totalSourcePackets: prepared.totalSourcePackets, currentPacketIndex: carousel.getCurrentSourceIndex(), modulePx: cellPxRef.current });

      const interval = 1000 / settings.targetFps;
      let ready: PreparedFrame | null = await nextFrame();
      let preparing = false;
      let nextDue = performance.now();
      let windowStart = performance.now();
      let framesInWindow = 0;
      let bytesInWindow = 0;
      let total = 0;

      const step = (now: number) => {
        if (!transmittingRef.current) return;
        rafRef.current = requestAnimationFrame(step);
        if (pausedRef.current || !ready || now + 2 < nextDue) return;
        // Keep a steady cadence without accumulating drift after stalls
        nextDue = Math.max(nextDue + interval, now + interval * 0.5);
        const frame = ready;
        ready = null;
        currentFrameRef.current = frame;
        drawFrame(frame);
        total++;
        framesInWindow++;
        bytesInWindow += frame.payloadLen;

        const elapsed = performance.now() - windowStart;
        if (elapsed >= 500) {
          setActiveType(frame.packetType);
          setActivePayloadBytes(frame.payloadLen);
          setActiveCrcHex(frame.crc.toString(16).toUpperCase().padStart(8, '0'));
          const fps = (framesInWindow * 1000) / elapsed;
          const bps = (bytesInWindow * 1000) / elapsed;
          setTelemetry((prev) => ({
            ...prev,
            displayFps: fps,
            dataBytesShownPerSec: bps,
            packetsTransmitted: total,
            currentPacketIndex: frame.packetIndex,
            loopCycles: frame.loopCycle,
            modulePx: cellPxRef.current,
          }));
          windowStart = performance.now();
          framesInWindow = 0;
          bytesInWindow = 0;
        }

        if (!preparing) {
          preparing = true;
          nextFrame()
            .then((f) => {
              if (transmittingRef.current) ready = f;
            })
            .catch((error: unknown) => {
              const msg =
                error instanceof DOMException && error.name === 'NotReadableError'
                  ? 'The file can no longer be read (it was moved, changed or access was revoked). Select it again.'
                  : error instanceof Error
                    ? error.message
                    : 'Unable to prepare the next frame.';
              setStartError(msg);
              stopTransmission();
            })
            .finally(() => {
              preparing = false;
            });
        }
      };
      rafRef.current = requestAnimationFrame(step);
    } catch (error) {
      const msg =
        error instanceof DOMException && error.name === 'NotReadableError'
          ? 'The file could not be read. Select it again.'
          : error instanceof Error
            ? error.message
            : 'Unable to start transmission.';
      setStartError(msg);
      setIsHashing(false);
      stopTransmission();
    }
  };

  const handleTogglePause = () => {
    pausedRef.current = !pausedRef.current;
    setTelemetry((prev) => ({ ...prev, isPaused: pausedRef.current }));
  };

  const chipClass = (active: boolean) =>
    `flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
      active ? 'bg-sky-500 text-slate-950 font-semibold' : 'text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div className="flex flex-col gap-6">
      {startError && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
          Transmission stopped: {startError}
        </div>
      )}

      {!telemetry.isTransmitting && (
        <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4 sm:p-6 flex flex-col gap-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/80 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Send a file</h2>
              <p className="text-xs text-slate-400 mt-1">
                The file is shown as a looping sequence of black-and-white patterns. A receiver can start scanning at any point.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors whitespace-nowrap"
              >
                <FileUp className="w-3.5 h-3.5" />
                <span>Choose file</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) selectFile(f);
                  e.target.value = '';
                }}
                className="hidden"
                aria-label="Choose a file to send"
              />
            </div>
          </div>

          {selectedFile ? (
            <div className="border border-slate-800 bg-slate-900/50 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-100 break-all">{selectedFile.name}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1.5 font-mono tabular-nums">
                  <span>{formatBytes(selectedFile.size)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{estimatedPackets.toLocaleString()} packets</span>
                  <span aria-hidden="true">·</span>
                  <span>{audit.usefulPayloadBytesPerDataFrame.toLocaleString()} B/frame</span>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-300" title="Assumes every frame is captured on the first pass — real transfers are slower.">
                    Best case ≥ {bestCaseSeconds < 60 ? `${bestCaseSeconds.toFixed(0)} s` : `${(bestCaseSeconds / 60).toFixed(1)} min`} at {settings.targetFps} FPS (
                    {formatSpeed(ceilingAtTarget)} ceiling)
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => selectFile(null)}
                  aria-label="Remove selected file"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
                <button
                  type="button"
                  disabled={isHashing}
                  onClick={() => void startTransmission()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors whitespace-nowrap disabled:opacity-60"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>{isHashing ? `Hashing (SHA-256) ${hashProgress}%` : 'Start transmission'}</span>
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="border border-dashed border-slate-700 hover:border-sky-500/60 bg-slate-900/30 rounded-xl p-10 text-center transition-colors"
            >
              <FileUp className="w-8 h-8 text-slate-400 mx-auto mb-2.5" />
              <div className="text-sm font-medium text-slate-200">Choose a file to send</div>
              <div className="text-xs text-slate-400 mt-1">Files are read in slices; large files are never loaded into memory at once.</div>
            </button>
          )}

          <div className="pt-2 border-t border-slate-800/80">
            <div className="text-xs font-medium text-slate-300 mb-2">Speed</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {SPEED_PRESETS.map((p) => {
                const active =
                  settings.targetFps === p.settings.targetFps && settings.gridSize === p.settings.gridSize && settings.transmissionMode === p.settings.transmissionMode;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onUpdateSettings(p.settings)}
                    className={`text-left rounded-xl border p-3 transition-colors ${active ? 'border-sky-500 bg-sky-500/10' : 'border-slate-800 bg-slate-900 hover:bg-slate-800'}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-100">{p.label}</span>
                      <span className="text-[11px] font-mono text-sky-300">≤ {formatSpeed(ceilingFor(p.settings.gridSize, p.settings.targetFps, p.settings.transmissionMode))}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">{p.description}</p>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5">
              Figures are protocol ceilings if every frame is captured; real rates are lower and depend on the camera. Fine-tune below.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-4">
              <div className="block text-xs font-medium text-slate-300 mb-2" id="fps-label">
                Frames per second
              </div>
              <div role="group" aria-labelledby="fps-label" className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg font-mono tabular-nums">
                {TARGET_FPS_OPTIONS.map((fps) => (
                  <button key={fps} type="button" aria-pressed={settings.targetFps === fps} onClick={() => onUpdateSettings({ targetFps: fps })} className={chipClass(settings.targetFps === fps)}>
                    {fps}
                  </button>
                ))}
              </div>
              <p className={`text-[11px] mt-1.5 ${settings.targetFps >= 30 ? 'text-amber-300' : 'text-slate-500'}`}>
                {settings.targetFps >= 30
                  ? `${settings.targetFps} FPS needs a ${settings.targetFps * 2} FPS receiver camera; most phones capture at 30, so many frames will be missed. The receiver shows its safe rate.`
                  : 'Keep at or below about two thirds of the receiver camera’s rate (≤20 for a 30 FPS camera). The receiver shows its safe rate.'}
              </p>
            </div>
            <div className="lg:col-span-5">
              <div className="block text-xs font-medium text-slate-300 mb-2" id="grid-label">
                Pattern density
              </div>
              <div role="group" aria-labelledby="grid-label" className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg font-mono tabular-nums">
                {GRID_RESOLUTIONS.map((g) => (
                  <button key={g} type="button" aria-pressed={settings.gridSize === g} onClick={() => onUpdateSettings({ gridSize: g })} className={chipClass(settings.gridSize === g)}>
                    {g}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                Denser grids carry more per frame but need ≥4 camera pixels per cell. 48–96 suit most phones; 192+ needs a large, sharp, close setup.
              </p>
            </div>
            <div className="lg:col-span-12">
              <div className="block text-xs font-medium text-slate-300 mb-2" id="mode-label">
                Encoding
              </div>
              <div role="group" aria-labelledby="mode-label" className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg max-w-md">
                {TRANSMISSION_MODES.map((m) => (
                  <button key={m} type="button" aria-pressed={settings.transmissionMode === m} onClick={() => onUpdateSettings({ transmissionMode: m })} className={chipClass(settings.transmissionMode === m)}>
                    {m === 'auto' ? 'Auto' : m === 'mono' ? 'Monochrome' : 'Grayscale'}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                {settings.transmissionMode === 'auto'
                  ? 'Alternates a grayscale loop (2 packets per frame) with a monochrome loop, so receivers that cannot read grayscale still get everything.'
                  : settings.transmissionMode === 'gray4'
                    ? 'Four gray levels, 2 packets per frame. Needs a sharp image with ≈6+ camera pixels per cell.'
                    : 'Black and white only — the most robust option.'}
              </p>
            </div>
            <div className="lg:col-span-3">
              <div className="block text-xs font-medium text-slate-300 mb-2">Start position</div>
              <button
                type="button"
                aria-pressed={startMidLoop}
                onClick={() => setStartMidLoop((p) => !p)}
                className={`w-full py-2 px-3 rounded-lg text-xs font-medium border transition-colors text-left ${
                  startMidLoop ? 'border-sky-500/60 bg-sky-500/10 text-sky-300' : 'border-slate-800 bg-slate-900 text-slate-300'
                }`}
              >
                {startMidLoop ? 'Mid-loop (45%) — join-anywhere demo' : 'From the first packet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {telemetry.isTransmitting && manifest && (
        <TransmissionDisplay
          canvasRef={canvasRef}
          manifest={manifest}
          quietZoneCells={settings.quietZoneCells}
          telemetry={telemetry}
          activePacketType={activeType}
          activePacketCrcHex={activeCrcHex}
          activePayloadBytes={activePayloadBytes}
          targetFps={settings.targetFps}
          onLayout={handleLayout}
          onTogglePause={handleTogglePause}
          onStop={stopTransmission}
        />
      )}
    </div>
  );
};
