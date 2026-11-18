import { decodeManifestPayload, DropFlashPacket, PacketType, TransferManifest } from './packetProtocol';
import { PacketRecoveryTracker } from './packetRecovery';
import { ChunkedFileStorage, ChunkedStorageOptions, StorageBackend, StorageError } from '../storage/opfsStorage';
import { saveTransferMetadata } from '../storage/indexedDB';

export type ReconstructorStatus =
  | 'waiting_manifest'
  | 'receiving'
  | 'verifying'
  | 'completed'
  | 'integrity_error'
  | 'storage_error';

export interface ReconstructorState {
  status: ReconstructorStatus;
  manifest: TransferManifest | null;
  storageBackend: StorageBackend | 'Pending';
  receivedPackets: number;
  totalPackets: number;
  uniqueBytesReceived: number;
  /** Unique verified-by-CRC payload bytes per second since the first accepted frame. */
  usefulThroughputBytesPerSec: number;
  etaSeconds: number | null;
  duplicatePackets: number;
  parityRecoveredPackets: number;
  preManifestBufferedPackets: number;
  joinedAtPacketIndex: number | null;
  resumedFromInterrupted: boolean;
  verified: boolean | null;
  computedSha256: string | null;
  downloadBlob: Blob | null;
  receivedBitmap: Uint8Array | null;
  /** Packets dropped because ingestion was still busy (bounded queue / backpressure). */
  backpressureDrops: number;
  /** CRC-valid packets rejected because they were inconsistent with the manifest. */
  rejectedPackets: number;
  /** A different transfer was seen while one is in progress. */
  otherTransferSeen: { transferId: number; fileName: string } | null;
  errorMessage: string | null;
  verifyProgress: number;
}

export interface ReconstructorOptions {
  storage?: ChunkedStorageOptions;
  /** Max packets waiting for ingestion; extra packets are dropped (carousel repeats them). */
  maxQueuedPackets?: number;
  /** Persist progress metadata (IndexedDB) every N new packets. */
  metadataEveryPackets?: number;
  now?: () => number;
}

const MAX_PRE_MANIFEST_QUEUE = 64;

/**
 * Join-anywhere incremental file reconstructor.
 *
 * All packet processing is serialised through a single promise chain so that storage writes and
 * the final verification can never interleave (previously a late write could race with
 * finalisation). The queue is bounded: when the camera produces packets faster than storage can
 * absorb them, packets are dropped and counted — the sender's carousel repeats them.
 */
export class IncrementalFileReconstructor {
  private manifest: TransferManifest | null = null;
  private tracker: PacketRecoveryTracker | null = null;
  private storage: ChunkedFileStorage | null = null;
  private storageBackend: StorageBackend | 'Pending' = 'Pending';
  private preManifestQueue: DropFlashPacket[] = [];

  private status: ReconstructorStatus = 'waiting_manifest';
  private joinedAtPacketIndex: number | null = null;
  private resumedFromInterrupted = false;
  private uniqueBytesReceived = 0;
  private startTime: number | null = null;
  private lastProgressTime: number | null = null;
  private usefulThroughputBytesPerSec = 0;
  private verified: boolean | null = null;
  private computedSha256: string | null = null;
  private downloadBlob: Blob | null = null;
  private backpressureDrops = 0;
  private rejectedPackets = 0;
  private otherTransferSeen: { transferId: number; fileName: string } | null = null;
  private errorMessage: string | null = null;
  private verifyProgress = 0;
  private packetsSinceMetadata = 0;

  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private generation = 0;
  private readonly options: ReconstructorOptions;
  private readonly now: () => number;

  constructor(options: ReconstructorOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  /**
   * Resets for a fresh transfer. With `preserveIncompleteTransfer` an in-progress transfer is kept
   * (scanning can continue in this page session; state is not persisted across reloads).
   */
  reset(preserveIncompleteTransfer = false): void {
    if (preserveIncompleteTransfer && this.status === 'receiving' && this.manifest) {
      this.resumedFromInterrupted = true;
      return;
    }
    const oldStorage = this.storage;
    const wasComplete = this.status === 'completed';
    this.generation++;
    this.chain = Promise.resolve();
    this.queued = 0;
    this.manifest = null;
    this.tracker = null;
    this.storage = null;
    this.storageBackend = 'Pending';
    this.preManifestQueue = [];
    this.status = 'waiting_manifest';
    this.joinedAtPacketIndex = null;
    this.resumedFromInterrupted = false;
    this.uniqueBytesReceived = 0;
    this.startTime = null;
    this.lastProgressTime = null;
    this.usefulThroughputBytesPerSec = 0;
    this.verified = null;
    this.computedSha256 = null;
    this.downloadBlob = null;
    this.backpressureDrops = 0;
    this.rejectedPackets = 0;
    this.otherTransferSeen = null;
    this.errorMessage = null;
    this.verifyProgress = 0;
    this.packetsSinceMetadata = 0;
    if (oldStorage && !wasComplete) void oldStorage.discard();
  }

  getState(): ReconstructorState {
    let etaSeconds: number | null = null;
    if (this.manifest && this.status === 'receiving' && this.usefulThroughputBytesPerSec > 0) {
      etaSeconds = Math.max(0, this.manifest.fileSize - this.uniqueBytesReceived) / this.usefulThroughputBytesPerSec;
    } else if (this.status === 'completed') {
      etaSeconds = 0;
    }
    return {
      status: this.status,
      manifest: this.manifest,
      storageBackend: this.storageBackend,
      receivedPackets: this.tracker ? this.tracker.getReceivedCount() : 0,
      totalPackets: this.manifest ? this.manifest.totalSourcePackets : 0,
      uniqueBytesReceived: this.uniqueBytesReceived,
      usefulThroughputBytesPerSec: this.usefulThroughputBytesPerSec,
      etaSeconds,
      duplicatePackets: this.tracker ? this.tracker.getDuplicateCount() : 0,
      parityRecoveredPackets: this.tracker ? this.tracker.getParityRecoveryCount() : 0,
      preManifestBufferedPackets: this.preManifestQueue.length,
      joinedAtPacketIndex: this.joinedAtPacketIndex,
      resumedFromInterrupted: this.resumedFromInterrupted,
      verified: this.verified,
      computedSha256: this.computedSha256,
      downloadBlob: this.downloadBlob,
      receivedBitmap: this.tracker ? this.tracker.getBitmapSnapshot() : null,
      backpressureDrops: this.backpressureDrops,
      rejectedPackets: this.rejectedPackets,
      otherTransferSeen: this.otherTransferSeen,
      errorMessage: this.errorMessage,
      verifyProgress: this.verifyProgress,
    };
  }

  /** Missing packets right now (first ranges) and blocks that need only their parity frame. */
  getMissingSummary(limit = 6): { ranges: Array<[number, number]>; awaitingParity: number } {
    if (!this.tracker) return { ranges: [], awaitingParity: 0 };
    return { ranges: this.tracker.missingRanges(limit), awaitingParity: this.tracker.blocksAwaitingParityOnly() };
  }

  /** Number of packets accepted but not yet processed. */
  getQueueDepth(): number {
    return this.queued;
  }

  /** Waits until every queued packet has been processed (tests / shutdown). */
  async drain(): Promise<ReconstructorState> {
    await this.chain;
    return this.getState();
  }

  /**
   * Queues a CRC-valid packet. Resolves with the state after this packet was processed, or
   * immediately (with the current state) if the packet was dropped due to backpressure.
   */
  ingestPacket(packet: DropFlashPacket): Promise<ReconstructorState> {
    if (this.status === 'completed' || this.status === 'integrity_error' || this.status === 'storage_error' || this.status === 'verifying') {
      return Promise.resolve(this.getState());
    }
    const maxQueued = this.options.maxQueuedPackets ?? 16;
    if (this.queued >= maxQueued) {
      this.backpressureDrops++;
      return Promise.resolve(this.getState());
    }
    this.queued++;
    const gen = this.generation;
    const run = this.chain.then(async () => {
      if (gen !== this.generation) return;
      try {
        await this.process(packet, gen);
      } catch (e) {
        if (gen !== this.generation) return;
        this.status = 'storage_error';
        this.errorMessage = e instanceof Error ? e.message : String(e);
      } finally {
        if (gen === this.generation) this.queued = Math.max(0, this.queued - 1);
      }
    });
    this.chain = run.catch(() => undefined);
    return run.then(() => this.getState());
  }

  private async process(packet: DropFlashPacket, gen: number): Promise<void> {
    if (this.status !== 'waiting_manifest' && this.status !== 'receiving') return;
    const t = this.now();
    if (this.startTime === null) this.startTime = t;

    if (packet.packetType === PacketType.MANIFEST) {
      const decoded = decodeManifestPayload(packet.payload);
      if (!decoded || decoded.transferId !== packet.transferId || decoded.totalSourcePackets !== packet.totalSourcePackets) {
        this.rejectedPackets++;
        return;
      }
      if (!this.manifest) {
        await this.initializeFromManifest(decoded, gen);
      } else if (decoded.transferId !== this.manifest.transferId) {
        if ((this.tracker?.getReceivedCount() ?? 0) === 0) {
          // Nothing received yet for the old transfer: follow the screen.
          const old = this.storage;
          this.manifest = null;
          this.tracker = null;
          this.storage = null;
          if (old) void old.discard();
          await this.initializeFromManifest(decoded, gen);
        } else {
          this.otherTransferSeen = { transferId: decoded.transferId, fileName: decoded.fileName };
        }
      }
      return;
    }

    if (!this.manifest || !this.tracker || !this.storage) {
      if (this.preManifestQueue.length < MAX_PRE_MANIFEST_QUEUE) this.preManifestQueue.push(packet);
      if (this.joinedAtPacketIndex === null && packet.packetType === PacketType.DATA) {
        this.joinedAtPacketIndex = packet.packetIndex;
      }
      return;
    }
    if (packet.transferId !== this.manifest.transferId) return;
    if (this.joinedAtPacketIndex === null && packet.packetType === PacketType.DATA) {
      this.joinedAtPacketIndex = packet.packetIndex;
    }
    await this.processActivePacket(packet);
  }

  private expectedLength(index: number): number {
    const m = this.manifest!;
    return Math.max(0, Math.min(m.chunkSize, m.fileSize - index * m.chunkSize));
  }

  private async initializeFromManifest(manifest: TransferManifest, gen: number): Promise<void> {
    const storage = new ChunkedFileStorage(
      manifest.transferId,
      manifest.fileName,
      manifest.fileSize,
      manifest.chunkSize,
      manifest.totalSourcePackets,
      this.options.storage
    );
    this.manifest = manifest;
    this.tracker = new PacketRecoveryTracker(manifest.totalSourcePackets, manifest.erasureBlockSize, manifest.chunkSize, {
      expectedLength: (i) => this.expectedLength(i),
    });
    let backend: StorageBackend;
    try {
      backend = (await storage.init()).backend;
    } catch (e) {
      if (gen !== this.generation) return;
      this.status = 'storage_error';
      this.errorMessage = e instanceof StorageError || e instanceof Error ? e.message : String(e);
      return;
    }
    if (gen !== this.generation) {
      void storage.discard();
      return;
    }
    this.storage = storage;
    this.storageBackend = backend;
    this.status = 'receiving';

    const queued = this.preManifestQueue.splice(0, this.preManifestQueue.length);
    for (const pkt of queued) {
      if (pkt.transferId === manifest.transferId) await this.processActivePacket(pkt);
    }
  }

  private validate(packet: DropFlashPacket): boolean {
    const m = this.manifest!;
    if (packet.totalSourcePackets !== m.totalSourcePackets || packet.gridSize !== m.gridSize) return false;
    if (packet.packetType === PacketType.DATA) {
      if (packet.packetIndex >= m.totalSourcePackets) return false;
      return packet.payload.byteLength === this.expectedLength(packet.packetIndex);
    }
    if (packet.packetType === PacketType.PARITY) {
      if (m.erasureBlockSize < 2) return false;
      if (packet.erasureBlockSize !== m.erasureBlockSize) return false;
      return packet.payload.byteLength === m.chunkSize + 2;
    }
    return false;
  }

  private async processActivePacket(packet: DropFlashPacket): Promise<void> {
    if (!this.tracker || !this.storage || !this.manifest || this.status !== 'receiving') return;
    if (!this.validate(packet)) {
      this.rejectedPackets++;
      return;
    }
    const events =
      packet.packetType === PacketType.DATA
        ? this.tracker.ingestDataPacket(packet.packetIndex, packet.payload)
        : this.tracker.ingestParityPacket(packet.packetIndex, packet.payload);

    for (const ev of events) {
      await this.storage.writeChunk(ev.packetIndex, ev.payload);
      this.uniqueBytesReceived += ev.payload.byteLength;
    }
    const t = this.now();
    if (events.length > 0) this.lastProgressTime = t;
    if (this.startTime !== null) {
      const elapsedSec = Math.max(0.001, (t - this.startTime) / 1000);
      this.usefulThroughputBytesPerSec = this.uniqueBytesReceived / elapsedSec;
    }

    this.packetsSinceMetadata += events.length;
    if (this.packetsSinceMetadata >= (this.options.metadataEveryPackets ?? 50)) {
      this.packetsSinceMetadata = 0;
      void saveTransferMetadata(this.metadataRecord(false, false));
    }

    if (this.tracker.isComplete()) {
      await this.finalizeReconstruction();
    }
  }

  private metadataRecord(completed: boolean, verified: boolean) {
    const m = this.manifest!;
    return {
      transferId: m.transferId,
      fileId: m.fileId,
      fileName: m.fileName,
      fileSize: m.fileSize,
      mimeType: m.mimeType,
      sha256: m.sha256,
      chunkSize: m.chunkSize,
      totalSourcePackets: m.totalSourcePackets,
      erasureBlockSize: m.erasureBlockSize,
      receivedCount: this.tracker ? this.tracker.getReceivedCount() : 0,
      completed,
      verified,
      updatedAt: Date.now(),
    };
  }

  private async finalizeReconstruction(): Promise<void> {
    if (!this.storage || !this.manifest || !this.tracker) return;
    this.status = 'verifying';
    if (this.startTime !== null && this.lastProgressTime !== null) {
      const elapsedSec = Math.max(0.001, (this.lastProgressTime - this.startTime) / 1000);
      this.usefulThroughputBytesPerSec = this.manifest.fileSize / elapsedSec;
    }
    try {
      const result = await this.storage.verifyAndFinalize(this.manifest.sha256, this.manifest.mimeType, (done, total) => {
        this.verifyProgress = total > 0 ? done / total : 1;
      });
      this.verified = result.verified;
      this.computedSha256 = result.actualSha256;
      this.downloadBlob = result.verified ? result.blob : null;
      this.status = result.verified ? 'completed' : 'integrity_error';
      this.errorMessage = result.verified
        ? null
        : 'The reassembled file does not match the sender’s SHA-256. It was discarded; restart the transfer.';
      if (!result.verified) void this.storage.discard();
    } catch (e) {
      this.status = 'storage_error';
      this.errorMessage = e instanceof Error ? e.message : String(e);
    }
    await saveTransferMetadata(this.metadataRecord(true, this.verified === true));
  }
}
