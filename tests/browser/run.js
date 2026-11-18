/**
 * In-browser integration tests (real OPFS, IndexedDB, module Worker, camera pipeline).
 * Serve with `npm run dev` and open /tests/browser/index.html, or run scripts/run-browser-tests.mjs.
 * The fake-camera test uses a GENERATED video (synthetic), not a physical camera.
 */
import { ChunkedFileStorage, cleanupIncomingStorage } from '../../src/storage/opfsStorage';
import { IncrementalFileReconstructor } from '../../src/engine/fileReconstructor';
import { StreamingFileCarousel } from '../../src/engine/fileChunker';
import { decodePacket } from '../../src/engine/packetProtocol';
import { ScanSession } from '../../src/engine/scanSession';
import { renderSyntheticCameraFrame } from '../../src/engine/syntheticCamera';
import { encodePacketToMatrix, getGridPayloadCapacityBytes } from '../../src/engine/opticalEncoder';
import { encodePacket, PacketType } from '../../src/engine/packetProtocol';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function gen(size, seed) { const d = new Uint8Array(size); let s = seed >>> 0; for (let i = 0; i < size; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s >>> 24; } return d; }
function shuffled(n, seed) { const a = [...Array(n).keys()]; let s = seed; for (let i = n - 1; i > 0; i--) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function opfsEntries() { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('flashdrop-incoming', { create: true }); const n = []; for await (const k of dir.keys()) n.push(k); return n; }

async function storageTest(backend, size) {
  const chunk = 18181; const total = Math.ceil(size / chunk); const data = gen(size, 5);
  const expected = hex(await crypto.subtle.digest('SHA-256', data));
  const st = new ChunkedFileStorage(0xabc000 + size % 1000, 'big.bin', size, chunk, total, { memoryThresholdBytes: 0, forceBackend: backend });
  const t0 = performance.now(); const init = await st.init();
  for (const i of shuffled(total, 9)) await st.writeChunk(i, data.subarray(i * chunk, Math.min(size, (i + 1) * chunk)));
  const t1 = performance.now();
  const res = await st.verifyAndFinalize(expected, 'application/octet-stream');
  const t2 = performance.now();
  const tail = new Uint8Array(await res.blob.slice(size - 16).arrayBuffer());
  const tailOk = tail.every((v, i) => v === data[size - 16 + i]);
  const entriesBefore = backend === 'OPFS' ? await opfsEntries() : [];
  await st.discard();
  const entriesAfter = backend === 'OPFS' ? await opfsEntries() : [];
  return { backend: init.backend, sizeMB: +(size / 1048576).toFixed(1), chunks: total, verified: res.verified, blobSize: res.blob.size, tailOk, writeMs: Math.round(t1 - t0), verifyMs: Math.round(t2 - t1), writeMBps: +((size / 1048576) / ((t1 - t0) / 1000)).toFixed(1), entriesBefore: entriesBefore.length, entriesAfter: entriesAfter.length };
}

async function quotaTest() {
  const st = new ChunkedFileStorage(1, 'q', 50e6, 18181, 2751, { memoryThresholdBytes: 0, estimate: async () => ({ quota: 60e6, usage: 30e6 }) });
  try { await st.init(); return { ok: false }; } catch (e) { return { ok: e.code === 'insufficient_quota', message: e.message }; }
}

async function reconstructorOpfsTest() {
  const size = 3 * 1024 * 1024 + 123; const data = gen(size, 11);
  const c = new StreamingFileCarousel(new File([data], 'r.bin'), 'r.bin', '', { gridSize: 384, erasureBlockSize: 8, startPacketOffset: 40 });
  const m = await c.prepare();
  const rec = new IncrementalFileReconstructor({ storage: { memoryThresholdBytes: 0 } });
  let frames = 0; let state;
  while (frames < 2000) { frames++; const p = await c.nextPacket(); if (frames % 7 === 0) continue; state = await rec.ingestPacket(decodePacket(p.rawBytes).packet); if (state.status !== 'receiving' && state.status !== 'waiting_manifest') break; }
  state = await rec.drain();
  const back = new Uint8Array(await state.downloadBlob.arrayBuffer());
  return { status: state.status, backend: state.storageBackend, verified: state.verified, bytesEqual: back.length === size && back.every((v, i) => v === data[i]), parity: state.parityRecoveredPackets, frames, packets: m.totalSourcePackets };
}

async function workerTest() {
  const w = new Worker(new URL('../../src/workers/decoder.worker.ts', import.meta.url), { type: 'module' });
  const gs = 96; const n = getGridPayloadCapacityBytes(gs) - 2; const payload = gen(n, 3);
  const bytes = encodePacket({ packetType: PacketType.DATA, transferId: 9, fileId: 1, packetIndex: 4, totalSourcePackets: 50, erasureBlockSize: 8, gridSize: gs, flags: 0, payload });
  const f = renderSyntheticCameraFrame(encodePacketToMatrix(bytes, gs), { width: 1280, height: 720, matrixSidePx: 600, rotationDeg: 20, perspectiveTilt: 0.12, seed: 3 });
  // Also exercise the ImageBitmap path used for camera frames
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(f.data), 1280, 720));
  const run = (msg, transfer) => new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(msg, transfer); });
  const a = await run({ type: 'decode', id: 1, buffer: f.data.buffer, width: 1280, height: 720, procWidth: 1280, procHeight: 720 }, [f.data.buffer]);
  const b = await run({ type: 'decode', id: 2, bitmap: bmp, width: 1280, height: 720, procWidth: 1280, procHeight: 720 }, [bmp]);
  w.terminate();
  const eq = (r) => r.type === 'result' && r.result.status === 'valid' && r.result.packet.payload.length === n && r.result.packet.payload.every((v, i) => v === payload[i]);
  return { bufferPath: eq(a), bufferMs: Math.round(a.decodeMs), bitmapPath: eq(b), bitmapMs: Math.round(b.decodeMs), locatorB: b.result?.locator };
}

async function fakeCameraTest() {
  // Needs Chrome started with a fake camera (see scripts/run-browser-tests.mjs); skipped otherwise.
  const metaRes = await fetch('./fake-camera.json').catch(() => null);
  if (!metaRes || !metaRes.ok) return { skipped: 'tests/browser/fake-camera.json not found — run scripts/make-fake-camera-video.ts first' };
  const meta = await metaRes.json();
  const rec = new IncrementalFileReconstructor();
  const video = document.getElementById('v');
  let last = null; let telemetry = null; let errors = [];
  const done = new Promise((resolve) => {
    const session = new ScanSession({
      onPacket: (p) => { void rec.ingestPacket(p).then((s) => { last = s; if (s.status === 'completed' || s.status === 'integrity_error' || s.status === 'storage_error') resolve(session); }); },
      onTelemetry: (t) => { telemetry = t; },
      onError: (m) => { errors.push(m); },
    }, { getExpectedGridSize: () => rec.getState().manifest?.gridSize, getManualCorners: () => null, maxProcessLongSide: 1280, workerFactory: () => new Worker(new URL('../../src/workers/decoder.worker.ts', import.meta.url), { type: 'module' }) });
    window.__session = session;
    session.startCamera(video, undefined, 30).catch((e) => { errors.push(String(e)); resolve(session); });
    setTimeout(() => resolve(session), 90000);
  });
  const t0 = performance.now();
  const session = await done;
  const elapsed = (performance.now() - t0) / 1000;
  const tel = session.getTelemetry();
  session.dispose();
  const s = await rec.drain();
  return { status: s.status, verified: s.verified, shaMatchesFile: s.computedSha256 === meta.sha, elapsedSec: +elapsed.toFixed(1), received: s.receivedPackets, total: s.totalPackets, parity: s.parityRecoveredPackets, joinedAt: s.joinedAtPacketIndex,
    framesProcessed: tel.framesProcessed, valid: tel.validPackets, crc: tel.crcErrors, noSync: tel.noSync, skippedBusy: tel.framesSkippedBusy, avgDecodeMs: +tel.avgDecodeMs.toFixed(1), video: `${video.videoWidth}x${video.videoHeight}`, errors };
}

window.runAll = async () => {
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e && e.stack || e) }; } };
  await cleanupIncomingStorage();
  await step('opfs_64MB_shuffled', () => storageTest('OPFS', 64 * 1024 * 1024));
  await step('indexeddb_16MB_shuffled', () => storageTest('IndexedDB', 16 * 1024 * 1024));
  await step('quota_check', quotaTest);
  await step('reconstructor_3MB_opfs', reconstructorOpfsTest);
  await step('worker_decode', workerTest);
  await step('fake_camera_end_to_end', fakeCameraTest);
  return out;
};
window.__ready = true;
document.getElementById('run')?.addEventListener('click', async () => {
  const out = document.getElementById('out');
  out.textContent = 'Running…';
  out.textContent = JSON.stringify(await window.runAll(), null, 2);
});
