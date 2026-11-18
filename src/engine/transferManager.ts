export type GridResolution = 48 | 64 | 96 | 128 | 192 | 256 | 384;
export const GRID_RESOLUTIONS: GridResolution[] = [48, 64, 96, 128, 192, 256, 384];
export type TargetFps = 5 | 10 | 15 | 20 | 30 | 60;
export const TARGET_FPS_OPTIONS: TargetFps[] = [5, 10, 15, 20, 30, 60];
export type ErasureBlockSize = 0 | 4 | 8 | 16;
/**
 * auto  — alternate whole loops: grayscale (2 packets/frame), then monochrome. A receiver that can
 *         read grayscale finishes in roughly half the time; one that cannot still receives every
 *         packet from the monochrome loops. (The link is one-way, so the sender cannot ask.)
 * mono  — 1 bit per cell, most robust.
 * gray4 — 2 bits per cell (4 levels); needs ≈ 6+ camera pixels per cell and good focus.
 */
export type TransmissionMode = 'auto' | 'mono' | 'gray4';
export const TRANSMISSION_MODES: TransmissionMode[] = ['auto', 'mono', 'gray4'];

/** Frame encoding for a frame whose first packet belongs to `loopCycle`. */
export function frameModeFor(mode: TransmissionMode, loopCycle: number): 'mono' | 'gray4' {
  if (mode === 'auto') return loopCycle % 2 === 0 ? 'gray4' : 'mono';
  return mode;
}

export interface TransferSettings {
  /**
   * Frames per second the SENDER tries to show. Each frame must stay on screen for at least two
   * camera exposures to be captured without tearing, so this should be ≤ about half of the
   * receiving camera's frame rate (e.g. ≤ 15 for a 30 FPS camera).
   */
  targetFps: TargetFps;
  gridSize: GridResolution;
  erasureBlockSize: ErasureBlockSize;
  selectedCameraId: string;
  returnChannelMode: 'broadcast_and_audio' | 'broadcast_only' | 'manual_only';
  quietZoneCells: number;
  transmissionMode: TransmissionMode;
  /** Longest side (px) of camera frames handed to the decoder. */
  processingResolution: 1280 | 1600 | 1920;
}

export const DEFAULT_SETTINGS: TransferSettings = {
  targetFps: 15,
  gridSize: 96,
  erasureBlockSize: 8,
  selectedCameraId: '',
  returnChannelMode: 'broadcast_only',
  quietZoneCells: 2,
  processingResolution: 1600,
  transmissionMode: 'auto',
};

export interface SpeedPreset {
  id: 'reliable' | 'balanced' | 'fast';
  label: string;
  description: string;
  settings: Pick<TransferSettings, 'targetFps' | 'gridSize' | 'transmissionMode'>;
}

/** Presets trade speed for robustness; the receiver needs more camera pixels per cell for faster ones. */
export const SPEED_PRESETS: SpeedPreset[] = [
  { id: 'reliable', label: 'Reliable', description: 'Black & white 64×64 at 10 FPS. Works with almost any phone.', settings: { targetFps: 10, gridSize: 64, transmissionMode: 'mono' } },
  { id: 'balanced', label: 'Balanced', description: 'Auto encoding 96×96 at 15 FPS. Pattern should fill most of the camera view.', settings: { targetFps: 15, gridSize: 96, transmissionMode: 'auto' } },
  { id: 'fast', label: 'Fast', description: 'Grayscale 128×128 at 20 FPS. Needs a large sharp screen and a steady hold. 20 FPS is the highest rate a 30 FPS phone camera reliably catches.', settings: { targetFps: 20, gridSize: 128, transmissionMode: 'gray4' } },
];

/** Validates settings loaded from localStorage (untrusted / possibly from an older version). */
export function sanitizeSettings(raw: unknown): TransferSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  return {
    targetFps: pick(s.targetFps, TARGET_FPS_OPTIONS, DEFAULT_SETTINGS.targetFps),
    gridSize: pick(s.gridSize, GRID_RESOLUTIONS, DEFAULT_SETTINGS.gridSize),
    erasureBlockSize: pick(s.erasureBlockSize, [0, 4, 8, 16] as const, DEFAULT_SETTINGS.erasureBlockSize),
    selectedCameraId: typeof s.selectedCameraId === 'string' ? s.selectedCameraId.slice(0, 256) : '',
    returnChannelMode: pick(s.returnChannelMode, ['broadcast_and_audio', 'broadcast_only', 'manual_only'] as const, DEFAULT_SETTINGS.returnChannelMode),
    quietZoneCells: pick(s.quietZoneCells, [2, 3, 4] as const, DEFAULT_SETTINGS.quietZoneCells),
    processingResolution: pick(s.processingResolution, [1280, 1600, 1920] as const, DEFAULT_SETTINGS.processingResolution),
    transmissionMode: pick(s.transmissionMode, TRANSMISSION_MODES, DEFAULT_SETTINGS.transmissionMode),
  };
}

export interface SenderTelemetry {
  isTransmitting: boolean;
  isPaused: boolean;
  /** Measured frames actually drawn per second. */
  displayFps: number;
  /** DATA payload bytes drawn per second (measured on the sender; not what a receiver gets). */
  dataBytesShownPerSec: number;
  packetsTransmitted: number;
  currentPacketIndex: number;
  totalSourcePackets: number;
  loopCycles: number;
  returnChannelConfirmed: boolean;
  returnChannelSource: string | null;
  /** Module size on screen in device pixels. */
  modulePx: number;
}

export interface CompletionConfirmationPayload {
  type: 'FLASHDROP_TRANSFER_COMPLETE';
  transferId: number;
  sha256: string;
  timestamp: number;
}

/**
 * Optional Local Return Channel for Completion Confirmation.
 */
export class LocalReturnChannel {
  private channel: BroadcastChannel | null = null;
  private onCompleteCallback: ((payload: CompletionConfirmationPayload) => void) | null = null;

  constructor(onComplete?: (payload: CompletionConfirmationPayload) => void) {
    this.onCompleteCallback = onComplete ?? null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('flashdrop_local_return_v1');
        this.channel.onmessage = (event) => {
          const data = event.data as CompletionConfirmationPayload;
          if (data && data.type === 'FLASHDROP_TRANSFER_COMPLETE' && this.onCompleteCallback) {
            this.onCompleteCallback(data);
          }
        };
      } catch {
        this.channel = null;
      }
    }
  }

  emitCompletionSignal(
    transferId: number,
    sha256: string,
    mode: TransferSettings['returnChannelMode']
  ): { sentBroadcast: boolean; playedAcousticTone: boolean } {
    let sentBroadcast = false;
    let playedAcousticTone = false;

    if (mode !== 'manual_only' && this.channel) {
      try {
        const msg: CompletionConfirmationPayload = {
          type: 'FLASHDROP_TRANSFER_COMPLETE',
          transferId,
          sha256,
          timestamp: Date.now(),
        };
        this.channel.postMessage(msg);
        sentBroadcast = true;
      } catch {
        sentBroadcast = false;
      }
    }

    if (mode === 'broadcast_and_audio' && typeof window !== 'undefined') {
      playedAcousticTone = this.playCompletionChime();
    }

    return { sentBroadcast, playedAcousticTone };
  }

  private playCompletionChime(): boolean {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return false;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.setValueAtTime(1318.5, now + 0.12);
      osc2.frequency.setValueAtTime(1760, now);
      osc2.frequency.setValueAtTime(2637, now + 0.12);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.36);
      osc2.stop(now + 0.36);
      setTimeout(() => {
        void ctx.close().catch(() => {});
      }, 500);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

export function createSampleDiagnosticFile(
  sizeBytes = 16 * 1024,
  fileName = 'flashdrop-diagnostic-payload.txt'
): File {
  const buffer = new Uint8Array(sizeBytes);
  const headerText = [
    '====================================================================',
    'FLASHDROP OPTICAL TRANSFER DIAGNOSTIC PAYLOAD',
    '====================================================================',
    `Generated Timestamp: ${new Date().toISOString()}`,
    'Protocol: Custom Monochrome Binary Matrix (Black = 0, White = 1, Sync = 0xFD4F)',
    'Capabilities Verified: Join-Anywhere Carousel + XOR Erasure Coding + SHA-256',
    '--------------------------------------------------------------------\n',
  ].join('\n');

  const encodedHeader = new TextEncoder().encode(headerText);
  const copyLen = Math.min(encodedHeader.byteLength, sizeBytes);
  buffer.set(encodedHeader.subarray(0, copyLen), 0);

  // Fill remainder with deterministic printable ASCII rows in O(N) without string concatenation overhead
  const pattern = new TextEncoder().encode(
    'ROW_DATA :: 01000110 01001100 01000001 01010011 01001000 01000100 01010010 01001111 01010000\n'
  );
  let offset = copyLen;
  while (offset < sizeBytes) {
    const take = Math.min(pattern.byteLength, sizeBytes - offset);
    buffer.set(pattern.subarray(0, take), offset);
    offset += take;
  }

  return new File([buffer], fileName, {
    type: 'text/plain;charset=utf-8',
  });
}
