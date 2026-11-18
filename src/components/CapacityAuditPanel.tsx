import React, { useState } from 'react';
import { CheckCircle2, Play, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { auditAllGridResolutions, auditClaimed700KbCapacity, CompleteOpticalAuditReport, runCompleteOpticalAudit } from '../engine/capacityAudit';
import { formatBytes, formatSpeed } from '../utils/integrity';

/**
 * Capacity arithmetic (exact) plus OPTIONAL software self-tests. The self-tests use generated
 * frames on this device; they are not physical camera measurements and are run only on request.
 */
export const CapacityAuditPanel: React.FC = () => {
  const claim = auditClaimed700KbCapacity();
  const rows = auditAllGridResolutions(8, 6);
  const [report, setReport] = useState<CompleteOpticalAuditReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await runCompleteOpticalAudit());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const fi = report?.faultInjection;
  const faultOk = fi ? fi.completed && fi.sha256Matches && fi.corruptedFramesAccepted === 0 : false;

  return (
    <section aria-label="Capacity and self-test" className="border border-slate-800 bg-[#0B101B] rounded-xl p-4 sm:p-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <div className="text-xs font-mono text-slate-400 mb-1">Capacity arithmetic · optional software self-test</div>
          <h2 className="text-lg font-semibold text-slate-100">How much data fits in one frame?</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-3xl">{claim.rootCauseExplanation}</p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={() => void run()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors whitespace-nowrap disabled:opacity-50"
        >
          {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          <span>{running ? 'Running self-test…' : 'Run software self-test'}</span>
        </button>
      </div>

      <div className="overflow-x-auto border border-slate-800 rounded-xl">
        <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-300 font-sans">
              <th className="py-2.5 px-3">Grid</th>
              <th className="py-2.5 px-3">Data cells</th>
              <th className="py-2.5 px-3">Fixed cells</th>
              <th className="py-2.5 px-3">Framing</th>
              <th className="py-2.5 px-3 text-sky-300">File data / DATA frame</th>
              <th className="py-2.5 px-3">Average / frame incl. manifest + parity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.map((r) => (
              <tr key={r.gridSize}>
                <td className="py-2 px-3 font-semibold text-slate-100">
                  {r.gridSize}×{r.gridSize}
                </td>
                <td className="py-2 px-3 text-slate-300">{r.independentBinaryDataCells.toLocaleString()}</td>
                <td className="py-2 px-3 text-slate-400">{r.totalReservedCells.toLocaleString()}</td>
                <td className="py-2 px-3 text-slate-400">{r.totalFramingOverheadBytes} B</td>
                <td className="py-2 px-3 font-semibold text-sky-400">
                  {r.usefulPayloadBytesPerDataFrame.toLocaleString()} B ({formatBytes(r.usefulPayloadBytesPerDataFrame)})
                </td>
                <td className="py-2 px-3 text-slate-300">{r.effectiveUsefulBytesPerEmittedFrame.toFixed(0)} B</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500 -mt-3">
        Fixed cells = 4G + 216 (fiducials, timing borders, calibration strip, sync word). Framing = 24 B header + 4 B CRC-32 + 2 B parity length.
        A 700 KB frame would need about {claim.requiredGridDimensionFor700Kb}×{claim.requiredGridDimensionFor700Kb} cells.
      </p>

      {error && <p role="alert" className="text-xs text-rose-300">Self-test failed to run: {error}</p>}

      {report && (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Synthetic camera frames (generated on this device — not a real camera)</h3>
            <div className="overflow-x-auto border border-slate-800 rounded-xl">
              <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-300 font-sans">
                    <th className="py-2 px-3">Grid</th>
                    <th className="py-2 px-3">Conditions</th>
                    <th className="py-2 px-3">px / cell</th>
                    <th className="py-2 px-3">Decode time</th>
                    <th className="py-2 px-3">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {report.syntheticFrameChecks.map((c) => (
                    <tr key={c.gridSize}>
                      <td className="py-2 px-3 text-slate-100">
                        {c.gridSize}×{c.gridSize}
                      </td>
                      <td className="py-2 px-3 text-slate-400 font-sans">{c.description}</td>
                      <td className="py-2 px-3 text-slate-300">{c.pixelsPerModule}</td>
                      <td className="py-2 px-3 text-slate-300">{c.decodeMs} ms</td>
                      <td className="py-2 px-3">
                        {c.bitExact ? <span className="text-emerald-400">Decoded, bit-exact</span> : <span className="text-amber-400">Not decoded ({c.status})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Decoder CPU cost on this device</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono tabular-nums">
              {report.decoderCost.map((d) => (
                <div key={d.gridSize} className="border border-slate-800 bg-slate-950/70 rounded-lg p-3">
                  <div className="text-slate-400 font-sans">
                    {d.gridSize}×{d.gridSize} on a {d.frameSize} frame
                  </div>
                  <div className="text-sm font-semibold text-slate-100 mt-1">{d.avgDecodeMs} ms / frame</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 font-sans">
                    Decoder-only ceiling {formatSpeed(d.decoderComputeCeilingBytesPerSec)} — not a transfer speed
                  </div>
                </div>
              ))}
            </div>
          </div>

          {fi && (
            <div className="border border-slate-800 bg-slate-900/40 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                {faultOk ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-rose-400" />}
                <span>Fault injection through the real pipeline (digital frames)</span>
              </div>
              <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-slate-300 font-mono tabular-nums">
                <li>Frames emitted: {fi.framesEmitted}</li>
                <li>Dropped: {fi.framesDropped}</li>
                <li>
                  Corrupted: {fi.corruptedFramesInjected} (accepted {fi.corruptedFramesAccepted})
                </li>
                <li>Joined at packet #{fi.joinedAtPacket ?? '—'}</li>
                <li>Parity recoveries: {fi.parityRecoveries}</li>
                <li>Duplicates ignored: {fi.duplicatesIgnored}</li>
                <li>Completed: {fi.completed ? 'yes' : 'no'}</li>
                <li>SHA-256 match: {fi.sha256Matches ? 'yes' : 'no'}</li>
              </ul>
            </div>
          )}

          <p className="flex items-start gap-2 text-xs text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              These are software checks run at {new Date(report.timestampIso).toLocaleTimeString()}. They show the protocol and decoder work on generated images; real
              transfer speed and reliability must be measured with two physical devices.
            </span>
          </p>
        </>
      )}
    </section>
  );
};
