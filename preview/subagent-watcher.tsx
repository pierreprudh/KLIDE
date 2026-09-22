// Preview: what the parent conversation shows while a delegated child works.
// A scripted child Run plays back in real time through the real fold, so the
// line, the clock and the expanded rows are the shipping ones — only the
// events are fake.
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/monaspace-neon/400.css';
import '../src/styles/tokens.css';
import { SubagentWatchBody, SubagentWatchLine } from '../src/components/ai/SubagentWatcher';
import { subagentActivity } from '../src/components/ai/subagentWatch';
import { foldAgentEvents, foldedToMsgs } from '../src/agent/foldEvents';
import { renderMessageBody } from '../src/components/ai/ChatMessage';
import { ProviderLogo } from '../src/components/ai/icons';
import type { AgentEvent } from '../src/agent/types';

document.documentElement.dataset.theme = 'dark';
const CHILD = 'sub_run-1_c1';
let t = Date.now();
const at = (ms: number) => (t += ms);

const SCRIPT: { after: number; event: AgentEvent }[] = [
  { after: 400, event: { type: 'run_started', runId: CHILD, mode: 'goal', provider: 'anthropic', model: 'claude-sonnet-5', cwd: null, ts: at(0) } },
  { after: 2200, event: { type: 'assistant_message', runId: CHILD, messageId: 'a1', content: [{ type: 'text', text: 'Finding where slugs are built today.' }], usage: { completionTokens: 74 }, ts: at(900) } },
  { after: 2600, event: { type: 'tool_call_started', runId: CHILD, toolCallId: 't1', name: 'grep', input: {}, summary: 'slugify', ts: at(300) } },
  { after: 4200, event: { type: 'tool_call_finished', runId: CHILD, toolCallId: 't1', result: { ok: true, content: 'src/time.ts:14\nsrc/fileSearch.ts:88' }, ts: at(1600) } },
  { after: 4600, event: { type: 'tool_call_started', runId: CHILD, toolCallId: 't2', name: 'read_file', input: {}, summary: 'src/time.ts', ts: at(400) } },
  { after: 7000, event: { type: 'tool_call_finished', runId: CHILD, toolCallId: 't2', result: { ok: true, content: 'export function formatElapsed…' }, ts: at(2400) } },
  { after: 9500, event: { type: 'assistant_message', runId: CHILD, messageId: 'a2', content: [{ type: 'text', text: 'Adding `slugify` beside the existing formatters.' }], usage: { completionTokens: 186 }, ts: at(2500) } },
  { after: 10000, event: { type: 'tool_call_started', runId: CHILD, toolCallId: 't3', name: 'write_file', input: {}, summary: 'src/time.ts', ts: at(500) } },
  { after: 13000, event: { type: 'tool_call_finished', runId: CHILD, toolCallId: 't3', result: { ok: true, content: 'written' }, ts: at(3000) } },
  { after: 14000, event: { type: 'run_result', runId: CHILD, result: { status: 'done' }, ts: at(1000) } },
];

function Watcher() {
  const [n, setN] = useState(0);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const timers = SCRIPT.map((s, i) => setTimeout(() => setN(i + 1), s.after));
    return () => timers.forEach(clearTimeout);
  }, []);
  const events = useMemo(() => SCRIPT.slice(0, n).map((s) => s.event), [n]);
  const activity = useMemo(() => subagentActivity(events), [events]);
  const rows = useMemo(() => (opened ? foldedToMsgs(foldAgentEvents(events)) : []), [opened, events]);
  const settled = activity.status === 'done' || activity.status === 'failed';
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6 }}>
      <p style={{ margin: '0 0 6px' }}>I'll hand the slug helper to Claude Code and review what comes back.</p>
      {/* The shipping delegation row, transcribed — the preview can't call the panel's private one. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span aria-hidden style={{ color: 'var(--fg-dim)' }}>·</span>
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Delegated to</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-strong)' }}>
          <ProviderLogo id="claude-code" size={13} />
          <span>Claude Code</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 500, color: 'var(--accent)' }}>implementer</span>
        <span style={{ fontSize: 12, color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· Add a slugify helper to time.ts</span>
      </div>
      {(!settled || opened) && (
        <SubagentWatchLine activity={activity} open={opened} onToggle={() => setOpened((w) => !w)} hasRows={events.length > 0} />
      )}
      {opened && (
        <SubagentWatchBody>
          {rows.map((row, i) => <div key={i}>{renderMessageBody(row)}</div>)}
        </SubagentWatchBody>
      )}
      {settled && !opened && (
        <p style={{ margin: '10px 0 0', color: 'var(--fg-subtle)' }}>
          Claude Code added <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>slugify</code> to <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>src/time.ts</code> on <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>klide/worker-slugify</code>.
        </p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <main style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', padding: 48, boxSizing: 'border-box' }}>
    <div style={{ maxWidth: 720 }}><Watcher /></div>
  </main>
);
