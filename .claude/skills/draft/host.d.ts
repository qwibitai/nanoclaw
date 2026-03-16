/**
 * Draft Skill IPC Handler
 *
 * Handles draft_git_push and draft_x_save IPC messages from container agents.
 * This is the entry point for draft operations on the host process.
 */
/**
 * Handle draft skill IPC messages
 *
 * @returns true if message was handled, false if not a draft message
 */
export declare function handleDraftIpc(data: Record<string, unknown>, sourceGroup: string, isMain: boolean, dataDir: string): Promise<boolean>;
//# sourceMappingURL=host.d.ts.map