// Opt-in live native-image -> scoped writer-tool handoff; no UI-quality claim.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNative } from './native-run.mjs';
import { sha256, json } from './evidence.mjs';
export async function handoff({ binary, canary: canaryPath, output, signal }) {
    const canary = JSON.parse(await readFile(canaryPath, 'utf8'));
    if (canary.status !== 'passed' || canary.kind !== 'colors' || canary.binarySha256 !== sha256(await readFile(binary)))
        throw Error('Matching passed color canary required');
    const bytes = await readFile(path.join(path.dirname(canaryPath), 'marker.png'));
    if (sha256(bytes) !== canary.imageSha256)
        throw Error('Canary image changed');
    await mkdir(output);
    const workspace = path.join(output, 'workspace');
    await mkdir(workspace + '/src', { recursive: true });
    await writeFile(workspace + '/.klide-design-disposable', 'Native writer handoff test\n');
    const prompt = 'Inspect the attached newly captured image. Create src/vision-handoff.txt using create_file. The entire file must be the six rectangle colors in left-to-right order, lowercase, separated by commas. Use only red, green, blue, yellow, purple, orange. Do not explain instead of creating the file. No other files may be changed.';
    if (prompt.includes(canary.expected))
        throw Error('Answer leaked into handoff prompt');
    const result = await runNative({ binary, directory: output + '/run', maxAttempts: 4, timeoutSecs: 240, allowedWritePaths: ['src/vision-handoff.txt'], signal, request: { workspaceRoot: workspace, mode: 'goal', provider: 'ollama', model: canary.model, maxTurns: 3, numPredict: 512, initialText: prompt, systemPrompt: 'Use the create_file tool to write the visual answer to the exact authorized path.', attachments: [{ path: 'candidate.png', content: '', mime: 'image/png', dataUri: 'data:image/png;base64,' + bytes.toString('base64') }] } });
    let answer = null;
    try {
        answer = (await readFile(workspace + '/src/vision-handoff.txt', 'utf8')).trim();
    }
    catch { }
    const proof = { schemaVersion: 1, status: result.status === 'done' && answer === canary.expected && result.attempts.length > 0 && result.attempts.every(a => a.imageSha256.includes(sha256(bytes))) ? 'passed' : 'incomplete', deliveryStatus: result.status === 'done' && result.attempts.every(a => a.imageSha256.includes(sha256(bytes))) ? 'passed' : 'incomplete', answerStatus: answer === canary.expected ? 'passed' : 'failed', binarySha256: canary.binarySha256, model: canary.model, runId: result.runId, expected: canary.expected, answer, imageSha256: sha256(bytes), attempts: result.attempts, scope: ['src/vision-handoff.txt'], limitation: 'Fresh-image-to-writer/file-tool handoff only; not a UI design trial.' };
    await json(output + '/verification.json', proof);
    return proof;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const proof = await handoff(JSON.parse(await readFile(process.argv[2], 'utf8')));
    console.log(JSON.stringify(proof));
    if (proof.status !== 'passed')
        process.exitCode = 1;
}
