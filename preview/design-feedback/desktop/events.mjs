export { listen, emit } from './bridge.mjs';
export async function once(event, handler) {
  const {listen} = await import('./bridge.mjs');
  const stop = await listen(event, value => { stop(); handler(value); });
  return stop;
}
export async function emitTo(_target, event, payload) {
  const {emit} = await import('./bridge.mjs');
  return emit(event, payload);
}
