/**
 * GitHub App Manifest
 * Defines the App's permissions and events for the one-click setup flow.
 */

export function buildAppManifest(webhookUrl: string, appName?: string): object {
  return {
    name: appName || 'NanoClaw AI',
    url: 'https://github.com/qwibitai/NanoClaw',
    hook_attributes: {
      url: `${webhookUrl}/github/webhooks`,
      active: true,
    },
    redirect_url: `${webhookUrl}/github/callback`,
    public: false,
    default_permissions: {
      issues: 'write',
      pull_requests: 'write',
      contents: 'write',
      checks: 'write',
      metadata: 'read',
      members: 'read',
    },
    default_events: [
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'installation_repositories',
    ],
  };
}
