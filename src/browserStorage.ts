// Local workspace persistence must not prevent shared sign-in from rendering.
const pending = new Map<string, string | null>();
const listeners = new Set<() => void>();
let unavailable = false;
function markUnavailable() {
  if (unavailable) return;
  unavailable = true;
  for (const listener of listeners) listener();
}
export const browserStorage = {
  getItem(key: string): string | null {
    if (pending.has(key)) return pending.get(key)!;
    try { return globalThis.localStorage.getItem(key); }
    catch { markUnavailable(); return null; }
  },
  setItem(key: string, value: string): void {
    try { globalThis.localStorage.setItem(key, value); pending.delete(key); }
    catch { pending.set(key, value); markUnavailable(); }
  },
  removeItem(key: string): void {
    try { globalThis.localStorage.removeItem(key); pending.delete(key); }
    catch { pending.set(key, null); markUnavailable(); }
  },
};
export const isBrowserStorageUnavailable = () => unavailable;
export function observeBrowserStorage(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
