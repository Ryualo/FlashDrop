import { crc32 } from '../utils/integrity';

export enum PacketType {
  MANIFEST = 1,
  DATA = 2,
  PARITY = 3,
}

export const PACKET_MAGIC_0 = 0xfd;
export const PACKET_MAGIC_1 = 0x4f;
/**
 * v2: binary manifest (fits the smallest 48×48 grid) and CRC-before-version validation so that a
 * frame from an incompatible sender build is reported as such instead of as a generic CRC error.
 */
export const PROTOCOL_VERSION = 2;
export const PACKET_HEADER_SIZE = 24;
export const PACKET_CRC_SIZE = 4;
export const PACKET_OVERHEAD_BYTES = PACKET_HEADER_SIZE + PACKET_CRC_SIZE; // 28 bytes
export const MAX_PAYLOAD_BYTES = 0xffff;

export interface DropFlashPacket {
  version: number;
  packetType: PacketType;
  transferId: number;
  fileId: number;
  packetIndex: number;
  totalSourcePackets: number;
  payloadLength: number;
  erasureBlockSize: number;
  gridSize: number;
  flags: number;
  payload: Uint8Array;
  crc: number;
}

export interface TransferManifest {
  transferId: number;
  fileId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string;
  chunkSize: number;
  totalSourcePackets: number;
  erasureBlockSize: number;
  gridSize: number;
}

export function encodePacket(input: Omit<DropFlashPacket, 'version' | 'payloadLength' | 'crc'>): Uint8Array {
  const payloadLen = input.payload.byteLength;
  if (payloadLen > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Packet payload of ${payloadLen} bytes exceeds the 16-bit length field.`);
  }
  const totalLength = PACKET_HEADER_SIZE + payloadLen + PACKET_CRC_SIZE;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer);

  buffer[0] = PACKET_MAGIC_0;
  buffer[1] = PACKET_MAGIC_1;
  buffer[2] = PROTOCOL_VERSION;
  buffer[3] = input.packetType;
  view.setUint32(4, input.transferId >>> 0, false);
  view.setUint16(8, input.fileId & 0xffff, false);
  view.setUint32(10, input.packetIndex >>> 0, false);
  view.setUint32(14, input.totalSourcePackets >>> 0, false);
  view.setUint16(18, payloadLen, false);
  buffer[20] = input.erasureBlockSize & 0xff;
  view.setUint16(21, input.gridSize & 0xffff, false);
  buffer[23] = input.flags & 0xff;

  buffer.set(input.payload, PACKET_HEADER_SIZE);
  const computedCrc = crc32(buffer, 0, PACKET_HEADER_SIZE + payloadLen);
  view.setUint32(PACKET_HEADER_SIZE + payloadLen, computedCrc >>> 0, false);
  return buffer;
}

export interface DecodePacketResult {
  ok: boolean;
  error?: 'magic_mismatch' | 'version_mismatch' | 'length_invalid' | 'crc_mismatch' | 'type_invalid';
  packet?: DropFlashPacket;
  /** Protocol version found in a CRC-valid frame (reported for version mismatches). */
  foundVersion?: number;
}

export function decodePacket(rawBytes: Uint8Array): DecodePacketResult {
  if (rawBytes.byteLength < PACKET_OVERHEAD_BYTES) {
    return { ok: false, error: 'length_invalid' };
  }
  if (rawBytes[0] !== PACKET_MAGIC_0 || rawBytes[1] !== PACKET_MAGIC_1) {
    return { ok: false, error: 'magic_mismatch' };
  }
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const payloadLength = view.getUint16(18, false);
  if (PACKET_HEADER_SIZE + payloadLength + PACKET_CRC_SIZE > rawBytes.byteLength) {
    return { ok: false, error: 'length_invalid' };
  }
  const expectedCrc = view.getUint32(PACKET_HEADER_SIZE + payloadLength, false);
  const actualCrc = crc32(rawBytes, 0, PACKET_HEADER_SIZE + payloadLength);
  if (expectedCrc !== actualCrc) {
    return { ok: false, error: 'crc_mismatch' };
  }

  const version = rawBytes[2];
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, error: 'version_mismatch', foundVersion: version };
  }
  const packetType = rawBytes[3] as PacketType;
  if (packetType !== PacketType.MANIFEST && packetType !== PacketType.DATA && packetType !== PacketType.PARITY) {
    return { ok: false, error: 'type_invalid' };
  }

  return {
    ok: true,
    packet: {
      version,
      packetType,
      transferId: view.getUint32(4, false),
      fileId: view.getUint16(8, false),
      packetIndex: view.getUint32(10, false),
      totalSourcePackets: view.getUint32(14, false),
      payloadLength,
      erasureBlockSize: rawBytes[20],
      gridSize: view.getUint16(21, false),
      flags: rawBytes[23],
      payload: rawBytes.slice(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + payloadLength),
      crc: expectedCrc,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Binary manifest (v2)
// ---------------------------------------------------------------------------------------------

const MANIFEST_FORMAT = 1;
const MANIFEST_FIXED_BYTES = 1 + 4 + 2 + 8 + 4 + 4 + 1 + 2 + 32 + 1 + 1; // 60
const MAX_MIME_BYTES = 64;
export const MIN_MANIFEST_NAME_BYTES = 8;
export const MAX_MANIFEST_NAME_BYTES = 200;

/** Truncates a string to at most `maxBytes` of UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // step back to a lead byte
  return bytes.slice(0, end);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function expectedSourcePacketCount(fileSize: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(fileSize / chunkSize));
}

/**
 * Encodes the manifest. `maxBytes` (the frame payload capacity) bounds the encoding: the file
 * name is truncated (UTF-8 safe) so the manifest always fits in a single frame.
 */
export function encodeManifestPayload(manifest: TransferManifest, maxBytes = 4096): Uint8Array {
  const sha = hexToBytes(manifest.sha256);
  if (!sha) throw new Error('Manifest SHA-256 must be 64 hex characters.');
  if (!Number.isSafeInteger(manifest.fileSize) || manifest.fileSize < 0) {
    throw new RangeError('Manifest fileSize must be a non-negative safe integer.');
  }
  const mime = truncateUtf8(manifest.mimeType || 'application/octet-stream', MAX_MIME_BYTES);
  const nameBudget = Math.min(MAX_MANIFEST_NAME_BYTES, maxBytes - MANIFEST_FIXED_BYTES - mime.byteLength);
  if (nameBudget < MIN_MANIFEST_NAME_BYTES) {
    throw new RangeError(`Frame payload capacity (${maxBytes} B) is too small for a manifest.`);
  }
  const name = truncateUtf8(manifest.fileName || 'payload.bin', nameBudget);
  const out = new Uint8Array(MANIFEST_FIXED_BYTES + mime.byteLength + name.byteLength);
  const v = new DataView(out.buffer);
  let o = 0;
  out[o++] = MANIFEST_FORMAT;
  v.setUint32(o, manifest.transferId >>> 0);
  o += 4;
  v.setUint16(o, manifest.fileId & 0xffff);
  o += 2;
  v.setUint32(o, Math.floor(manifest.fileSize / 0x100000000));
  o += 4;
  v.setUint32(o, manifest.fileSize >>> 0);
  o += 4;
  v.setUint32(o, manifest.chunkSize >>> 0);
  o += 4;
  v.setUint32(o, manifest.totalSourcePackets >>> 0);
  o += 4;
  out[o++] = manifest.erasureBlockSize & 0xff;
  v.setUint16(o, manifest.gridSize & 0xffff);
  o += 2;
  out.set(sha, o);
  o += 32;
  out[o++] = mime.byteLength;
  out.set(mime, o);
  o += mime.byteLength;
  out[o++] = name.byteLength;
  out.set(name, o);
  return out;
}

/**
 * Decodes and VALIDATES a manifest. Every field is treated as untrusted input (it arrives over a
 * one-way optical channel from an arbitrary screen): inconsistent sizes are rejected.
 */
export function decodeManifestPayload(payload: Uint8Array): TransferManifest | null {
  try {
    if (payload.byteLength < MANIFEST_FIXED_BYTES || payload[0] !== MANIFEST_FORMAT) return null;
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let o = 1;
    const transferId = v.getUint32(o);
    o += 4;
    const fileId = v.getUint16(o);
    o += 2;
    const hi = v.getUint32(o);
    o += 4;
    const lo = v.getUint32(o);
    o += 4;
    const fileSize = hi * 0x100000000 + lo;
    const chunkSize = v.getUint32(o);
    o += 4;
    const totalSourcePackets = v.getUint32(o);
    o += 4;
    const erasureBlockSize = payload[o++];
    const gridSize = v.getUint16(o);
    o += 2;
    const sha256 = bytesToHex(payload.subarray(o, o + 32));
    o += 32;
    const mimeLen = payload[o++];
    if (mimeLen > MAX_MIME_BYTES || o + mimeLen + 1 > payload.byteLength) return null;
    const mimeType = new TextDecoder('utf-8', { fatal: false }).decode(payload.subarray(o, o + mimeLen));
    o += mimeLen;
    const nameLen = payload[o++];
    if (o + nameLen > payload.byteLength) return null;
    const fileName = new TextDecoder('utf-8', { fatal: false }).decode(payload.subarray(o, o + nameLen));

    if (!Number.isSafeInteger(fileSize)) return null;
    if (chunkSize < 1 || chunkSize > MAX_PAYLOAD_BYTES - 2) return null;
    if (totalSourcePackets !== expectedSourcePacketCount(fileSize, chunkSize)) return null;
    if (gridSize < 40 || gridSize > 512) return null;

    return {
      transferId,
      fileId,
      fileName: fileName || 'received.bin',
      fileSize,
      mimeType: mimeType || 'application/octet-stream',
      sha256,
      chunkSize,
      totalSourcePackets,
      erasureBlockSize,
      gridSize,
    };
  } catch {
    return null;
  }
}
