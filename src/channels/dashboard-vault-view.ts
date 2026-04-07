/**
 * Vault view — D3.js force-directed knowledge graph.
 * Migrated to the shared dashboard vocabulary in devtask #60: chrome
 * (title, search, legend, zoom controls) lives in a real .page-header
 * instead of floating absolute over the canvas. The graph itself,
 * the slide-in detail panel, and the D3 simulation are unchanged
 * except for:
 *   - formatContent() now esc()s d.content before its regex transforms
 *     (closes a pre-existing XSS sink — see devtask #60 plan Unit 4).
 *   - initGraph() defers the dimension read with requestAnimationFrame
 *     and a one-frame zero-width retry guard so the page-header has
 *     time to take its space before forceCenter computes.
 */

export function getVaultViewHTML(): string {
  return `
<div class="view-shell">
  <header class="page-header">
    <div class="page-header__title-block">
      <div class="page-header__eyebrow">Knowledge Graph</div>
      <h1 class="page-header__title">Family Vault</h1>
      <div class="page-header__meta" id="vault-meta"></div>
    </div>
    <div class="page-header__tools">
      <input type="search" id="vault-search-input" class="input" placeholder="Search nodes…" autocomplete="off" spellcheck="false" />
      <div id="vault-legend" class="vault-legend"></div>
      <div class="vault-ctrls">
        <button class="vault-ctrl" type="button" onclick="window._vaultZoomIn()" title="Zoom in">+</button>
        <button class="vault-ctrl" type="button" onclick="window._vaultZoomOut()" title="Zoom out">&minus;</button>
        <button class="vault-ctrl" type="button" onclick="window._vaultReset()" title="Reset">&#x2302;</button>
      </div>
    </div>
  </header>
  <div class="vault-canvas" id="vault-container">
    <svg id="vault-svg"></svg>
    <aside class="vault-detail-panel" id="vault-detail">
      <button id="vault-detail-close" class="vault-detail-close" type="button" aria-label="Close">&times;</button>
      <div id="vault-detail-content"></div>
    </aside>
  </div>
</div>

<style>
.vault-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.vault-canvas svg { width: 100%; height: 100%; display: block; }

.vault-legend {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}
.vault-legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  transition: opacity 0.2s, background 0.15s;
}
.vault-legend-pill:hover { background: var(--surface-hover); }
.vault-legend-pill[aria-pressed="false"] { opacity: 0.4; }
.vault-legend-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.vault-ctrls { display: flex; gap: 4px; }
.vault-ctrl {
  width: 32px; height: 32px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
.vault-ctrl:hover { background: var(--surface-hover); color: var(--text); }
.vault-ctrl:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.vault-detail-panel {
  position: absolute;
  top: 0;
  right: -400px;
  width: 400px;
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  padding: 24px 20px;
  overflow-y: auto;
  transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 10;
}
.vault-detail-panel.is-open { right: 0; }
.vault-detail-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px; height: 28px;
  border: none;
  background: var(--surface-hover);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
#vault-detail .domain-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 12px;
}
#vault-detail h3 {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 6px;
  letter-spacing: -0.3px;
  color: var(--text);
}
#vault-detail .desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  line-height: 1.5;
}
#vault-detail .meta {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 12px;
  color: var(--text-tertiary);
}
#vault-detail .section-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin: 16px 0 8px;
}
#vault-detail .content-text {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-secondary);
}
#vault-detail .content-text h3 { font-size: 14px; font-weight: 600; color: var(--text); margin: 12px 0 4px; }
#vault-detail .content-text ul { padding-left: 16px; }
#vault-detail .content-text li { margin-bottom: 4px; }
#vault-detail .content-text strong { color: var(--text); }
.connected-nodes { display: flex; flex-wrap: wrap; gap: 6px; }
.connected-node {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
}
.connected-node:hover { background: var(--accent-light); }
</style>
`;
}

export function getVaultViewJS(): string {
  return `
(function() {
  const domainColors = {
    root:      { fill: 'var(--text)', raw: '#888', bg: 'var(--surface-hover)' },
    people:    { fill: '#f0a060', raw: '#f0a060', bg: 'var(--orange-light)' },
    school:    { fill: '#60b8f0', raw: '#60b8f0', bg: 'var(--blue-light)' },
    health:    { fill: '#f06080', raw: '#f06080', bg: 'var(--red-light)' },
    household: { fill: '#80d080', raw: '#80d080', bg: 'var(--green-light)' },
    finances:  { fill: '#c090f0', raw: '#c090f0', bg: 'var(--purple-light)' },
    food:      { fill: '#f0d060', raw: '#f0d060', bg: 'rgba(240,208,96,0.12)' }
  };
  const extraColors = ['#f090b0','#90d0c0','#b0a0f0','#d0b080','#80c0c0'];
  let extraIdx = 0;

  let vaultNodes = [];
  let edges = [];
  let simulation = null;
  let svg, gContainer, zoom, link, node;
  let initialized = false;
  const activeDomains = new Set();

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function formatContent(text) {
    // Escape first so the regex transforms operate on safe text. The
    // markdown delimiters (*, #, -, \\n) are not HTML-special and pass
    // through esc() unchanged, so the substitutions still match.
    // Captured \$1 groups now contain pre-escaped text.
    text = esc(text);
    return text
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\\/li>)/gs, '<ul>$1</ul>')
      .replace(/<\\/ul>\\s*<ul>/g, '')
      .replace(/\\n/g, '<br>');
  }

  function getColor(domain) {
    if (!domainColors[domain]) {
      const c = extraColors[extraIdx++ % extraColors.length];
      domainColors[domain] = { fill: c, raw: c, bg: c.replace(')', ',0.12)').replace('rgb', 'rgba') };
    }
    return domainColors[domain];
  }

  function openPanel(d) {
    const panel = document.getElementById('vault-detail');
    const content = document.getElementById('vault-detail-content');
    const colors = getColor(d.domain);
    const connected = [];
    edges.forEach(function(e) {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      if (sid === d.id) connected.push(vaultNodes.find(function(n) { return n.id === tid; }));
      if (tid === d.id) connected.push(vaultNodes.find(function(n) { return n.id === sid; }));
    });
    const icons = { permanent: '\\u25c6', annual: '\\u25c7', seasonal: '\\u25cb', weekly: '\\u00b7', ephemeral: '\\u2218' };
    content.innerHTML =
      '<div class="domain-badge" style="background:' + colors.bg + ';color:' + colors.raw + '">' + esc(d.domain) + '</div>' +
      '<h3>' + esc(d.label) + '</h3>' +
      '<p class="desc">' + esc(d.description) + '</p>' +
      '<div class="meta"><span>' + (icons[d.durability] || '\\u00b7') + ' ' + esc(d.durability) + '</span><span>Updated ' + esc(d.updated) + '</span><span>by ' + esc(d.updated_by) + '</span></div>' +
      (connected.length ? '<div class="section-label">Connected to</div><div class="connected-nodes">' +
        connected.filter(Boolean).map(function(n) {
          return '<span class="connected-node" style="border-color:' + getColor(n.domain).raw + '30;color:' + getColor(n.domain).raw + '" data-id="' + esc(n.id) + '">' + esc(n.label) + '</span>';
        }).join('') +
      '</div>' : '') +
      '<div class="section-label">Contents</div><div class="content-text">' + formatContent(d.content) + '</div>';
    content.querySelectorAll('.connected-node').forEach(function(el) {
      el.addEventListener('click', function() {
        const n = vaultNodes.find(function(v) { return v.id === el.dataset.id; });
        if (n) openPanel(n);
      });
    });
    panel.classList.add('is-open');
  }

  function closePanel() {
    document.getElementById('vault-detail').classList.remove('is-open');
  }

  document.getElementById('vault-detail-close').addEventListener('click', closePanel);

  function buildSimulation(width, height) {
    const svgEl = document.getElementById('vault-svg');
    svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    gContainer = svg.append('g');
    zoom = d3.zoom().scaleExtent([0.3, 4]).on('zoom', function(e) { gContainer.attr('transform', e.transform); });
    svg.call(zoom);

    simulation = d3.forceSimulation(vaultNodes)
      .force('link', d3.forceLink(edges).id(function(d) { return d.id; }).distance(100).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40));

    link = gContainer.selectAll('.link').data(edges).enter().append('line')
      .attr('stroke', 'var(--border)').attr('stroke-width', 1);

    node = gContainer.selectAll('.node').data(vaultNodes).enter().append('g')
      .attr('class', 'node').style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', function(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', function(event, d) { d.fx = event.x; d.fy = event.y; })
        .on('end', function(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    node.append('circle').attr('class', 'hit-area').attr('r', 30).attr('fill', 'transparent');
    node.append('circle').attr('class', 'glow-ring')
      .attr('r', function(d) { return d.type === 'moc' ? 18 : 12; })
      .attr('fill', function(d) { return getColor(d.domain).raw; })
      .attr('opacity', 0.15);
    node.append('circle').attr('class', 'main-circle')
      .attr('r', function(d) { return d.type === 'moc' ? 12 : 8; })
      .attr('fill', function(d) { return getColor(d.domain).raw; })
      .attr('stroke', function(d) { return getColor(d.domain).raw; })
      .attr('stroke-width', 2).attr('stroke-opacity', 0.3).attr('opacity', 0.9);
    node.filter(function(d) { return d.type === 'moc'; }).append('circle')
      .attr('r', 16).attr('fill', 'none')
      .attr('stroke', function(d) { return getColor(d.domain).raw; })
      .attr('stroke-width', 1).attr('stroke-opacity', 0.25).attr('stroke-dasharray', '3,3');
    node.append('text')
      .attr('dy', function(d) { return d.type === 'moc' ? 28 : 22; })
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--text-secondary)')
      .attr('font-size', function(d) { return d.type === 'moc' ? '12px' : '11px'; })
      .attr('font-weight', function(d) { return d.type === 'moc' ? 600 : 400; })
      .text(function(d) { return d.label; });

    node.on('mouseover', function(event, d) {
      var connected = new Set([d.id]);
      edges.forEach(function(e) {
        var sid = typeof e.source === 'object' ? e.source.id : e.source;
        var tid = typeof e.target === 'object' ? e.target.id : e.target;
        if (sid === d.id) connected.add(tid);
        if (tid === d.id) connected.add(sid);
      });
      node.transition().duration(200).style('opacity', function(n) { return connected.has(n.id) ? 1 : 0.15; });
      link.transition().duration(200)
        .attr('stroke', function(e) {
          var sid = typeof e.source === 'object' ? e.source.id : e.source;
          var tid = typeof e.target === 'object' ? e.target.id : e.target;
          return (sid === d.id || tid === d.id) ? getColor(d.domain).raw : 'var(--border)';
        })
        .attr('stroke-width', function(e) {
          var sid = typeof e.source === 'object' ? e.source.id : e.source;
          var tid = typeof e.target === 'object' ? e.target.id : e.target;
          return (sid === d.id || tid === d.id) ? 2 : 1;
        });
      d3.select(this).select('.main-circle').transition().duration(200).attr('r', d.type === 'moc' ? 15 : 11);
      d3.select(this).select('.glow-ring').transition().duration(200).attr('opacity', 0.35);
    })
    .on('mouseout', function(event, d) {
      node.transition().duration(300).style('opacity', 1);
      link.transition().duration(300).attr('stroke', 'var(--border)').attr('stroke-width', 1);
      d3.select(this).select('.main-circle').transition().duration(200).attr('r', d.type === 'moc' ? 12 : 8);
      d3.select(this).select('.glow-ring').transition().duration(200).attr('opacity', 0.15);
    })
    .on('click', function(event, d) {
      event.stopPropagation();
      openPanel(d);
    });

    svg.on('click', closePanel);

    simulation.on('tick', function() {
      link.attr('x1', function(d) { return d.source.x; }).attr('y1', function(d) { return d.source.y; })
          .attr('x2', function(d) { return d.target.x; }).attr('y2', function(d) { return d.target.y; });
      node.attr('transform', function(d) { return 'translate(' + d.x + ',' + d.y + ')'; });
    });
  }

  function buildLegend() {
    var legendEl = document.getElementById('vault-legend');
    legendEl.innerHTML = '';
    Object.entries(domainColors).forEach(function(entry) {
      var domain = entry[0], colors = entry[1];
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'vault-legend-pill';
      pill.setAttribute('aria-pressed', 'true');
      pill.innerHTML = '<span class="vault-legend-pill__dot" style="background:' + colors.raw + '"></span>' + esc(domain);
      pill.addEventListener('click', function() {
        var on = activeDomains.has(domain);
        if (on) { activeDomains.delete(domain); pill.setAttribute('aria-pressed', 'false'); }
        else { activeDomains.add(domain); pill.setAttribute('aria-pressed', 'true'); }
        if (node) node.transition().duration(300).style('opacity', function(d) { return activeDomains.has(d.domain) ? 1 : 0.08; });
      });
      legendEl.appendChild(pill);
    });
  }

  function updateMeta() {
    var meta = document.getElementById('vault-meta');
    if (meta) meta.textContent = vaultNodes.length + ' nodes · ' + edges.length + ' connections';
  }

  function initGraph(data) {
    vaultNodes = data.nodes;
    edges = data.edges;

    vaultNodes.forEach(function(n) { getColor(n.domain); });
    Object.keys(domainColors).forEach(function(d) { activeDomains.add(d); });

    updateMeta();
    buildLegend();

    // Defer the dimension read until after layout. The viewchange event
    // fires before the new flex layout has computed, so reading
    // container.clientWidth synchronously can return 0 — which would bake
    // a forceCenter at (0, 0) silently. rAF + one-frame zero-width retry.
    var container = document.getElementById('vault-container');
    function tryInit() {
      var width = container.clientWidth;
      var height = container.clientHeight;
      if (width === 0 || height === 0) {
        requestAnimationFrame(tryInit);
        return;
      }
      buildSimulation(width, height);
      initialized = true;
    }
    requestAnimationFrame(tryInit);
  }

  // Search
  document.getElementById('vault-search-input').addEventListener('input', function() {
    if (!initialized || !node) return;
    var q = this.value.toLowerCase().trim();
    if (!q) { node.transition().duration(200).style('opacity', 1); return; }
    node.transition().duration(200).style('opacity', function(d) {
      return (d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)) ? 1 : 0.08;
    });
  });

  // Zoom controls
  window._vaultZoomIn = function() { if (svg && zoom) svg.transition().duration(300).call(zoom.scaleBy, 1.4); };
  window._vaultZoomOut = function() { if (svg && zoom) svg.transition().duration(300).call(zoom.scaleBy, 0.7); };
  window._vaultReset = function() { if (svg && zoom) svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closePanel();
  });

  // Load data and init
  function loadVault() {
    fetch('/dashboard/api/graph')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.nodes && data.nodes.length > 0) {
          initGraph(data);
        } else {
          var canvas = document.querySelector('#view-vault .vault-canvas');
          if (canvas) canvas.innerHTML = '<div class="empty-state"><h3>Vault</h3><p>No vault files found.</p></div>';
        }
      })
      .catch(function(err) {
        console.error('Failed to load vault:', err);
      });
  }

  // Load when vault view becomes active
  window.addEventListener('viewchange', function(e) {
    if (e.detail.view === 'vault' && !initialized) loadVault();
  });

  // Re-fetch on SSE update
  window.addEventListener('dashboard-vault_updated', function() {
    loadVault();
  });

  // Load immediately if vault is the active view
  if (location.hash === '#vault' || !location.hash) loadVault();
})();
`;
}
