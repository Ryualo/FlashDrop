/**
 * ScanSession resilience: a decoder worker that fails to load (typical offline with a stale cache,
 * or a browser without module workers) must NOT stop scanning. Real decoding runs on the main
 * thread instead; no mocks of the decoder itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePacket, PacketType } from './packetProtocol';
import { encodePacketToMatrix, getGridPayloadCapacityBytes } from './opticalEncoder';
import { renderSyntheticCameraFrame } from './syntheticCamera';
import { ScanSession } from './scanSession';
import type { LoopbackFrame, OpticalLoopbackFeed } from './cameraCapture';
import type { DropFlashPacket } from './packetProtocol';

/** Stand-in for a Worker whose script cannot be fetched: it errors asynchronously, never answers. */
class FailingWorker {
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: { message: string; preventDefault?: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    setTimeout(() => this.onerror?.({ message: 'Failed to fetch worker script', preventDefault() {} }), 5);
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
  }
}

function makeFeed(count: number): OpticalLoopbackFeed {
  const gs = 64;
  let i = 0;
  const feed = {
    async next(): Promise<LoopbackFrame> {
      const k = i++ % count;
      const bytes = encodePacket({
        packetType: PacketType.DATA,
        transferId: 9,
        fileId: 1,
        packetIndex: k,
        totalSourcePackets: count,
        erasureBlockSize: 0,
        gridSize: gs,
        flags: 0,
        payload: new Uint8Array(getGridPayloadCapacityBytes(gs) - 2).fill(k),
      });
      const f = renderSyntheticCameraFrame(encodePacketToMatrix(bytes, gs), { width: 960, height: 540, matrixSidePx: 480, seed: k + 1 });
      return { data: f.data as Uint8ClampedArray<ArrayBuffer>, width: 960, height: 540, dropped: false, corrupted: false, packetIndex: k, loopCycle: 0 };
    },
  };
  return feed as unknown as OpticalLoopbackFeed;
}

test('OFFLINE: a decoder worker that fails to load falls back to main-thread decoding and keeps scanning', async () => {
  const g = globalThis as unknown as { Worker?: unknown };
  const hadWorker = 'Worker' in g;
  const prevWorker = g.Worker;
  g.Worker = FailingWorker; // ScanSession only checks that Worker exists before calling the factory
  const created: FailingWorker[] = [];
  const got = new Set<number>();
  const errors: string[] = [];
  let lastThread = '';
  const session = new ScanSession(
    {
      onPacket: (p: DropFlashPacket) => got.add(p.packetIndex),
      onTelemetry: (t) => (lastThread = t.decoderThread),
      onError: (m) => errors.push(m),
    },
    {
      getExpectedGridSize: () => undefined,
      getManualCorners: () => null,
      workerFactory: () => {
        const w = new FailingWorker();
        created.push(w);
        return w as unknown as Worker;
      },
    }
  );
  try {
    session.startLoopback(makeFeed(4), true);
    const deadline = Date.now() + 20000;
    while (got.size < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(created.length, 1, 'a worker that never loaded is not retried');
    assert.ok(created[0].terminated);
    assert.ok(session.isRunning(), 'scanning keeps running');
    assert.equal(session.getTelemetry().decoderThread, 'main');
    assert.deepEqual([...got].sort(), [0, 1, 2, 3], 'all packets decoded on the main thread');
    assert.deepEqual(errors, []);
    void lastThread;
  } finally {
    session.stop();
    if (hadWorker) g.Worker = prevWorker;
    else delete g.Worker;
  }
});
