/**
 * D3 force-directed simulation hook for the Vault knowledge graph.
 *
 * Ported essentially verbatim from the previous
 * nanoclaw/src/channels/dashboard-vault-view.ts so the graph feels
 * identical after the rebuild. React owns the chrome (header,
 * search input, legend, zoom buttons, detail panel). This hook
 * owns everything inside the <svg> element.
 *
 * Strict Mode safety: React 18+ runs effect init → cleanup → init
 * once on mount in dev. The cleanup function does all of the
 * following, in order, so the second init doesn't create duplicate
 * simulations or leaked listeners:
 *
 *   1. simulation.stop()
 *   2. simulation.on('tick', null)
 *   3. zoom listener detached via svg.on('.zoom', null)
 *   4. drag listener detached via node.on('.drag', null)
 *   5. svg.selectAll('*').remove()  (nuke everything d3 appended)
 *   6. ResizeObserver disconnected
 *   7. any pending requestAnimationFrame cancelled
 *
 * The deferred-init dimension-read fix from the previous
 * implementation is preserved: on first mount (or container
 * resize) the simulation waits for the container to have non-zero
 * width/height before calling forceCenter — mobile Safari and
 * first-frame layout both briefly return 0 for clientWidth.
 */

import { useEffect, useRef } from "react";
import * as d3Selection from "d3-selection";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { zoom as d3Zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { drag as d3Drag } from "d3-drag";
// Side-effect import: d3-transition augments the Selection
// prototype so .transition() becomes available on d3 selections.
// Without this import the transition calls below type-check as
// missing methods.
import "d3-transition";
import type { VaultGraph, VaultNode } from "@/types";
import { DomainColorMap } from "./domainColors";

// Extend the plain VaultNode with d3-force simulation state.
interface SimNode extends SimulationNodeDatum, VaultNode {
  fx?: number | null;
  fy?: number | null;
}

type SimLink = SimulationLinkDatum<SimNode>;

export interface VaultHandle {
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  setSearch(query: string): void;
  setDomainFilter(domains: Set<string>): void;
}

export interface UseVaultSimulationOptions {
  graph: VaultGraph | null;
  onNodeClick: (node: VaultNode) => void;
  colors: DomainColorMap;
}

export function useVaultSimulation({
  graph,
  onNodeClick,
  colors,
}: UseVaultSimulationOptions): {
  svgRef: React.RefObject<SVGSVGElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  handle: React.MutableRefObject<VaultHandle | null>;
} {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handle = useRef<VaultHandle | null>(null);

  // Stash the latest onNodeClick in a ref so the effect doesn't
  // re-run every time the parent re-renders with a fresh callback.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  useEffect(() => {
    const svgEl = svgRef.current;
    const containerEl = containerRef.current;
    if (!svgEl || !containerEl || !graph) return;

    // Mutable copies so d3-force can decorate the data with
    // positions without polluting the original objects.
    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    const edges: SimLink[] = graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
    }));

    // Warm the color map so every node has a color before the
    // legend asks for one.
    for (const n of nodes) colors.get(n.domain);

    let simulation: Simulation<SimNode, SimLink> | null = null;
    let zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> | null = null;
    let rafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let disposed = false;

    const svg = d3Selection.select(svgEl);

    const init = (width: number, height: number) => {
      svg.selectAll("*").remove();

      const gContainer = svg.append("g");

      zoomBehavior = d3Zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 4])
        .on("zoom", (e) => {
          gContainer.attr("transform", e.transform.toString());
        });
      svg.call(zoomBehavior);

      simulation = forceSimulation<SimNode, SimLink>(nodes)
        .force(
          "link",
          forceLink<SimNode, SimLink>(edges)
            .id((d) => d.id)
            .distance(100)
            .strength(0.6),
        )
        .force("charge", forceManyBody().strength(-400))
        .force("center", forceCenter(width / 2, height / 2))
        .force("collision", forceCollide<SimNode>().radius(40));

      const link = gContainer
        .selectAll<SVGLineElement, SimLink>(".link")
        .data(edges)
        .enter()
        .append("line")
        .attr("stroke", "var(--color-border)")
        .attr("stroke-width", 1);

      const node = gContainer
        .selectAll<SVGGElement, SimNode>(".node")
        .data(nodes)
        .enter()
        .append("g")
        .attr("class", "node")
        .style("cursor", "pointer")
        .call(
          d3Drag<SVGGElement, SimNode>()
            .on("start", (event, d) => {
              if (!event.active) simulation?.alphaTarget(0.3).restart();
              d.fx = d.x;
              d.fy = d.y;
            })
            .on("drag", (event, d) => {
              d.fx = event.x;
              d.fy = event.y;
            })
            .on("end", (event, d) => {
              if (!event.active) simulation?.alphaTarget(0);
              d.fx = null;
              d.fy = null;
            }),
        );

      node
        .append("circle")
        .attr("class", "hit-area")
        .attr("r", 30)
        .attr("fill", "transparent");

      node
        .append("circle")
        .attr("class", "glow-ring")
        .attr("r", (d) => (d.type === "moc" ? 18 : 12))
        .attr("fill", (d) => colors.get(d.domain).raw)
        .attr("opacity", 0.15);

      node
        .append("circle")
        .attr("class", "main-circle")
        .attr("r", (d) => (d.type === "moc" ? 12 : 8))
        .attr("fill", (d) => colors.get(d.domain).raw)
        .attr("stroke", (d) => colors.get(d.domain).raw)
        .attr("stroke-width", 2)
        .attr("stroke-opacity", 0.3)
        .attr("opacity", 0.9);

      node
        .filter((d) => d.type === "moc")
        .append("circle")
        .attr("r", 16)
        .attr("fill", "none")
        .attr("stroke", (d) => colors.get(d.domain).raw)
        .attr("stroke-width", 1)
        .attr("stroke-opacity", 0.25)
        .attr("stroke-dasharray", "3,3");

      node
        .append("text")
        .attr("dy", (d) => (d.type === "moc" ? 28 : 22))
        .attr("text-anchor", "middle")
        .attr("fill", "var(--color-muted-foreground)")
        .attr("font-size", (d) => (d.type === "moc" ? "12px" : "11px"))
        .attr("font-weight", (d) => (d.type === "moc" ? 600 : 400))
        .text((d) => d.label);

      // Hover: dim non-connected nodes and highlight links.
      node
        .on("mouseover", function (_event, d) {
          const connected = new Set<string>([d.id]);
          for (const e of edges) {
            const sid =
              typeof e.source === "object" ? (e.source as SimNode).id : e.source;
            const tid =
              typeof e.target === "object" ? (e.target as SimNode).id : e.target;
            if (sid === d.id) connected.add(tid as string);
            if (tid === d.id) connected.add(sid as string);
          }
          node
            .transition()
            .duration(200)
            .style("opacity", (n: SimNode) => (connected.has(n.id) ? 1 : 0.15));
          link
            .transition()
            .duration(200)
            .attr("stroke", (e: SimLink) => {
              const sid =
                typeof e.source === "object"
                  ? (e.source as SimNode).id
                  : e.source;
              const tid =
                typeof e.target === "object"
                  ? (e.target as SimNode).id
                  : e.target;
              return sid === d.id || tid === d.id
                ? colors.get(d.domain).raw
                : "var(--color-border)";
            })
            .attr("stroke-width", (e: SimLink) => {
              const sid =
                typeof e.source === "object"
                  ? (e.source as SimNode).id
                  : e.source;
              const tid =
                typeof e.target === "object"
                  ? (e.target as SimNode).id
                  : e.target;
              return sid === d.id || tid === d.id ? 2 : 1;
            });
          d3Selection
            .select(this)
            .select(".main-circle")
            .transition()
            .duration(200)
            .attr("r", d.type === "moc" ? 15 : 11);
          d3Selection
            .select(this)
            .select(".glow-ring")
            .transition()
            .duration(200)
            .attr("opacity", 0.35);
        })
        .on("mouseout", function (_event, d) {
          node.transition().duration(300).style("opacity", 1);
          link
            .transition()
            .duration(300)
            .attr("stroke", "var(--color-border)")
            .attr("stroke-width", 1);
          d3Selection
            .select(this)
            .select(".main-circle")
            .transition()
            .duration(200)
            .attr("r", d.type === "moc" ? 12 : 8);
          d3Selection
            .select(this)
            .select(".glow-ring")
            .transition()
            .duration(200)
            .attr("opacity", 0.15);
        })
        .on("click", (event, d) => {
          event.stopPropagation();
          onNodeClickRef.current(d);
        });

      simulation.on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x ?? 0)
          .attr("y1", (d) => (d.source as SimNode).y ?? 0)
          .attr("x2", (d) => (d.target as SimNode).x ?? 0)
          .attr("y2", (d) => (d.target as SimNode).y ?? 0);
        node.attr(
          "transform",
          (d) => `translate(${d.x ?? 0},${d.y ?? 0})`,
        );
      });

      // Publish the imperative handle so React chrome (zoom
      // buttons, search input) can poke the simulation.
      handle.current = {
        zoomIn() {
          if (zoomBehavior)
            svg
              .transition()
              .duration(300)
              .call(zoomBehavior.scaleBy, 1.4);
        },
        zoomOut() {
          if (zoomBehavior)
            svg
              .transition()
              .duration(300)
              .call(zoomBehavior.scaleBy, 0.7);
        },
        reset() {
          if (zoomBehavior)
            svg
              .transition()
              .duration(500)
              .call(zoomBehavior.transform, zoomIdentity);
        },
        setSearch(query: string) {
          const q = query.toLowerCase().trim();
          if (!q) {
            node.transition().duration(200).style("opacity", 1);
            return;
          }
          node
            .transition()
            .duration(200)
            .style("opacity", (d: SimNode) => {
              const hit =
                d.label.toLowerCase().includes(q) ||
                d.description.toLowerCase().includes(q) ||
                d.content.toLowerCase().includes(q);
              return hit ? 1 : 0.08;
            });
        },
        setDomainFilter(domains: Set<string>) {
          node
            .transition()
            .duration(300)
            .style("opacity", (d: SimNode) => (domains.has(d.domain) ? 1 : 0.08));
        },
      };
    };

    // Deferred dimension read. Container width/height can briefly
    // be zero on first mount (flex layout hasn't settled), and
    // forceCenter((0, 0)) silently bakes nodes into a corner.
    // rAF + one-frame retry until we see real dimensions.
    const tryInit = () => {
      if (disposed) return;
      const width = containerEl.clientWidth;
      const height = containerEl.clientHeight;
      if (width === 0 || height === 0) {
        rafId = requestAnimationFrame(tryInit);
        return;
      }
      init(width, height);
    };
    rafId = requestAnimationFrame(tryInit);

    // React to container resize (orientation change on mobile,
    // sidebar collapse on desktop). We tear down and re-init
    // rather than trying to live-update forces.
    resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      const width = containerEl.clientWidth;
      const height = containerEl.clientHeight;
      if (width === 0 || height === 0) return;
      // Cheap update: nudge the center force and re-warm alpha
      // rather than a full rebuild.
      if (simulation) {
        simulation
          .force("center", forceCenter(width / 2, height / 2))
          .alpha(0.3)
          .restart();
      }
    });
    resizeObserver.observe(containerEl);

    // --- Cleanup — the Strict Mode safety net ---
    return () => {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (simulation) {
        simulation.on("tick", null);
        simulation.stop();
        simulation = null;
      }
      // Detach any lingering d3 event namespaces on svg + nodes.
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
      handle.current = null;
    };
  }, [graph, colors]);

  return { svgRef, containerRef, handle };
}
