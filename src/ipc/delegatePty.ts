// The delegate-PTY wire, in one place.
//
// A delegate session (Claude Code, Codex, OpenCode, omp, or a custom CLI) keeps
// running in Rust after the surface showing it unmounts, so reattaching means
// repainting the history produced while nobody was watching. Getting that right
// needs a specific ordering, and `docs/delegate-session-replay.md` calls the
// handshake the load-bearing invariant of the feature.
//
// It used to be a convention rather than a module: three surfaces attached a
// terminal three different ways, and two of them declared the chunk payload
// without `seq` at all — which is exactly how their missing dedupe went
// unnoticed. This module owns the commands, the two events, the wire types and
// the handshake, so there is one implementation to be right.
//
// Deliberately xterm-free: the handshake talks to a `TerminalSink`, so it can be
// tested with a recording stub instead of a real terminal.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DelegateId } from "../delegates";

/** Rust emits these globally — `pty.rs`'s `TauriSink`. */
const DATA_EVENT = "delegate-pty:data";
const EXIT_EVENT = "delegate-pty:exit";

/** One chunk of PTY output. `seq` is monotonic per session and is what lets a
 *  reattaching terminal drop chunks its snapshot already covered. Never make it
 *  optional: the two surfaces that omitted it are the two that double-wrote. */
export type DelegatePtyChunk = {
  sessionId: string;
  data: string;
  seq: number;
};

/** Mirrors `PtyExitOutcome` in `pty_host.rs`. */
export type DelegatePtyExitOutcome = {
  exitCode: number;
  signal?: string;
  /** True when Klide asked it to stop, rather than the CLI finishing. */
  stopRequested: boolean;
};

export type DelegatePtyExit = {
  sessionId: string;
  outcome: DelegatePtyExitOutcome;
};

/** History bytes plus the high-water `seq` they cover. */
export type DelegatePtySnapshot = {
  data: string;
  seq: number;
  live: boolean;
};

/** Hook-reported when the CLI has Klide's status hooks installed
 *  (`working` / `blocked` / `waiting` — see Rust `delegate/status.rs`);
 *  otherwise the PTY idle-timer heuristic (`running` / `idle`). */
export type LiveDelegateStatus = "running" | "idle" | "working" | "blocked" | "waiting";

/** One live delegate PTY. Mirrors `LiveDelegateSession` in `pty.rs`. */
export type LiveDelegateSession = {
  /** Full PTY session id (`{convoId}:{provider}`). */
  sessionId: string;
  /** The AI-panel conversation id — `sessionId` minus the `:provider` suffix.
   *  Reattaching opens a panel bound to this id so the rebuilt terminal lands
   *  on the same `sessionId`. */
  convoId: string;
  provider: string;
  cwd: string | null;
  task: string | null;
  model: string | null;
  startedMs: number;
  updatedMs: number;
  status: LiveDelegateStatus;
  /** Bytes of replay buffer retained — a cheap "has output" signal. */
  bufferedBytes: number;
};

/** One persisted-but-ended delegate session. Its PTY died (the CLI finished, or
 *  the app restarted) but its scrollback survives on disk, so reopening
 *  repaints the history and resumes the CLI when `resumeSessionId` is known.
 *  Mirrors `RecentDelegateSession` in `pty_host.rs`. */
export type RecentDelegateSession = {
  sessionId: string;
  convoId: string;
  provider: string;
  cwd: string | null;
  task: string | null;
  model: string | null;
  resumeSessionId: string | null;
  startedMs: number;
  /** Clean-exit stamp, or the log's mtime for sessions the app quit killed. */
  endedMs: number | null;
  exitOutcome?: DelegatePtyExitOutcome;
  bufferedBytes: number;
};

export type DelegateSpawnArgs = {
  provider: DelegateId | string;
  workspaceRoot: string | null;
  parentRunId?: string | null;
  resumeSessionId?: string | null;
  model?: string | null;
  /** The reasoning effort the user picked, for a CLI that publishes a set of
   *  them (Codex). Rust drops it for the CLIs that take no such switch. */
  effort?: string | null;
  task?: string | null;
  oneShot?: boolean;
};

/**
 * The PTY session id for a conversation: `{convoId}:{provider}`.
 *
 * Composed in four places before this existed and taken apart by `strip_suffix`
 * in two Rust ones. `convo_id_for` in `pty.rs` is the other half.
 */
export function delegateSessionId(convoId: string, provider: string): string {
  return `${convoId}:${provider}`;
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function spawnDelegatePty(sessionId: string, args: DelegateSpawnArgs): Promise<void> {
  return invoke("delegate_pty_spawn", {
    sessionId,
    provider: args.provider,
    workspaceRoot: args.workspaceRoot,
    parentRunId: args.parentRunId ?? null,
    resumeSessionId: args.resumeSessionId ?? null,
    model: args.model ?? null,
    effort: args.effort ?? null,
    task: args.task ?? null,
    ...(args.oneShot === undefined ? {} : { oneShot: args.oneShot }),
  });
}

export function writeDelegatePty(sessionId: string, data: string): Promise<void> {
  return invoke("delegate_pty_write", { sessionId, data });
}

export function stopDelegatePty(sessionId: string): Promise<void> {
  return invoke("delegate_pty_stop", { sessionId });
}

export function resizeDelegatePty(sessionId: string, rows: number, cols: number): Promise<void> {
  return invoke("delegate_pty_resize", { sessionId, rows, cols });
}

export function delegatePtySnapshot(sessionId: string): Promise<DelegatePtySnapshot> {
  return invoke<DelegatePtySnapshot>("delegate_pty_snapshot", { sessionId });
}

export function listLiveDelegateSessions(): Promise<LiveDelegateSession[]> {
  return invoke<LiveDelegateSession[]>("delegate_pty_live_sessions");
}

export function listRecentDelegateSessions(): Promise<RecentDelegateSession[]> {
  return invoke<RecentDelegateSession[]>("delegate_pty_recent_sessions");
}

// ── Events ───────────────────────────────────────────────────────────────────

export function onDelegateChunk(handler: (chunk: DelegatePtyChunk) => void): Promise<() => void> {
  return listen<DelegatePtyChunk>(DATA_EVENT, (e) => handler(e.payload));
}

export function onDelegateExit(handler: (exit: DelegatePtyExit) => void): Promise<() => void> {
  return listen<DelegatePtyExit>(EXIT_EVENT, (e) => handler(e.payload));
}

// ── The attach handshake ─────────────────────────────────────────────────────

/** The slice of xterm's `Terminal` the handshake needs. */
export type TerminalSink = {
  write(data: string, callback?: () => void): void;
};

export type AttachDelegateOptions = {
  sessionId: string;
  term: TerminalSink;
  /** Spawn before snapshotting. Omit to attach to a session someone else
   *  started — spawn is a no-op for a live id, but an attach-only surface
   *  (read-only evidence, an already-dispatched task) must not risk starting
   *  a CLI as a side effect of being looked at. */
  spawn?: DelegateSpawnArgs;
  /** History is painted and live chunks are flowing. */
  onReady?: () => void;
  onError?: (err: unknown) => void;
};

export type DelegateAttachment = {
  dispose(): void;
  /**
   * True until the whole replay has been parsed.
   *
   * Callers MUST gate `term.onData` on this. Replayed history contains terminal
   * queries the TUI sent on a previous attach (cursor position `ESC[6n`, device
   * attribute and colour probes); xterm answers them while parsing, and piping
   * those stale answers back into the PTY shows up as typed junk like `3R` in
   * the agent's input.
   */
  isReplaying(): boolean;
};

/**
 * Attach a terminal to a delegate session, replaying what it missed.
 *
 * The ordering is the invariant — get it wrong and output is dropped or
 * doubled:
 *   1. subscribe FIRST, buffering live chunks without writing them
 *   2. spawn (a no-op returning the existing session when already live)
 *   3. fetch the snapshot: history bytes + the high-water seq they cover
 *   4. paint history, then flush buffered chunks with `seq` past that mark
 *   5. go live, dropping anything already covered
 */
export function attachDelegatePty(options: AttachDelegateOptions): DelegateAttachment {
  const { sessionId, term, spawn, onReady, onError } = options;

  let cancelled = false;
  let applied = false;
  let replaying = true;
  let writtenThrough = -1;
  const pending: DelegatePtyChunk[] = [];

  const write = (chunk: DelegatePtyChunk) => {
    if (chunk.seq <= writtenThrough) return;
    term.write(chunk.data);
    writtenThrough = chunk.seq;
  };

  const unlisten = onDelegateChunk((chunk) => {
    if (chunk.sessionId !== sessionId) return;
    if (!applied) {
      pending.push(chunk);
      return;
    }
    write(chunk);
  });

  const start = async () => {
    // Register the listener before spawning, so no live chunk slips through
    // the gap between spawn and snapshot.
    await unlisten;
    if (cancelled) return;
    try {
      if (spawn) {
        await spawnDelegatePty(sessionId, spawn);
        if (cancelled) return;
      }
      const snap = await delegatePtySnapshot(sessionId);
      if (cancelled) return;
      if (snap.data) term.write(snap.data);
      writtenThrough = snap.seq;
      for (const chunk of pending) write(chunk);
      pending.length = 0;
      applied = true;
      // Writes are parsed FIFO, so this callback fires only once the snapshot
      // and the buffered chunks above have been fully parsed.
      term.write("", () => {
        replaying = false;
      });
      onReady?.();
    } catch (err) {
      // Never leave input gated on a failure, or the terminal is dead to typing.
      replaying = false;
      onError?.(err);
    }
  };
  void start();

  return {
    dispose() {
      cancelled = true;
      void unlisten.then((u) => u());
    },
    isReplaying: () => replaying,
  };
}
