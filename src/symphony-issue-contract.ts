import {
  SymphonyExecutionLaneSchema,
  SymphonyTargetRuntimeSchema,
  SymphonyWorkClassSchema,
  type SymphonyExecutionLane,
  type SymphonyTargetRuntime,
  type SymphonyWorkClass,
} from './symphony-routing.js';

const REQUIRED_SECTION_NAMES = [
  'Problem Statement',
  'Scope',
  'Acceptance Criteria',
  'Required Checks',
  'Required Evidence',
  'Blocked If',
  'Symphony Routing',
] as const;

function sectionPattern(sectionName: string): RegExp {
  return new RegExp(`^##+\\s+${sectionName}\\s*$`, 'im');
}

function extractSection(body: string, sectionName: string): string {
  const heading = new RegExp(`^##+\\s+${sectionName}\\s*$`, 'im');
  const match = heading.exec(body);
  if (!match) {
    return '';
  }
  const start = match.index + match[0].length;
  const remaining = body.slice(start);
  const nextHeadingIndex = remaining.search(/^##+\s+/m);
  return (nextHeadingIndex === -1 ? remaining : remaining.slice(0, nextHeadingIndex)).trim();
}

function parseRoutingLine(section: string, fieldName: string): string {
  const pattern = new RegExp(`^[-*]\\s*${fieldName}\\s*:\\s*(.+)$`, 'im');
  const match = section.match(pattern);
  if (!match?.[1]?.trim()) {
    throw new Error(`Symphony Routing is missing "${fieldName}".`);
  }
  return match[1].trim();
}

export type SymphonyIssueContract = {
  workClass: SymphonyWorkClass;
  executionLane: SymphonyExecutionLane;
  targetRuntime: SymphonyTargetRuntime;
  missingSections: string[];
};

export function missingSymphonySections(body: string): string[] {
  return REQUIRED_SECTION_NAMES.filter(
    (sectionName) => !sectionPattern(sectionName).test(body || ''),
  );
}

export function parseSymphonyIssueContract(body: string): SymphonyIssueContract {
  const missingSections = missingSymphonySections(body);
  if (missingSections.length > 0) {
    throw new Error(
      `Issue description is missing required sections: ${missingSections.join(', ')}`,
    );
  }

  const routingSection = extractSection(body, 'Symphony Routing');
  const executionLane = SymphonyExecutionLaneSchema.parse(
    parseRoutingLine(routingSection, 'Execution Lane').toLowerCase(),
  );
  const targetRuntime = SymphonyTargetRuntimeSchema.parse(
    parseRoutingLine(routingSection, 'Target Runtime').toLowerCase(),
  );
  const workClass = SymphonyWorkClassSchema.parse(
    parseRoutingLine(routingSection, 'Work Class').toLowerCase(),
  );

  return {
    workClass,
    executionLane,
    targetRuntime,
    missingSections,
  };
}

export function buildSymphonyPrompt(input: {
  identifier: string;
  title: string;
  url: string;
  description: string;
}): string {
  return [
    `Implement Linear issue ${input.identifier}: ${input.title}`,
    '',
    `Issue URL: ${input.url}`,
    '',
    'Follow the issue description exactly. Do not widen scope.',
    'If required checks fail or scope is incomplete, stop and report the blocker.',
    '',
    input.description.trim(),
  ].join('\n');
}
