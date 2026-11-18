import type { OpticalDecodeResult, QuadCorners } from '../engine/opticalDecoder';

export type DecodeRequest =
  | {
      type: 'decode';
      id: number;
      /** Preferred: camera frame as a transferable ImageBitmap (scaled inside the worker). */
      bitmap?: ImageBitmap;
      /** Fallback: raw RGBA pixels (transferred). */
      buffer?: ArrayBuffer;
      width: number;
      height: number;
      procWidth: number;
      procHeight: number;
      expectedGridSize?: number;
      /** Manual calibration corners in normalised [0,1] frame coordinates. */
      customCornersNormalized?: QuadCorners | null;
    }
  | { type: 'reset' };

export type DecodeResponse =
  | {
      type: 'result';
      id: number;
      result: OpticalDecodeResult;
      decodeMs: number;
      procWidth: number;
      procHeight: number;
    }
  | { type: 'error'; id: number; message: string };
