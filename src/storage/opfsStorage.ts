import { deleteFallbackChunks, getFallbackChunks, putFallbackChunks } from './indexedDB';
import { StreamingSha256 } from '../utils/integrity';

export type StorageBackend = 'OPFS' | 'IndexedDB' | 'Memory';

export type StorageErrorCode = 'insufficient_quota' | 'unavailable' | 'write_failed' | 'missing_chunk';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export interface ChunkedStorageOptions {
  /** Files up to this size are staged in RAM (fastest, no quota prompt). Default 32 MiB. */
  memoryThresholdBytes?: number;
  /** Force a backend (tests / diagnostics). */
  forceBackend?: StorageBackend;
  /** Override quota checking (tests). */
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

const INCOMING_DIR = 'flashdrop-incoming';
const IDB_BATCH_BYTES = 2 * 1024 * 1024;
const IDB_BATCH_CHUNKS = 64;
const HASH_SLICE_BYTES = 4 * 1024 * 1024;
const QUOTA_SAFETY_BYTES = 16 * 1024 * 1024;

interface WritableLike {
  write(data: { type: 'write'; position: number; data: BufferSource | Blob }): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

/**
 * Chunk storage for a single incoming transfer.
 *
 * - Memory: files ≤ memoryThresholdBytes.
 * - OPFS: ONE FileSystemWritableFileStream for the whole transfer; chunks are written at their
 *   byte offset (positioned writes) and committed once on close. (The previous implementation
 *   reopened the writable with keepExistingData for every 4 MB batch, which copies the entire
 *   file each time — quadratic I/O for multi-GB transfers — and lost earlier batches when it fell
 *   back to memory mid-transfer.)
 * - IndexedDB: batched transactions on one cached connection; used where OPFS writables are not
 *   available (e.g. older Safari).
 *
 * Errors are surfaced as StorageError instead of silently switching backends mid-transfer.
 */
export class ChunkedFileStorage {
  private readonly transferId: number;
  private readonly fileName: string;
  private readonly fileSize: number;
  private readonly chunkSize: number;
  private readonly totalPackets: number;
  private readonly options: ChunkedStorageOptions;

  private backend: StorageBackend | null = null;
  private memoryChunks = new Map<number, Uint8Array>();
  private opfsDir: FileSystemDirectoryHandle | null = null;
  private opfsHandle: FileSystemFileHandle | null = null;
  private opfsEntryName = '';
  private writable: WritableLike | null = null;
  private idbBatch: Array<{ packetIndex: number; data: Uint8Array }> = [];
  private idbBatchBytes = 0;
  private finalized = false;

  constructor(
    transferId: number,
    fileName: string,
    fileSize: number,
    chunkSize: number,
    totalPackets: number,
    options: ChunkedStorageOptions = {}
  ) {
    this.transferId = transferId >>> 0;
    this.fileName = fileName;
    this.fileSize = fileSize;
    this.chunkSize = chunkSize;
    this.totalPackets = totalPackets;
    this.options = options;
  }

  getBackend(): StorageBackend | null {
    return this.backend;
  }

  private expectedLength(index: number): number {
    const offset = index * this.chunkSize;
    return Math.max(0, Math.min(this.chunkSize, this.fileSize - offset));
  }

  private async checkQuota(requiredBytes: number): Promise<void> {
    const estimateFn =
      this.options.estimate ??
      (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function'
        ? () => navigator.storage.estimate()
        : null);
    if (!estimateFn) return; // Unknown quota: proceed, write errors are still surfaced.
    try {
      const { quota, usage } = await estimateFn();
      if (typeof quota === 'number' && typeof usage === 'number') {
        const free = quota - usage;
        if (free < requiredBytes + QUOTA_SAFETY_BYTES) {
          throw new StorageError(
            'insufficient_quota',
            `Not enough browser storage: ${Math.round(requiredBytes / 1048576)} MB needed, about ${Math.max(0, Math.round(free / 1048576))} MB available. Free up space or use a smaller file.`
          );
        }
      }
    } catch (e) {
      if (e instanceof StorageError) throw e;
    }
  }

  async init(): Promise<{ backend: StorageBackend }> {
    const memLimit = this.options.memoryThresholdBytes ?? 32 * 1024 * 1024;
    const forced = this.options.forceBackend;

    if (forced === 'Memory' || (!forced && this.fileSize <= memLimit)) {
      this.backend = 'Memory';
      return { backend: 'Memory' };
    }

    await this.checkQuota(this.fileSize);
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      // Reduce the chance of eviction for large incoming files (browser may decline).
      void navigator.storage.persist().catch(() => false);
    }

    if (forced !== 'IndexedDB' && (await this.tryInitOpfs())) {
      this.backend = 'OPFS';
      return { backend: 'OPFS' };
    }
    if (forced === 'OPFS') throw new StorageError('unavailable', 'OPFS writable streams are not available in this browser.');

    if (typeof indexedDB !== 'undefined') {
      await deleteFallbackChunks(this.transferId); // stale chunks from an earlier attempt
      this.backend = 'IndexedDB';
      return { backend: 'IndexedDB' };
    }
    throw new StorageError(
      'unavailable',
      'This browser offers neither OPFS nor IndexedDB storage, so files larger than the in-memory limit cannot be received.'
    );
  }

  private async tryInitOpfs(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      return false;
    }
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(INCOMING_DIR, { create: true });
      const name = `${this.transferId}.part`;
      const handle = await dir.getFileHandle(name, { create: true });
      if (typeof (handle as FileSystemFileHandle & { createWritable?: unknown }).createWritable !== 'function') {
        await dir.removeEntry(name).catch(() => undefined);
        return false;
      }
      const writable = (await handle.createWritable({ keepExistingData: false })) as unknown as WritableLike;
      this.opfsDir = dir;
      this.opfsHandle = handle;
      this.opfsEntryName = name;
      this.writable = writable;
      void cleanupIncomingStorage(name);
      return true;
    } catch {
      return false;
    }
  }

  async writeChunk(packetIndex: number, payload: Uint8Array): Promise<void> {
    if (this.finalized) return;
    if (packetIndex < 0 || packetIndex >= this.totalPackets) {
      throw new StorageError('write_failed', `Chunk index ${packetIndex} is out of range.`);
    }
    const expected = this.expectedLength(packetIndex);
    const data = payload.byteLength === expected ? payload : payload.subarray(0, expected);
    if (data.byteLength !== expected) {
      throw new StorageError('write_failed', `Chunk ${packetIndex} has ${payload.byteLength} bytes, expected ${expected}.`);
    }
    try {
      switch (this.backend) {
        case 'Memory':
          this.memoryChunks.set(packetIndex, data.slice());
          return;
        case 'OPFS':
          await this.writable!.write({ type: 'write', position: packetIndex * this.chunkSize, data: data.slice() });
          return;
        case 'IndexedDB':
          this.idbBatch.push({ packetIndex, data: data.slice() });
          this.idbBatchBytes += data.byteLength;
          if (this.idbBatchBytes >= IDB_BATCH_BYTES || this.idbBatch.length >= IDB_BATCH_CHUNKS) {
            await this.flushIdb();
          }
          return;
        default:
          throw new StorageError('unavailable', 'Storage has not been initialised.');
      }
    } catch (e) {
      if (e instanceof StorageError) throw e;
      const name = e instanceof DOMException ? e.name : '';
      throw new StorageError(
        name === 'QuotaExceededError' ? 'insufficient_quota' : 'write_failed',
        name === 'QuotaExceededError'
          ? 'Browser storage quota exceeded while receiving. Free up space and restart the transfer.'
          : `Could not store received data (${e instanceof Error ? e.message : String(e)}).`
      );
    }
  }

  private async flushIdb(): Promise<void> {
    if (this.idbBatch.length === 0) return;
    const batch = this.idbBatch;
    this.idbBatch = [];
    this.idbBatchBytes = 0;
    await putFallbackChunks(this.transferId, batch);
  }

  /**
   * Commits data, verifies SHA-256 by streaming, and returns a Blob for download.
   * For OPFS the Blob is backed by the on-disk file (not RAM).
   */
  async verifyAndFinalize(
    expectedSha256: string,
    mimeType: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<{ verified: boolean; actualSha256: string; blob: Blob }> {
    this.finalized = true;
    const type = mimeType || 'application/octet-stream';
    const hasher = new StreamingSha256();

    if (this.backend === 'OPFS') {
      try {
        await this.writable!.close();
      } catch (e) {
        throw new StorageError('write_failed', `Could not commit the received file (${e instanceof Error ? e.message : String(e)}).`);
      }
      this.writable = null;
      const file = await this.opfsHandle!.getFile();
      if (file.size !== this.fileSize) {
        throw new StorageError('missing_chunk', `Stored file is ${file.size} bytes, expected ${this.fileSize}.`);
      }
      for (let off = 0; off < this.fileSize; off += HASH_SLICE_BYTES) {
        const end = Math.min(off + HASH_SLICE_BYTES, this.fileSize);
        hasher.update(new Uint8Array(await file.slice(off, end).arrayBuffer()));
        onProgress?.(end, this.fileSize);
      }
      const actualSha256 = hasher.digestHex();
      return { verified: actualSha256 === expectedSha256.toLowerCase(), actualSha256, blob: file.slice(0, this.fileSize, type) };
    }

    if (this.backend === 'IndexedDB') {
      await this.flushIdb();
      const parts: Blob[] = [];
      const BATCH = 256;
      let done = 0;
      for (let start = 0; start < this.totalPackets; start += BATCH) {
        const end = Math.min(this.totalPackets, start + BATCH);
        const got = await getFallbackChunks(this.transferId, start, end);
        const group: Uint8Array[] = [];
        for (let i = start; i < end; i++) {
          const c = got.get(i);
          if (!c) throw new StorageError('missing_chunk', `Chunk ${i} is missing from IndexedDB.`);
          hasher.update(c);
          group.push(c);
          done += c.byteLength;
        }
        // Blob per batch lets the browser page large data to disk instead of holding one huge array
        parts.push(new Blob(group as BlobPart[]));
        onProgress?.(done, this.fileSize);
      }
      const actualSha256 = hasher.digestHex();
      const blob = new Blob(parts, { type });
      await deleteFallbackChunks(this.transferId);
      return { verified: actualSha256 === expectedSha256.toLowerCase(), actualSha256, blob };
    }

    // Memory
    const parts: Uint8Array[] = [];
    let done = 0;
    for (let i = 0; i < this.totalPackets; i++) {
      const c = this.memoryChunks.get(i);
      if (!c) throw new StorageError('missing_chunk', `Chunk ${i} is missing.`);
      hasher.update(c);
      parts.push(c);
      done += c.byteLength;
    }
    onProgress?.(done, this.fileSize);
    const actualSha256 = hasher.digestHex();
    const blob = new Blob(parts as BlobPart[], { type });
    this.memoryChunks.clear();
    return { verified: actualSha256 === expectedSha256.toLowerCase(), actualSha256, blob };
  }

  /** Releases resources of an abandoned transfer (best effort). */
  async discard(): Promise<void> {
    this.finalized = true;
    this.memoryChunks.clear();
    this.idbBatch = [];
    if (this.writable) {
      try {
        if (this.writable.abort) await this.writable.abort();
        else await this.writable.close();
      } catch {
        // ignore
      }
      this.writable = null;
    }
    if (this.opfsDir && this.opfsEntryName) {
      await this.opfsDir.removeEntry(this.opfsEntryName).catch(() => undefined);
    }
    if (this.backend === 'IndexedDB') await deleteFallbackChunks(this.transferId);
  }

  get name(): string {
    return this.fileName;
  }
}

/**
 * Removes leftover partial files from earlier sessions (DropFlash does not resume across page
 * reloads, so they would otherwise consume quota forever). `keepName` is the active transfer.
 */
export async function cleanupIncomingStorage(keepName?: string): Promise<number> {
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') return 0;
  let removed = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(INCOMING_DIR, { create: true });
    const names: string[] = [];
    const iterable = dir as unknown as { keys?: () => AsyncIterable<string> };
    if (typeof iterable.keys !== 'function') return 0;
    for await (const name of iterable.keys()) names.push(name);
    for (const name of names) {
      if (name === keepName) continue;
      try {
        await dir.removeEntry(name);
        removed++;
      } catch {
        // In use by another tab, or locked: leave it
      }
    }
    // Legacy files written by the previous storage engine at the OPFS root
    const rootIt = root as unknown as { keys?: () => AsyncIterable<string> };
    if (typeof rootIt.keys === 'function') {
      const legacy: string[] = [];
      for await (const name of rootIt.keys()) if (name.startsWith('flashdrop_')) legacy.push(name);
      for (const name of legacy) await root.removeEntry(name).catch(() => undefined);
    }
  } catch {
    // ignore
  }
  return removed;
}
