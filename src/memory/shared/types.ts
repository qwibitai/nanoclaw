// src/memory/shared/types.ts

export type FactType = 'user' | 'feedback' | 'project' | 'reference';

/** Frontmatter persisted to disk for a promoted fact. */
export interface FactFrontmatter {
  name: string;
  description: string;
  type: FactType;
  scopes?: string[];
  count: number;
  first_seen: string; // ISO date
  last_seen: string; // ISO date
  last_value?: string;
  sources: Record<string, number>; // groupName -> count
  history?: string[]; // last 5 prior bodies, newest first
}

/** A promoted fact = frontmatter + body. */
export interface Fact {
  slug: string; // filename stem, e.g. "feedback_terse_responses"
  frontmatter: FactFrontmatter;
  body: string;
}

/** Frontmatter for a candidate (unverified) fact. */
export interface CandidateFrontmatter {
  candidate: true;
  type: FactType;
  name: string;
  description: string;
  scopes?: string[];
  extracted_from: string; // group name
  extracted_at: string; // ISO datetime
  turn_excerpt: string;
  proposed_action: 'create' | `merge:${string}`;
  confidence: number; // 0..1
}

export interface Candidate {
  filename: string; // basename only
  frontmatter: CandidateFrontmatter;
  body: string;
}

/** Output schema from the extractor LLM. */
export interface ExtractedCandidate {
  type: FactType;
  name: string;
  description: string;
  body: string;
  scopes?: string[];
  proposed_action: 'create' | `merge:${string}`;
  confidence: number;
}

export interface ExtractorResult {
  candidates: ExtractedCandidate[];
}
