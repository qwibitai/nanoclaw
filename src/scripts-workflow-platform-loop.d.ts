declare module '../scripts/workflow/platform-loop.js' {
  export function buildPlatformBranchName(issueNumber: number, title: string): string;
  export function buildPlatformRunContext(
    issueNumber: number,
    title: string,
    now?: Date,
  ): {
    requestId: string;
    runId: string;
    branch: string;
  };
  export function missingPlatformSections(body: string | null | undefined): string[];
  export function selectPlatformCandidate(items: Array<{
    number: number;
    title?: string;
    url?: string;
    state: string;
    status: string | null;
    priority: string;
    labels: string[];
    missingSections: string[];
    requestId?: string;
    runId?: string;
    nextDecision?: string;
  }>): {
    action: 'noop' | 'pickup';
    reason?: string;
    blockingIssueNumbers?: number[];
    candidatesChecked?: Array<{
      number: number;
      status: string | null;
      priority: string;
      blocked: boolean;
      missingSections: string[];
    }>;
    issue?: {
      number: number;
      title: string;
      url: string;
      status: string | null;
      priority: string;
      labels: string[];
      missingSections: string[];
      requestId: string;
      runId: string;
      nextDecision: string;
      branch: string;
    };
  };
}
