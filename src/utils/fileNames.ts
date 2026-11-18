/**
 * File names arrive from an untrusted sender. Strip path separators, control characters and
 * characters Windows/macOS/Android reject, avoid reserved device names, and bound the length.
 * Browsers also sanitise `download` names; this is defence in depth and gives a predictable name.
 */
export function sanitizeDownloadName(name: string, fallback = 'received.bin'): string {
  let n = (name || '').normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ''); // control + bidi overrides
  n = n.replace(/[\\/:*?"<>|]/g, '_');
  n = n.replace(/^[.\s]+|[.\s]+$/g, ''); // no leading dots (hidden files) or trailing dots/spaces
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || fallback;
}
