import { createRoot } from 'react-dom/client';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/monaspace-neon/400.css';
import '../src/styles/tokens.css';
import { CompletionCard } from '../src/components/ai/CompletionCard';
import type { RunCompletion } from '../src/agent/completion';
import type { CheckpointEntry } from '../src/agent/types';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const before = '#!/bin/sh\nmax=0\ntext="$1"\nslug=$(printf "%s" "$text" | tr A-Z a-z)\nslug=$(printf "%s" "$slug" | tr -cs a-z0-9 -)\nprintf "%s\\n" "$slug"\n';
const after = '#!/bin/sh\nmax=0\nif [ "$1" = "--max" ]; then\n  max="$2"\n  shift 2\nfi\ntext="$1"\nslug=$(printf "%s" "$text" | tr A-Z a-z)\nslug=$(printf "%s" "$slug" | tr -cs a-z0-9 -)\nif [ "$max" -gt 0 ]; then\n  slug=$(printf "%s" "$slug" | cut -c1-"$max")\nfi\nprintf "%s\\n" "$slug"\n';
const entries: CheckpointEntry[] = [{ toolCallId: 't1', path: 'slug.sh', oldContent: before, newContent: after, isCreate: false, workspaceRoot: '/x', ts: 1 }];
const failing = params.get('fail') === '1';
const result: RunCompletion = { runId: 'preview', completedAt: 1, outcome: 'Added --max.', files: ['slug.sh'], warnings: [], commands: [
  { id: '1', label: 'sh test.sh', status: failing ? 'failed' : 'passed', output: failing ? 'expected hello-wo, got hello-world' : 'ok 6/6' },
  { id: '2', label: `sh slug.sh --max 0 'Hello World'; echo "exit=$?"; sh slug.sh --max 3 'Hello World'; sh slug.sh --max 20 'Hello World'`, status: 'passed', output: 'hello-world\nexit=0\nhel\nhello-world' },
  { id: '3', label: `sh test.sh; echo "---"; sh slug.sh --max 0 'Hello World' | od -c | head -2`, status: 'passed', output: 'ok' },
] };
function Island() {
  return <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 12 }}><CompletionCard variant="island" completion={result} onRequestChanges={() => {}} loadChanges={async () => entries} /></div>;
}
createRoot(document.getElementById('root')!).render(<main style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', padding: 32, boxSizing: 'border-box' }}><Island /></main>);
// Open the card, then the file and the checks, so the shot shows the whole body.
setTimeout(() => {
  (document.querySelector('.klide-result-island-header') as HTMLElement | null)?.click();
  setTimeout(() => {
    if (params.get('diff') === '1') (document.querySelector('button.klide-result-file-row') as HTMLElement | null)?.click();
    if (params.get('checks') === '1') (document.querySelector('.klide-result-commands .klide-result-fold-summary') as HTMLElement | null)?.click();
  }, 300);
}, 200);
