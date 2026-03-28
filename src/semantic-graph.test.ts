import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  ConceptNode,
  SemanticGraph,
  getGraphContextSummary,
  loadSemanticGraph,
  mergeConceptsIntoGraph,
  pruneGraph,
  saveSemanticGraph,
} from './semantic-graph.js';

function emptyGraph(): SemanticGraph {
  return {
    nodes: [],
    edges: [],
    updated_at: new Date().toISOString(),
    version: 1,
  };
}

describe('semantic-graph', () => {
  it('loadSemanticGraph returns empty graph when file absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
    const graph = loadSemanticGraph(dir);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.version).toBe(1);
  });

  it('mergeConceptsIntoGraph adds new nodes for unseen concepts', () => {
    const graph = emptyGraph();
    const updated = mergeConceptsIntoGraph(graph, ['machine learning', 'data science']);
    const ids = updated.nodes.map((n) => n.id);
    expect(ids).toContain('machine-learning');
    expect(ids).toContain('data-science');
  });

  it('mergeConceptsIntoGraph increments weight for existing nodes', () => {
    const graph = emptyGraph();
    const g1 = mergeConceptsIntoGraph(graph, ['typescript']);
    const g2 = mergeConceptsIntoGraph(g1, ['typescript']);
    const node = g2.nodes.find((n) => n.id === 'typescript');
    expect(node).toBeDefined();
    expect(node!.weight).toBe(2);
  });

  it('mergeConceptsIntoGraph creates edges between co-occurring concepts', () => {
    const graph = emptyGraph();
    const updated = mergeConceptsIntoGraph(graph, ['alpha', 'beta', 'gamma']);
    // 3 concepts => 3 edges: alpha-beta, alpha-gamma, beta-gamma
    expect(updated.edges).toHaveLength(3);
    const sourceTargetPairs = updated.edges.map((e) => [e.source, e.target].sort().join('-'));
    expect(sourceTargetPairs).toContain('alpha-beta');
    expect(sourceTargetPairs).toContain('alpha-gamma');
    expect(sourceTargetPairs).toContain('beta-gamma');
  });

  it('mergeConceptsIntoGraph increments existing edge weights on second call', () => {
    const graph = emptyGraph();
    const g1 = mergeConceptsIntoGraph(graph, ['x', 'y']);
    const g2 = mergeConceptsIntoGraph(g1, ['x', 'y']);
    const edge = g2.edges.find(
      (e) =>
        (e.source === 'x' && e.target === 'y') ||
        (e.source === 'y' && e.target === 'x'),
    );
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(2);
  });

  it('pruneGraph removes lowest-weight nodes beyond maxNodes', () => {
    const nodes: ConceptNode[] = Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i}`,
      label: `Node ${i}`,
      weight: i + 1, // weights 1..10
    }));
    const graph: SemanticGraph = { nodes, edges: [], updated_at: new Date().toISOString(), version: 1 };
    const pruned = pruneGraph(graph, 5);
    expect(pruned.nodes).toHaveLength(5);
    // Should keep the 5 highest-weight nodes (weights 6..10)
    const weights = pruned.nodes.map((n) => n.weight).sort((a, b) => a - b);
    expect(weights).toEqual([6, 7, 8, 9, 10]);
  });

  it('pruneGraph removes edges with pruned source or target', () => {
    const nodes: ConceptNode[] = [
      { id: 'keep', label: 'Keep', weight: 10 },
      { id: 'prune', label: 'Prune', weight: 1 },
      { id: 'also-keep', label: 'Also Keep', weight: 9 },
    ];
    const edges = [
      { source: 'keep', target: 'prune', weight: 1, last_seen: new Date().toISOString() },
      { source: 'keep', target: 'also-keep', weight: 2, last_seen: new Date().toISOString() },
    ];
    const graph: SemanticGraph = { nodes, edges, updated_at: new Date().toISOString(), version: 1 };
    const pruned = pruneGraph(graph, 2);
    expect(pruned.nodes.map((n) => n.id)).not.toContain('prune');
    // Edge involving 'prune' should be removed
    for (const e of pruned.edges) {
      expect(e.source).not.toBe('prune');
      expect(e.target).not.toBe('prune');
    }
  });

  it('getGraphContextSummary returns non-empty string for non-empty graph', () => {
    const nodes: ConceptNode[] = [
      { id: 'ai', label: 'AI', weight: 5 },
      { id: 'ml', label: 'ML', weight: 3 },
    ];
    const graph: SemanticGraph = { nodes, edges: [], updated_at: new Date().toISOString(), version: 1 };
    const summary = getGraphContextSummary(graph);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('AI');
    expect(summary).toContain('5');
  });

  it('saveSemanticGraph then loadSemanticGraph round-trips without data loss', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-roundtrip-'));
    const graph: SemanticGraph = {
      nodes: [
        { id: 'concept-one', label: 'Concept One', weight: 7 },
        { id: 'concept-two', label: 'Concept Two', weight: 3 },
      ],
      edges: [
        {
          source: 'concept-one',
          target: 'concept-two',
          weight: 2,
          last_seen: '2026-03-27T00:00:00.000Z',
        },
      ],
      updated_at: '2026-03-27T00:00:00.000Z',
      version: 2,
    };

    saveSemanticGraph(dir, graph);
    const loaded = loadSemanticGraph(dir);

    expect(loaded.nodes).toHaveLength(2);
    expect(loaded.edges).toHaveLength(1);
    expect(loaded.version).toBe(2);
    expect(loaded.updated_at).toBe('2026-03-27T00:00:00.000Z');
    expect(loaded.nodes[0].id).toBe('concept-one');
    expect(loaded.nodes[0].weight).toBe(7);
    expect(loaded.edges[0].source).toBe('concept-one');
    expect(loaded.edges[0].target).toBe('concept-two');
  });
});
