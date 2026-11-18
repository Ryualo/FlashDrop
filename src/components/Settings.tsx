import React, { useEffect, useState } from 'react';
import { Check, HardDrive, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { CameraDeviceInfo, listCameraDevices } from '../engine/cameraCapture';
import { auditGridCapacity } from '../engine/capacityAudit';
import { GRID_RESOLUTIONS, TARGET_FPS_OPTIONS, TransferSettings } from '../engine/transferManager';
import { clearAllTransferHistory } from '../storage/indexedDB';
import { cleanupIncomingStorage } from '../storage/opfsStorage';
import { BrowserCapabilities } from '../utils/browserSupport';
import { formatBytes, formatSpeed } from '../utils/integrity';

interface SettingsProps {
  settings: TransferSettings;
  capabilities: BrowserCapabilities;
  swStatus: string;
  onUpdateSettings: (partial: Partial<TransferSettings>) => void;
  onRefreshCapabilities: () => void;
}

const card = 'border border-slate-800 bg-slate-900/40 rounded-xl p-5 flex flex-col gap-3';
const chip = (active: boolean) =>
  `py-2 px-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap text-center ${
    active ? 'border-sky-500 bg-sky-500 text-slate-950 font-semibold' : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
  }`;

export const Settings: React.FC<SettingsProps> = ({ settings, capabilities, swStatus, onUpdateSettings, onRefreshCapabilities }) => {
  const [cameras, setCameras] = useState<CameraDeviceInfo[]>([]);
  const [clearedNotice, setClearedNotice] = useState(false);

  useEffect(() => {
    void listCameraDevices().then(setCameras);
  }, []);

  const gridAudit = auditGridCapacity(settings.gridSize, settings.erasureBlockSize, 6);
  const ceiling = gridAudit.effectiveUsefulBytesPerEmittedFrame * settings.targetFps;

  const handleClearStorage = async () => {
    await clearAllTransferHistory();
    await cleanupIncomingStorage();
    setClearedNotice(true);
    onRefreshCapabilities();
    setTimeout(() => setClearedNotice(false), 2500);
  };

  return (
    <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4 sm:p-6 flex flex-col gap-8">
      <div className="border-b border-slate-800/80 pb-4">
        <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
        <p className="text-xs text-slate-400 mt-1">Settings are stored in this browser only. Sender and receiver read the grid size from the transmission automatically.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className={card}>
          <div className="text-sm font-semibold text-slate-100">Sender frame rate</div>
          <p className="text-xs text-slate-400">
            Each frame must stay on screen for at least two camera exposures. For a typical 30 FPS phone camera use 10–15 FPS.
          </p>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-1 font-mono tabular-nums">
            {TARGET_FPS_OPTIONS.map((fps) => (
              <button key={fps} type="button" aria-pressed={settings.targetFps === fps} onClick={() => onUpdateSettings({ targetFps: fps })} className={chip(settings.targetFps === fps)}>
                {fps}
              </button>
            ))}
          </div>
        </div>

        <div className={card}>
          <div className="text-sm font-semibold text-slate-100">Pattern density</div>
          <p className="text-xs text-slate-400">
            {gridAudit.independentBinaryDataCells.toLocaleString()} data cells · {gridAudit.usefulPayloadBytesPerDataFrame.toLocaleString()} B per DATA frame ·
            theoretical ceiling <strong className="text-slate-200">{formatSpeed(ceiling)}</strong> at {settings.targetFps} FPS if every frame is captured.
          </p>
          <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 mt-1 font-mono tabular-nums">
            {GRID_RESOLUTIONS.map((g) => (
              <button key={g} type="button" aria-pressed={settings.gridSize === g} onClick={() => onUpdateSettings({ gridSize: g })} className={chip(settings.gridSize === g)}>
                {g}
              </button>
            ))}
          </div>
        </div>

        <div className={card}>
          <div className="text-sm font-semibold text-slate-100">Parity (XOR erasure recovery)</div>
          <p className="text-xs text-slate-400">
            One parity frame per K data frames lets the receiver rebuild one missed frame per block without waiting for the next loop.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1 font-mono tabular-nums">
            {(
              [
                [4, '1 per 4'],
                [8, '1 per 8'],
                [16, '1 per 16'],
                [0, 'Off'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={settings.erasureBlockSize === k} onClick={() => onUpdateSettings({ erasureBlockSize: k })} className={chip(settings.erasureBlockSize === k)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className={card}>
          <div className="text-sm font-semibold text-slate-100">Receiver camera</div>
          <label className="text-xs text-slate-300 flex flex-col gap-1">
            <span>Camera</span>
            <select
              value={settings.selectedCameraId}
              onChange={(e) => onUpdateSettings({ selectedCameraId: e.target.value })}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
            >
              <option value="">Default rear camera</option>
              {cameras.map((cam) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label}
                </option>
              ))}
            </select>
            {cameras.length > 0 && cameras.every((c) => !c.deviceId) && (
              <span className="text-[11px] text-slate-500">Camera names appear after camera permission has been granted once.</span>
            )}
          </label>
          <label className="text-xs text-slate-300 flex flex-col gap-1">
            <span>Processing resolution (longest side)</span>
            <select
              value={settings.processingResolution}
              onChange={(e) => onUpdateSettings({ processingResolution: Number(e.target.value) as TransferSettings['processingResolution'] })}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
            >
              <option value={1280}>1280 px — fastest</option>
              <option value={1600}>1600 px — balanced</option>
              <option value={1920}>1920 px — dense grids, slower</option>
            </select>
          </label>
          <label className="text-xs text-slate-300 flex flex-col gap-1">
            <span>Same-browser completion signal</span>
            <select
              value={settings.returnChannelMode}
              onChange={(e) => onUpdateSettings({ returnChannelMode: e.target.value as TransferSettings['returnChannelMode'] })}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
            >
              <option value="broadcast_only">Signal other tabs in this browser</option>
              <option value="broadcast_and_audio">Signal other tabs + play a chime</option>
              <option value="manual_only">Off (stop the sender manually)</option>
            </select>
            <span className="text-[11px] text-slate-500">Works only between tabs of the same browser on one device; a separate phone cannot signal back.</span>
          </label>
        </div>
      </div>

      <div className="border border-slate-800 bg-slate-900/30 rounded-xl p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-slate-100">This browser</h3>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onRefreshCapabilities} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 whitespace-nowrap">
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Re-check</span>
            </button>
            <button type="button" onClick={() => void handleClearStorage()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-rose-300 hover:bg-slate-800 whitespace-nowrap">
              {clearedNotice ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Trash2 className="w-3.5 h-3.5" />}
              <span>{clearedNotice ? 'Cleared' : 'Clear stored transfer data'}</span>
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
          {[
            ['Secure context', capabilities.secureContext ? 'Yes (camera allowed)' : 'No — camera blocked'],
            ['Large-file storage', capabilities.opfsWritableSupported ? 'OPFS' : capabilities.indexedDbSupported ? 'IndexedDB' : 'Memory only'],
            ['Offline cache', swStatus],
            [
              'Storage available',
              capabilities.storageQuotaBytes !== null && capabilities.storageUsageBytes !== null
                ? `${formatBytes(Math.max(0, capabilities.storageQuotaBytes - capabilities.storageUsageBytes))} free`
                : 'Unknown',
            ],
          ].map(([k, v]) => (
            <div key={k} className="border border-slate-800/90 bg-slate-950/60 rounded-lg p-3">
              <div className="text-slate-400 font-sans">{k}</div>
              <div className="text-slate-100 font-semibold mt-1">{v}</div>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-2.5 text-xs text-slate-400 pt-1 leading-relaxed">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>
            Capacity figures are protocol arithmetic, not measured speeds. A 64×64 frame carries 423 bytes of file data and a 384×384 frame 18,183 bytes. What a
            receiver actually gets depends on the camera, focus, distance, lighting and display — measure it with two devices.
          </span>
        </div>
      </div>
    </div>
  );
};
