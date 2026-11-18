/**
 * Protocol, integrity and recovery unit tests (pure software; no camera involved).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeSha256Bytes, crc32, StreamingSha256 } from '../utils/integrity';
import {
  decodeManifestPayload,
  decodePacket,
  encodeManifestPayload,
  encodePacket,
  PacketType,
  PROTOCOL_VERSION,
  TransferManifest,
  truncateUtf8,
} from './packetProtocol';
import { createXorParityPayload, PacketRecoveryTracker } from './packetRecovery';
import { encodePacketToMatrix, getGridLayoutPlan, getGridPayloadCapacityBytes } from './opticalEncoder';
import { SUPPORTED_GRID_SIZES } from './opticalDecoder';
import { auditAllGridResolutions, auditClaimed700KbCapacity, auditGridCapacity } from './capacityAudit';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

test('CRC-32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('StreamingSha256 matches node:crypto for many sizes and arbitrary chunking', () => {
  const rnd = seeded(42);
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096, 100_003]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (rnd() * 256) | 0;
    const expected = createHash('sha256').update(data).digest('hex');
    assert.equal(computeSha256Bytes(data), expected, `single-shot size ${size}`);
    const h = new StreamingSha256();
    let off = 0;
    while (off < size) {
      const n = Math.min(size - off, 1 + ((rnd() * 200) | 0));
      h.update(data.subarray(off, off + n));
      off += n;
    }
    assert.equal(h.digestHex(), expected, `chunked size ${size}`);
  }
});

test('Packet framing round-trips and CRC-32 rejects any single-bit corruption', () => {
  const payload = new Uint8Array([10, 20, 30, 40, 50, 60]);
  const encoded = encodePacket({
    packetType: PacketType.DATA,
    transferId: 0x12345678,
    fileId: 1,
    packetIndex: 42,
    totalSourcePackets: 100,
    erasureBlockSize: 4,
    gridSize: 48,
    flags: 0,
    payload,
  });
  const decoded = decodePacket(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.packet!.transferId, 0x12345678);
  assert.equal(decoded.packet!.packetIndex, 42);
  assert.equal(decoded.packet!.gridSize, 48);
  assert.deepEqual(decoded.packet!.payload, payload);

  for (let bit = 0; bit < encoded.length * 8; bit++) {
    const corrupted = new Uint8Array(encoded);
    corrupted[bit >> 3] ^= 1 << (bit & 7);
    assert.equal(decodePacket(corrupted).ok, false, `bit ${bit} flip must be rejected`);
  }
});

test('A CRC-valid frame from another protocol version is reported as version_mismatch', () => {
  const pkt = encodePacket({
    packetType: PacketType.DATA,
    transferId: 1,
    fileId: 1,
    packetIndex: 0,
    totalSourcePackets: 1,
    erasureBlockSize: 0,
    gridSize: 64,
    flags: 0,
    payload: new Uint8Array(8),
  });
  pkt[2] = PROTOCOL_VERSION + 1;
  // Recompute CRC as a different-version sender would
  const crc = crc32(pkt, 0, pkt.length - 4);
  new DataView(pkt.buffer).setUint32(pkt.length - 4, crc);
  const r = decodePacket(pkt);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'version_mismatch');
  assert.equal(r.foundVersion, PROTOCOL_VERSION + 1);
});

test('Binary manifest round-trips, fits every supported grid, and truncates names UTF-8 safely', () => {
  const longName = 'Résumé — 東京の写真 '.repeat(30) + '.zip';
  for (const gs of SUPPORTED_GRID_SIZES) {
    const cap = getGridPayloadCapacityBytes(gs);
    const chunkSize = cap - 2;
    const fileSize = 5 * 1024 * 1024 * 1024 + 123; // > 4 GiB: exercises the 64-bit size field
    const manifest: TransferManifest = {
      transferId: 0xdeadbeef,
      fileId: 1,
      fileName: longName,
      fileSize,
      mimeType: 'application/zip',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      chunkSize,
      totalSourcePackets: Math.ceil(fileSize / chunkSize),
      erasureBlockSize: 8,
      gridSize: gs,
    };
    const payload = encodeManifestPayload(manifest, cap);
    assert.ok(payload.byteLength <= cap, `manifest must fit grid ${gs}`);
    const back = decodeManifestPayload(payload);
    assert.ok(back, `decodes for grid ${gs}`);
    assert.equal(back!.fileSize, fileSize);
    assert.equal(back!.sha256, manifest.sha256);
    assert.ok(longName.startsWith(back!.fileName), 'truncated name is a prefix');
    assert.ok(!back!.fileName.includes('�'), 'no broken code points');
    // The manifest packet must fit the frame
    const pkt = encodePacket({ ...manifest, packetType: PacketType.MANIFEST, packetIndex: 0, flags: 0, payload });
    assert.doesNotThrow(() => encodePacketToMatrix(pkt, gs));
  }
  const t = truncateUtf8('aé東', 4); // 'a'(1) + 'é'(2) + '東'(3)
  assert.deepEqual(Array.from(t), Array.from(new TextEncoder().encode('aé')));
});

test('Manifest decoder rejects inconsistent or malformed manifests', () => {
  const base: TransferManifest = {
    transferId: 7,
    fileId: 1,
    fileName: 'a.bin',
    fileSize: 1000,
    mimeType: 'application/octet-stream',
    sha256: '00'.repeat(32),
    chunkSize: 100,
    totalSourcePackets: 10,
    erasureBlockSize: 4,
    gridSize: 64,
  };
  assert.ok(decodeManifestPayload(encodeManifestPayload(base)));
  assert.equal(decodeManifestPayload(encodeManifestPayload({ ...base, totalSourcePackets: 11 })), null);
  assert.equal(decodeManifestPayload(encodeManifestPayload({ ...base, chunkSize: 0, totalSourcePackets: 0 })), null);
  assert.equal(decodeManifestPayload(new TextEncoder().encode('{"t":1}')), null);
  const truncated = encodeManifestPayload(base).slice(0, 40);
  assert.equal(decodeManifestPayload(truncated), null);
  assert.throws(() => encodeManifestPayload({ ...base, sha256: 'xyz' }));
});

test('Encoder rejects oversized packets and unsupported grid sizes', () => {
  const plan = getGridLayoutPlan(48);
  assert.throws(() => encodePacketToMatrix(new Uint8Array(plan.rawByteCapacity + 1), 48), /can encode at most/);
  assert.throws(() => getGridLayoutPlan(32), /Unsupported grid size/);
  assert.throws(() => getGridLayoutPlan(64.5), /Unsupported grid size/);
});

test('LFSR whitening balances an all-zero payload', () => {
  const gs = 48;
  const pkt = encodePacket({
    packetType: PacketType.DATA,
    transferId: 1,
    fileId: 1,
    packetIndex: 0,
    totalSourcePackets: 1,
    erasureBlockSize: 0,
    gridSize: gs,
    flags: 0,
    payload: new Uint8Array(getGridPayloadCapacityBytes(gs)),
  });
  const m = encodePacketToMatrix(pkt, gs);
  const plan = getGridLayoutPlan(gs);
  let white = 0;
  for (const idx of plan.dataCellIndices) white += m.cells[idx];
  const ratio = white / plan.dataCellIndices.length;
  assert.ok(ratio > 0.4 && ratio < 0.6, `data-cell white ratio ${ratio}`);
});

function makeChunks(total: number, chunkSize: number, lastLen: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const arr = new Uint8Array(i === total - 1 ? lastLen : chunkSize);
    for (let b = 0; b < arr.length; b++) arr[b] = (i * 31 + b * 7) & 0xff;
    chunks.push(arr);
  }
  return chunks;
}

test('Join-anywhere tracker recovers a missing chunk via XOR parity in any arrival order', () => {
  const total = 8;
  const K = 4;
  const chunkSize = 16;
  const chunks = makeChunks(total, chunkSize, 11);
  const expectedLength = (i: number) => (i === total - 1 ? 11 : chunkSize);
  const tracker = new PacketRecoveryTracker(total, K, chunkSize, { expectedLength });
  const p0 = createXorParityPayload(chunks.slice(0, 4), chunkSize);
  const p1 = createXorParityPayload(chunks.slice(4, 8), chunkSize);
  const got = new Map<number, Uint8Array>();
  const take = (evs: { packetIndex: number; payload: Uint8Array }[]) => evs.forEach((e) => got.set(e.packetIndex, e.payload));

  for (const i of [5, 6, 7]) take(tracker.ingestDataPacket(i, chunks[i]));
  assert.equal(got.has(4), false);
  const ev = tracker.ingestParityPacket(1, p1);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].packetIndex, 4);
  assert.equal(ev[0].viaParity, true);
  take(ev);

  assert.equal(tracker.ingestDataPacket(6, chunks[6]).length, 0);
  assert.equal(tracker.getDuplicateCount(), 1);

  assert.equal(tracker.ingestParityPacket(0, p0).length, 0); // parity first
  for (const i of [3, 0, 1]) take(tracker.ingestDataPacket(i, chunks[i])); // 2 is recovered
  assert.equal(tracker.isComplete(), true);
  assert.equal(tracker.getParityRecoveryCount(), 2);
  for (let i = 0; i < total; i++) assert.deepEqual(got.get(i), chunks[i], `chunk ${i}`);
  assert.equal(tracker.getRecoveryMemoryBytes(), 0, 'completed blocks release recovery memory');
});

test('Recovery memory stays bounded and evicted blocks are never reconstructed from partial state', () => {
  const chunkSize = 1000;
  const K = 4;
  const total = 400; // 100 blocks
  const chunks = makeChunks(total, chunkSize, chunkSize);
  const budget = 20 * (chunkSize + 2) * 2; // room for ~20 blocks
  const tracker = new PacketRecoveryTracker(total, K, chunkSize, { maxRecoveryBytes: budget, expectedLength: () => chunkSize });
  // Receive 3 of 4 chunks of every block (one loss per block), parity never seen yet
  for (let b = 0; b < 100; b++) for (let j = 0; j < 3; j++) tracker.ingestDataPacket(b * K + j, chunks[b * K + j]);
  assert.ok(tracker.getRecoveryMemoryBytes() <= budget, `memory ${tracker.getRecoveryMemoryBytes()} <= ${budget}`);
  assert.ok(tracker.getRecoveryStateEvictions() > 0);
  // Parity for an evicted (early) block must NOT produce a recovery
  const early = tracker.ingestParityPacket(0, createXorParityPayload(chunks.slice(0, 4), chunkSize));
  assert.equal(early.length, 0);
  // Parity for a recent block still recovers correctly
  const late = tracker.ingestParityPacket(99, createXorParityPayload(chunks.slice(396, 400), chunkSize));
  assert.equal(late.length, 1);
  assert.deepEqual(late[0].payload, chunks[399]);
});

test('Recovered chunk with an impossible length is rejected rather than written', () => {
  const chunkSize = 32;
  const chunks = makeChunks(4, chunkSize, chunkSize);
  const tracker = new PacketRecoveryTracker(4, 4, chunkSize, { expectedLength: () => chunkSize });
  const parity = createXorParityPayload(chunks, chunkSize);
  parity[1] ^= 0x01; // corrupt the length XOR (cannot pass CRC in practice; defence in depth)
  for (const i of [0, 1, 2]) tracker.ingestDataPacket(i, chunks[i]);
  assert.equal(tracker.ingestParityPacket(0, parity).length, 0);
  assert.equal(tracker.getRejectedRecoveries(), 1);
  assert.equal(tracker.hasPacket(3), false);
});

test('Capacity audit: exact cell accounting and the 700 KB/frame claim', () => {
  const claim = auditClaimed700KbCapacity();
  assert.equal(claim.claimedBytesPerFrame, 716800);
  assert.equal(claim.actualDefault64UsefulBytes, 423);
  assert.equal(claim.actualMax384UsefulBytes, 18183);
  assert.ok(claim.requiredGridDimensionFor700Kb > 2000);
  for (const row of auditAllGridResolutions(8, 6)) {
    assert.equal(row.totalReservedCells, 4 * row.gridSize + 216);
    assert.equal(row.independentBinaryDataCells, row.totalGridCells - row.totalReservedCells);
    assert.equal(row.usefulPayloadBytesPerDataFrame, row.rawEncodedFrameBytes - 30);
  }
  const g64 = auditGridCapacity(64, 8, 6);
  assert.equal(g64.independentBinaryDataCells, 3624);
  assert.equal(g64.usefulPayloadBytesPerDataFrame, 423);
});

test('Download names from the sender are sanitised', async () => {
  const { sanitizeDownloadName } = await import('../utils/fileNames');
  assert.equal(sanitizeDownloadName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeDownloadName('a‮gnp.exe'), 'agnp.exe');
  assert.equal(sanitizeDownloadName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeDownloadName('...'), 'received.bin');
  assert.equal(sanitizeDownloadName('x'.repeat(300) + '.pdf').length, 120);
  assert.ok(sanitizeDownloadName('x'.repeat(300) + '.pdf').endsWith('.pdf'));
  assert.equal(sanitizeDownloadName('report (final).pdf'), 'report (final).pdf');
});
