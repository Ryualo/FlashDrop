import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Pause, Play, Square } from 'lucide-react';
import { PacketType, TransferManifest } from '../engine/packetProtocol';
import { computeIntegerCanvasLayout } from '../engine/opticalEncoder';
import type { SenderTelemetry } from '../engine/transferManager';
import { formatBytes, formatSpeed } from '../utils/integrity';

interface TransmissionDisplayProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  manifest: TransferManifest;
  quietZoneCells: number;
  telemetry: SenderTelemetry;
  activePacketType: PacketType;
  activePacketCrcHex: string;
  activePayloadBytes: number;
  targetFps: number;
  onLayout: (cellPx: number) => void;
  onTogglePause: () => void;
  onStop: () => void;
}

export const TransmissionDisplay: React.FC<TransmissionDisplayProps> = ({
  canvasRef,
  manifest,
  quietZoneCells,
  telemetry,
  activePacketType,
  activePacketCrcHex,
  activePayloadBytes,
  targetFps,
  onLayout,
  onTogglePause,
  onStop,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [cssSide, setCssSide] = useState(0);
  const [tooDense, setTooDense] = useState(false);

  // Integer device-pixel layout, recomputed on resize / fullscreen / zoom changes.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const apply = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = stage.getBoundingClientRect();
      const availCss = isFullscreen
        ? Math.max(64, Math.min(window.innerWidth, window.innerHeight) - 16)
        : Math.max(64, Math.min(rect.width, window.innerHeight * 0.8, 760));
      const layout = computeIntegerCanvasLayout(manifest.gridSize, quietZoneCells, Math.floor(availCss * dpr));
      setTooDense(layout.cellPx < 2);
      if (canvas.width !== layout.canvasPx || canvas.height !== layout.canvasPx) {
        canvas.width = layout.canvasPx;
        canvas.height = layout.canvasPx;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
      setCssSide(layout.canvasPx / dpr);
      onLayout(layout.cellPx);
    };
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    ro?.observe(stage);
    window.addEventListener('resize', apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [canvasRef, manifest.gridSize, quietZoneCells, isFullscreen, onLayout]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = async () => {
    const el = document.documentElement;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        return;
      } catch {
        // fall through to CSS fullscreen (e.g. iPhone Safari has no element fullscreen)
      }
    }
    setIsFullscreen((p) => !p);
  };

  if (isFullscreen) {
    return (
      <div ref={containerRef} className="fixed inset-0 z-50 bg-black flex items-center justify-center group">
        <div ref={stageRef} className="w-full h-full flex items-center justify-center">
          <canvas
            ref={canvasRef}
            data-testid="optical-sender-canvas"
            className="block bg-black"
            style={{ width: cssSide ? `${cssSide}px` : '90vmin', height: cssSide ? `${cssSide}px` : '90vmin', imageRendering: 'pixelated' }}
          />
        </div>
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-2 py-1.5 opacity-40 hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <span className="px-2 text-[11px] text-white/70 font-mono tabular-nums">
            {telemetry.displayFps.toFixed(0)} FPS · #{telemetry.currentPacketIndex}/{manifest.totalSourcePackets} · loop {telemetry.loopCycles + 1}
          </span>
          <button type="button" onClick={onTogglePause} aria-label={telemetry.isPaused ? 'Resume' : 'Pause'} className="p-2 rounded-full text-white hover:bg-white/10">
            {telemetry.isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
          <button type="button" onClick={() => void toggleFullscreen()} aria-label="Exit full screen" className="p-2 rounded-full text-white hover:bg-white/10">
            <Minimize2 className="w-4 h-4" />
          </button>
          <button type="button" onClick={onStop} aria-label="Stop transmission" className="p-2 rounded-full text-rose-300 hover:bg-white/10">
            <Square className="w-4 h-4" />
          </button>
        </div>
        {tooDense && (
          <p role="alert" className="absolute top-3 inset-x-0 text-center text-xs text-amber-300">
            Screen too small for a {manifest.gridSize}×{manifest.gridSize} grid — choose a coarser grid.
          </p>
        )}
      </div>
    );
  }

  const packetTypeName =
    activePacketType === PacketType.MANIFEST ? 'MANIFEST' : activePacketType === PacketType.PARITY ? 'XOR PARITY' : 'DATA';
  const loopPercent =
    manifest.totalSourcePackets > 0 ? Math.min(100, Math.round((telemetry.currentPacketIndex / manifest.totalSourcePackets) * 100)) : 0;
  const fpsShortfall = telemetry.displayFps > 0 && telemetry.displayFps < targetFps * 0.85;

  return (
    <div
      ref={containerRef}
      className={`border border-slate-800 bg-[#0B101B] rounded-xl p-4 sm:p-6 flex flex-col gap-6 ${
        isFullscreen ? 'fixed inset-0 z-50 rounded-none overflow-auto bg-black' : ''
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-100 tracking-tight">Transmitting</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1 font-mono tabular-nums">
            <span className="truncate max-w-[14rem]">{manifest.fileName}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(manifest.fileSize)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {manifest.gridSize}×{manifest.gridSize}, {manifest.chunkSize.toLocaleString()} B/packet
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onTogglePause}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            {telemetry.isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{telemetry.isPaused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            <span>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
          </button>
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white transition-colors whitespace-nowrap"
          >
            <Square className="w-3.5 h-3.5" />
            <span>Stop</span>
          </button>
        </div>
      </div>

      <div className={`grid grid-cols-1 ${isFullscreen ? '' : 'lg:grid-cols-12'} gap-6 items-start`}>
        <div className={`${isFullscreen ? '' : 'lg:col-span-7'} flex flex-col items-center bg-black border border-slate-800 rounded-xl p-3 sm:p-4`}>
          <div ref={stageRef} className="w-full flex justify-center">
            <canvas
              ref={canvasRef}
              data-testid="optical-sender-canvas"
              className="bg-black block"
              style={{ width: cssSide ? `${cssSide}px` : '100%', height: cssSide ? `${cssSide}px` : 'auto', imageRendering: 'pixelated' }}
            />
          </div>
          <p className="text-xs text-slate-400 mt-3 text-center">
            Fill most of the receiving camera’s view with this pattern. Use full brightness and avoid reflections.
          </p>
          {tooDense && (
            <p role="alert" className="text-xs text-amber-300 mt-2 text-center">
              This screen is too small for a {manifest.gridSize}×{manifest.gridSize} grid (under 2 device pixels per cell). Use full screen or a coarser grid.
            </p>
          )}
        </div>

        {!isFullscreen && (
          <div className="lg:col-span-5 flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 font-mono tabular-nums">
              <div className="border border-slate-800 bg-slate-900/60 rounded-lg p-3.5">
                <div className="text-xs text-slate-400 font-sans">Frames shown / target</div>
                <div className={`text-xl font-semibold mt-1 ${fpsShortfall ? 'text-amber-300' : 'text-slate-100'}`}>
                  {telemetry.displayFps.toFixed(1)} <span className="text-xs text-slate-400">/ {targetFps} FPS</span>
                </div>
              </div>
              <div className="border border-slate-800 bg-slate-900/60 rounded-lg p-3.5">
                <div className="text-xs text-slate-400 font-sans">File data shown</div>
                <div className="text-xl font-semibold text-slate-100 mt-1">{formatSpeed(telemetry.dataBytesShownPerSec)}</div>
                <div className="text-[11px] text-slate-400 mt-0.5 font-sans">Upper bound; the receiver gets less</div>
              </div>
              <div className="border border-slate-800 bg-slate-900/60 rounded-lg p-3.5">
                <div className="text-xs text-slate-400 font-sans">Packet / total</div>
                <div className="text-xl font-semibold text-slate-100 mt-1">
                  #{telemetry.currentPacketIndex} <span className="text-xs text-slate-400">/ {manifest.totalSourcePackets}</span>
                </div>
              </div>
              <div className="border border-slate-800 bg-slate-900/60 rounded-lg p-3.5">
                <div className="text-xs text-slate-400 font-sans">Cell size on screen</div>
                <div className="text-xl font-semibold text-slate-100 mt-1">
                  {telemetry.modulePx} <span className="text-xs text-slate-400">device px</span>
                </div>
              </div>
            </div>

            <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-3.5">
              <div className="flex items-center justify-between text-xs text-slate-300 mb-2 font-mono tabular-nums">
                <span>Loop {telemetry.loopCycles + 1} progress</span>
                <span>{loopPercent}%</span>
              </div>
              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-sky-500 origin-left" style={{ transform: `scaleX(${loopPercent / 100})` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400 mt-2 font-mono tabular-nums">
                <span>Frames: {telemetry.packetsTransmitted.toLocaleString()}</span>
                <span>Parity: {manifest.erasureBlockSize > 1 ? `1 per ${manifest.erasureBlockSize}` : 'off'}</span>
              </div>
            </div>

            {fpsShortfall && (
              <p className="text-xs text-amber-300 border border-amber-500/30 bg-amber-950/20 rounded-lg p-3">
                This device cannot show {targetFps} frames per second right now (display refresh, power saving or load). The receiver can only get what is actually shown.
              </p>
            )}

            <div className="border border-slate-800 bg-slate-900/40 rounded-lg p-3.5 text-xs text-slate-300 leading-relaxed">
              {telemetry.returnChannelConfirmed ? (
                <div className="text-emerald-400 font-medium">
                  A receiver in this browser confirmed the SHA-256 ({telemetry.returnChannelSource}). Transmission paused.
                </div>
              ) : (
                <div>
                  <span className="font-semibold text-slate-100">One-way link:</span> the sender cannot see when a separate device finishes. Press{' '}
                  <strong className="text-slate-100">Stop</strong> once the receiver shows “SHA-256 verified”.
                </div>
              )}
            </div>

            <div className="border border-slate-800 bg-slate-900/30 rounded-lg overflow-hidden">
              <button
                type="button"
                aria-expanded={showDiagnostics}
                onClick={() => setShowDiagnostics((p) => !p)}
                className="w-full px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:text-slate-100 flex items-center justify-between transition-colors"
              >
                <span>Frame diagnostics</span>
                {showDiagnostics ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
              </button>
              {showDiagnostics && (
                <div className="px-3.5 pb-3.5 pt-1 border-t border-slate-800/80 text-xs font-mono tabular-nums grid grid-cols-2 gap-x-4 gap-y-1.5 text-slate-400">
                  <div>
                    Frame type: <span className="text-slate-200">{packetTypeName}</span>
                  </div>
                  <div>
                    Payload: <span className="text-slate-200">{activePayloadBytes} B</span>
                  </div>
                  <div>
                    Transfer ID: <span className="text-slate-200">0x{manifest.transferId.toString(16).toUpperCase().padStart(8, '0')}</span>
                  </div>
                  <div>
                    CRC-32: <span className="text-emerald-400">0x{activePacketCrcHex}</span>
                  </div>
                  <div className="col-span-2 break-all">
                    SHA-256: <span className="text-slate-200">{manifest.sha256}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
