/// <reference lib="webworker" />
/**
 * Off-main-thread optical decoder. Receives either an ImageBitmap (preferred: the full-resolution
 * camera frame is scaled here, off the UI thread) or a raw RGBA buffer, and returns the decode
 * result. Exactly one frame is processed at a time; the caller keeps at most one in flight.
 */
import { OpticalFrameDecoder, QuadCorners } from '../engine/opticalDecoder';
import { rgbaToLuma } from '../engine/vision/finderPatterns';
import type { DecodeRequest, DecodeResponse } from './decoderProtocol';

declare const self: DedicatedWorkerGlobalScope;

const decoder = new OpticalFrameDecoder();
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let lumaBuffer: Uint8Array | null = null;

function scaleCorners(c: QuadCorners | null | undefined, w: number, h: number): QuadCorners | null {
  if (!c) return null;
  const s = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h });
  return { topLeft: s(c.topLeft), topRight: s(c.topRight), bottomLeft: s(c.bottomLeft), bottomRight: s(c.bottomRight) };
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const msg = event.data;
  if (msg.type === 'reset') {
    decoder.reset();
    return;
  }
  if (msg.type !== 'decode') return;
  const t0 = performance.now();
  try {
    let rgba: Uint8ClampedArray;
    let w: number;
    let h: number;
    if (msg.bitmap) {
      w = msg.procWidth;
      h = msg.procHeight;
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false }) as OffscreenCanvasRenderingContext2D | null;
      }
      if (!ctx) throw new Error('OffscreenCanvas 2D is unavailable in this worker');
      ctx.imageSmoothingEnabled = true; // area-average when downscaling the camera frame
      ctx.drawImage(msg.bitmap, 0, 0, w, h);
      msg.bitmap.close();
      rgba = ctx.getImageData(0, 0, w, h).data;
    } else if (msg.buffer) {
      w = msg.width;
      h = msg.height;
      rgba = new Uint8ClampedArray(msg.buffer);
    } else {
      throw new Error('Decode request has no image');
    }
    if (!lumaBuffer || lumaBuffer.length < w * h) lumaBuffer = new Uint8Array(w * h);
    const luma = rgbaToLuma(rgba, w, h, lumaBuffer);
    const result = decoder.decodeLuma(luma.subarray(0, w * h), w, h, {
      expectedGridSize: msg.expectedGridSize,
      customCorners: scaleCorners(msg.customCornersNormalized, w, h),
    });
    const response: DecodeResponse = {
      type: 'result',
      id: msg.id,
      result,
      decodeMs: performance.now() - t0,
      procWidth: w,
      procHeight: h,
    };
    const transfer: Transferable[] = [];
    if (result.packet) transfer.push(result.packet.payload.buffer as ArrayBuffer);
    self.postMessage(response, transfer);
  } catch (e) {
    const response: DecodeResponse = {
      type: 'error',
      id: msg.id,
      message: e instanceof Error ? e.message : String(e),
    };
    self.postMessage(response);
  }
};
