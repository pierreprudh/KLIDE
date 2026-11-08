import { describe, it, expect } from 'vitest';
import { advance, verifyWire } from './experiment.mjs';
import { resumeState, reviewOutcome } from './experiment-state.mjs';
const initial = () => ({ phase: 'prepared', deadline: Date.now() + 100000, maxAttempts: 24, maxCycles: 3, attempts: 0, cycles: 0, stagnant: 0 });
const issue = { region: 'composer', observation: 'Action label is clipped' };
describe('bounded writer controller', () => {
    it('persists intent before dispatch and sends the newly captured candidate to the next writer', async () => {
        let s = initial(), writerCandidates = [], reviewCandidates = [], captures = 0;
        const fx = { capture: async () => `capture-${captures++}`, evidence: async () => ({ native: true, manifest: {} }), sourceMatches: async () => { }, writer: async (state) => { expect(s.phase).toBe('writing'); writerCandidates.push(state.candidate); return { status: 'done', attempts: [{}] }; }, preserve: async () => { }, changed: async () => true, check: async () => { }, review: async (state) => { expect(s.phase).toBe('self-reviewing'); reviewCandidates.push(state.candidate); return { result: { status: 'done', attempts: [{}] }, review: { findings: state.cycles === 1 ? [issue] : [] } }; } };
        const save = async (next) => (s = next);
        for (let i = 0; i < 20 && s.phase !== 'settled'; i++)
            s = await advance(s, fx, save);
        expect(s.phase).toBe('settled');
        expect(writerCandidates).toEqual(['capture-0', 'capture-1']);
        expect(reviewCandidates).toEqual(['capture-1', 'capture-2']);
        expect(s.attempts).toBe(4);
        expect(s.bestCandidate).toBe('capture-2');
    });
    it('functional failure prevents any review', async () => { let s = { ...initial(), phase: 'checks-ready' }; let reviewed = false; await expect(advance(s, { check: async () => { throw Error('overflow'); }, review: async () => { reviewed = true; } }, async (n) => (s = n))).rejects.toThrow('overflow'); expect(reviewed).toBe(false); expect(s.phase).toBe('checking'); });
    it('native scope pauses before dispatch and resumes only explicitly', async () => { let s = { ...initial(), phase: 'candidate-captured', candidate: 'candidate' }; s = await advance(s, { evidence: async () => ({ native: false }) }, async (n) => n); expect(s.phase).toBe('waiting-native'); expect(resumeState(s).phase).toBe('candidate-captured'); expect(() => resumeState({ ...s, phase: 'writing' })).toThrow('replay'); });
    it('refuses automatic replay after crash', async () => { await expect(advance({ ...initial(), phase: 'writing' }, {}, async (n) => n)).rejects.toThrow('reconciliation'); });
    it('stops before dispatch when attempts or time expire', async () => { for (const update of [{ attempts: 24 }, { deadline: 0 }]) {
        let s = await advance({ ...initial(), ...update }, {}, async (n) => n);
        expect(s.phase).toBe('budget');
    } });
    it('stops after two unresolved cycles; preference tradeoffs go to a person', () => { let s = { ...initial(), cycles: 1, candidate: 'c' }; s = reviewOutcome(s, { findings: [issue] }); s = reviewOutcome({ ...s, cycles: 2 }, { findings: [issue] }); s = reviewOutcome({ ...s, cycles: 3 }, { findings: [issue] }); expect(s.phase).toBe('stalled'); expect(reviewOutcome(initial(), { humanDecisionRequired: true, findings: [] }).phase).toBe('human-decision-required'); });
    it('required image hashes must be present on every physical attempt', async () => { const e = { receipt: { images: [{ sha256: 'new-image' }] } }, config = { model: 'fixture' }; const r = { provider: 'ollama', model: 'fixture', attempts: [{ model: 'fixture', imageSha256: ['old-image'] }] }; await expect(verifyWire(r, e, config)).rejects.toThrow('Required image'); r.attempts[0].imageSha256 = ['new-image']; await expect(verifyWire(r, e, config)).resolves.toBeUndefined(); });
});
describe('evidence identity gate', () => {
    it('refuses tampering and does not clear an unsupported native theme', async () => {
        const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
        const { evidence } = await import('./experiment.mjs'), { sha256 } = await import('./evidence.mjs');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-evidence-'));
        try {
            const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), checks = Buffer.from('{"passed":true,"captures":[]}');
            await fs.writeFile(path.join(dir, 'view.png'), png);
            await fs.writeFile(path.join(dir, 'checks.json'), checks);
            const ui = { 'src/panel.tsx': 'ui' };
            const manifest = { schemaVersion: 1, status: 'complete', scenario: 'tools-and-review', evidenceId: 'e', source: { fixtureHash: 'f', files: ui }, fileHashes: { 'view.png': sha256(png), 'checks.json': sha256(checks) }, captures: [{ id: 'view', png: 'view.png', theme: 'klide-light', viewport: { width: 900, height: 700 }, state: 'permission' }] };
            const file = path.join(dir, 'manifest.json'), parityFile = path.join(dir, 'parity.json');
            await fs.writeFile(file, JSON.stringify(manifest));
            const parity = { status: 'scoped-pass', fixtureHash: 'f', uiHash: sha256(JSON.stringify(ui)), eligibleCaptures: [{ scenario: 'tools-and-review', theme: 'sage-garden-dark', viewport: { width: 900, height: 700 }, states: ['permission'] }] };
            await fs.writeFile(parityFile, JSON.stringify(parity));
            expect((await evidence(file, ['view'], parityFile)).native).toBe(false);
            parity.eligibleCaptures[0].theme = 'klide-light';
            await fs.writeFile(parityFile, JSON.stringify(parity));
            expect((await evidence(file, ['view'], parityFile)).native).toBe(true);
            await fs.writeFile(path.join(dir, 'view.png'), 'tamper');
            await expect(evidence(file, ['view'], parityFile)).rejects.toThrow('hash mismatch');
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
