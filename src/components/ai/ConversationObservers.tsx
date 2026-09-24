import { GithubObserverCard } from "./GithubObserverCard";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { createListenerScope } from "../../tauriEvents";
import { listObservers, stopObserver, observerLabel, type Observer } from "../../agent/observers";
import { notify } from "../../toast";
import { DotGridLoader } from "./icons";
import { useElapsed } from "./WorkingRow";

/** A conversation can be idle while its observers are working. These rows
 * stay separate from the reply's Working row, so sending remains available. */
export function ConversationObservers({ runId, onFollowup }: {
  runId: string;
  /** False means a local turn is still cleaning up; try after it releases. */
  onFollowup: () => boolean;
}) {
  const [observers, setObservers] = useState<Observer[]>([]);
  const follow = useRef(onFollowup);
  follow.current = onFollowup;
  useEffect(() => {
    setObservers([]);
    let alive = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const scope = createListenerScope();
    scope.add(listen<string>("agent-observer-wake", ({ payload }) => {
      if (payload === runId) pending = true;
    }));
    // Completion is a second signal in case a very short follow-up finished
    // before this view could attach. The transcript remains the authority.
    scope.add(listen<string>("agent-observer-finished", ({ payload }) => {
      if (payload === runId) pending = true;
    }));
    const refresh = async () => {
      try {
        const rows = await listObservers(runId);
        if (!alive) return;
        setObservers(rows);
        if (pending && follow.current()) pending = false;
      } catch { /* Browser previews have no native observer registry. */ }
      if (alive) timer = setTimeout(() => void refresh(), 1000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); scope.dispose(); };
  }, [runId]);

  if (!observers.length) return null;
  return <div aria-label="Background observers" style={{ margin: "12px 0", color: "var(--fg-subtle)", fontSize: 12 }}>
    {observers.map((observer) => <ObserverRow key={observer.id} observer={observer} runId={runId} onStopped={() => void listObservers(runId).then(setObservers)} />)}
  </div>;
}

function ObserverRow({ observer, runId, onStopped }: { observer: Observer; runId: string; onStopped: () => void }) {
  const [hovered, setHovered] = useState(false);
  const elapsed = useElapsed(observer.startedMs);
  const running = observer.status.state === "running";
  if (observer.githubWatch) return <GithubObserverCard observer={observer} runId={runId} onStop={() => {
    void stopObserver(runId, observer.id).then(onStopped).catch(error => notify(String(error), { tone: "error" }));
  }} />;
  return <div
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", minWidth: 0 }}
  >
    {running && <DotGridLoader size={10} label="Watching in background" />}
    <span>{observerLabel(observer)}</span>
    {running && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)", fontVariantNumeric: "tabular-nums" }}>{elapsed}</span>}
    <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-dim)" }} title={observer.command}>{observer.command}</code>
    {running && <button
      type="button"
      aria-label="Stop background observer"
      onClick={() => {
        void stopObserver(runId, observer.id).then(onStopped)
          .catch((error) => notify(`Couldn't stop observer: ${String(error)}`, { tone: "error" }));
      }}
      style={{ border: 0, background: "none", color: "var(--fg-subtle)", cursor: "pointer", fontSize: 12, opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 120ms ease" }}
    >Stop</button>}
  </div>;
}
