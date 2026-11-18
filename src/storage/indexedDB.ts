export interface StoredTransferRecord {
  transferId: number;
  fileId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string;
  chunkSize: number;
  totalSourcePackets: number;
  erasureBlockSize: number;
  receivedCount: number;
  completed: boolean;
  verified: boolean;
  updatedAt: number;
}

const DB_NAME = 'flashdrop_metadata_db';
const DB_VERSION = 1;
const STORE_TRANSFERS = 'transfers';
const STORE_CHUNKS_FALLBACK = 'fallback_chunks';
const MAX_HISTORY_RECORDS = 50;

let dbPromise: Promise<IDBDatabase> | null = null;

/** One shared connection per page (opening a connection per chunk was a major bottleneck). */
function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRANSFERS)) {
        db.createObjectStore(STORE_TRANSFERS, { keyPath: 'transferId' });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS_FALLBACK)) {
        db.createObjectStore(STORE_CHUNKS_FALLBACK);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      // Another tab holds an old version open; keep waiting for onsuccess/onerror.
    };
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function chunkKey(transferId: number, packetIndex: number): string {
  // Zero-padded so lexical key order equals numeric order
  return `${transferId >>> 0}:${String(packetIndex).padStart(10, '0')}`;
}

export async function saveTransferMetadata(record: StoredTransferRecord): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_TRANSFERS, 'readwrite');
    tx.objectStore(STORE_TRANSFERS).put(record);
    await txDone(tx);
    await pruneHistory(db);
  } catch {
    // Non-fatal: history is informational only
  }
}

async function pruneHistory(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_TRANSFERS, 'readwrite');
  const store = tx.objectStore(STORE_TRANSFERS);
  const req = store.getAll();
  req.onsuccess = () => {
    const records = (req.result as StoredTransferRecord[]).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of records.slice(MAX_HISTORY_RECORDS)) store.delete(old.transferId);
  };
  await txDone(tx);
}

export async function listTransferMetadata(): Promise<StoredTransferRecord[]> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_TRANSFERS, 'readonly');
    const req = tx.objectStore(STORE_TRANSFERS).getAll();
    await txDone(tx);
    return ((req.result as StoredTransferRecord[]) || []).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function clearAllTransferHistory(): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction([STORE_TRANSFERS, STORE_CHUNKS_FALLBACK], 'readwrite');
    tx.objectStore(STORE_TRANSFERS).clear();
    tx.objectStore(STORE_CHUNKS_FALLBACK).clear();
    await txDone(tx);
  } catch {
    // Ignore
  }
}

/** Writes several chunks in ONE transaction. */
export async function putFallbackChunks(
  transferId: number,
  items: Array<{ packetIndex: number; data: Uint8Array }>
): Promise<void> {
  if (items.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction(STORE_CHUNKS_FALLBACK, 'readwrite');
  const store = tx.objectStore(STORE_CHUNKS_FALLBACK);
  for (const it of items) store.put(it.data, chunkKey(transferId, it.packetIndex));
  await txDone(tx);
}

export async function putFallbackChunk(transferId: number, packetIndex: number, payload: Uint8Array): Promise<void> {
  await putFallbackChunks(transferId, [{ packetIndex, data: payload }]);
}

export async function getFallbackChunks(
  transferId: number,
  fromIndex: number,
  toIndexExclusive: number
): Promise<Map<number, Uint8Array>> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_CHUNKS_FALLBACK, 'readonly');
  const store = tx.objectStore(STORE_CHUNKS_FALLBACK);
  const out = new Map<number, Uint8Array>();
  const range = IDBKeyRange.bound(chunkKey(transferId, fromIndex), chunkKey(transferId, toIndexExclusive), false, true);
  const req = store.openCursor(range);
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const key = String(cursor.key);
    const idx = Number(key.slice(key.indexOf(':') + 1));
    const v = cursor.value as Uint8Array | ArrayBuffer;
    out.set(idx, v instanceof Uint8Array ? v : new Uint8Array(v));
    cursor.continue();
  };
  await txDone(tx);
  return out;
}

export async function getFallbackChunk(transferId: number, packetIndex: number): Promise<Uint8Array | null> {
  const m = await getFallbackChunks(transferId, packetIndex, packetIndex + 1);
  return m.get(packetIndex) ?? null;
}

export async function deleteFallbackChunks(transferId: number): Promise<void> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_CHUNKS_FALLBACK, 'readwrite');
    tx.objectStore(STORE_CHUNKS_FALLBACK).delete(
      IDBKeyRange.bound(`${transferId >>> 0}:`, `${transferId >>> 0}:￿`)
    );
    await txDone(tx);
  } catch {
    // Ignore
  }
}

/** Test hook: drop the cached connection (e.g. between test cases). */
export function __resetIndexedDbConnectionForTests(): void {
  dbPromise = null;
}
