// Browser-only demo. The shipping observer row calls a simulated native wire;
// no GitHub command or model is run. Rust integration tests exercise the real lifecycle.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { ConversationObservers } from "../src/components/ai/ConversationObservers";
import { renderMessageBody } from "../src/components/ai/ChatMessage";
import type { Observer } from "../src/agent/observers";
import type { Msg } from "../src/components/ai/types";

const RUN = "observer-preview";
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
let nextId = 1;
let observers: Observer[] = [];
let stopped = false;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback(callback: (event: unknown) => void) { const id = nextId++; callbacks.set(id, callback); return id; },
  unregisterCallback(id: number) { callbacks.delete(id); },
  async invoke(command: string, args: any) {
    if (command === "plugin:event|listen") { const id = nextId++; listeners.set(id, args); return id; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    if (command === "agent_list_observers") return [...observers];
    if (command === "agent_stop_observer") { stopped = true; observers = []; return; }
    return null;
  },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
function emit(event: string) {
  for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload: RUN });
}

function Demo() {
  const [version, setVersion] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState("Replying");
  const busy = useRef(false);
  const delivered = useRef(false);
  useEffect(() => {
    stopped = false;
    delivered.current = false;
    observers = [];
    busy.current = false;
    setPhase("Replying");
    setMessages([{ role: "user", content: "Watch the deployment of my branch and let me know when it finishes." }]);
    const first = setTimeout(() => {
      observers = [{ id: "demo-shell", command: "gh run watch 12345 --exit-status", status: { state: "running" }, startedMs: Date.now(), endedMs: null, notifyOnExit: true }];
      setMessages((rows) => [...rows, { role: "assistant", content: "The deployment is running. I’ll notify you here when it finishes—you can keep chatting meanwhile." }]);
      setPhase("First reply finished · watching in background");
    }, 800);
    const finish = setTimeout(() => {
      if (stopped) { setPhase("Observer stopped · no follow-up"); return; }
      observers = observers.map((row) => ({ ...row, status: { state: "exited", code: 0 }, endedMs: Date.now() }));
      setPhase("Observer finished · follow-up queued");
      emit("agent-observer-wake");
    }, 12000);
    return () => { clearTimeout(first); clearTimeout(finish); };
  }, [version]);

  function followup() {
    if (busy.current) return false;
    if (!delivered.current && !stopped) {
      delivered.current = true;
      observers = [];
      setMessages((rows) => [...rows,
        { role: "system", content: "Background observer finished", observer: { shellId: "demo-shell" } },
        { role: "assistant", content: "The deployment finished successfully. In a real run, this new message would include the preview URL returned by your deployment." },
      ]);
      setPhase("New reply delivered · same conversation");
    }
    return true;
  }
  const muted = { fontSize: 12, color: "var(--fg-dim)" };
  return <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)", padding: "48px 24px", boxSizing: "border-box" }}>
    <div style={{ maxWidth: 740, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 30 }}>
        <div><h1 style={{ fontSize: 22, fontWeight: 400, margin: "0 0 6px" }}>Keep the conversation moving</h1><div style={muted}>Interactive simulation · no deployment is launched</div></div>
        <button onClick={() => setVersion((v) => v + 1)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 12px", background: "none", color: "var(--fg)" }}>Replay</button>
      </div>
      <div aria-live="polite" style={{ ...muted, marginBottom: 24 }}>{phase}</div>
      <div style={{ minHeight: 310 }}>
        {messages.map((message, i) => <div key={i} style={message.role === "user" ? { margin: "18px 0 18px auto", padding: "10px 14px", maxWidth: "85%", background: "var(--accent-soft)", borderRadius: 10, fontSize: 14 } : { margin: "18px 0", fontSize: 14, lineHeight: 1.65 }}>
          {message.role === "user" ? message.content : renderMessageBody(message)}
        </div>)}
        <ConversationObservers key={version} runId={RUN} onFollowup={followup} />
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || busy.current) return;
        setDraft("");
        busy.current = true;
        setMessages((rows) => [...rows, { role: "user", content: text }]);
        setTimeout(() => {
          setMessages((rows) => [...rows, { role: "assistant", content: "You can keep sending messages while the observer watches. Its update waits for this reply to finish." }]);
          busy.current = false;
        }, 1800);
      }} style={{ display: "flex", gap: 12, border: "1px solid var(--border)", borderRadius: 10, padding: 12, marginTop: 20 }}>
        <input aria-label="Message" placeholder="Send a message while it watches…" value={draft} onChange={(event) => setDraft(event.target.value)} style={{ flex: 1, border: 0, outline: 0, background: "none", color: "var(--fg)", font: "inherit", fontSize: 14 }} />
        <button style={{ background: "none", color: "var(--fg)", border: 0, cursor: "pointer" }}>Send</button>
      </form>
      <p style={{ ...muted, marginTop: 14 }}>The watch completes after 12 seconds. Stop suppresses its follow-up.</p>
    </div>
  </main>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Demo />);
