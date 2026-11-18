import React from 'react';
import { AlertTriangle, CheckCircle2, Download, Play, RotateCcw } from 'lucide-react';
import type { ReconstructorState } from '../engine/fileReconstructor';
import type { ScanTelemetry } from '../engine/scanSession';
import { formatBytes, formatSpeed } from '../utils/integrity';
import type { ReceiverMode } from './Receiver';

interface TransferProgressProps {
  state: ReconstructorState;
  telemetry: ScanTelemetry;
  mode: ReceiverMode;
  onDownload: () => void;
  onContinueScanning: () => void;
  onReset: () => void;
  onSwitchTransfer: () => void;
}

function formatEta(etaSeconds: number | null): string {
  if (etaSeconds === null || !Number.isFinite(etaSeconds)) return '—';
  if (etaSeconds < 1) return '<1 s';
  if (etaSeconds < 60) return `${Math.round(etaSeconds)} s`;
  const mins = Math.floor(etaSeconds / 60);
  if (mins < 60) return `${mins} min ${Math.round(etaSeconds % 60)} s`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

const MAP_CELLS = 120;

export const TransferProgress: React.FC<TransferProgressProps> = ({
  state,
  telemetry,
  mode,
  onDownload,
  onContinueScanning,
  onReset,
  onSwitchTransfer,
}) => {
  const {
    status,
    manifest,
    storageBackend,
    receivedPackets,
    totalPackets,
    uniqueBytesReceived,
    usefulThroughputBytesPerSec,
    etaSeconds,
    duplicatePackets,
    parityRecoveredPackets,
    joinedAtPacketIndex,
    computedSha256,
    receivedBitmap,
    rejectedPackets,
    backpressureDrops,
    otherTransferSeen,
    errorMessage,
    verifyProgress,
  } = state;

  const progress = totalPackets > 0 ? receivedPackets / totalPackets : 0;
  const progressPercent = Math.min(100, Math.floor(progress * 100));

  // Each map cell is "received" only if EVERY packet it represents has been received.
  const cells: boolean[] = [];
  const cellCount = totalPackets > 0 ? Math.min(totalPackets, MAP_CELLS) : 60;
  for (let i = 0; i < cellCount; i++) {
    if (!receivedBitmap || totalPackets === 0) {
      cells.push(false);
      continue;
    }
    const from = Math.floor((i / cellCount) * totalPackets);
    const to = Math.max(from + 1, Math.floor(((i + 1) / cellCount) * totalPackets));
    let all = true;
    for (let p = from; p < to; p++) {
      if (receivedBitmap[p] !== 1) {
        all = false;
        break;
      }
    }
    cells.push(all);
  }

  const paused = mode === 'idle' && status === 'receiving' && receivedPackets > 0 && receivedPackets < totalPackets;
  const isSynthetic = mode === 'loopback' || mode === 'benchmark';

  return (
    <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4 sm:p-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-100 break-all">
            {manifest ? manifest.fileName : status === 'storage_error' ? 'Storage problem' : 'Waiting for the sender’s manifest frame…'}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1 font-mono tabular-nums">
            {manifest ? (
              <>
                <span>
                  {formatBytes(uniqueBytesReceived)} / {formatBytes(manifest.fileSize)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{manifest.totalSourcePackets.toLocaleString()} packets</span>
                <span aria-hidden="true">·</span>
                <span>
                  {manifest.gridSize}×{manifest.gridSize}, {manifest.chunkSize.toLocaleString()} B/packet
                </span>
                <span aria-hidden="true">·</span>
                <span>Storage: {storageBackend}</span>
                {joinedAtPacketIndex !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-sky-400">Joined at packet #{joinedAtPacketIndex}</span>
                  </>
                )}
              </>
            ) : (
              <span>Packets that arrive before the manifest are buffered (up to 64).</span>
            )}
          </div>
        </div>
        <div className="text-right font-mono tabular-nums">
          <div className="text-2xl font-bold text-slate-100">{status === 'verifying' ? `${Math.floor(verifyProgress * 100)}%` : `${progressPercent}%`}</div>
          <div className="text-xs text-slate-400">
            {status === 'verifying' ? 'Verifying SHA-256…' : `${receivedPackets.toLocaleString()} / ${totalPackets ? totalPackets.toLocaleString() : '—'} · ETA ${formatEta(etaSeconds)}`}
          </div>
        </div>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-label="Transfer progress"
        className="w-full h-2.5 bg-slate-900 border border-slate-800 rounded-full overflow-hidden"
      >
        <div className="h-full bg-sky-500 transition-transform duration-150 origin-left" style={{ transform: `scaleX(${progress})` }} />
      </div>

      {otherTransferSeen && (
        <div className="border border-amber-500/40 bg-amber-950/20 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-100">
          <span>
            The camera now sees a different transfer (“{otherTransferSeen.fileName}”). Packets from it are ignored until you switch.
          </span>
          <button type="button" onClick={onSwitchTransfer} className="px-3 py-1.5 rounded-md bg-amber-500/20 border border-amber-500/40 hover:bg-amber-500/30 whitespace-nowrap">
            Switch to the new transfer
          </button>
        </div>
      )}

      {paused && (
        <div className="border border-sky-500/40 bg-sky-950/20 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-slate-200">
            <span className="font-semibold text-sky-300">Scanning paused.</span> {receivedPackets} of {totalPackets} packets are held in{' '}
            {storageBackend === 'Memory' ? 'memory' : storageBackend} for this page session. Keep this tab open and continue; reloading discards them.
          </div>
          <button
            type="button"
            onClick={onContinueScanning}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Continue scanning</span>
          </button>
        </div>
      )}

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 mb-2">
          <span>Packet map (filled = every packet in that segment received)</span>
          <span className="font-mono tabular-nums text-sky-400">Recovered by parity: {parityRecoveredPackets}</span>
        </div>
        <div data-testid="packet-reconstruction-map" className="grid grid-cols-20 sm:grid-cols-30 gap-1 p-3 bg-slate-950 border border-slate-800/90 rounded-lg">
          {cells.map((ok, idx) => (
            <div key={idx} className={`h-2.5 rounded-[2px] ${ok ? 'bg-sky-400' : 'bg-slate-800/70'}`} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono tabular-nums">
        <div className="border border-slate-800 bg-slate-900/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 font-sans">Measured file data rate</div>
          <div data-testid="measured-useful-throughput" className="text-base font-semibold text-sky-400 mt-1">
            {formatSpeed(usefulThroughputBytesPerSec)}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 font-sans">{isSynthetic ? 'Software loopback — not an optical link' : 'Unique bytes / elapsed time'}</div>
        </div>
        <div className="border border-slate-800 bg-slate-900/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 font-sans">Valid packets</div>
          <div className="text-base font-semibold text-slate-100 mt-1">{telemetry.validPackets.toLocaleString()}</div>
          <div className="text-[11px] text-slate-400 mt-0.5 font-sans">Duplicates: {duplicatePackets.toLocaleString()}</div>
        </div>
        <div className="border border-slate-800 bg-slate-900/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 font-sans">Unreadable frames</div>
          <div className="text-base font-semibold text-slate-200 mt-1">
            {telemetry.crcErrors.toLocaleString()} <span className="text-xs text-slate-400">CRC</span> / {telemetry.noSync.toLocaleString()}{' '}
            <span className="text-xs text-slate-400">no lock</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 font-sans">Corrupted frames are discarded</div>
        </div>
        <div className="border border-slate-800 bg-slate-900/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 font-sans">Rejected / dropped</div>
          <div className="text-base font-semibold text-slate-200 mt-1">
            {rejectedPackets} / {backpressureDrops}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 font-sans">Inconsistent / storage busy</div>
        </div>
      </div>

      {status === 'completed' && manifest && (
        <div data-testid="transfer-verified-banner" className="border border-emerald-500/40 bg-emerald-950/20 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-emerald-300">SHA-256 verified — the file matches what the sender hashed</div>
              <div className="text-xs text-slate-300 font-mono tabular-nums mt-1 break-all">{computedSha256}</div>
              <div className="text-[11px] text-slate-400 mt-1">Integrity is not safety: only open files from senders you trust.</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onDownload} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors whitespace-nowrap">
              <Download className="w-4 h-4" />
              <span>Save file</span>
            </button>
            <button type="button" onClick={onReset} className="px-3 py-2.5 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap">
              Receive another
            </button>
          </div>
        </div>
      )}

      {(status === 'integrity_error' || status === 'storage_error') && (
        <div role="alert" className="border border-rose-500/40 bg-rose-950/20 rounded-xl p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="text-xs text-rose-200 min-w-0">
              <div className="font-semibold text-sm text-rose-300">{status === 'integrity_error' ? 'SHA-256 mismatch' : 'Could not store the incoming file'}</div>
              <div className="mt-1">{errorMessage}</div>
              {status === 'integrity_error' && (
                <div className="font-mono mt-1 break-all text-rose-300/80">
                  expected {manifest?.sha256}
                  <br />
                  computed {computedSha256}
                </div>
              )}
            </div>
          </div>
          <button type="button" onClick={onReset} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-rose-500/40 bg-rose-950/40 text-rose-100 hover:bg-rose-900/40 whitespace-nowrap">
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Start over</span>
          </button>
        </div>
      )}
    </div>
  );
};
