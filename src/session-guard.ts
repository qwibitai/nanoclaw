/**
 * Prevents a still-running agent from restoring a session that was
 * explicitly cleared (e.g. via /clear). When a session is cleared,
 * the group is marked so that any subsequent save() calls from the
 * winding-down agent are silently suppressed. The mark is removed
 * when a new agent run starts via startRun().
 */
export class SessionGuard {
  private cleared = new Set<string>();

  /** Mark a group's session as explicitly cleared. */
  markCleared(groupFolder: string): void {
    this.cleared.add(groupFolder);
  }

  /** True if the group's session was cleared and no new run has started. */
  isCleared(groupFolder: string): boolean {
    return this.cleared.has(groupFolder);
  }

  /** Remove the cleared mark — called at the start of a new agent run. */
  startRun(groupFolder: string): void {
    this.cleared.delete(groupFolder);
  }
}
