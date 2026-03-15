/**
 * Agent Provisioner — creates NanoClaw groups, CLAUDE.md files,
 * and registers agents in the system.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { PortalAgent } from '../db-portal.js';

const SPECIALIZATION_TEMPLATES: Record<string, string> = {
  cisco: `## Cisco Networking Expertise
- Meraki (MX, MR, MS, MV product lines)
- Catalyst switches, ISR/ASR routers
- ISE (Identity Services Engine)
- AnyConnect VPN, ASA firewalls
- DNA Center, SD-WAN (Viptela)
When handling Cisco issues: identify the specific product, check firmware advisories, reference TAC patterns, suggest CLI diagnostics.`,

  fortinet: `## Fortinet Security Expertise
- FortiGate (NGFW, UTM, SD-WAN)
- FortiAnalyzer, FortiManager
- FortiClient VPN
- FortiSwitch, FortiAP
- FortiSIEM, FortiEDR
When handling Fortinet issues: identify FortiOS version and model, check FortiGuard advisories, analyze policy conflicts, review VPN tunnel status.`,

  microsoft: `## Microsoft 365 & Azure Expertise
- Microsoft 365 (Exchange Online, Teams, SharePoint, OneDrive)
- Azure AD / Entra ID (SSO, MFA, Conditional Access)
- Intune / Endpoint Manager
- Azure Infrastructure (VMs, networking, storage)
- Windows Server, Active Directory, Group Policy
When handling Microsoft issues: check M365 service health, review Azure AD sign-in logs, verify license assignments, suggest PowerShell diagnostics.`,

  cybersecurity: `## Cybersecurity Response Expertise
- SIEM alert triage (Fortinet, Sentinel, Splunk)
- Endpoint detection (EDR/XDR alerts)
- Phishing analysis and response
- Incident response procedures (NIST 800-61)
- Vulnerability management and patching
When handling security incidents: classify severity (P1-P4), identify IOCs, check threat intel, determine blast radius, recommend containment. Escalate P1/P2 to human SOC analyst immediately.`,

  general: `## General IT Support
- Desktop/laptop troubleshooting
- Printer and peripheral issues
- Network connectivity
- Email and productivity apps
- Password resets and account management`,
};

export function generateClaudeMd(agent: PortalAgent): string {
  const specializations: string[] = JSON.parse(agent.specializations || '[]');
  const triageConfig = JSON.parse(agent.triage_config || '{}');

  const lines: string[] = [];

  // Header
  lines.push(`# ${agent.display_name || agent.name}`);
  lines.push('');

  // Role description
  if (agent.role === 'dedicated' && agent.client_name) {
    lines.push(
      `You are a dedicated IT support agent for ${agent.client_name}.`,
    );
    lines.push(
      'You handle all tickets assigned to this client with full context of their environment.',
    );
  } else if (agent.role === 'specialist') {
    lines.push(
      'You are a specialist IT support agent available for escalations.',
    );
    lines.push(
      'When you receive an escalated ticket, provide expert analysis based on your specialization.',
    );
  } else if (agent.role === 'cyber') {
    lines.push(
      'You are a cybersecurity response agent for SOC alert triage and incident response.',
    );
    lines.push(
      'Prioritize speed and accuracy in threat assessment. Escalate critical threats immediately.',
    );
  } else {
    lines.push(`You are an AI support agent: ${agent.name}.`);
  }
  lines.push('');

  // Specializations
  for (const spec of specializations) {
    const template = SPECIALIZATION_TEMPLATES[spec];
    if (template) {
      lines.push(template);
      lines.push('');
    }
  }

  // Triage workflow
  lines.push('## Triage Workflow');
  lines.push('');
  lines.push('When you receive a new ticket:');
  lines.push('');

  if (triageConfig.autoAccept !== false) {
    lines.push('1. **Accept the ticket** immediately');
  }
  if (triageConfig.searchKb !== false) {
    lines.push(
      '2. **Search Knowledge Base** — Use `vivantio-search-kb` with relevant keywords',
    );
  }
  if (triageConfig.checkHistory !== false) {
    lines.push(
      '3. **Check Client History** — Use `vivantio-client-history` to find previous similar issues',
    );
  }
  lines.push(
    '4. **Assess & Update** — Post findings to ticket with solution or escalation',
  );
  lines.push('');

  // Update guidelines
  lines.push('## Update Guidelines');
  lines.push('');
  lines.push(
    '- Always add a **public note** to the ticket so the client sees progress',
  );
  lines.push('- Use **internal comments** for your analysis and reasoning');
  lines.push(
    '- Be professional, concise, and empathetic in client-facing notes',
  );
  lines.push(
    '- Reference KB article IDs and past ticket numbers when applicable',
  );

  if (triageConfig.autoResolve) {
    lines.push('- You may resolve tickets when a KB article directly applies');
  } else {
    lines.push('- Never close a ticket — escalate or leave for human review');
  }
  lines.push('');

  // Escalation
  if (triageConfig.escalateTimeout) {
    lines.push('## Escalation');
    lines.push('');
    lines.push(
      `If no solution is found within ${triageConfig.escalateTimeout} minutes, escalate the ticket with your analysis.`,
    );
    lines.push('');
  }

  // Custom instructions
  if (agent.custom_instructions) {
    lines.push('## Additional Instructions');
    lines.push('');
    lines.push(agent.custom_instructions);
    lines.push('');
  }

  return lines.join('\n');
}

export function provisionAgent(agent: PortalAgent): void {
  const groupDir = path.join(GROUPS_DIR, agent.group_folder);

  // Create directories
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'kb'), { recursive: true });

  // Write CLAUDE.md
  const claudeMd = generateClaudeMd(agent);
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd, 'utf-8');

  logger.info(
    { agentId: agent.id, folder: agent.group_folder },
    'Agent provisioned',
  );
}

export function updateAgentClaudeMd(agent: PortalAgent): void {
  const groupDir = path.join(GROUPS_DIR, agent.group_folder);
  if (!fs.existsSync(groupDir)) {
    provisionAgent(agent);
    return;
  }

  const claudeMd = generateClaudeMd(agent);
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd, 'utf-8');
  logger.info(
    { agentId: agent.id, folder: agent.group_folder },
    'Agent CLAUDE.md updated',
  );
}

export function deprovisionAgent(agent: PortalAgent): void {
  // Don't delete the folder — just log. Manual cleanup can happen later.
  logger.info(
    { agentId: agent.id, folder: agent.group_folder },
    'Agent deprovisioned (folder preserved for data retention)',
  );
}
