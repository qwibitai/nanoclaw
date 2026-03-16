/**
 * Browser Automation IPC Handler
 *
 * Handles all browser_* IPC messages from container agents.
 * Spawns Playwright scripts on the host to automate Chrome.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } },
});
async function runScript(script, args) {
    const scriptPath = path.join(process.cwd(), '.claude', 'skills', 'browser-automation', 'scripts', `${script}.ts`);
    return new Promise((resolve) => {
        const proc = spawn('npx', ['tsx', scriptPath], {
            cwd: process.cwd(),
            env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        proc.stdin.write(JSON.stringify(args));
        proc.stdin.end();
        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve({ success: false, message: 'Browser script timed out (120s)' });
        }, 120000);
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve({
                    success: false,
                    message: `Script exited with code: ${code}`,
                });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                resolve(JSON.parse(lines[lines.length - 1]));
            }
            catch {
                resolve({
                    success: false,
                    message: `Failed to parse output: ${stdout.slice(0, 200)}`,
                });
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({ success: false, message: `Failed to spawn: ${err.message}` });
        });
    });
}
function writeResult(dataDir, sourceGroup, requestId, result) {
    const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'browser_results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}
/**
 * Handle browser automation IPC messages
 *
 * @returns true if message was handled, false if not a browser message
 */
export async function handleBrowserIpc(data, sourceGroup, isMain, dataDir) {
    const type = data.type;
    if (!type?.startsWith('browser_')) {
        return false;
    }
    // Only main group can use browser automation
    if (!isMain) {
        logger.warn({ sourceGroup, type }, 'Browser automation blocked: not main group');
        return true;
    }
    const requestId = data.requestId;
    if (!requestId) {
        logger.warn({ type }, 'Browser automation blocked: missing requestId');
        return true;
    }
    logger.info({ type, requestId }, 'Processing browser request');
    let result;
    switch (type) {
        case 'browser_navigate':
            if (!data.url) {
                result = { success: false, message: 'Missing url' };
                break;
            }
            result = await runScript('navigate', { url: data.url });
            break;
        case 'browser_click':
            if (!data.selector) {
                result = { success: false, message: 'Missing selector' };
                break;
            }
            result = await runScript('click', {
                url: data.url,
                selector: data.selector,
            });
            break;
        case 'browser_fill':
            if (!data.fields || !Array.isArray(data.fields)) {
                result = { success: false, message: 'Missing fields array' };
                break;
            }
            result = await runScript('fill', {
                url: data.url,
                fields: data.fields,
                submit_selector: data.submit_selector,
            });
            break;
        case 'browser_extract':
            if (!data.extract_type) {
                result = { success: false, message: 'Missing extract_type' };
                break;
            }
            result = await runScript('extract', {
                url: data.url,
                selector: data.selector,
                extract_type: data.extract_type,
            });
            break;
        case 'browser_screenshot':
            result = await runScript('screenshot', {
                url: data.url,
                selector: data.selector,
                full_page: data.full_page,
            });
            break;
        default:
            return false;
    }
    writeResult(dataDir, sourceGroup, requestId, result);
    if (result.success) {
        logger.info({ type, requestId }, 'Browser request completed');
    }
    else {
        logger.error({ type, requestId, message: result.message }, 'Browser request failed');
    }
    return true;
}
