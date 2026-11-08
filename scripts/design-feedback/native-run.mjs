import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function runNative({ binary, request, directory, maxAttempts = 4, timeoutSecs = 180, allowedWritePaths = [], signal }) {
    if (signal?.aborted)
        throw Error('Cancelled before dispatch');
    await mkdir(path.dirname(directory), { recursive: true });
    const inputPath = directory + '.input.json';
    await writeFile(inputPath, JSON.stringify({ request, maxAttempts, timeoutSecs, allowedWritePaths }));
    const child = spawn(binary, ['design-pilot-run', inputPath, directory], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const logs = [];
    child.stdout.on('data', b => logs.push(b));
    child.stderr.on('data', b => logs.push(b));
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    let kill;
    const stop = () => { child.kill('SIGINT'); kill = setTimeout(() => child.kill('SIGKILL'), 10000); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted)
        stop();
    const watchdog = setTimeout(stop, (timeoutSecs + 15) * 1000);
    try {
        await Promise.all([completed, writeFile(directory + '.process.json', JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), inputPath }))]);
    }
    finally {
        clearTimeout(watchdog);
        clearTimeout(kill);
        signal?.removeEventListener('abort', stop);
        await writeFile(directory + '.log.txt', Buffer.concat(logs));
    }
    let result;
    try {
        result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    }
    catch {
        throw Error(`Run has no terminal report; inspect ${directory}.log.txt. Do not automatically replay it.`);
    }
    if (signal?.aborted)
        throw Error('Cancelled; native Run was stopped');
    return result;
}
