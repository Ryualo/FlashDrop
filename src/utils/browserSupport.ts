export interface BrowserCapabilities {
  secureContext: boolean;
  cameraSupported: boolean;
  opfsSupported: boolean;
  /** OPFS FileSystemFileHandle.createWritable (needed for streaming large received files). */
  opfsWritableSupported: boolean;
  indexedDbSupported: boolean;
  serviceWorkerSupported: boolean;
  webAudioSupported: boolean;
  broadcastChannelSupported: boolean;
  wakeLockSupported: boolean;
  storageQuotaBytes: number | null;
  storageUsageBytes: number | null;
  userAgentSummary: string;
}

export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
  if (!isBrowser) {
    return {
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
      userAgentSummary: 'Node / Headless Environment',
    };
  }

  const secureContext = Boolean(window.isSecureContext);
  const cameraSupported = Boolean(
    navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  const opfsSupported = Boolean(
    navigator.storage && typeof navigator.storage.getDirectory === 'function'
  );
  const opfsWritableSupported =
    opfsSupported &&
    typeof (globalThis as unknown as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle !== 'undefined' &&
    'createWritable' in (globalThis as unknown as { FileSystemFileHandle: { prototype: object } }).FileSystemFileHandle.prototype;
  const indexedDbSupported = typeof indexedDB !== 'undefined';
  const serviceWorkerSupported = 'serviceWorker' in navigator;
  const webAudioSupported = Boolean(
    window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
  );
  const broadcastChannelSupported = typeof BroadcastChannel !== 'undefined';
  const wakeLockSupported = 'wakeLock' in navigator;

  let storageQuotaBytes: number | null = null;
  let storageUsageBytes: number | null = null;

  if (navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      const estimate = await navigator.storage.estimate();
      storageQuotaBytes = estimate.quota ?? null;
      storageUsageBytes = estimate.usage ?? null;
    } catch {
      // Ignore quota estimation errors on restricted origins
    }
  }

  const ua = navigator.userAgent;
  // Coarse platform label for display only (never used for feature decisions).
  let userAgentSummary = 'Desktop browser';
  if (/Android/i.test(ua)) userAgentSummary = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) userAgentSummary = 'iOS / iPadOS (WebKit)';
  else if (/Macintosh/i.test(ua)) userAgentSummary = 'macOS';
  else if (/Windows/i.test(ua)) userAgentSummary = 'Windows';
  else if (/Linux/i.test(ua)) userAgentSummary = 'Linux';

  return {
    secureContext,
    cameraSupported,
    opfsSupported,
    opfsWritableSupported,
    indexedDbSupported,
    serviceWorkerSupported,
    webAudioSupported,
    broadcastChannelSupported,
    wakeLockSupported,
    storageQuotaBytes,
    storageUsageBytes,
    userAgentSummary,
  };
}

export async function requestScreenWakeLock(): Promise<WakeLockSentinel | null> {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      return await navigator.wakeLock.request('screen');
    } catch {
      return null;
    }
  }
  return null;
}
