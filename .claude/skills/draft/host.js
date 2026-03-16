/**
 * Draft Skill IPC Handler
 *
 * Handles draft_git_push and draft_x_save IPC messages from container agents.
 * This is the entry point for draft operations on the host process.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
});
// Run a skill script as subprocess
async function runScript(script, args) {
    const scriptPath = path.join(process.cwd(), '.claude', 'skills', 'draft', 'scripts', `${script}.ts`);
    return new Promise((resolve) => {
        const proc = spawn('npx', ['tsx', scriptPath], {
            cwd: process.cwd(),
            env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stdin.write(JSON.stringify(args));
        proc.stdin.end();
        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve({ success: false, message: 'Script timed out (120s)' });
        }, 120000);
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve({ success: false, message: `Script exited with code: ${code}` });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                resolve(JSON.parse(lines[lines.length - 1]));
            }
            catch {
                resolve({ success: false, message: `Failed to parse output: ${stdout.slice(0, 200)}` });
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({ success: false, message: `Failed to spawn: ${err.message}` });
        });
    });
}
// Write result to IPC results directory
function writeResult(dataDir, sourceGroup, requestId, result) {
    const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'draft_results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}
/**
 * Handle draft skill IPC messages
 *
 * @returns true if message was handled, false if not a draft message
 */
export async function handleDraftIpc(data, sourceGroup, isMain, dataDir) {
    const type = data.type;
    // Only handle draft_* types
    if (!type?.startsWith('draft_')) {
        return false;
    }
    // Only main group can use draft skill
    if (!isMain) {
        logger.warn({ sourceGroup, type }, 'Draft skill blocked: not main group');
        return true;
    }
    const requestId = data.requestId;
    if (!requestId) {
        logger.warn({ type }, 'Draft skill blocked: missing requestId');
        return true;
    }
    logger.info({ type, requestId }, 'Processing draft request');
    let result;
    switch (type) {
        case 'draft_git_push':
            if (!data.directory) {
                result = { success: false, message: 'Missing directory' };
                break;
            }
            result = await runScript('git-push', {
                directory: data.directory,
                commitMessage: data.commitMessage || `draft: ${data.directory}`,
            });
            break;
        case 'draft_x_save':
            if (!data.content) {
                result = { success: false, message: 'Missing content' };
                break;
            }
            result = await runScript('x-save-draft', { content: data.content });
            break;
        default:
            return false;
    }
    writeResult(dataDir, sourceGroup, requestId, result);
    if (result.success) {
        logger.info({ type, requestId }, 'Draft request completed');
    }
    else {
        logger.error({ type, requestId, message: result.message }, 'Draft request failed');
    }
    return true;
}
//# sourceMappingURL=host.js.map