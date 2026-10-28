// Preview: Claude Code fanning out its own sub-agents in a Focus conversation.
// The conversation keeps one line of work; the sub-agents sit in the tray on
// the composer. Real tray, real fold; the events are the shape a real
// `claude -p` background fan-out folds to (2026-10-28). `?state=done` shows
// the turn after they all settled.
import { createRoot } from 'react-dom/client';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/monaspace-neon/400.css';
import '../src/styles/tokens.css';
import { renderMessageBody } from '../src/components/ai/ChatMessage';
import { SubagentTray } from '../src/components/ai/SubagentTray';
import { turnSubagents } from '../src/components/ai/turnSubagents';
import { foldAgentEvents, foldedRowToMsgs } from '../src/agent/foldEvents';
import type { AgentEvent } from '../src/agent/types';
import type { Msg } from '../src/components/ai/types';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const done = params.get('state') === 'done';
const RUN = 'r1';
let t = Date.now() - 40_000;
const at = (ms = 1200) => (t += ms);
const call = (id: string, name: string, input: unknown, parentToolCallId?: string): AgentEvent =>
  ({ type: 'observed_tool_call', runId: RUN, toolCallId: id, provider: 'claude-code', name, input, summary: name, ts: at(), ...(parentToolCallId ? { parentToolCallId } : {}) });
const res = (id: string, content: string, parentToolCallId?: string): AgentEvent =>
  ({ type: 'observed_tool_result', runId: RUN, toolCallId: id, ok: true, content, ts: at(), ...(parentToolCallId ? { parentToolCallId } : {}) });
const sub = (id: string, status: 'running' | 'completed', activity?: string, steps?: number): AgentEvent =>
  ({ type: 'observed_subagent', runId: RUN, toolCallId: id, status, activity, steps, ts: at(400) });
const LAUNCHED = 'Async agent launched successfully.';

const events: AgentEvent[] = [
  { type: 'assistant_message', runId: RUN, messageId: 'm0', content: [{ type: 'text', text: "I'll map the codebase with three explorers in parallel." }], ts: at() },
  call('A', 'Agent', { description: 'Map src-tauri/src/agent', subagent_type: 'Explore', run_in_background: true }), sub('A', 'running'), res('A', LAUNCHED),
  call('B', 'Agent', { description: 'Map src/components/ai', subagent_type: 'Explore', run_in_background: true }), sub('B', 'running'), res('B', LAUNCHED),
  call('C', 'Agent', { description: 'Read CONTEXT.md', subagent_type: 'Explore', run_in_background: true }), sub('C', 'running'), res('C', LAUNCHED),
  call('a1', 'Grep', { pattern: 'fn run_agent_loop' }, 'A'), res('a1', 'mod.rs:2410', 'A'), sub('A', 'running', 'Reading mod.rs', 2),
  call('b1', 'Glob', { pattern: 'src/components/ai/*.ts' }, 'B'), sub('B', 'running', 'Searching src/components/ai', 1),
  call('c1', 'Read', { file_path: 'CONTEXT.md' }, 'C'), res('c1', '# Klide', 'C'), sub('C', 'completed', undefined, 1),
  { type: 'assistant_message', runId: RUN, messageId: 'm1', content: [{ type: 'text', text: 'The CONTEXT.md explorer is back. Waiting on the other two before the summary.' }], ts: at() },
  ...(done ? [
    sub('A', 'completed', undefined, 7), sub('B', 'completed', undefined, 5),
    { type: 'assistant_message', runId: RUN, messageId: 'm2', content: [{ type: 'text', text: 'The run loop lives in `agent/mod.rs`; the panel is a pure view over its events; the vocabulary is Run, Mission, Delegate, Workspace.' }], ts: at() } as AgentEvent,
  ] : []),
];

const msgs: Msg[] = [{ role: 'user', content: 'Use the Agent tool to launch 3 Explore sub-agents in parallel…' }, ...foldAgentEvents(events).flatMap((row) => foldedRowToMsgs(row, { runningPlaceholders: true }))];
const rows = turnSubagents(msgs, !done);

createRoot(document.getElementById('root')!).render(
  <main style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', padding: '40px 48px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
    <div style={{ maxWidth: 760, width: '100%', margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, fontSize: 14, lineHeight: 1.6 }}>
        {msgs.filter((m) => m.role === 'assistant').map((m, i) => <div key={i} style={{ marginBottom: 10 }}>{renderMessageBody(m, false)}</div>)}
      </div>
      <SubagentTray subagents={rows} />
      <div className="klide-composer-surface" style={{ padding: '14px 16px 44px', color: 'var(--fg-dim)', fontSize: 14 }}>Queue another message…</div>
    </div>
  </main>
);
