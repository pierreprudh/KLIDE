import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, open, copyFile, symlink, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceEvidence, sha256, json } from './evidence.mjs';
import { runNative } from './native-run.mjs';
import { validateReview } from './review-output.mjs';
import { terminal, limits, reviewOutcome, resumeState } from './experiment-state.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const parse = async (p) => JSON.parse(await readFile(p, 'utf8'));
export async function atomic(file, value) { const temp = file + '.next'; const f = await open(temp, 'w'); try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
}
finally {
    await f.close();
} await rename(temp, file); }
export async function evidence(manifestPath, captureIds, parityPath) {
    const m = await parse(manifestPath), dir = path.dirname(manifestPath), canonical = await realpath(dir);
    if (m.status !== 'complete' || m.schemaVersion !== 1 || !m.fileHashes || Object.keys(m.fileHashes).length > 4096 || typeof m.source?.fixtureHash !== 'string' || !m.source.fixtureHash || !m.source.files)
        throw Error('Incomplete evidence bundle');
    const bytesOf = async (name) => { if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '.' || p === '..'))
        throw Error('Unsafe evidence path'); const p = await realpath(path.join(dir, name)); if (!p.startsWith(canonical + path.sep))
        throw Error('Evidence symlink escapes bundle'); if ((await stat(p)).size > 20000000)
        throw Error('Evidence member too large'); const b = await readFile(p); if (sha256(b) !== m.fileHashes[name])
        throw Error('Evidence hash mismatch: ' + name); return b; };
    let total = 0;
    for (const name of Object.keys(m.fileHashes)) {
        total += (await bytesOf(name)).length;
        if (total > 200000000)
            throw Error('Evidence bundle too large');
    }
    const checks = JSON.parse((await bytesOf('checks.json')).toString());
    if (!checks.passed)
        throw Error('Functional gate failed');
    if (!Array.isArray(captureIds) || !captureIds.length || captureIds.length > 4 || new Set(captureIds).size !== captureIds.length)
        throw Error('Select 1–4 distinct captures');
    const images = [], attachments = [];
    for (const id of captureIds) {
        const captures = m.captures.filter(c => c.id === id);
        if (captures.length !== 1)
            throw Error('Missing/duplicate selected capture');
        const c = captures[0], b = await bytesOf(c.png);
        if (b.length > 6000000 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw Error('Required PNG unavailable');
        images.push({ captureId: id, path: c.png, sha256: sha256(b), bytes: b.length });
        attachments.push({ path: c.png, content: '', mime: 'image/png', dataUri: 'data:image/png;base64,' + b.toString('base64') });
    }
    const ui = Object.fromEntries(Object.entries(m.source.files).filter(([p]) => p.startsWith('src/')).sort());
    if (!Object.keys(ui).length)
        throw Error('Missing production UI identity');
    let native = false, paritySha256 = null;
    if (parityPath) {
        const bytes = await readFile(parityPath), p = JSON.parse(bytes);
        paritySha256 = sha256(bytes);
        native = p.status === 'scoped-pass' && p.fixtureHash === m.source.fixtureHash && p.uiHash === sha256(JSON.stringify(ui)) && captureIds.every(id => { const c = m.captures.find(c => c.id === id); return p.eligibleCaptures?.some(s => s.scenario === m.scenario && s.theme === c.theme && s.viewport?.width === c.viewport.width && s.viewport?.height === c.viewport.height && s.states?.includes(c.state)); });
    }
    return { manifest: m, checks, native, attachments, receipt: { evidenceId: m.evidenceId, manifestSha256: sha256(await readFile(manifestPath)), paritySha256, images } };
}
async function command(executable, args, { cwd, log, signal, timeout = 180000 }) {
    if (signal?.aborted)
        throw Error('Cancelled');
    const child = spawn(executable, args, { cwd, shell: false, env: { ...process.env, KLIDE_DESIGN_CACHE_DIR: path.join(cwd, '.klide-design-cache/tests'), KLIDE_DESIGN_DEPENDENCY_ROOT: await realpath(path.join(cwd, 'node_modules')) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', b => chunks.push(b));
    child.stderr.on('data', b => chunks.push(b));
    let kill;
    const stop = () => { child.kill('SIGINT'); kill = setTimeout(() => child.kill('SIGKILL'), 8000); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted)
        stop();
    const timer = setTimeout(stop, timeout);
    let code;
    try {
        code = await new Promise((res, rej) => { child.once('error', rej); child.once('exit', res); });
    }
    finally {
        clearTimeout(timer);
        clearTimeout(kill);
        signal?.removeEventListener('abort', stop);
        await writeFile(log, Buffer.concat(chunks));
    }
    if (code !== 0 || signal?.aborted)
        throw Error('Check/capture incomplete: ' + log);
}
async function isolate(config, out) {
    const workspace = path.join(out, 'workspace');
    execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', config.source, workspace], { stdio: 'pipe' });
    execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: workspace, stdio: 'pipe' });
    const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: config.source, maxBuffer: 64 * 1024 * 1024 });
    if (patch.length)
        execFileSync('git', ['apply', '--binary', '-'], { cwd: workspace, input: patch });
    // Copy only declared source inputs; runtime state and ignored files stay out.
    const snapshot = await sourceEvidence(config.source);
    for (const file of snapshot.untrackedInputs) {
        const destination = path.join(workspace, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(config.source, file), destination);
    }
    await writeFile(path.join(workspace, '.klide-design-disposable'), 'Isolated design pilot; preserve this checkout and its patches.\n');
    await symlink(path.join(config.source, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
    const copied = await sourceEvidence(workspace);
    if (copied.treeHash !== snapshot.treeHash)
        throw Error('Disposable source snapshot differs; no writer dispatched');
    await json(path.join(out, 'source.json'), snapshot);
    return workspace;
}
export async function advance(state, effects, save) {
    if (terminal.has(state.phase) || state.phase === 'waiting-native')
        return state;
    if (limits(state))
        return save({ ...state, phase: 'budget', reason: 'Wall-time/provider-attempt limit' });
    let s = state;
    switch (s.phase) {
        case 'prepared': {
            s = await save({ ...s, phase: 'capturing-baseline' });
            const baseline = await effects.capture(0);
            return save({ ...s, phase: 'baseline-captured', baseline, candidate: baseline, bestCandidate: baseline });
        }
        case 'baseline-captured':
        case 'candidate-captured': {
            const current = await effects.evidence(s.candidate);
            if (!current.native)
                return save({ ...s, phase: 'waiting-native', resumePhase: s.phase, reason: 'Matching native Mac verification required for selected candidate captures' });
            await effects.sourceMatches(current.manifest);
            return save({ ...s, phase: s.cycles ? 'self-review-ready' : 'writer-ready' });
        }
        case 'writer-ready':
        case 'revising': {
            if (s.cycles >= s.maxCycles)
                return save({ ...s, phase: 'budget', reason: 'Revision limit' });
            const pending = `writer-${s.cycles + 1}`;
            s = await save({ ...s, phase: 'writing', pending });
            const result = await effects.writer(s);
            s = await save({ ...s, attempts: s.attempts + result.attempts.length });
            await effects.preserve(s.cycles + 1);
            if (result.status !== 'done')
                return save({ ...s, phase: ['human-decision-required', 'budget', 'cancelled'].includes(result.status) ? result.status : 'failed', reason: 'Writer did not complete' });
            if (!await effects.changed())
                return save({ ...s, phase: 'stalled', reason: 'Writer produced no source change' });
            return save({ ...s, phase: 'candidate-capture-ready', cycles: s.cycles + 1 });
        }
        case 'candidate-capture-ready': {
            s = await save({ ...s, phase: 'capturing-candidate' });
            const candidate = await effects.capture(s.cycles);
            return save({ ...s, phase: 'checks-ready', candidate });
        }
        case 'checks-ready': {
            s = await save({ ...s, phase: 'checking' });
            await effects.check(s);
            return save({ ...s, phase: 'candidate-captured' });
        }
        case 'self-review-ready': {
            s = await save({ ...s, phase: 'self-reviewing', pending: `review-${s.cycles}` });
            const { result, review } = await effects.review(s);
            s = await save({ ...s, attempts: s.attempts + result.attempts.length });
            if (result.status !== 'done')
                return save({ ...s, phase: ['budget', 'cancelled', 'human-decision-required'].includes(result.status) ? result.status : 'failed', reason: 'Reviewer did not complete' });
            return save(reviewOutcome(s, review));
        }
        default: throw Error('In-flight phase requires explicit reconciliation; refusing automatic replay: ' + s.phase);
    }
}
function selectedRequest(config, e, brief, mode) {
    return { workspaceRoot: config.workspace, mode, provider: 'ollama', model: config.model, maxTurns: mode === 'chat' ? 1 : 6, numPredict: mode === 'chat' ? 2048 : 4096, attachments: e.attachments, initialText: brief, systemPrompt: mode === 'chat' ? 'Tool-free interface reviewer. Return raw JSON only, without Markdown fences.' : 'Implement the requested small UI revision using only the explicitly permitted files. Inspect source first. Preserve behavior. Do not modify tests, evidence, configuration or runtime state. Explain the change and uncertainty.' };
}
async function runTrial(out, parityOverride) {
    const file = path.join(out, 'state.json'), lock = await open(path.join(out, 'controller.lock'), 'wx');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    let state, config;
    try {
        state = await parse(file);
        config = await parse(path.join(out, 'config.json'));
        if (state.configSha256 !== sha256(JSON.stringify({ ...config, parity: null })))
            throw Error('Frozen experiment configuration changed');
        if (parityOverride)
            config.parity = path.resolve(parityOverride);
    }
    catch (error) {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
        await lock.close();
        await import('node:fs/promises').then(fs => fs.unlink(path.join(out, 'controller.lock')));
        throw error;
    }
    const save = async (s) => { await atomic(file, s); const log = await open(path.join(out, 'events.jsonl'), 'a'); try {
        await log.writeFile(JSON.stringify({ at: new Date().toISOString(), phase: s.phase, attempts: s.attempts, cycles: s.cycles, pending: s.pending ?? null }) + '\n');
        await log.sync();
    }
    finally {
        await log.close();
    } state = s; return s; };
    let lastWrittenHash = null;
    const load = p => evidence(p, config.captureIds, config.parity);
    const sourceMatches = async (m) => { if ((await sourceEvidence(config.workspace)).treeHash !== m.source.treeHash)
        throw Error('Workspace changed after capture; refusing stale evidence'); };
    const remaining = () => ({ maxAttempts: state.maxAttempts - state.attempts, timeoutSecs: Math.max(1, Math.min(300, Math.floor((state.deadline - Date.now()) / 1000))), signal: abort.signal, binary: config.binary, allowedWritePaths: config.allowedWritePaths });
    const effects = {
        evidence: load, sourceMatches,
        capture: async (cycle) => { const dir = path.join(out, 'captures', String(cycle)); await mkdir(path.dirname(dir), { recursive: true }); await command(process.execPath, [path.join(config.workspace, 'scripts/design-feedback/capture.mjs'), '--scenario', config.scenario, '--output', dir, '--port', String(config.capturePort ?? 1468)], { cwd: config.workspace, log: path.join(out, `capture-${cycle}.log`), signal: abort.signal, timeout: Math.max(1, state.deadline - Date.now()) }); return path.join(dir, 'manifest.json'); },
        writer: async (s) => { const e = await load(s.candidate); if (!e.native)
            throw Error('Native scope lost'); await sourceMatches(e.manifest); lastWrittenHash = e.manifest.source.treeHash; const prompt = `Brief: ${config.brief}\nAllowed write paths: ${JSON.stringify(config.allowedWritePaths)}\nEvidence receipt: ${JSON.stringify(e.receipt)}\nFunctional checks: ${JSON.stringify(e.checks)}\nPrior findings: ${JSON.stringify(s.findings ?? [])}\nHypothesize one small improvement; implement it using the allowed file tools. The attached images are the latest candidate. Stop when the scoped change is made.`; const result = await runNative({ ...remaining(), request: selectedRequest(config, e, prompt, 'goal'), directory: path.join(out, 'runs', s.pending) }); await verifyWire(result, e, config); return result; },
        preserve: async (cycle) => { await writeFile(path.join(out, `candidate-${cycle}.patch`), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: config.workspace, maxBuffer: 64 * 1024 * 1024 })); const current = await sourceEvidence(config.workspace); await json(path.join(out, `candidate-${cycle}-source.json`), current); for (const name of config.allowedWritePaths) {
            try {
                const dest = path.join(out, 'candidates', String(cycle), name);
                await mkdir(path.dirname(dest), { recursive: true });
                await copyFile(path.join(config.workspace, name), dest);
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
        } },
        changed: async () => lastWrittenHash !== (await sourceEvidence(config.workspace)).treeHash,
        check: async (s) => {
            const e = await load(s.candidate), base = await load(s.baseline);
            await sourceMatches(e.manifest);
            for (const c of e.checks.captures) {
                const b = base.checks.captures.find(b => b.id === c.id);
                if (!b || c.accessibilityViolations > b.accessibilityViolations)
                    throw Error('Accessibility violation count increased');
            }
            await command(process.execPath, [path.join(config.workspace, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.design.json', '--noEmit'], { cwd: config.workspace, log: path.join(out, `typecheck-${s.cycles}.log`), signal: abort.signal, timeout: Math.max(1, state.deadline - Date.now()) });
            await command(process.execPath, [path.join(config.workspace, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.design.config.ts'], { cwd: config.workspace, log: path.join(out, `flows-${s.cycles}.log`), signal: abort.signal, timeout: Math.max(1, state.deadline - Date.now()) });
        },
        review: async (s) => { const e = await load(s.candidate); await sourceMatches(e.manifest); const prompt = `Brief: ${config.brief}\nEvidence: ${JSON.stringify(e.receipt)}\nFunctional checks: ${JSON.stringify(e.checks)}\nReturn JSON with evidenceId, summary, findings, and optional humanDecisionRequired boolean for preference tradeoffs. Each finding must include captureId, imageSha256, region, observation, impact, severity (low/medium/high), remedy, uncertainty. Use stable wording for unresolved issues. No scores. Empty findings is valid. Images alone cannot prove behavior.`; const result = await runNative({ ...remaining(), request: selectedRequest(config, e, prompt, 'chat'), directory: path.join(out, 'runs', s.pending) }); await sourceMatches(e.manifest); await verifyWire(result, e, config); const review = result.status === 'done' ? validateReview(result.output, e.receipt) : null; await json(path.join(out, `review-${s.cycles}.json`), { receipt: e.receipt, review, runId: result.runId }); return { result, review }; },
    };
    try {
        if (parityOverride) {
            state = resumeState(state);
            await json(path.join(out, 'config.json'), config);
            await save(state);
        }
        while (!terminal.has(state.phase) && state.phase !== 'waiting-native') {
            if (abort.signal.aborted)
                throw Error('Cancelled');
            await advance(state, effects, save);
        }
    }
    catch (error) {
        try {
            await effects.preserve('interrupted-' + state.cycles);
        }
        catch { }
        await save({ ...state, phase: abort.signal.aborted ? 'cancelled' : 'failed', reason: String(error), reconciliation: 'Inspect pending native admission, attempts.json and transcript. Never automatically replay edits.' });
    }
    finally {
        try {
            let recorded = 0;
            let entries = [];
            try {
                entries = await readdir(path.join(out, 'runs'), { withFileTypes: true });
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            for (const entry of entries.filter(e => e.isDirectory())) {
                try {
                    recorded += (await parse(path.join(out, 'runs', entry.name, 'attempts.json'))).attempts.length;
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
            }
            if (recorded > state.attempts)
                await save({ ...state, attempts: recorded });
        }
        finally {
            process.removeListener('SIGINT', cancel);
            process.removeListener('SIGTERM', cancel);
            await lock.close();
            await import('node:fs/promises').then(fs => fs.unlink(path.join(out, 'controller.lock')));
        }
    }
    const summary = { status: state.phase, reason: state.reason, cycles: state.cycles, attempts: state.attempts, bestCandidate: state.bestCandidate, workspace: config.workspace, pending: state.pending ?? null, limitations: 'Native verification is required per captured UI identity. Model findings and the baseline fallback are not a design-quality verdict. In-flight crash recovery requires manual reconciliation.' };
    await json(path.join(out, 'report.json'), summary);
    console.log(JSON.stringify(summary));
    return state;
}
export async function verifyWire(result, e, config) { if (result.provider !== 'ollama' || result.model !== config.model)
    throw Error('Provider/model substitution'); if (!result.attempts?.length)
    throw Error('No physical provider attempt recorded'); for (const a of result.attempts) {
    if (a.model !== config.model || e.receipt.images.some(i => !a.imageSha256.includes(i.sha256)))
        throw Error('Required image missing from native wire');
} ; }
async function create(configPath, out) { const c = await parse(configPath); c.source = path.resolve(c.source ?? root); c.binary = path.resolve(c.binary); c.parity = c.parity ? path.resolve(c.parity) : null; if (!c.brief?.trim() || !c.model || !c.allowedWritePaths?.length)
    throw Error('Explicit brief, local vision model and write paths required'); const canary = await parse(c.canary); if (canary.status !== 'passed' || canary.provider !== 'ollama' || canary.model !== c.model || canary.binarySha256 !== sha256(await readFile(c.binary)))
    throw Error('Matching live vision canary required for this model/build'); await mkdir(out); c.workspace = await isolate(c, out); await json(path.join(out, 'config.json'), c); await atomic(path.join(out, 'state.json'), { schemaVersion: 1, phase: 'prepared', createdAt: Date.now(), deadline: Date.now() + 2700000, maxAttempts: 24, maxCycles: 3, attempts: 0, cycles: 0, stagnant: 0, briefSha256: sha256(c.brief), configSha256: sha256(JSON.stringify({ ...c, parity: null })) }); return runTrial(out); }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [verb, a, b] = process.argv.slice(2);
    let state;
    if (verb === 'start' && a && b)
        state = await create(a, path.resolve(b));
    else if (verb === 'resume' && a && b)
        state = await runTrial(path.resolve(a), b);
    else
        throw Error('Use experiment.mjs start CONFIG NEW_DIR | resume TRIAL_DIR MATCHING_NATIVE_VERIFICATION');
    process.exitCode = state.phase === 'settled' ? 0 : ['waiting-native', 'human-decision-required'].includes(state.phase) ? 2 : 1;
}
