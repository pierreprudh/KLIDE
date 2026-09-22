import { createRoot } from 'react-dom/client';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/monaspace-neon/400.css';
import '../src/styles/tokens.css';
import { renderMarkdown } from '../src/components/markdown';
import { CompletionCard } from '../src/components/ai/CompletionCard';
import type { RunCompletion } from '../src/agent/completion';
document.documentElement.dataset.theme = 'dark';
const result: RunCompletion = { runId: 'preview', completedAt: 1, outcome: 'Both workers finished. Six tests passed.', files: [], warnings: [], commands: [
 { id:'1', label:'git log wrong-branch', status:'failed', output:'fatal: ambiguous argument: wrong-branch' },
 { id:'2', label:'git worktree list', status:'passed', output:'implementer\ntester' },
 { id:'3', label:'git merge-base --is-ancestor implementation tester', status:'passed', output:'Tester descends from the implementation.' },
 { id:'4', label:'npm test', status:'passed', output:'tests 6\npass 6\nfail 0' },
] };
const answer = '**Actual test output**\n\n```\n✔ test runner is ready (0.291125ms)\n✔ removes accents from words (0.05925ms)\n✔ returns an empty string for empty input (0.037541ms)\nℹ tests 6 ℹ pass 6 ℹ fail 0\n```\n\nThe tester started from the implementation commit. All six tests passed. Nothing has been merged.\n\n**Source code still has syntax colours**\n\n```javascript\nexport function slugify(text) {\n  return text.toLowerCase();\n}\n```';
createRoot(document.getElementById('root')!).render(<main style={{minHeight:'100vh',background:'var(--bg)',color:'var(--fg)',fontFamily:'var(--font-ui)',padding:40,boxSizing:'border-box',display:'grid',gridTemplateColumns:'minmax(0, 760px) minmax(260px, 360px)',gap:40,alignItems:'start'}}><article style={{fontSize:16,lineHeight:1.7}}>{renderMarkdown(answer)}</article><CompletionCard variant="island" completion={result} onRequestChanges={()=>{}} /></main>);
