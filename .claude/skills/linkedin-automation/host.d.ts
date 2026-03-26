/**
 * LinkedIn Automation — Host-side IPC Handler
 *
 * Receives IPC task requests from the container and executes
 * the appropriate Playwright script as a subprocess.
 *
 * Integration: import and call handleLinkedInIpc() from src/ipc.ts
 */
export declare function handleLinkedInIpc(data: {
    type: string;
    requestId: string;
    [key: string]: unknown;
}, _sourceGroup: string, _isMain: boolean, _dataDir: string): Promise<boolean>;
//# sourceMappingURL=host.d.ts.map