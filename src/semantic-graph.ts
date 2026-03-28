import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface ConceptNode {
  id: string; // normalized: lowercase, hyphenated
  label: string;
  weight: number;
}

export interface ConceptEdge {
  source: string;
  target: string;
  weight: number;
  last_seen: string;
}

export interface SemanticGraph {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  updated_at: string;
  version: number;
}

/**
 * Returns the path to the semantic graph JSON file.
 */
export function getSemanticGraphPath(globalDir: string): string {
  return path.join(globalDir, 'semantic-graph.json');
}

/**
 * Loads the semantic graph from disk. Returns an empty graph on any error.
 */
export function loadSemanticGraph(globalDir: string): SemanticGraph {
  const filePath = getSemanticGraphPath(globalDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SemanticGraph;
    return parsed;
  } catch (err) {
    logger.debug(
      { filePath, err },
      'Could not load semantic graph, returning empty graph',
    );
    return {
      nodes: [],
      edges: [],
      updated_at: new Date().toISOString(),
      version: 1,
    };
  }
}

/**
 * Writes the semantic graph to disk, creating directories as needed.
 */
export function saveSemanticGraph(
  globalDir: string,
  graph: SemanticGraph,
): void {
  fs.mkdirSync(globalDir, { recursive: true });
  const filePath = getSemanticGraphPath(globalDir);
  fs.writeFileSync(filePath, JSON.stringify(graph, null, 2), 'utf-8');
}

/**
 * Normalizes a concept string to a node ID: lowercase and hyphenated.
 */
function normalizeConceptId(concept: string): string {
  return concept.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Merges a list of concepts into the graph, incrementing weights and creating
 * edges between co-occurring concepts. Returns a new graph (no mutation).
 */
export function mergeConceptsIntoGraph(
  graph: SemanticGraph,
  concepts: string[],
  now?: Date,
): SemanticGraph {
  const timestamp = (now ?? new Date()).toISOString();

  // Deep clone
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges.map((e) => ({ ...e }));

  const normalizedConcepts = concepts.map((c) => ({
    id: normalizeConceptId(c),
    label: c,
  }));

  // Update or create nodes
  for (const { id, label } of normalizedConcepts) {
    const existing = nodes.find((n) => n.id === id);
    if (existing) {
      existing.weight += 1;
    } else {
      nodes.push({ id, label, weight: 1 });
    }
  }

  // Update or create edges between co-occurring concepts
  for (let i = 0; i < normalizedConcepts.length; i++) {
    for (let j = i + 1; j < normalizedConcepts.length; j++) {
      const source = normalizedConcepts[i].id;
      const target = normalizedConcepts[j].id;

      const existing = edges.find(
        (e) =>
          (e.source === source && e.target === target) ||
          (e.source === target && e.target === source),
      );
      if (existing) {
        existing.weight += 1;
        existing.last_seen = timestamp;
      } else {
        edges.push({ source, target, weight: 1, last_seen: timestamp });
      }
    }
  }

  let result: SemanticGraph = {
    nodes,
    edges,
    updated_at: timestamp,
    version: graph.version,
  };

  if (result.nodes.length > 500) {
    result = pruneGraph(result);
  }

  return result;
}

/**
 * Prunes the graph to at most maxNodes nodes (default 500), removing the
 * lowest-weight nodes and any edges that reference pruned nodes.
 */
export function pruneGraph(
  graph: SemanticGraph,
  maxNodes: number = 500,
): SemanticGraph {
  if (graph.nodes.length <= maxNodes) {
    return graph;
  }

  // Sort ascending by weight, keep only the top maxNodes
  const sorted = [...graph.nodes].sort((a, b) => a.weight - b.weight);
  const toRemove = new Set(
    sorted.slice(0, sorted.length - maxNodes).map((n) => n.id),
  );
  const prunedNodes = graph.nodes.filter((n) => !toRemove.has(n.id));
  const keptIds = new Set(prunedNodes.map((n) => n.id));
  const prunedEdges = graph.edges.filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target),
  );

  return {
    ...graph,
    nodes: prunedNodes,
    edges: prunedEdges,
  };
}

/**
 * Returns a summary string of the top N concepts by weight.
 */
export function getGraphContextSummary(
  graph: SemanticGraph,
  topN: number = 20,
): string {
  if (graph.nodes.length === 0) {
    return '';
  }

  const top = [...graph.nodes]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, topN);

  return 'Key concepts: ' + top.map((n) => `${n.label}(${n.weight})`).join(', ');
}
