import { PNG } from 'pngjs';
import { randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, json } from './evidence.mjs';
import { runNative } from './native-run.mjs';
const glyphs = ['11111100011000110001100011000111111', '00100011000010000100001000010001110', '11111000010000111111100001000011111', '11111000010000101111000010000111111', '10001100011000111111000010000100001', '11111100001000011111000010000111111', '11111100001000011111100011000111111', '11111000010001000100010000100001000', '11111100011000111111100011000111111', '11111100011000111111000010000111111'];
export function marker(code) {
    const png = new PNG({ width: 720, height: 180 });
    png.data.fill(255);
    const scale = 16;
    [...code].forEach((digit, i) => { [...glyphs[Number(digit)]].forEach((bit, k) => { if (bit !== '1')
        return; for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
            let x = 30 + i * 110 + (k % 5) * scale + dx, y = 30 + Math.floor(k / 5) * scale + dy, p = (y * png.width + x) * 4;
            png.data[p] = png.data[p + 1] = png.data[p + 2] = 12;
        } }); });
    return PNG.sync.write(png);
}
export async function canary({ binary, model = 'qwen3.5:9b', output, signal, kind = 'colors' }) {
    await mkdir(output);
    const workspace = path.join(output, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, '.klide-design-disposable'), 'Live vision canary only\n');
    const palette = { red: [220, 20, 35], green: [0, 150, 50], blue: [20, 65, 230], yellow: [245, 225, 10], purple: [130, 25, 190], orange: [250, 120, 10] };
    const colors = Array.from({ length: 6 }, () => Object.keys(palette)[randomInt(6)]);
    const code = kind === 'digits' ? Array.from({ length: 6 }, () => String(randomInt(10))).join('') : colors.join(',');
    let bytes;
    if (kind === 'digits')
        bytes = marker(code);
    else {
        const png = new PNG({ width: 720, height: 180 });
        png.data.fill(255);
        for (let i = 0; i < 6; i++)
            for (let y = 20; y < 160; y++)
                for (let x = 10 + i * 120; x < 110 + i * 120; x++) {
                    let p = (y * 720 + x) * 4;
                    [png.data[p], png.data[p + 1], png.data[p + 2]] = palette[colors[i]];
                }
        bytes = PNG.sync.write(png);
    }
    const imageSha256 = sha256(bytes);
    await writeFile(path.join(output, 'marker.png'), bytes);
    const prompt = kind === 'digits' ? 'Read the six digits printed in the attached image, from left to right. Return only JSON with the key "code" and the six-digit string. Preserve leading zeros.' : 'Name the six colored rectangles in the attached image from left to right. Each is red, green, blue, yellow, purple, or orange. Return only JSON: {"colors":[six lowercase color names in order]}.';
    if (prompt.includes(code))
        throw Error('Canary answer leaked into prompt');
    const request = { workspaceRoot: workspace, mode: 'chat', provider: 'ollama', model, initialText: prompt, maxTurns: 1, numPredict: 128, systemPrompt: 'Inspect the attached image. Return a raw JSON object only. Do not use Markdown or code fences.', attachments: [{ path: 'marker.png', content: '', mime: 'image/png', dataUri: `data:image/png;base64,${bytes.toString('base64')}` }] };
    const result = await runNative({ binary, request, directory: path.join(output, 'run'), maxAttempts: 2, timeoutSecs: 240, signal });
    let answer;
    try {
        answer = kind === 'digits' ? JSON.parse(result.output).code : JSON.parse(result.output).colors.join(',');
    }
    catch { }
    const passed = result.status === 'done' && answer === code && result.attempts.length > 0 && result.attempts.every(a => a.model === model && a.imageSha256.length === 1 && a.imageSha256[0] === imageSha256);
    const report = { schemaVersion: 1, status: passed ? 'passed' : 'incomplete', kind, provider: 'ollama', model, imageSha256, promptSha256: sha256(prompt), expected: code, answer: answer ?? null, runId: result.runId, attempts: result.attempts, binarySha256: sha256(await readFile(binary)), exclusion: 'Image-delivery check only; excluded from UI/design-quality judgments.' };
    await json(path.join(output, 'verification.json'), report);
    return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const result = await canary(config);
    console.log(JSON.stringify(result));
    if (result.status !== 'passed')
        process.exitCode = 1;
}
