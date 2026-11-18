import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Camera, Cpu, Radio, ShieldCheck, Sliders } from 'lucide-react';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { Settings } from './components/Settings';
import { CapacityAuditPanel } from './components/CapacityAuditPanel';
import { auditGridCapacity } from './engine/capacityAudit';
import { sanitizeSettings, TransferSettings } from './engine/transferManager';
import { BrowserCapabilities, detectBrowserCapabilities } from './utils/browserSupport';
import { formatBytes, formatSpeed } from './utils/integrity';

type ActiveView = 'home' | 'send' | 'receive' | 'settings';
const VIEWS: ActiveView[] = ['home', 'send', 'receive', 'settings'];

function viewFromLocation(): ActiveView {
  if (typeof window === 'undefined') return 'home';
  const hash = window.location.hash.replace('#', '') as ActiveView;
  if (VIEWS.includes(hash)) return hash;
  const q = new URLSearchParams(window.location.search).get('view') as ActiveView | null;
  return q && VIEWS.includes(q) ? q : 'home';
}

export default function App() {
  const [activeView, setActiveViewState] = useState<ActiveView>(viewFromLocation);
  const setActiveView = useCallback((v: ActiveView) => {
    setActiveViewState(v);
    if (window.location.hash !== `#${v}`) window.history.pushState(null, '', `#${v}`);
  }, []);
  useEffect(() => {
    const onPop = () => setActiveViewState(viewFromLocation());
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);
  const [updateReady, setUpdateReady] = useState<ServiceWorker | null>(null);

  const [autoStartLoopback, setAutoStartLoopback] = useState(false);
  const [settings, setSettings] = useState<TransferSettings>(() => {
    try {
      const saved = localStorage.getItem('flashdrop_settings_v2');
      return sanitizeSettings(saved ? JSON.parse(saved) : null);
    } catch {
      return sanitizeSettings(null);
    }
  });

  const [capabilities, setCapabilities] = useState<BrowserCapabilities>({
    secureContext: false,
    cameraSupported: false,
    opfsSupported: false,
    opfsWritableSupported: false,
    indexedDbSupported: false,
    serviceWorkerSupported: false,
    webAudioSupported: false,
    broadcastChannelSupported: false,
    wakeLockSupported: false,
    storageQuotaBytes: null,
    storageUsageBytes: null,
    userAgentSummary: 'Detecting browser capabilities…',
  });

  const [swStatus, setSwStatus] = useState<string>(import.meta.env.PROD ? 'Checking…' : 'Off in development');

  const refreshCapabilities = () => {
    void detectBrowserCapabilities().then(setCapabilities);
  };

  useEffect(() => {
    refreshCapabilities();
    const onUpdate = (e: Event) => setUpdateReady((e as CustomEvent<ServiceWorker>).detail);
    window.addEventListener('flashdrop:update-ready', onUpdate);
    if (!import.meta.env.PROD) return () => window.removeEventListener('flashdrop:update-ready', onUpdate);
    if (!('serviceWorker' in navigator)) {
      setSwStatus('Not supported');
      return () => window.removeEventListener('flashdrop:update-ready', onUpdate);
    }
    let cancelled = false;
    void navigator.serviceWorker.ready
      .then(async (reg) => {
        if (cancelled) return;
        const keys = await caches.keys().catch(() => [] as string[]);
        setSwStatus(reg.active && keys.some((k) => k.startsWith('flashdrop-')) ? 'Ready for offline use' : 'Installing…');
      })
      .catch(() => setSwStatus('Unavailable'));
    return () => {
      cancelled = true;
      window.removeEventListener('flashdrop:update-ready', onUpdate);
    };
  }, []);

  const handleUpdateSettings = (partial: Partial<TransferSettings>) => {
    setSettings((prev) => {
      const next = sanitizeSettings({ ...prev, ...partial });
      try {
        localStorage.setItem('flashdrop_settings_v2', JSON.stringify(next));
      } catch {
        // Ignore
      }
      return next;
    });
  };

  const launchLoopbackDemo = () => {
    setAutoStartLoopback(true);
    setActiveView('receive');
  };

  const activeAudit = auditGridCapacity(settings.gridSize, settings.erasureBlockSize, 6);
  const bytesPerFrame = activeAudit.usefulPayloadBytesPerDataFrame;
  const carouselUsefulCeilingSpeed = activeAudit.effectiveUsefulBytesPerEmittedFrame * settings.targetFps;

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Zone 1 (Wordmark) — Zone 2 (4 Single-Line Links) — Zone 3 (1 Primary CTA) */}
      <header className="flex items-center justify-between gap-3 sm:gap-8 px-3 sm:px-6 py-3.5 sm:py-4 border-b border-slate-800/90 bg-[#090D16]/95 sticky top-0 z-40 backdrop-blur">
        <a
          href="#home"
          onClick={(e) => {
            e.preventDefault();
            setActiveView('home');
          }}
          className="text-base sm:text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          DropFlash
        </a>

        <nav
          aria-label="Primary Navigation"
          className="flex items-center gap-3 sm:gap-6 text-xs sm:text-sm font-medium text-slate-400 overflow-x-auto"
        >
          <a
            href="#home"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('home');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'home' ? 'text-slate-100 underline underline-offset-8 decoration-sky-400' : ''
            }`}
          >
            Overview
          </a>
          <a
            href="#send"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('send');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'send' ? 'text-slate-100 underline underline-offset-8 decoration-sky-400' : ''
            }`}
          >
            Send Files
          </a>
          <a
            href="#receive"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('receive');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'receive'
                ? 'text-slate-100 underline underline-offset-8 decoration-sky-400'
                : ''
            }`}
          >
            Receive Files
          </a>
          <a
            href="#settings"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('settings');
            }}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'settings'
                ? 'text-slate-100 underline underline-offset-8 decoration-sky-400'
                : ''
            }`}
          >
            Settings
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={launchLoopbackDemo}
            className="px-2.5 sm:px-4 py-1.5 sm:py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            Run Loopback Test
          </button>
        </div>
      </header>

      {updateReady && (
        <div role="status" className="bg-sky-950/60 border-b border-sky-500/30 px-4 py-2 text-xs text-sky-100 flex flex-wrap items-center justify-center gap-3">
          <span>A new version of DropFlash is ready.</span>
          <button
            type="button"
            onClick={() => {
              navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
              updateReady.postMessage({ type: 'SKIP_WAITING' });
            }}
            className="px-2.5 py-1 rounded-md bg-sky-500 text-slate-950 font-semibold"
          >
            Reload now
          </button>
          <span className="text-sky-300/70">(finish any transfer first)</span>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 w-full max-w-[1240px] mx-auto px-4 sm:px-6 py-8">
        {activeView === 'home' && (
          <div className="flex flex-col gap-10">
            {/* Hero Section */}
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
              <div className="lg:col-span-7 flex flex-col justify-between border border-slate-800 bg-[#0B101B] rounded-xl p-6 sm:p-8">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums mb-4">
                    <span>Screen-to-camera transfer</span>
                    <span aria-hidden="true">·</span>
                    <span>No network needed</span>
                    <span aria-hidden="true">·</span>
                    <span>Offline: {swStatus}</span>
                  </div>

                  <h1
                    className="text-3xl sm:text-4xl font-bold text-slate-100 tracking-tight leading-tight"
                    style={{ textWrap: 'balance' }}
                  >
                    Send files from one screen to another device’s camera
                  </h1>

                  <p className="text-sm sm:text-base text-slate-300 mt-4 leading-relaxed max-w-[65ch]">
                    DropFlash shows a file as a looping sequence of black-and-white patterns. The receiving device films the screen, can join at any point in the loop, rebuilds occasional missed frames from parity frames, and checks the result with SHA-256. Nothing is uploaded anywhere. Speeds are modest and depend heavily on the camera — this is an experimental tool, best for small files.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 mt-8 pt-6 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setActiveView('send')}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Radio className="w-4 h-4" />
                    <span>Send Files</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveView('receive')}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Camera className="w-4 h-4 text-sky-400" />
                    <span>Receive Files</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveView('settings')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Sliders className="w-4 h-4" />
                    <span>Configure {settings.targetFps} FPS / {settings.gridSize}×{settings.gridSize}</span>
                  </button>
                </div>
              </div>

              {/* Right Column: Live Interactive Protocol Capabilities Card */}
              <div className="lg:col-span-5 border border-slate-800 bg-[#0B101B] rounded-xl p-6 sm:p-8 flex flex-col justify-between gap-6">
                <div>
                  <h2 className="text-base font-semibold text-slate-100">
                    Continuous Carousel & Erasure Architecture
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    How a one-way optical link stays reliable.
                  </p>

                  <div className="mt-5 space-y-4 text-xs text-slate-300">
                    <div className="border-b border-slate-800/80 pb-3">
                      <div className="font-semibold text-slate-100">
                        01. Join-Anywhere Carousel Loop
                      </div>
                      <p className="text-slate-400 mt-1">
                        A manifest frame repeats every 6 frames, so a receiver can start at any point; packets are stored out of order until the loop wraps around.
                      </p>
                    </div>

                    <div className="border-b border-slate-800/80 pb-3">
                      <div className="font-semibold text-slate-100">
                        02. XOR Block Erasure Coding & CRC-32
                      </div>
                      <p className="text-slate-400 mt-1">
                        Every frame carries a CRC-32; damaged frames are discarded. One parity frame per block rebuilds a single missed frame without waiting for the next loop.
                      </p>
                    </div>

                    <div>
                      <div className="font-semibold text-slate-100">
                        03. Streaming storage & SHA-256
                      </div>
                      <p className="text-slate-400 mt-1">
                        Files are read in slices and, when large, written straight to browser storage (OPFS or IndexedDB) within the site’s quota. Large files take a long time over an optical link.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-800/80 flex items-center justify-between gap-4">
                  <div className="text-xs text-slate-400 font-mono tabular-nums">
                    <div>
                      Profile: {settings.gridSize}×{settings.gridSize} ({activeAudit.independentBinaryDataCells.toLocaleString()} data bits) @ {settings.targetFps} FPS
                    </div>
                    <div className="text-sky-400 font-medium mt-0.5">
                      {bytesPerFrame.toLocaleString()} B per data frame · ≤ {formatSpeed(carouselUsefulCeilingSpeed)} if every frame is captured
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={launchLoopbackDemo}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Run loopback test</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </section>

            {/* Full-Width 4-Column Hardware & Browser Readiness Strip */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono tabular-nums">
              <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4">
                <div className="text-xs text-slate-400 font-sans">Offline use</div>
                <div className="text-sm font-semibold text-slate-100 mt-1">{swStatus}</div>
                <div className="text-[11px] text-slate-400 mt-1 font-sans">After one online visit, reopen the same HTTPS address offline</div>
              </div>

              <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4">
                <div className="text-xs text-slate-400 font-sans">Large-File Storage Engine</div>
                <div className="text-sm font-semibold text-slate-100 mt-1">
                  {capabilities.opfsWritableSupported ? 'OPFS streaming' : capabilities.indexedDbSupported ? 'IndexedDB chunks' : 'Memory only'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1 font-sans">
                  Quota:{' '}
                  {capabilities.storageQuotaBytes
                    ? formatBytes(capabilities.storageQuotaBytes)
                    : 'Browser Managed'}
                </div>
              </div>

              <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4">
                <div className="text-xs text-slate-400 font-sans">Optical Camera API</div>
                <div className="text-sm font-semibold text-slate-100 mt-1">
                  {!capabilities.cameraSupported ? 'Not available' : capabilities.secureContext ? 'Available' : 'Needs HTTPS'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1 font-sans">
                  {capabilities.userAgentSummary}
                </div>
              </div>

              <div className="border border-slate-800 bg-[#0B101B] rounded-xl p-4">
                <div className="text-xs text-slate-400 font-sans">Integrity & Return Link</div>
                <div className="text-sm font-semibold text-emerald-400 mt-1">CRC-32 per frame + SHA-256 per file</div>
                <div className="text-[11px] text-slate-400 mt-1 font-sans">Stop the sender manually when the receiver verifies</div>
              </div>
            </section>

            {/* Full Engineering Capacity & Real-Camera Audit Panel */}
            <CapacityAuditPanel />
          </div>
        )}

        {activeView === 'send' && (
          <Sender settings={settings} onUpdateSettings={handleUpdateSettings} />
        )}

        {activeView === 'receive' && (
          <Receiver
            settings={settings}
            autoStartLoopback={autoStartLoopback}
            onAutoStartConsumed={() => setAutoStartLoopback(false)}
          />
        )}

        {activeView === 'settings' && (
          <Settings
            settings={settings}
            capabilities={capabilities}
            swStatus={swStatus}
            onUpdateSettings={handleUpdateSettings}
            onRefreshCapabilities={refreshCapabilities}
          />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 px-6 py-4 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-4 max-w-[1240px] w-full mx-auto">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-slate-400" />
          <span>DropFlash — runs entirely in your browser; files never leave the two devices</span>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setActiveView('send')}
            className="hover:text-slate-200 transition-colors"
          >
            Sender
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => setActiveView('receive')}
            className="hover:text-slate-200 transition-colors"
          >
            Receiver
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => setActiveView('settings')}
            className="hover:text-slate-200 transition-colors"
          >
            Protocol Settings
          </button>
        </div>
      </footer>
    </div>
  );
}
