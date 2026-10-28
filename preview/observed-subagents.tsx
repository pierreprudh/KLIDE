// Preview: Claude Code fanning out its own sub-agents in a Focus conversation.
// The events are the shape a real `claude -p` stream folds to (2026-10-28):
// every sub-agent step names its `Agent` call. Rendered through the real fold
// and the real message body.
import { createRoot } from 'react-dom/client';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/monaspace-neon/400.css';
import '../src/styles/tokens.css';
import { renderMessageBody, type AttachedResult } from '../src/components/ai/ChatMessage';
import { foldAgentEvents, foldedRowToMsgs } from '../src/agent/foldEvents';
import type { AgentEvent } from '../src/agent/types';
import type { Msg } from '../src/components/ai/types';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const RUN = 'r1';
let t = Date.now() - 40_000;
const at = (ms = 1200) => (t += ms);
const call = (id: string, name: string, input: unknown, summary: string, parentToolCallId?: string): AgentEvent =>
  ({ type: 'observed_tool_call', runId: RUN, toolCallId: id, provider: 'claude-code', name, input, summary, ts: at(), ...(parentToolCallId ? { parentToolCallId } : {}) });
const done = (id: string, content: string, parentToolCallId?: string): AgentEvent =>
  ({ type: 'observed_tool_result', runId: RUN, toolCallId: id, ok: true, content, ts: at(), ...(parentToolCallId ? { parentToolCallId } : {}) });

const events: AgentEvent[] = [
  call('A', 'Agent', { description: 'Map the run loop and its seams', subagent_type: 'Explore' }, 'Agent Map the run loop'),
  call('B', 'Agent', { description: 'Find shallow modules in src/components/ai', subagent_type: 'Explore' }, 'Agent Find shallow modules'),
  call('C', 'Agent', { description: 'Read CONTEXT.md and the ADRs for vocabulary', subagent_type: 'general-purpose' }, 'Agent Read CONTEXT.md'),
  call('a1', 'Grep', { pattern: 'fn run_agent_loop' }, 'Grep fn run_agent_loop', 'A'),
  call('b1', 'Glob', { pattern: 'src/components/ai/*.ts' }, 'Glob src/components/ai/*.ts', 'B'),
  done('a1', 'src-tauri/src/agent/mod.rs:2410', 'A'),
  call('c1', 'Read', { file_path: 'CONTEXT.md' }, 'Read CONTEXT.md', 'C'),
  done('c1', '# Klide domain…', 'C'),
  call('a2', 'Read', { file_path: 'src-tauri/src/agent/mod.rs' }, 'Read src-tauri/src/agent/mod.rs', 'A'),
  done('b1', '41 files', 'B'),
  call('b2', 'Read', { file_path: 'src/components/ai/runController.ts' }, 'Read src/components/ai/runController.ts', 'B'),
  done('C', 'Vocabulary: Run, Mission, Delegate, Workspace…'),
];

const msgs: Msg[] = foldAgentEvents(events).flatMap((row) => foldedRowToMsgs(row, { runningPlaceholders: true }));
const assistant = msgs.find((m) => m.role === 'assistant')!;
const results = new Map<string, AttachedResult>();
for (const m of msgs) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, { msg: m, active: /^Running /.test(m.content) });

createRoot(document.getElementById('root')!).render(
  <main style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', padding: 48, boxSizing: 'border-box' }}>
    <div style={{ maxWidth: 720, fontSize: 14, lineHeight: 1.6 }}>
      <p style={{ margin: '0 0 6px' }}>I'll explore the codebase in parallel before proposing candidates.</p>
      {renderMessageBody(assistant, true, { results })}
    </div>
  </main>
);
