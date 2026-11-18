import {
  encodeManifestPayload,
  encodePacket,
  expectedSourcePacketCount,
  PacketType,
  TransferManifest,
} from './packetProtocol';
import { getGridPayloadCapacityBytes } from './opticalEncoder';
import { createXorParityPayload } from './packetRecovery';
import { computeFileSha256Streaming } from '../utils/integrity';

export interface ChunkerConfig {
  gridSize: number; // one of SUPPORTED_GRID_SIZES (48..384)
  erasureBlockSize: number; // 0 (disabled) | 4 | 8 | 16 (max 255)
  manifestIntervalFrames?: number; // a MANIFEST frame every N frames (default 6)
  startPacketOffset?: number; // optional mid-stream start offset (join-anywhere demo)
}

/**
 * Streaming, bounded-memory file chunker and continuous carousel scheduler.
 * Never loads the entire file into RAM: reads bounded slices via `Blob.slice()`
 * and interleaves MANIFEST, DATA, and XOR PARITY packets in an endless carousel loop.
 */
export class StreamingFileCarousel {
  private file: File | Blob;
  private fileName: string;
  private mimeType: string;
  private config: Required<ChunkerConfig>;
  private manifest!: TransferManifest;
  private encodedManifestPacket!: Uint8Array;

  private currentSourceIndex = 0;
  private framesEmitted = 0;
  private loopCyclesCompleted = 0;

  // Bounded FIFO cache of recently read chunks (≤ 32 × chunkSize, i.e. ≤ ~600 KB at 384×384) so
  // parity generation does not re-read slices, while multi-GB files never load into RAM.
  private chunkCache = new Map<number, Uint8Array>();
  private MAX_CACHED_CHUNKS = 32;

  constructor(file: File | Blob, fileName: string, mimeType: string, config: ChunkerConfig) {
    this.file = file;
    this.fileName = fileName || 'payload.bin';
    this.mimeType = mimeType || 'application/octet-stream';
    if (!Number.isInteger(config.erasureBlockSize) || config.erasureBlockSize < 0 || config.erasureBlockSize > 255) {
      throw new RangeError('erasureBlockSize must be an integer between 0 and 255.');
    }
    this.config = {
      gridSize: config.gridSize,
      erasureBlockSize: config.erasureBlockSize === 1 ? 0 : config.erasureBlockSize,
      manifestIntervalFrames: Math.max(2, Math.floor(config.manifestIntervalFrames ?? 6)),
      startPacketOffset: Math.max(0, Math.floor(config.startPacketOffset ?? 0)),
    };
  }

  async prepare(onHashProgress?: (processed: number, total: number) => void): Promise<TransferManifest> {
    const maxPayloadBytes = getGridPayloadCapacityBytes(this.config.gridSize);
    // Parity payloads carry a 2-byte length XOR, so a data chunk is 2 bytes smaller than a frame.
    const chunkSize = maxPayloadBytes - 2;
    if (chunkSize < 64) throw new RangeError(`Grid ${this.config.gridSize} is too small to carry data.`);
    const totalSourcePackets = expectedSourcePacketCount(this.file.size, chunkSize);

    const sha256 = await computeFileSha256Streaming(this.file, onHashProgress);
    const transferId = ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;

    this.manifest = {
      transferId: transferId || 1001,
      fileId: 1,
      fileName: this.fileName,
      fileSize: this.file.size,
      mimeType: this.mimeType,
      sha256,
      chunkSize,
      totalSourcePackets,
      erasureBlockSize: this.config.erasureBlockSize,
      gridSize: this.config.gridSize,
    };

    // Truncates the file name (UTF-8 safe) so the manifest always fits in one frame.
    // Cache must hold one interleave group (K blocks × K chunks) so parity never re-reads the file.
    this.MAX_CACHED_CHUNKS = Math.max(32, this.config.erasureBlockSize * this.config.erasureBlockSize + this.config.erasureBlockSize);
    const manifestPayload = encodeManifestPayload(this.manifest, maxPayloadBytes);
    this.encodedManifestPacket = encodePacket({
      packetType: PacketType.MANIFEST,
      transferId: this.manifest.transferId,
      fileId: this.manifest.fileId,
      packetIndex: 0,
      totalSourcePackets: this.manifest.totalSourcePackets,
      erasureBlockSize: this.manifest.erasureBlockSize,
      gridSize: this.manifest.gridSize,
      flags: 0,
      payload: manifestPayload,
    });

    this.initSchedule(this.config.startPacketOffset % this.manifest.totalSourcePackets);
    return this.manifest;
  }

  getManifest(): TransferManifest {
    return this.manifest;
  }

  getLoopCyclesCompleted(): number {
    return this.loopCyclesCompleted;
  }

  getCurrentSourceIndex(): number {
    return this.currentSourceIndex;
  }

  getFramesEmitted(): number {
    return this.framesEmitted;
  }

  private async readSourceChunk(index: number): Promise<Uint8Array> {
    const cached = this.chunkCache.get(index);
    if (cached) return cached;

    const start = index * this.manifest.chunkSize;
    const end = Math.min(start + this.manifest.chunkSize, this.file.size);
    const slice = this.file.slice(start, end);
    const arrayBuffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (this.chunkCache.size >= this.MAX_CACHED_CHUNKS) {
      const oldestKey = this.chunkCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.chunkCache.delete(oldestKey);
      }
    }
    this.chunkCache.set(index, bytes);
    return bytes;
  }

  // ------------------------------------------------------------------ interleaved schedule
  //
  // Parity blocks are K consecutive packet indices (protocol unchanged). Frames are sent in
  // groups of G = K blocks, column-major: block0[0], block1[0], …, blockG-1[0], block0[1], …,
  // followed by the G parity frames of the group. A burst of up to G consecutive lost frames
  // (hand shake, refocus, glare) therefore removes at most ONE packet per block, which the
  // block's parity rebuilds immediately — instead of waiting a whole extra loop.
  private group = 0;
  private col = 0;
  private row = 0;
  private parityRow = -1; // ≥0 while emitting the group's parity frames

  private get K(): number {
    return this.config.erasureBlockSize > 1 ? this.config.erasureBlockSize : 1;
  }
  private get totalBlocks(): number {
    return Math.ceil(this.manifest.totalSourcePackets / this.K);
  }
  private get groupBlocks(): number {
    return this.K > 1 ? this.K : 1;
  }
  private get totalGroups(): number {
    return Math.ceil(this.totalBlocks / this.groupBlocks);
  }

  private initSchedule(startIndex: number): void {
    const K = this.K;
    const block = Math.floor(startIndex / K);
    this.group = Math.floor(block / this.groupBlocks);
    this.row = block - this.group * this.groupBlocks;
    this.col = startIndex - block * K;
    this.parityRow = -1;
    this.currentSourceIndex = startIndex;
  }

  /** Advances to the next schedule slot; returns a data index, or -(blockIndex+1) for parity. */
  private nextSlot(): number {
    const N = this.manifest.totalSourcePackets;
    const K = this.K;
    const G = this.groupBlocks;
    for (let guard = 0; guard < 4 * G * K + 8; guard++) {
      const firstBlock = this.group * G;
      const blocksInGroup = Math.min(G, this.totalBlocks - firstBlock);
      if (this.parityRow >= 0) {
        if (this.parityRow < blocksInGroup) {
          const b = firstBlock + this.parityRow++;
          return -(b + 1);
        }
        // group finished → next group (wrap = new loop)
        this.parityRow = -1;
        this.col = 0;
        this.row = 0;
        this.group++;
        if (this.group >= this.totalGroups) {
          this.group = 0;
          this.loopCyclesCompleted++;
        }
        continue;
      }
      if (this.col >= K) {
        if (K > 1) {
          this.parityRow = 0;
          continue;
        }
        this.col = 0;
        this.row = 0;
        this.group++;
        if (this.group >= this.totalGroups) {
          this.group = 0;
          this.loopCyclesCompleted++;
        }
        continue;
      }
      const idx = (firstBlock + this.row) * K + this.col;
      this.row++;
      if (this.row >= blocksInGroup) {
        this.row = 0;
        this.col++;
      }
      if (idx < N) return idx;
    }
    throw new Error('Carousel schedule did not advance');
  }

  private async blockChunks(blockIndex: number): Promise<Uint8Array[]> {
    const K = this.K;
    const out: Uint8Array[] = [];
    const end = Math.min((blockIndex + 1) * K, this.manifest.totalSourcePackets);
    for (let i = blockIndex * K; i < end; i++) out.push(await this.readSourceChunk(i));
    return out;
  }

  /**
   * Produces the next frame of the endless loop: a MANIFEST every `manifestIntervalFrames`
   * frames, otherwise the next DATA or PARITY packet of the interleaved schedule.
   */
  async nextPacket(): Promise<{
    rawBytes: Uint8Array;
    packetType: PacketType;
    packetIndex: number;
    loopCycle: number;
  }> {
    const step = this.framesEmitted++;
    if (step % this.config.manifestIntervalFrames === 0) {
      return { rawBytes: this.encodedManifestPacket, packetType: PacketType.MANIFEST, packetIndex: this.currentSourceIndex, loopCycle: this.loopCyclesCompleted };
    }
    const slot = this.nextSlot();
    const base = {
      transferId: this.manifest.transferId,
      fileId: this.manifest.fileId,
      totalSourcePackets: this.manifest.totalSourcePackets,
      erasureBlockSize: this.config.erasureBlockSize,
      gridSize: this.manifest.gridSize,
      flags: 0,
    };
    if (slot < 0) {
      const blockIndex = -slot - 1;
      const payload = createXorParityPayload(await this.blockChunks(blockIndex), this.manifest.chunkSize);
      return {
        rawBytes: encodePacket({ ...base, packetType: PacketType.PARITY, packetIndex: blockIndex, payload }),
        packetType: PacketType.PARITY,
        packetIndex: blockIndex,
        loopCycle: this.loopCyclesCompleted,
      };
    }
    this.currentSourceIndex = slot;
    const payload = await this.readSourceChunk(slot);
    return {
      rawBytes: encodePacket({ ...base, packetType: PacketType.DATA, packetIndex: slot, payload }),
      packetType: PacketType.DATA,
      packetIndex: slot,
      loopCycle: this.loopCyclesCompleted,
    };
  }
}
