/**
 * End-to-end transfer tests: sender carousel → optical frames → decoder → reconstructor → SHA-256.
 * Frames are DIGITAL renders or SYNTHETIC camera frames (not physical devices).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StreamingFileCarousel } from './fileChunker';
import { IncrementalFileReconstructor } from './fileReconstructor';
import { encodePacket, decodePacket, PacketType } from './packetProtocol';
import { encodePacketToMatrix, getGridLayoutPlan, renderMatrixToImageData } from './opticalEncoder';
import { OpticalFrameDecoder } from './opticalDecoder';
import { renderSyntheticCameraFrame } from './syntheticCamera';

function seededBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

test('E2E (synthetic camera): join mid-loop, 20 % frame loss, corrupted frames → SHA-256 verified file', async () => {
  const original = seededBytes(9_000, 7);
  const file = new File([original as BlobPart], 'report.bin', { type: 'application/octet-stream' });
  const gs = 48;
  const carousel = new StreamingFileCarousel(file, file.name, file.type, {
    gridSize: gs,
    erasureBlockSize: 4,
    manifestIntervalFrames: 6,
    startPacketOffset: 13,
  });
  const manifest = await carousel.prepare();
  assert.equal(manifest.sha256, createHash('sha256').update(original).digest('hex'));

  const decoder = new OpticalFrameDecoder();
  const rec = new IncrementalFileReconstructor();
  const rand = rng(5);
  const plan = getGridLayoutPlan(gs);
  let corruptedSeen = 0;
  let corruptedAccepted = 0;
  let frames = 0;
  // Skip the initial MANIFEST so the receiver joins on DATA frames first
  await carousel.nextPacket();
  while (frames < 600) {
    frames++;
    const next = await carousel.nextPacket();
    if (rand() < 0.2) continue; // dropped frame (blur / tear / missed exposure)
    const matrix = encodePacketToMatrix(next.rawBytes, gs);
    const corrupt = rand() < 0.08;
    if (corrupt) {
      for (let k = 0; k < 3; k++) matrix.cells[plan.dataCellIndices[(rand() * plan.dataCellIndices.length) | 0]] ^= 1;
    }
    const cam = renderSyntheticCameraFrame(matrix, {
      width: 480,
      height: 360,
      matrixSidePx: 300,
      rotationDeg: 6,
      perspectiveTilt: 0.08,
      noiseAmplitude: 5,
      seed: frames,
    });
    const r = decoder.decodeRgba(cam.data, cam.width, cam.height, { expectedGridSize: gs });
    if (corrupt) {
      corruptedSeen++;
      if (r.status === 'valid') corruptedAccepted++;
    }
    if (r.status === 'valid' && r.packet) {
      const st = await rec.ingestPacket(r.packet);
      if (st.status === 'completed' || st.status === 'integrity_error') break;
    }
  }
  const st = await rec.drain();
  assert.equal(st.status, 'completed', `status ${st.status} ${st.errorMessage ?? ''} after ${frames} frames`);
  assert.equal(st.verified, true);
  assert.equal(st.joinedAtPacketIndex, 13);
  assert.ok(st.preManifestBufferedPackets === 0);
  assert.ok(corruptedSeen > 0);
  assert.equal(corruptedAccepted, 0, 'corrupted frames must never be accepted');
  assert.deepEqual(await blobBytes(st.downloadBlob!), original);
});

test('E2E (digital): XOR parity recovers a single missed frame without waiting for the next loop', async () => {
  const original = seededBytes(4 * 421 - 100, 3); // 4 chunks at grid 64 (chunk 421 B)
  const file = new File([original as BlobPart], 'four.bin');
  const carousel = new StreamingFileCarousel(file, file.name, '', { gridSize: 64, erasureBlockSize: 4, manifestIntervalFrames: 50 });
  const manifest = await carousel.prepare();
  assert.equal(manifest.totalSourcePackets, 4);
  const rec = new IncrementalFileReconstructor();
  const dec = new OpticalFrameDecoder();
  // Frames: MANIFEST, D0, D1, D2, D3, PARITY0 — drop D2
  for (let i = 0; i < 6; i++) {
    const p = await carousel.nextPacket();
    if (p.packetType === PacketType.DATA && p.packetIndex === 2) continue;
    const dim = (64 + 4) * 3;
    const img = renderMatrixToImageData(encodePacketToMatrix(p.rawBytes, 64), dim, dim, 2);
    const r = dec.decodeRgba(img.data, dim, dim);
    assert.equal(r.status, 'valid');
    await rec.ingestPacket(r.packet!);
  }
  const st = await rec.drain();
  assert.equal(st.status, 'completed');
  assert.equal(st.parityRecoveredPackets, 1);
  assert.deepEqual(await blobBytes(st.downloadBlob!), original);
});

test('Reconstructor: bounded queue drops excess packets (backpressure) and still completes', async () => {
  const original = seededBytes(3_000, 11);
  const file = new File([original as BlobPart], 'bp.bin');
  const carousel = new StreamingFileCarousel(file, file.name, '', { gridSize: 64, erasureBlockSize: 0, manifestIntervalFrames: 4 });
  await carousel.prepare();
  const rec = new IncrementalFileReconstructor({ maxQueuedPackets: 2 });
  const packets = [];
  for (let i = 0; i < 40; i++) packets.push(decodePacket((await carousel.nextPacket()).rawBytes).packet!);
  // Fire without awaiting: queue holds 2, the rest is dropped
  const pending = packets.slice(0, 10).map((p) => rec.ingestPacket(p));
  await Promise.all(pending);
  assert.ok(rec.getState().backpressureDrops >= 8);
  for (const p of packets) await rec.ingestPacket(p);
  const st = await rec.drain();
  assert.equal(st.status, 'completed');
  assert.deepEqual(await blobBytes(st.downloadBlob!), original);
});

test('Reconstructor: rejects CRC-valid packets that contradict the manifest, follows a new transfer only before data', async () => {
  const fileA = new File([seededBytes(2_000, 1) as BlobPart], 'a.bin');
  const fileB = new File([seededBytes(2_000, 2) as BlobPart], 'b.bin');
  const ca = new StreamingFileCarousel(fileA, 'a.bin', '', { gridSize: 64, erasureBlockSize: 4 });
  const cb = new StreamingFileCarousel(fileB, 'b.bin', '', { gridSize: 64, erasureBlockSize: 4 });
  const ma = await ca.prepare();
  const mb = await cb.prepare();
  const rec = new IncrementalFileReconstructor();
  const manifestA = decodePacket((await ca.nextPacket()).rawBytes).packet!;
  const manifestB = decodePacket((await cb.nextPacket()).rawBytes).packet!;

  await rec.ingestPacket(manifestA);
  assert.equal(rec.getState().manifest!.transferId, ma.transferId);
  await rec.ingestPacket(manifestB); // nothing received yet → switch
  assert.equal(rec.getState().manifest!.transferId, mb.transferId);

  // A DATA packet with the right transferId but wrong length is rejected
  const bad = decodePacket(
    encodePacket({
      packetType: PacketType.DATA,
      transferId: mb.transferId,
      fileId: 1,
      packetIndex: 0,
      totalSourcePackets: mb.totalSourcePackets,
      erasureBlockSize: 4,
      gridSize: 64,
      flags: 0,
      payload: new Uint8Array(10),
    })
  ).packet!;
  await rec.ingestPacket(bad);
  assert.equal(rec.getState().rejectedPackets, 1);
  assert.equal(rec.getState().receivedPackets, 0);

  const dataB = decodePacket((await cb.nextPacket()).rawBytes).packet!;
  await rec.ingestPacket(dataB);
  assert.equal(rec.getState().receivedPackets, 1);
  await rec.ingestPacket(manifestA); // data already received for B → do not switch, report
  const st = rec.getState();
  assert.equal(st.manifest!.transferId, mb.transferId);
  assert.equal(st.otherTransferSeen?.transferId, ma.transferId);
});

test('Reconstructor: storage failures surface as storage_error instead of silent corruption', async () => {
  const file = new File([seededBytes(1_000, 4) as BlobPart], 'x.bin');
  const c = new StreamingFileCarousel(file, 'x.bin', '', { gridSize: 64, erasureBlockSize: 0 });
  await c.prepare();
  const rec = new IncrementalFileReconstructor({ storage: { forceBackend: 'OPFS' } }); // unavailable in Node
  await rec.ingestPacket(decodePacket((await c.nextPacket()).rawBytes).packet!);
  const st = rec.getState();
  assert.equal(st.status, 'storage_error');
  assert.match(st.errorMessage ?? '', /OPFS/);
});

test('Reconstructor: insufficient quota is detected before receiving', async () => {
  const file = new File([seededBytes(1_000, 4) as BlobPart], 'q.bin');
  const c = new StreamingFileCarousel(file, 'q.bin', '', { gridSize: 64, erasureBlockSize: 0 });
  await c.prepare();
  const rec = new IncrementalFileReconstructor({
    storage: { memoryThresholdBytes: 0, estimate: async () => ({ quota: 1_000_000, usage: 999_000 }) },
  });
  await rec.ingestPacket(decodePacket((await c.nextPacket()).rawBytes).packet!);
  assert.equal(rec.getState().status, 'storage_error');
  assert.match(rec.getState().errorMessage ?? '', /Not enough browser storage/);
});

test('Audit fault injection reports measured outcomes of the real pipeline', async () => {
  const { runFaultInjection } = await import('./capacityAudit');
  const r = await runFaultInjection();
  assert.equal(r.completed, true);
  assert.equal(r.sha256Matches, true);
  assert.ok(r.framesDropped > 0);
  assert.ok(r.corruptedFramesInjected > 0);
  assert.equal(r.corruptedFramesAccepted, 0);
  assert.equal(r.joinedAtPacket, 13);
});

test('Interleaved schedule: a burst of K lost frames is rebuilt by parity within the FIRST pass', async () => {
  const K = 8;
  const original = seededBytes(421 * 64 - 50, 21); // 64 chunks at grid 64 = one 8×8 interleave group
  const file = new File([original as BlobPart], 'burst.bin');
  const c = new StreamingFileCarousel(file, file.name, '', { gridSize: 64, erasureBlockSize: K, manifestIntervalFrames: 6 });
  const m = await c.prepare();
  const rec = new IncrementalFileReconstructor();
  const seen = new Set<number>();
  let dataFrames = 0;
  let firstLoopFrames = 0;
  for (let f = 0; f < 400; f++) {
    const p = await c.nextPacket();
    if (p.loopCycle > 0) break;
    firstLoopFrames++;
    if (p.packetType === PacketType.DATA) {
      dataFrames++;
      seen.add(p.packetIndex);
      if (dataFrames >= 20 && dataFrames < 20 + K) continue; // camera blinded for K consecutive data frames
    }
    await rec.ingestPacket(decodePacket(p.rawBytes).packet!);
  }
  const st = await rec.drain();
  assert.equal(seen.size, m.totalSourcePackets, 'every packet is scheduled once per loop');
  assert.equal(st.status, 'completed', 'completed without a second loop');
  assert.equal(st.parityRecoveredPackets, K);
  assert.deepEqual(await blobBytes(st.downloadBlob!), original);
  assert.ok(firstLoopFrames > 0);
});

test('Interleaved schedule: each packet and each parity block appears exactly once per loop, any start offset', async () => {
  for (const [size, K, offset] of [[421 * 37 - 9, 4, 0], [421 * 100 + 5, 8, 53], [421 * 10, 16, 3], [421 * 7, 0, 2]] as const) {
    const file = new File([seededBytes(size, 2) as BlobPart], 'x.bin');
    const c = new StreamingFileCarousel(file, 'x', '', { gridSize: 64, erasureBlockSize: K, manifestIntervalFrames: 1000, startPacketOffset: offset });
    const m = await c.prepare();
    const data: number[] = [];
    const parity: number[] = [];
    const blocks = K > 1 ? Math.ceil(m.totalSourcePackets / K) : 0;
    while (data.length < m.totalSourcePackets || parity.length < blocks) {
      const p = await c.nextPacket();
      if (p.packetType === PacketType.DATA) data.push(p.packetIndex);
      if (p.packetType === PacketType.PARITY) parity.push(p.packetIndex);
    }
    assert.equal(new Set(data).size, m.totalSourcePackets, `size ${size} K ${K}`);
    assert.equal(data[0], offset % m.totalSourcePackets, 'starts at the requested packet');
    assert.equal(new Set(parity).size, blocks);
  }
});

test('Missing-packet summary lists exactly what is still needed', async () => {
  const file = new File([seededBytes(421 * 20, 3) as BlobPart], 'm.bin');
  const c = new StreamingFileCarousel(file, 'm', '', { gridSize: 64, erasureBlockSize: 0, manifestIntervalFrames: 1000 });
  await c.prepare();
  const rec = new IncrementalFileReconstructor();
  for (let i = 0; i < 21; i++) {
    const p = await c.nextPacket();
    if (p.packetType === PacketType.DATA && p.packetIndex >= 5 && p.packetIndex <= 7) continue;
    if (p.packetType === PacketType.DATA && p.packetIndex === 12) continue;
    await rec.ingestPacket(decodePacket(p.rawBytes).packet!);
  }
  await rec.drain();
  assert.deepEqual(rec.getMissingSummary().ranges, [[5, 7], [12, 12]]);
});

test('E2E Auto mode: grayscale + monochrome loops combine; a gray-blind receiver still completes', async () => {
  const { frameModeFor } = await import('./transferManager');
  const { encodeFrameToMatrix, renderMatrixToImageData: render } = await import('./opticalEncoder');
  const original = seededBytes(421 * 30 - 7, 31);
  for (const grayBlind of [false, true]) {
    const c = new StreamingFileCarousel(new File([original as BlobPart], 'a.bin'), 'a.bin', '', { gridSize: 64, erasureBlockSize: 8, startPacketOffset: 11 });
    await c.prepare();
    const rec = new IncrementalFileReconstructor();
    const dec = new OpticalFrameDecoder();
    let frames = 0;
    let grayPackets = 0;
    while (frames < 400) {
      frames++;
      const first = await c.nextPacket();
      const mode = frameModeFor('auto', first.loopCycle);
      const pkts = mode === 'gray4' ? [first, await c.nextPacket()] : [first];
      if (grayBlind && mode === 'gray4') continue; // this receiver cannot read grayscale at all
      const dim = (64 + 4) * 4;
      const img = render(encodeFrameToMatrix(pkts.map((p) => p.rawBytes), 64, mode), dim, dim, 2);
      const r = dec.decodeRgba(img.data, dim, dim);
      assert.equal(r.status, 'valid');
      for (const p of r.packets!) {
        if (r.mode === 'gray4') grayPackets++;
        await rec.ingestPacket(p);
      }
      if (rec.getState().status === 'completed') break;
    }
    const st = await rec.drain();
    assert.equal(st.status, 'completed', `grayBlind=${grayBlind}`);
    assert.deepEqual(await blobBytes(st.downloadBlob!), original);
    if (!grayBlind) assert.ok(grayPackets > 0);
  }
});
