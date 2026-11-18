/**
 * Out-of-order (join-anywhere) packet tracking with single-erasure XOR recovery per block.
 *
 * Every group of K = `erasureBlockSize` source chunks has one PARITY payload:
 *   parity[0..1] = XOR of the K chunk lengths (big-endian u16)
 *   parity[2..]  = XOR of the K chunks (zero-padded to chunkSize)
 * When K−1 chunks of a block and its parity are known — in any order — the missing chunk is
 * reconstructed immediately.
 *
 * Memory is bounded: instead of keeping every received chunk of every incomplete block (which for a
 * multi-GB transfer with steady loss approached the whole file), each incomplete block keeps one
 * running XOR accumulator of chunkSize + 2 bytes. Accumulators and stored parity payloads share a
 * byte budget; when it is exceeded, the least-recently-touched block loses its recovery state and is
 * simply completed by the carousel's next pass instead (never reconstructed from partial state).
 */

export function createXorParityPayload(chunks: Uint8Array[], maxChunkSize: number): Uint8Array {
  const parity = new Uint8Array(maxChunkSize + 2);
  let lengthXor = 0;
  for (const chunk of chunks) {
    if (chunk.byteLength > maxChunkSize) throw new RangeError('Chunk larger than chunkSize');
    lengthXor ^= chunk.byteLength;
    for (let i = 0; i < chunk.byteLength; i++) parity[i + 2] ^= chunk[i];
  }
  parity[0] = (lengthXor >>> 8) & 0xff;
  parity[1] = lengthXor & 0xff;
  return parity;
}

export interface RecoveredChunkEvent {
  packetIndex: number;
  payload: Uint8Array;
  viaParity: boolean;
}

interface BlockState {
  acc: Uint8Array | null; // XOR of received chunks, chunkSize bytes
  lengthXor: number;
  present: number;
  parity: Uint8Array | null;
}

export interface RecoveryTrackerOptions {
  /** Upper bound for accumulator + parity memory. Default 48 MiB. */
  maxRecoveryBytes?: number;
  /** Expected length of each source chunk (validates recovered chunks). */
  expectedLength?: (packetIndex: number) => number;
}

export class PacketRecoveryTracker {
  readonly totalSourcePackets: number;
  readonly erasureBlockSize: number;
  readonly chunkSize: number;
  private receivedBitmap: Uint8Array;
  private receivedCounter = 0;
  private duplicateCounter = 0;
  private parityRecoveries = 0;
  private recoveryStateEvictions = 0;
  private rejectedRecoveries = 0;

  private blocks = new Map<number, BlockState>(); // Map iteration order = LRU order
  /** 1 = this block's accumulator was evicted; it can no longer be used for XOR recovery. */
  private evicted: Uint8Array;
  private bytesInUse = 0;
  private readonly maxBytes: number;
  private readonly expectedLength: (i: number) => number;

  constructor(totalSourcePackets: number, erasureBlockSize: number, chunkSize: number, options: RecoveryTrackerOptions = {}) {
    this.totalSourcePackets = Math.max(1, totalSourcePackets);
    this.erasureBlockSize = Math.max(0, erasureBlockSize);
    this.chunkSize = chunkSize;
    this.receivedBitmap = new Uint8Array(this.totalSourcePackets);
    const blockCount = this.erasureBlockSize > 1 ? Math.ceil(this.totalSourcePackets / this.erasureBlockSize) : 0;
    this.evicted = new Uint8Array(blockCount);
    this.maxBytes = options.maxRecoveryBytes ?? 48 * 1024 * 1024;
    this.expectedLength = options.expectedLength ?? (() => -1);
  }

  hasPacket(packetIndex: number): boolean {
    if (packetIndex < 0 || packetIndex >= this.totalSourcePackets) return false;
    return this.receivedBitmap[packetIndex] === 1;
  }

  getReceivedCount(): number {
    return this.receivedCounter;
  }

  getDuplicateCount(): number {
    return this.duplicateCounter;
  }

  getParityRecoveryCount(): number {
    return this.parityRecoveries;
  }

  getRecoveryMemoryBytes(): number {
    return this.bytesInUse;
  }

  getRecoveryStateEvictions(): number {
    return this.recoveryStateEvictions;
  }

  getRejectedRecoveries(): number {
    return this.rejectedRecoveries;
  }

  isComplete(): boolean {
    return this.receivedCounter >= this.totalSourcePackets;
  }

  getBitmapSnapshot(): Uint8Array {
    return this.receivedBitmap;
  }

  /** Missing packet indices as inclusive [from, to] ranges (first `limit` ranges). */
  missingRanges(limit = 8): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const n = this.totalSourcePackets;
    for (let i = 0; i < n && out.length < limit; i++) {
      if (this.receivedBitmap[i] === 1) continue;
      let j = i;
      while (j + 1 < n && this.receivedBitmap[j + 1] === 0) j++;
      out.push([i, j]);
      i = j;
    }
    return out;
  }

  /** Blocks whose single missing packet will be rebuilt as soon as their parity frame arrives. */
  blocksAwaitingParityOnly(): number {
    if (this.erasureBlockSize <= 1) return 0;
    let n = 0;
    for (const [b, st] of this.blocks) {
      const [s, e] = this.blockRange(b);
      if (!st.parity && st.present === e - s - 1) n++;
    }
    return n;
  }

  /** Returns the first missing packet index, or -1 when complete. */
  firstMissing(): number {
    for (let i = 0; i < this.totalSourcePackets; i++) if (this.receivedBitmap[i] === 0) return i;
    return -1;
  }

  private blockRange(blockIndex: number): [number, number] {
    const start = blockIndex * this.erasureBlockSize;
    return [start, Math.min(start + this.erasureBlockSize, this.totalSourcePackets)];
  }

  private touch(blockIndex: number, state: BlockState): void {
    this.blocks.delete(blockIndex);
    this.blocks.set(blockIndex, state);
  }

  private releaseBlock(blockIndex: number): void {
    const st = this.blocks.get(blockIndex);
    if (!st) return;
    if (st.acc) this.bytesInUse -= st.acc.byteLength;
    if (st.parity) this.bytesInUse -= st.parity.byteLength;
    this.blocks.delete(blockIndex);
  }

  private enforceBudget(protectBlock: number): void {
    for (const [idx] of this.blocks) {
      if (this.bytesInUse <= this.maxBytes) break;
      if (idx === protectBlock) continue;
      this.releaseBlock(idx);
      this.evicted[idx] = 1;
      this.recoveryStateEvictions++;
    }
  }

  private getState(blockIndex: number): BlockState | null {
    if (this.evicted[blockIndex]) return null;
    let st = this.blocks.get(blockIndex);
    if (!st) {
      st = { acc: null, lengthXor: 0, present: 0, parity: null };
      this.blocks.set(blockIndex, st);
    } else {
      this.touch(blockIndex, st);
    }
    return st;
  }

  private blockComplete(blockIndex: number): boolean {
    const [s, e] = this.blockRange(blockIndex);
    for (let i = s; i < e; i++) if (this.receivedBitmap[i] === 0) return false;
    return true;
  }

  ingestDataPacket(packetIndex: number, payload: Uint8Array): RecoveredChunkEvent[] {
    if (packetIndex < 0 || packetIndex >= this.totalSourcePackets) return [];
    if (this.receivedBitmap[packetIndex] === 1) {
      this.duplicateCounter++;
      return [];
    }
    this.receivedBitmap[packetIndex] = 1;
    this.receivedCounter++;
    const events: RecoveredChunkEvent[] = [{ packetIndex, payload, viaParity: false }];

    if (this.erasureBlockSize > 1) {
      const blockIndex = Math.floor(packetIndex / this.erasureBlockSize);
      if (this.blockComplete(blockIndex)) {
        this.releaseBlock(blockIndex);
        return events;
      }
      const st = this.getState(blockIndex);
      if (st) {
        if (!st.acc) {
          st.acc = new Uint8Array(this.chunkSize);
          this.bytesInUse += st.acc.byteLength;
        }
        const n = Math.min(payload.byteLength, this.chunkSize);
        for (let i = 0; i < n; i++) st.acc[i] ^= payload[i];
        st.lengthXor ^= payload.byteLength;
        st.present++;
        const recovered = this.tryRecover(blockIndex, st);
        if (recovered) events.push(recovered);
        if (this.blockComplete(blockIndex)) this.releaseBlock(blockIndex);
        else this.enforceBudget(blockIndex);
      }
    }
    return events;
  }

  ingestParityPacket(blockIndex: number, parityPayload: Uint8Array): RecoveredChunkEvent[] {
    if (this.erasureBlockSize <= 1) return [];
    const [start] = this.blockRange(blockIndex);
    if (start >= this.totalSourcePackets || blockIndex < 0) return [];
    if (parityPayload.byteLength !== this.chunkSize + 2) return [];
    if (this.blockComplete(blockIndex)) {
      this.duplicateCounter++;
      return [];
    }
    const st = this.getState(blockIndex);
    if (!st) return [];
    if (!st.parity) {
      st.parity = parityPayload.slice();
      this.bytesInUse += st.parity.byteLength;
    }
    const recovered = this.tryRecover(blockIndex, st);
    if (this.blockComplete(blockIndex)) this.releaseBlock(blockIndex);
    else this.enforceBudget(blockIndex);
    return recovered ? [recovered] : [];
  }

  private tryRecover(blockIndex: number, st: BlockState): RecoveredChunkEvent | null {
    if (!st.parity) return null;
    const [s, e] = this.blockRange(blockIndex);
    if (st.present !== e - s - 1) return null;
    let missing = -1;
    for (let i = s; i < e; i++) {
      if (this.receivedBitmap[i] === 0) {
        missing = i;
        break;
      }
    }
    if (missing < 0) return null;

    const lengthXor = ((st.parity[0] << 8) | st.parity[1]) ^ st.lengthXor;
    const expected = this.expectedLength(missing);
    if (lengthXor > this.chunkSize || (expected >= 0 && lengthXor !== expected)) {
      // Inconsistent parity (should not happen with CRC-valid packets) — never write bad data.
      this.rejectedRecoveries++;
      st.parity = null;
      return null;
    }
    const out = new Uint8Array(lengthXor);
    const acc = st.acc;
    for (let i = 0; i < lengthXor; i++) out[i] = st.parity[i + 2] ^ (acc ? acc[i] : 0);

    this.receivedBitmap[missing] = 1;
    this.receivedCounter++;
    this.parityRecoveries++;
    return { packetIndex: missing, payload: out, viaParity: true };
  }
}
