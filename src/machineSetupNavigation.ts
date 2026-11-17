// Focus can request the add-machine form before lazy Settings has mounted.
// A pending request is consumed once; existing settings instances also listen.
let pending = false;
const listeners = new Set<() => void>();
export function requestMachineSetup(): void {
  pending = true;
  for (const listener of listeners) listener();
}
export function consumeMachineSetupRequest(): boolean {
  const requested = pending;
  pending = false;
  return requested;
}
export function subscribeMachineSetup(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
