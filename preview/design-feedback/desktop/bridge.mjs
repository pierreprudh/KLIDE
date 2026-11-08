let handler;
const listeners = new Map();
export function install(callback) { handler = callback; listeners.clear(); }
export async function invoke(command, args) {
  if (!handler) throw new Error('Native parity fixture is not installed');
  return handler(command, args);
}
export async function listen(event, callback) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(callback);
  return () => listeners.get(event)?.delete(callback);
}
export async function emit(event, payload) {
  for (const callback of [...(listeners.get(event) ?? [])]) callback({ event, id: 0, payload });
}
