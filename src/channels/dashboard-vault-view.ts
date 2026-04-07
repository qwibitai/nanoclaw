/**
 * Vault view — D3.js force-directed knowledge graph.
 * Ported from vault-explorer/server.js, restyled for dashboard design tokens.
 */

export function getVaultViewHTML(): string {
  return `
<div id="vault-container" style="position:relative;width:100%;height:100%;overflow:hidden;">
  <div id="vault-header" style="position:absolute;top:16px;left:20px;z-index:5;pointer-events:none;">
    <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.3px;">Family Vault</h2>
    <p style="font-size:12px;color:var(--text-secondary);margin-top:2px;">Knowledge graph</p>
  </div>
  <div id="vault-search" style="position:absolute;top:16px;right:20px;z-index:5;">
    <input type="text" id="vault-search-input" placeholder="Search nodes\u2026"
      style="width:180px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:13px;font-family:inherit;outline:none;transition:width 0.2s;"
      autocomplete="off" spellcheck="false">
  </div>
  <svg id="vault-svg" style="width:100%;height:100%;display:block;"></svg>
  <div id="vault-detail" style="position:absolute;top:0;right:-400px;width:400px;height:100%;background:var(--surface);border-left:1px solid var(--border);padding:24px 20px;overflow-y:auto;transition:right 0.3s cubic-bezier(0.4,0,0.2,1);z-index:10;">
    <button id="vault-detail-close" style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:var(--surface-hover);border-radius:var(--radius-sm);color:var(--text-secondary);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&times;</button>
    <div id="vault-detail-content"></div>
  </div>
  <div id="vault-legend" style="position:absolute;bottom:16px;left:20px;display:flex;gap:12px;z-index:5;flex-wrap:wrap;"></div>
  <div id="vault-controls" style="position:absolute;bottom:16px;right:20px;display:flex;gap:6px;z-index:5;">
    <button class="vault-ctrl" onclick="window._vaultZoomIn()" title="Zoom in">+</button>
    <button class="vault-ctrl" onclick="window._vaultZoomOut()" title="Zoom out">&minus;</button>
    <button class="vault-ctrl" onclick="window._vaultReset()" title="Reset">&#x2302;</button>
  </div>
</div>

<style>
#vault-search-input:focus { border-color:var(--accent); width:240px; }
#vault-search-input::placeholder { color:var(--text-tertiary); }
.vault-ctrl {
  width:34px;height:34px;border:1px solid var(--border);background:var(--surface);
  border-radius:var(--radius-sm);color:var(--text-secondary);font-size:16px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:background 0.15s;
}
.vault-ctrl:hover { background:var(--surface-hover);color:var(--text); }
#vault-detail .domain-badge {
  display:inline-block;padding:3px 10px;border-radius:6px;
  font-size:11px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:12px;
}
#vault-detail h3 { font-size:20px;font-weight:700;margin-bottom:6px;letter-spacing:-0.3px; }
#vault-detail .desc { font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.5; }
#vault-detail .meta { display:flex;gap:12px;margin-bottom:16px;font-size:12px;color:var(--text-tertiary); }
#vault-detail .section-label {
  font-size:11px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;
  color:var(--text-tertiary);margin:16px 0 8px;
}
#vault-detail .content-text { font-size:13.5px;line-height:1.7;color:var(--text-secondary); }
#vault-detail .content-text h3 { font-size:14px;font-weight:600;color:var(--text);margin:12px 0 4px; }
#vault-detail .content-text ul { padding-left:16px; }
#vault-detail .content-text li { margin-bottom:4px; }
#vault-detail .content-text strong { color:var(--text); }
.connected-nodes { display:flex;flex-wrap:wrap;gap:6px; }
.connected-node {
  padding:4px 10px;border-radius:6px;font-size:12px;
  background:var(--surface-hover);border:1px solid var(--border);cursor:pointer;transition:background 0.15s;
}
.connected-node:hover { background:var(--accent-light); }
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
    d.textContent = s;
    return d.innerHTML;
  }

  function formatContent(text) {
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
    panel.style.right = '0';
  }

  function closePanel() {
    document.getElementById('vault-detail').style.right = '-400px';
  }

  document.getElementById('vault-detail-close').addEventListener('click', closePanel);

  function initGraph(data) {
    vaultNodes = data.nodes;
    edges = data.edges;

    vaultNodes.forEach(function(n) { getColor(n.domain); });
    Object.keys(domainColors).forEach(function(d) { activeDomains.add(d); });

    const container = document.getElementById('vault-container');
    const svgEl = document.getElementById('vault-svg');
    svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = container.clientWidth;
    const height = container.clientHeight;

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

    // Legend
    var legendEl = document.getElementById('vault-legend');
    legendEl.innerHTML = '';
    Object.entries(domainColors).forEach(function(entry) {
      var domain = entry[0], colors = entry[1];
      var item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);cursor:pointer;user-select:none;';
      item.innerHTML = '<div style="width:10px;height:10px;border-radius:50%;background:' + colors.raw + '"></div>' + domain;
      item.addEventListener('click', function() {
        if (activeDomains.has(domain)) { activeDomains.delete(domain); item.style.opacity = '0.3'; }
        else { activeDomains.add(domain); item.style.opacity = '1'; }
        node.transition().duration(300).style('opacity', function(d) { return activeDomains.has(d.domain) ? 1 : 0.08; });
      });
      legendEl.appendChild(item);
    });

    initialized = true;
  }

  // Search
  document.getElementById('vault-search-input').addEventListener('input', function() {
    if (!initialized) return;
    var q = this.value.toLowerCase().trim();
    if (!q) { node.transition().duration(200).style('opacity', 1); return; }
    node.transition().duration(200).style('opacity', function(d) {
      return (d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)) ? 1 : 0.08;
    });
  });

  // Zoom controls
  window._vaultZoomIn = function() { svg.transition().duration(300).call(zoom.scaleBy, 1.4); };
  window._vaultZoomOut = function() { svg.transition().duration(300).call(zoom.scaleBy, 0.7); };
  window._vaultReset = function() { svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); };

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
          document.getElementById('view-vault').innerHTML =
            '<div class="empty-state"><h3>Vault</h3><p>No vault files found.</p></div>';
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
