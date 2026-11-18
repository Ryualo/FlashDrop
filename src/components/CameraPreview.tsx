import React from 'react';
import { Camera, Cpu, Flashlight, Gauge, RefreshCw, Sliders, Square, Zap, ZoomIn } from 'lucide-react';
import type { QuadCorners } from '../engine/opticalDecoder';
import type { CameraControls, ScanTelemetry } from '../engine/scanSession';
import type { ReconstructorState } from '../engine/fileReconstructor';
import type { ReceiverMode } from './Receiver';

/** Highest sender FPS option that stays at or below ~2/3 of the measured camera rate. */
function safeSenderFps(cameraFps: number): number {
  const options = [5, 10, 15, 20, 30, 60];
  let best = 5;
  for (const o of options) if (o <= cameraFps * 0.7) best = o;
  return best;
}

interface CameraPreviewProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  mode: ReceiverMode;
  telemetry: ScanTelemetry;
  state: ReconstructorState;
  missing: { ranges: Array<[number, number]>; awaitingParity: number };
  cameraError: string | null;
  controls: CameraControls | null;
  manualCalibration: boolean;
  corners: QuadCorners;
  onToggleManualCalibration: () => void;
  onUpdateCorner: (corner: keyof QuadCorners, axis: 'x' | 'y', value: number) => void;
  onStartCameraScan: () => void;
  onStartLoopback: () => void;
  onStartBenchmark: () => void;
  onStopScan: () => void;
  onZoom: (v: number) => void;
  onTorch: (on: boolean) => void;
  onFocusAt: (x: number, y: number) => void;
  onShortExposure: (on: boolean) => void;
}

export function scannerHint(t: ScanTelemetry): { text: string; tone: 'ok' | 'warn' | 'info' } {
  switch (t.hint) {
    case 'idle':
      return { text: 'Scanner stopped.', tone: 'info' };
    case 'searching':
    case 'no_pattern':
      return { text: 'Searching — point the camera at the sender’s pattern (all four corners in view).', tone: 'info' };
    case 'partial_pattern':
      return { text: 'Pattern partly visible — fit all four corners inside the view.', tone: 'warn' };
    case 'too_small':
      return { text: `Cells too small (${t.modulePx.toFixed(1)} px) — move closer or zoom in.`, tone: 'warn' };
    case 'too_close':
      return { text: 'Pattern goes past the edge of the view — move back a little so all four corners are visible.', tone: 'warn' };
    case 'low_contrast':
      return { text: 'Low contrast — raise the sender’s brightness, avoid reflections.', tone: 'warn' };
    case 'blurred_or_torn':
      return { text: 'Locked, but frames are blurred — hold steady or tap to focus.', tone: 'warn' };
    case 'incompatible_version':
      return { text: 'Sender runs a different DropFlash version — reload both devices.', tone: 'warn' };
    case 'ok':
      return { text: t.frameMode === 'gray4' ? 'Receiving · grayscale' : 'Receiving', tone: 'ok' };
    case 'tracking':
      return { text: 'Tracking — keep the pattern in view', tone: 'info' };
    default:
      return { text: '', tone: 'info' };
  }
}

function Ring({ value }: { value: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r={r} stroke="rgba(255,255,255,0.15)" strokeWidth="6" fill="none" />
      <circle
        cx="32"
        cy="32"
        r={r}
        stroke="#38BDF8"
        strokeWidth="6"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        transform="rotate(-90 32 32)"
        style={{ transition: 'stroke-dashoffset 200ms' }}
      />
    </svg>
  );
}

const CORNER_LABELS: Array<[keyof QuadCorners, string]> = [
  ['topLeft', 'Top-left'],
  ['topRight', 'Top-right'],
  ['bottomLeft', 'Bottom-left'],
  ['bottomRight', 'Bottom-right'],
];

const btn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium backdrop-blur bg-black/50 border border-white/15 text-white hover:bg-black/70 transition-colors';

export const CameraPreview: React.FC<CameraPreviewProps> = (p) => {
  const { mode, telemetry, state } = p;
  const running = mode !== 'idle';
  const hint = scannerHint(telemetry);
  const progress = state.totalPackets ? state.receivedPackets / state.totalPackets : 0;
  const locked = telemetry.hint === 'ok' || telemetry.hint === 'tracking' || telemetry.hint === 'blurred_or_torn' || telemetry.syncQuality >= 0.8;
  const missingCount = state.totalPackets ? state.totalPackets - state.receivedPackets : 0;
  const dot = hint.tone === 'ok' ? 'bg-emerald-400' : locked ? 'bg-sky-400' : hint.tone === 'warn' ? 'bg-amber-400' : 'bg-slate-300';

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative bg-black rounded-2xl overflow-hidden w-full aspect-[3/4] sm:aspect-video max-h-[78vh] ring-1 ring-white/10"
        onClick={(e) => {
          if (mode !== 'camera' || !p.controls?.tapToFocus) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          p.onFocusAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        }}
      >
        <video
          ref={p.videoRef}
          playsInline
          muted
          autoPlay
          aria-label="Camera preview"
          className={`absolute inset-0 w-full h-full object-contain ${mode === 'camera' ? '' : 'invisible'}`}
        />
        <canvas
          ref={p.overlayRef}
          data-testid="optical-receiver-canvas"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          style={{ imageRendering: mode === 'camera' ? 'auto' : 'pixelated' }}
        />

        {/* Scanning reticle while searching */}
        {running && !locked && (
          <div className="pointer-events-none absolute inset-[12%] rounded-3xl border-2 border-dashed border-white/30 animate-pulse" />
        )}

        {/* Top HUD */}
        {running && (
          <div className="absolute top-0 inset-x-0 p-3 flex items-start justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent">
            <div className="flex items-center gap-2 rounded-full bg-black/50 backdrop-blur px-3 py-1.5 text-xs text-white border border-white/10" aria-live="polite">
              <span className={`w-2 h-2 rounded-full ${dot} ${hint.tone === 'ok' ? '' : 'animate-pulse'}`} />
              <span>{hint.text}</span>
            </div>
            {state.manifest && (
              <div className="relative shrink-0">
                <Ring value={progress} />
                <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white tabular-nums">
                  {Math.floor(progress * 100)}%
                </span>
              </div>
            )}
          </div>
        )}

        {/* Bottom HUD */}
        {running && (
          <div className="absolute bottom-0 inset-x-0 p-3 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent">
            {state.manifest && (
              <div className="text-[11px] text-white/80 font-mono tabular-nums flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-white font-sans font-medium truncate max-w-[60%]">{state.manifest.fileName}</span>
                <span>
                  {state.receivedPackets}/{state.totalPackets} packets
                </span>
                {missingCount > 0 && (
                  <span title="Packets already received are remembered; only these are still needed.">
                    still need {missingCount}
                    {p.missing.ranges.length > 0 &&
                      ` (${p.missing.ranges
                        .slice(0, 3)
                        .map(([a, b]) => (a === b ? `#${a}` : `#${a}–${b}`))
                        .join(', ')}${p.missing.ranges.length > 3 ? '…' : ''})`}
                  </span>
                )}
                {p.missing.awaitingParity > 0 && <span className="text-sky-300">{p.missing.awaitingParity} rebuild on next parity</span>}
                <span>{telemetry.validFps.toFixed(1)} pkt/s</span>
              </div>
            )}
            {mode === 'camera' && telemetry.inputFps >= 5 && (
              <div className="text-[11px] text-white/70 font-mono tabular-nums flex flex-wrap gap-x-3">
                <span title="A sender rate above about two thirds of the camera rate makes most captures straddle two frames.">
                  camera {Math.round(telemetry.inputFps)} fps · sender ≤ {safeSenderFps(telemetry.inputFps)} FPS
                </span>
                {telemetry.decoderThread === 'main' && (
                  <span className="text-amber-300" title="The background decoder could not start (often offline with an old cache). Decoding continues on the main thread, slightly slower.">
                    decoding on main thread
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {mode === 'camera' && p.controls?.zoom && (
                <label className={`${btn} gap-2`} onClick={(e) => e.stopPropagation()}>
                  <ZoomIn className="w-3.5 h-3.5" />
                  <input
                    type="range"
                    aria-label="Zoom"
                    min={p.controls.zoom.min}
                    max={p.controls.zoom.max}
                    step={p.controls.zoom.step}
                    defaultValue={p.controls.zoom.value}
                    onChange={(e) => p.onZoom(Number(e.target.value))}
                    className="w-24 accent-sky-400"
                  />
                </label>
              )}
              {mode === 'camera' && p.controls?.shortExposure && (
                <button
                  type="button"
                  aria-pressed={p.controls.shortExposureOn}
                  title="Short exposure: sharper frames while your hand moves"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onShortExposure(!p.controls!.shortExposureOn);
                  }}
                  className={`${btn} ${p.controls.shortExposureOn ? 'bg-sky-500/40 border-sky-300/50' : ''}`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Freeze motion</span>
                </button>
              )}
              {mode === 'camera' && p.controls?.torch && (
                <button
                  type="button"
                  aria-pressed={p.controls.torchOn}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onTorch(!p.controls!.torchOn);
                  }}
                  className={btn}
                >
                  <Flashlight className="w-3.5 h-3.5" />
                  <span>Light</span>
                </button>
              )}
              {mode === 'camera' && (
                <button
                  type="button"
                  aria-pressed={p.manualCalibration}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onToggleManualCalibration();
                  }}
                  className={btn}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>{p.manualCalibration ? 'Auto detect' : 'Manual corners'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onStopScan();
                }}
                className={`${btn} ml-auto bg-rose-600/80 border-rose-400/40 hover:bg-rose-600`}
              >
                <Square className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            </div>
          </div>
        )}

        {/* Idle / error overlay */}
        {!running && (
          <div className="absolute inset-0 bg-slate-950/85 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Camera className="w-10 h-10 text-sky-400" />
            {p.cameraError ? (
              <p role="alert" className="text-sm text-amber-200 max-w-md">
                {p.cameraError}
              </p>
            ) : (
              <p className="text-sm text-slate-300 max-w-md">Scanner paused. Received packets are kept — resume any time.</p>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" onClick={p.onStartCameraScan} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-sm font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950">
                {p.cameraError ? <RefreshCw className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
                <span>{p.cameraError ? 'Try camera again' : 'Resume scanning'}</span>
              </button>
              <button type="button" onClick={p.onStartLoopback} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800">
                <Cpu className="w-3.5 h-3.5 text-sky-400" />
                <span>Loopback test</span>
              </button>
              <button
                type="button"
                onClick={p.onStartBenchmark}
                title="Decodes generated 384×384 frames as fast as this device can. Measures decoder speed only."
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
              >
                <Gauge className="w-3.5 h-3.5" />
                <span>Decoder benchmark</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {(mode === 'loopback' || mode === 'benchmark') && (
        <p className="text-xs text-slate-400">Software loopback — generated frames, no camera involved.</p>
      )}

      {p.manualCalibration && mode === 'camera' && (
        <fieldset className="border border-slate-800 bg-slate-900/50 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
          <legend className="px-1 text-slate-300 font-sans">Outer pattern corners (% of camera frame)</legend>
          {CORNER_LABELS.map(([key, label]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <span className="text-slate-300 font-sans font-medium">{label}</span>
              {(['x', 'y'] as const).map((axis) => (
                <label key={axis} className="flex items-center justify-between gap-2 text-slate-400">
                  <span>
                    {axis.toUpperCase()} {Math.round(p.corners[key][axis] * 100)}%
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    value={Math.round(p.corners[key][axis] * 1000)}
                    onChange={(e) => p.onUpdateCorner(key, axis, Number(e.target.value) / 1000)}
                    className="w-20 accent-amber-400"
                    aria-label={`${label} ${axis}`}
                  />
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
};
