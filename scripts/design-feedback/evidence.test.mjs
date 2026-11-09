import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { captureInputs, changedInputs } from './evidence.mjs';

const root = path.join(path.sep, 'repo');
const evidence = { files: { 'src/components/AiPanel.tsx': 'a', 'src/unrelated.ts': 'b', 'scripts/design-feedback/browser.mjs': 'c', 'scripts/remote-host/run.sh': 'd', 'preview/design-feedback/matrix.json': 'e' } };

describe('capture inputs', () => {
  it('keeps the served modules and the capture tooling, nothing else', () => {
    const inputs = captureInputs(root, [path.join(root, 'src/components/AiPanel.tsx'), path.join(path.sep, 'elsewhere', 'x.ts')], evidence);
    expect(inputs).toEqual(['preview/design-feedback/matrix.json', 'scripts/design-feedback/browser.mjs', 'src/components/AiPanel.tsx']);
  });
  it('ignores an edit a capture never read', () => {
    const inputs = captureInputs(root, [path.join(root, 'src/components/AiPanel.tsx')], evidence);
    const after = { files: { ...evidence.files, 'src/unrelated.ts': 'changed', 'scripts/remote-host/run.sh': 'changed' } };
    expect(changedInputs(inputs, evidence, after)).toEqual([]);
  });
  it('reports an edit to a served module or a deleted input', () => {
    const inputs = captureInputs(root, [path.join(root, 'src/components/AiPanel.tsx')], evidence);
    const { 'scripts/design-feedback/browser.mjs': _gone, ...rest } = evidence.files;
    const after = { files: { ...rest, 'src/components/AiPanel.tsx': 'changed' } };
    expect(changedInputs(inputs, evidence, after)).toEqual(['scripts/design-feedback/browser.mjs', 'src/components/AiPanel.tsx']);
  });
});
