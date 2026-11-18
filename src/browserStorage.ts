import {openWorkspaceDatabase} from './workspaceDatabase.ts';
import type {WorkspaceDatabase, WorkspaceSnapshot} from './workspaceDatabase.ts';
export const workspaceKeys = [
  'zbyzack-erp-v1', 'zbyzack-erp-v1-costs',
  'zbyzack-erp-v1-before-erp-updates', 'zbyzack-erp-v1-costs-before-erp-updates',
] as const;
const managed = new Set<string>(workspaceKeys);
type SmallStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Options = {
  localStorage?: () => SmallStorage;
  openDatabase?: () => Promise<WorkspaceDatabase>;
  notifyPeers?: () => void;
  onRemoteChange?: () => void;
};
export function createBrowserStorage(options: Options = {}) {
  const local = options.localStorage ?? (() => globalThis.localStorage);
  const memory = new Map<string, string | null>(), dirty = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  let db: WorkspaceDatabase | undefined, mode: 'legacy' | 'database' | 'memory' = 'legacy';
  let unavailable = false, version = 0;
  let initialization: Promise<void> | undefined, worker: Promise<void> | undefined;
  let migrationBackup: Record<string, string> | undefined;
  let migrationArchive: Record<string, string[]> | undefined;
  const status = (next: boolean) => {
    if (unavailable === next) return;
    unavailable = next; for (const listener of listeners) listener();
  };
  const readLegacy = () => {
    const values: Record<string, string> = {};
    for (const key of workspaceKeys) {
      try { const value = local().getItem(key); if (value !== null) values[key] = value; } catch { /* IndexedDB can still work. */ }
    }
    return values;
  };
  const adopt = (snapshot: WorkspaceSnapshot) => {
    for (const key of workspaceKeys) memory.set(key, snapshot.values[key] ?? null);
    migrationBackup = snapshot.legacyBackup;
    migrationArchive = snapshot.legacyArchive;
  };
  const revision = (text?: string) => {
    try { const value = JSON.parse(text ?? 'null')?.revision; return Number.isFinite(value) ? Number(value) : -1; } catch { return -1; }
  };
  const initialize = () => initialization ??= (async () => {
    const legacy = readLegacy();
    try {
      db = await (options.openDatabase ?? openWorkspaceDatabase)();
      let snapshot = await db.read();
      const changes: Record<string, string> = {};
      for (const key of workspaceKeys) if (snapshot.values[key] === undefined && legacy[key] !== undefined) changes[key] = legacy[key];
      const state = workspaceKeys[0], costs = workspaceKeys[1];
      if (legacy[state] !== undefined && revision(legacy[state]) > revision(snapshot.values[state])) {
        changes[state] = legacy[state];
        if (legacy[costs] !== undefined) changes[costs] = legacy[costs];
      }
      if (Object.keys(legacy).length) {
        // Commit and verify before freeing the small localStorage area.
        snapshot = await db.update(changes, legacy);
        const verified = await db.read();
        for (const [key, value] of Object.entries(changes)) {
          const superseded = (key === state || key === costs) && revision(verified.values[state]) > revision(legacy[state]);
          if (verified.values[key] !== value && !superseded) throw Error('Local workspace migration could not be verified.');
        }
        if (!verified.legacyBackup) throw Error('Original local workspace backup could not be verified.');
        for (const [key, value] of Object.entries(legacy)) if (verified.values[key] !== value && verified.legacyBackup[key] !== value && !verified.legacyArchive?.[key]?.includes(value)) throw Error('An original local workspace value was not preserved.');
        snapshot = verified;
        for (const [key, value] of Object.entries(legacy)) {
          // Keep concurrent old-tab writes and any unarchived conflicting values.
          const preserved = verified.values[key] === value || verified.legacyBackup[key] === value || verified.legacyArchive?.[key]?.includes(value);
          try { if (preserved && local().getItem(key) === value) local().removeItem(key); } catch { /* Committed copy remains durable. */ }
        }
      }
      adopt(snapshot); mode = 'database'; status(false);
    } catch {
      db?.close(); db = undefined; mode = 'memory';
      for (const [key, value] of Object.entries(legacy)) if (!memory.has(key)) memory.set(key, value);
      // Do not put another multi-megabyte copy into localStorage on failure.
      status(true);
    }
  })();
  const startWorker = () => {
    if (worker || !db || !dirty.size) return;
    worker = Promise.resolve().then(async () => {
      while (dirty.size && db) {
        const changes = Object.fromEntries(dirty);
        try {
          await db.update(changes);
          for (const [key, value] of Object.entries(changes)) if (dirty.get(key) === value) dirty.delete(key);
          status(false);
          try { options.notifyPeers?.(); } catch { /* Persistence succeeded. */ }
        } catch { status(true); break; }
      }
    }).finally(() => { worker = undefined; if (dirty.size && !unavailable) startWorker(); });
  };
  const storage = {
    getItem(key: string): string | null {
      if (memory.has(key)) return memory.get(key) ?? null;
      try { return local().getItem(key); } catch { status(true); return null; }
    },
    setItem(key: string, value: string): void {
      if (mode !== 'legacy' && managed.has(key)) {
        memory.set(key, value); version++; dirty.set(key, value);
        if (db) startWorker(); else status(true);
        return;
      }
      try { local().setItem(key, value); memory.delete(key); }
      catch { memory.set(key, value); status(true); }
    },
    removeItem(key: string): void {
      if (mode !== 'legacy' && managed.has(key)) {
        memory.set(key, null); version++; dirty.set(key, null);
        if (db) startWorker(); else status(true);
        return;
      }
      try { local().removeItem(key); memory.delete(key); }
      catch { memory.set(key, null); status(true); }
    },
  };
  return {
    storage, initialize,
    unavailable: () => unavailable,
    hasPendingWrites: () => !!dirty.size,
    observe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async flush() {
      do {
        startWorker(); await worker;
        if (unavailable || (!db && dirty.size)) return false;
      } while (dirty.size || worker);
      return true;
    },
    async refresh() {
      if (!db) return;
      await worker;
      if (dirty.size) return;
      const currentVersion = version;
      try {
        const snapshot = await db.read();
        if (version !== currentVersion || dirty.size) return;
        adopt(snapshot); options.onRemoteChange?.();
      } catch { /* Do not discard the current workspace on refresh failure. */ }
    },
    exportBackup() {
      const values: Record<string, string> = {};
      for (const key of workspaceKeys) { const value = storage.getItem(key); if (value !== null) values[key] = value; }
      return JSON.stringify({format:'zbyzack-local-workspace-backup-v1',exportedAt:new Date().toISOString(),values,legacyBackup:migrationBackup,legacyArchive:migrationArchive},null,2);
    },
  };
}
const notificationKey = 'zbyzack-workspace-change';
let channel: BroadcastChannel | undefined;
const workspace = createBrowserStorage({
  notifyPeers() {
    if (channel) channel.postMessage('saved');
    else try { globalThis.localStorage.setItem(notificationKey, String(Date.now()) + Math.random()); } catch {}
  },
  onRemoteChange() { globalThis.window?.dispatchEvent(new CustomEvent('zbyzack-state')); },
});
let connected = false;
export async function initializeBrowserStorage() {
  await workspace.initialize();
  if (connected || typeof window === 'undefined') return;
  connected = true;
  try { channel = new BroadcastChannel('zbyzack-local-workspace-v2'); channel.onmessage = () => { void workspace.refresh(); }; } catch {}
  window.addEventListener('storage', event => { if (event.key === notificationKey) void workspace.refresh(); });
  window.addEventListener('focus', () => { void workspace.refresh(); });
  window.addEventListener('pagehide', () => { void workspace.flush(); });
  window.addEventListener('beforeunload', event => {
    if (!workspace.hasPendingWrites()) return;
    event.preventDefault(); event.returnValue = '';
  });
}
export const browserStorage = workspace.storage;
export const isBrowserStorageUnavailable = workspace.unavailable;
export const observeBrowserStorage = workspace.observe;
export const exportBrowserWorkspace = workspace.exportBackup;
export const flushBrowserStorage = workspace.flush;
