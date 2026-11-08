// Dedicated fixture-server boundary. Native Tauri globals remain untouched.
export * from '../../../node_modules/@tauri-apps/api/core.js';
export { invoke } from './bridge.mjs';
export function isTauri() { return true; }
let nextId = 0;
export class Channel {
  constructor(onmessage = () => {}) { this.id = ++nextId; this.onmessage = onmessage; }
}
