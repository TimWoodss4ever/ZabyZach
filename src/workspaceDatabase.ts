// Auth and RPC retry identifiers deliberately keep their existing storage.
export type WorkspaceSnapshot = {values: Record<string, string>; legacyBackup?: Record<string, string>; legacyArchive?: Record<string, string[]>};
export interface WorkspaceDatabase {
  read(): Promise<WorkspaceSnapshot>;
  update(changes: Record<string, string | null>, legacyBackup?: Record<string, string>): Promise<WorkspaceSnapshot>;
  close(): void;
}
function revision(text?: string) {
  try { const n = JSON.parse(text ?? 'null')?.revision; return Number.isFinite(n) ? Number(n) : -1; } catch { return -1; }
}
export function mergeWorkspaceSnapshot(previous: WorkspaceSnapshot, changes: Record<string, string | null>, legacyBackup?: Record<string, string>): WorkspaceSnapshot {
  const result: WorkspaceSnapshot = {values:{...previous.values}, ...(previous.legacyBackup ? {legacyBackup:{...previous.legacyBackup}} : {}), ...(previous.legacyArchive ? {legacyArchive:structuredClone(previous.legacyArchive)} : {})};
  const state = 'zbyzack-erp-v1', costs = state + '-costs';
  // Recheck inside the read/write transaction: a newer tab may have committed
  // after the migration's initial read. Never replace its state/cost pair.
  const newer = legacyBackup && typeof changes[state] === 'string' && revision(previous.values[state]) > revision(changes[state]);
  for (const [key, value] of Object.entries(changes)) {
    if (newer && (key === state || key === costs)) continue;
    if (value === null) delete result.values[key]; else result.values[key] = value;
  }
  if (legacyBackup && Object.keys(legacyBackup).length) {
    result.legacyBackup ??= {...legacyBackup};
    for (const [key, value] of Object.entries(legacyBackup)) {
      if (result.values[key] === value || result.legacyBackup[key] === value || result.legacyArchive?.[key]?.includes(value)) continue;
      result.legacyArchive ??= {}; result.legacyArchive[key] = [...(result.legacyArchive[key] ?? []), value];
    }
  }
  return result;
}
export function openWorkspaceDatabase(timeoutMs = 5000): Promise<WorkspaceDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = (error: unknown) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new Error('Opening local workspace storage timed out.')), timeoutMs);
    try {
      const request = globalThis.indexedDB.open('zbyzack-local-workspace-v2', 1);
      request.onupgradeneeded = () => {
        if (finished) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace');
      };
      request.onerror = () => fail(request.error ?? new Error('Unable to open local workspace storage.'));
      request.onblocked = () => fail(new Error('Another tab is blocking local workspace storage.'));
      request.onsuccess = () => {
        const db = request.result;
        if (finished) { db.close(); return; }
        finished = true; clearTimeout(timer); db.onversionchange = () => db.close();
        const transaction = (changes?: Record<string, string | null>, legacyBackup?: Record<string, string>) =>
          new Promise<WorkspaceSnapshot>((done, failed) => {
            let tx: IDBTransaction;
            try { tx = db.transaction('workspace', changes ? 'readwrite' : 'readonly'); }
            catch (error) { failed(error); return; }
            let result: WorkspaceSnapshot = {values: {}}, settled = false;
            const finish = (error?: unknown) => {
              if (settled) return;
              settled = true; clearTimeout(limit); if (error) failed(error); else done(result);
            };
            const limit = setTimeout(() => {
              try { tx.abort(); } catch { /* Already completed. */ }
              finish(new Error('Local workspace transaction timed out.'));
            }, timeoutMs);
            tx.onabort = () => finish(tx.error ?? new Error('Local workspace transaction was cancelled.'));
            tx.onerror = () => finish(tx.error ?? new Error('Local workspace transaction failed.'));
            // Request success alone does not prove that the transaction committed.
            tx.oncomplete = () => finish();
            const store = tx.objectStore('workspace'), get = store.get('current');
            get.onsuccess = () => {
              try {
                const previous = get.result as WorkspaceSnapshot | undefined;
                result = previous ?? {values:{}};
                if (!changes) return;
                result = mergeWorkspaceSnapshot(result, changes, legacyBackup);
                store.put(result, 'current');
              } catch (error) { try { tx.abort(); } catch {} finish(error); }
            };
          });
        resolve({read: () => transaction(), update: (changes, backup) => transaction(changes, backup), close: () => db.close()});
      };
    } catch (error) { fail(error); }
  });
}
