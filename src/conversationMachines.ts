// Where a conversation runs — this Mac (no entry) or a Remote machine's id.
//
// Chosen once, before the first message, and fixed after: a conversation keeps
// its Machine the way it keeps its agent. A separate store rather than a field
// on the stored Conversation, for the reason `pinnedConversations.ts` gives —
// the panel persists a conversation whole on every snapshot.

const KEY = "klide.conversationMachines";

function read(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function write(map: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable */
  }
}

const listeners = new Set<() => void>();

/** The Remote machine id a conversation runs on, or null for this Mac. */
export function conversationMachine(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return read()[conversationId] ?? null;
}

/** Place a conversation on a Remote machine (or back on this Mac with null). */
export function setConversationMachine(conversationId: string, machineId: string | null): void {
  const map = read();
  if ((map[conversationId] ?? null) === machineId) return;
  if (machineId) map[conversationId] = machineId;
  else delete map[conversationId];
  write(map);
  for (const listener of listeners) listener();
}

export function subscribeConversationMachines(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── The start stage's choice ────────────────────────────────────────────────
// What the Focus start composer shows before a conversation exists, remembered
// per project like the Claude and Codex apps remember their environment: open a
// project you last ran on klide-box and the start stage is already there. App
// reads it once, when the first message is sent, and hands it to the panel as
// `hostMachine`.

const START_KEY = "klide.startMachineByProject";

function readStart(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(START_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

let startMachine: string | null = null;
const startListeners = new Set<() => void>();

function announceStart(): void {
  for (const listener of startListeners) listener();
}

export function startStageMachine(): string | null {
  return startMachine;
}

/** The Machine this project last started on; null is this Mac. */
export function rememberedStartMachine(workspaceRoot: string | null): string | null {
  return workspaceRoot ? readStart()[workspaceRoot] ?? null : null;
}

/** Show `workspaceRoot`'s remembered Machine on the start stage. */
export function restoreStartStageMachine(workspaceRoot: string | null): void {
  const next = rememberedStartMachine(workspaceRoot);
  if (startMachine === next) return;
  startMachine = next;
  announceStart();
}

/** A pick on the start stage — shown now and remembered for the project. */
export function setStartStageMachine(machineId: string | null, workspaceRoot?: string | null): void {
  if (workspaceRoot) {
    const map = readStart();
    if (machineId) map[workspaceRoot] = machineId;
    else delete map[workspaceRoot];
    try {
      localStorage.setItem(START_KEY, JSON.stringify(map));
    } catch {
      /* storage full / unavailable */
    }
  }
  if (startMachine === machineId) return;
  startMachine = machineId;
  announceStart();
}

export function subscribeStartStageMachine(listener: () => void): () => void {
  startListeners.add(listener);
  return () => startListeners.delete(listener);
}
