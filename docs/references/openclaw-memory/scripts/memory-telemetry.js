/**
 * memory-telemetry.js — Analyze memory search performance across all systems.
 * 
 * Reads from:
 *   - /tmp/openclaw/memory-telemetry.jsonl (live instrumentation)
 *   - Gateway logs (fallback for graph-memory)
 * 
 * Usage:
 *   node memory-telemetry.js report          # Show aggregate stats
 *   node memory-telemetry.js tail            # Watch live
 *   node memory-telemetry.js benchmark       # Run golden query set
 */

const fs = require('fs');
const path = require('path');

const TELEMETRY_FILE = '/tmp/openclaw/memory-telemetry.jsonl';

// Golden query set — known-good queries with expected behavior
const GOLDEN_QUERIES = [
    { query: 'Janna birthday', expectSystem: 'graph', expectEntity: 'Janna' },
    { query: 'graph memory architecture decisions', expectSystem: 'continuity', minResults: 1 },
    { query: 'Microdose Tracker tech stack', expectSystem: 'graph', expectEntity: 'Microdose Tracker' },
    { query: 'llama.cpp vs Ollama embeddings', expectSystem: 'continuity', minResults: 1 },
    { query: 'Carsten best friend Minden', expectSystem: 'graph', expectEntity: 'Carsten Bredemeier' },
    { query: 'blog publishing Wix API', expectSystem: 'continuity', minResults: 1 },
    { query: 'ClawSmith process model', expectSystem: 'graph', expectEntity: 'ClawSmith' },
    { query: 'psychedelic 5-MeO-DMT integration', expectSystem: 'graph', expectEntity: 'Adult in Training' },
    { query: 'Dan Verakis WordPress', expectSystem: 'graph', expectEntity: 'Dan Verakis' },
    { query: 'Home Assistant automation setup', expectSystem: 'continuity', minResults: 1 },
];

function report() {
    if (!fs.existsSync(TELEMETRY_FILE)) {
        console.log('No telemetry data yet. File: ' + TELEMETRY_FILE);
        return;
    }
    
    const lines = fs.readFileSync(TELEMETRY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    
    if (entries.length === 0) {
        console.log('No telemetry entries.');
        return;
    }
    
    // Group by system
    const systems = {};
    for (const e of entries) {
        const sys = e.system || 'unknown';
        if (!systems[sys]) systems[sys] = { latencies: [], distances: [], hits: 0, misses: 0, injected: 0 };
        systems[sys].latencies.push(e.latencyMs || 0);
        if (e.topDistance !== undefined && e.topDistance !== null) {
            systems[sys].distances.push(e.topDistance);
        }
        if (e.resultCount > 0) systems[sys].hits++;
        else systems[sys].misses++;
        if (e.injected) systems[sys].injected++;
    }
    
    console.log(`\n=== Memory Search Telemetry (${entries.length} queries) ===\n`);
    console.log(`${'System'.padEnd(20)} | ${'Queries'.padStart(7)} | ${'Hits'.padStart(5)} | ${'Miss'.padStart(5)} | ${'Inject'.padStart(6)} | ${'p50ms'.padStart(6)} | ${'p95ms'.padStart(6)} | ${'AvgDist'.padStart(7)}`);
    console.log('-'.repeat(85));
    
    for (const [sys, data] of Object.entries(systems).sort()) {
        const total = data.latencies.length;
        const sorted = [...data.latencies].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(total * 0.5)] || 0;
        const p95 = sorted[Math.floor(total * 0.95)] || 0;
        const avgDist = data.distances.length > 0 
            ? (data.distances.reduce((a, b) => a + b, 0) / data.distances.length).toFixed(3)
            : 'n/a';
        
        console.log(
            `${sys.padEnd(20)} | ${String(total).padStart(7)} | ${String(data.hits).padStart(5)} | ${String(data.misses).padStart(5)} | ${String(data.injected).padStart(6)} | ${String(p50).padStart(6)} | ${String(p95).padStart(6)} | ${String(avgDist).padStart(7)}`
        );
    }
    
    // Daily breakdown
    const byDay = {};
    for (const e of entries) {
        const day = (e.timestamp || '').substring(0, 10);
        if (!day) continue;
        if (!byDay[day]) byDay[day] = {};
        const sys = e.system || 'unknown';
        if (!byDay[day][sys]) byDay[day][sys] = { total: 0, injected: 0, latencies: [], distances: [] };
        byDay[day][sys].total++;
        if (e.injected) byDay[day][sys].injected++;
        if (e.latencyMs) byDay[day][sys].latencies.push(e.latencyMs);
        if (e.topDistance) byDay[day][sys].distances.push(e.topDistance);
    }
    
    if (Object.keys(byDay).length > 0) {
        console.log('\n--- Daily Breakdown by System ---');
        for (const [day, syss] of Object.entries(byDay).sort()) {
            console.log(`\n  ${day}:`);
            for (const [sys, data] of Object.entries(syss).sort()) {
                const avgLat = data.latencies.length > 0
                    ? (data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length).toFixed(0) + 'ms'
                    : 'n/a';
                const avgDist = data.distances.length > 0
                    ? (data.distances.reduce((a, b) => a + b, 0) / data.distances.length).toFixed(3)
                    : 'n/a';
                console.log(`    ${sys.padEnd(18)} | ${data.total} queries | ${data.injected} injected | avg ${avgLat} | avgDist ${avgDist}`);
            }
        }
    }

    // System comparison — which system contributes most
    console.log('\n--- System Contribution ---');
    const allSystems = Object.keys(systems).sort();
    const totalInjected = Object.values(systems).reduce((s, d) => s + d.injected, 0);
    for (const sys of allSystems) {
        const s = systems[sys];
        const pct = totalInjected > 0 ? ((s.injected / totalInjected) * 100).toFixed(0) : '0';
        const hitRate = s.latencies.length > 0 ? ((s.hits / s.latencies.length) * 100).toFixed(0) : '0';
        console.log(`  ${sys.padEnd(18)} | ${pct}% of injections | ${hitRate}% hit rate | ${s.hits} hits, ${s.misses} misses`);
    }
}


async function benchmark() {
    const { execSync } = require('child_process');
    
    console.log('=== Golden Query Benchmark ===\n');
    
    // Test graph search
    console.log('--- Graph Memory (facts.db) ---');
    let graphPass = 0;
    for (const gq of GOLDEN_QUERIES.filter(q => q.expectSystem === 'graph')) {
        try {
            const result = execSync(
                `python3 /home/coolmann/clawd/scripts/graph-search.py "${gq.query}" 2>/dev/null`,
                { timeout: 5000, encoding: 'utf8' }
            );
            const hasEntity = gq.expectEntity ? result.includes(gq.expectEntity) : true;
            const status = hasEntity ? '✅' : '❌';
            if (hasEntity) graphPass++;
            const firstLine = result.split('\n').find(l => l.trim()) || 'no results';
            console.log(`  ${status} "${gq.query}" → ${hasEntity ? 'found ' + gq.expectEntity : 'MISSED ' + gq.expectEntity}`);
        } catch (e) {
            console.log(`  ❌ "${gq.query}" → ERROR: ${e.message.substring(0, 60)}`);
        }
    }
    
    // Test continuity search
    console.log('\n--- Continuity (sqlite-vec 768d) ---');
    let contPass = 0;
    const contQueries = GOLDEN_QUERIES.filter(q => q.expectSystem === 'continuity');
    
    const searchScript = `
const Indexer = require('./storage/indexer');
const Searcher = require('./storage/searcher');
const path = require('path');
const dataDir = path.join(__dirname, 'data');
(async () => {
    const indexer = new Indexer({}, dataDir);
    await indexer.initialize();
    const searcher = new Searcher({}, dataDir, indexer.db);
    await searcher.initialize();
    const queries = ${JSON.stringify(contQueries.map(q => q.query))};
    const results = [];
    for (const q of queries) {
        const s = Date.now();
        const r = await searcher.search(q, 3);
        results.push({ query: q, latency: Date.now() - s, count: r.exchanges.length, topDist: r.exchanges[0]?.distance });
    }
    console.log(JSON.stringify(results));
    process.exit(0);
})();
`;
    
    try {
        const raw = execSync(
            `cd ~/.openclaw/extensions/openclaw-plugin-continuity && node -e '${searchScript.replace(/'/g, "'\\''")}'`,
            { timeout: 30000, encoding: 'utf8' }
        );
        // Find the JSON line (skip [Indexer] log lines)
        const jsonLine = raw.split('\n').find(l => l.startsWith('[{') || l.startsWith('[{"'));
        if (!jsonLine) {
            // Try last line
            const lastLine = raw.trim().split('\n').pop();
            var parsed = JSON.parse(lastLine);
        } else {
            var parsed = JSON.parse(jsonLine);
        }
        
        for (let i = 0; i < parsed.length; i++) {
            const r = parsed[i];
            const gq = contQueries[i];
            const pass = r.count >= (gq.minResults || 1);
            if (pass) contPass++;
            console.log(`  ${pass ? '✅' : '❌'} "${r.query}" → ${r.count} results, dist=${r.topDist?.toFixed(3) || 'n/a'}, ${r.latency}ms`);
        }
    } catch (e) {
        console.log(`  ❌ Continuity search failed: ${e.message.substring(0, 100)}`);
    }
    
    const totalTests = GOLDEN_QUERIES.length;
    const totalPass = graphPass + contPass;
    console.log(`\n=== Score: ${totalPass}/${totalTests} (${(totalPass/totalTests*100).toFixed(0)}%) ===`);
}

// CLI
const cmd = process.argv[2] || 'report';
if (cmd === 'report') report();
else if (cmd === 'benchmark') benchmark();
else if (cmd === 'tail') {
    console.log('Watching ' + TELEMETRY_FILE + '...');
    const { spawn } = require('child_process');
    spawn('tail', ['-f', TELEMETRY_FILE], { stdio: 'inherit' });
}
else console.log('Usage: node memory-telemetry.js [report|benchmark|tail]');
