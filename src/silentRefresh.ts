// Background refreshes (timers, tab focus, live database changes) must be invisible:
// they never flip a loading flag, and when the data came back unchanged they hand
// React the SAME object so nothing re-renders. Only real changes update the screen.
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const keepIfSame = <T,>(old: T | null, next: T): T => (old !== null && sameJson(old, next) ? old : next)
