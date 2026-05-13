#!/usr/bin/env node
// aggregate.mjs — combine all audit tool outputs into one LLM-optimized
// Markdown report. Designed so an agent can paste the result back to a user
// without further reformatting.

import { readFileSync } from "node:fs";
import { argv } from "node:process";

function arg(name, fallback = null) {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
}
function flag(name) {
    return argv.includes(name);
}

const url = arg("--url");
const lhPath = arg("--lighthouse");
const axePath = arg("--axe");
const linkPath = arg("--linkinator");
const headersPath = arg("--headers");
const metaPath = arg("--meta");
const robotsStatus = parseInt(arg("--robots-status", "0"), 10);
const sitemapStatus = parseInt(arg("--sitemap-status", "0"), 10);
const quick = flag("--quick");

function readJson(p, fallback = null) {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return fallback;
    }
}
function readText(p) {
    try {
        return readFileSync(p, "utf8");
    } catch {
        return "";
    }
}

const lh = readJson(lhPath, null);
const axe = readJson(axePath, []);
const link = readJson(linkPath, { links: [] });
const meta = readJson(metaPath, {});
const headersTxt = readText(headersPath);

// ---- Lighthouse scores -----------------------------------------------------
function lhScore(cat) {
    const c = lh?.categories?.[cat];
    if (!c || c.score == null) return null;
    return Math.round(c.score * 100);
}
const scores = {
    performance: lhScore("performance"),
    accessibility: lhScore("accessibility"),
    seo: lhScore("seo"),
    "best-practices": lhScore("best-practices"),
};
const validScores = Object.values(scores).filter((s) => s != null);
const composite = validScores.length
    ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
    : null;

// Core Web Vitals from Lighthouse audits
function audit(id) {
    return lh?.audits?.[id];
}
function val(id) {
    return audit(id)?.displayValue ?? audit(id)?.numericValue ?? "n/a";
}
const cwv = {
    LCP: val("largest-contentful-paint"),
    INP: val("interaction-to-next-paint"),
    CLS: val("cumulative-layout-shift"),
    FCP: val("first-contentful-paint"),
    TBT: val("total-blocking-time"),
    SI: val("speed-index"),
};

// ---- Security headers ------------------------------------------------------
function hasHeader(name) {
    const re = new RegExp(`^${name}\\s*:`, "im");
    const m = headersTxt.match(re);
    if (!m) return null;
    const line = headersTxt.split("\n").find((l) => re.test(l));
    return line ? line.split(":").slice(1).join(":").trim() : "(empty)";
}
const securityHeaders = {
    "Strict-Transport-Security": hasHeader("Strict-Transport-Security"),
    "Content-Security-Policy": hasHeader("Content-Security-Policy"),
    "X-Frame-Options": hasHeader("X-Frame-Options"),
    "Referrer-Policy": hasHeader("Referrer-Policy"),
    "X-Content-Type-Options": hasHeader("X-Content-Type-Options"),
    "Permissions-Policy": hasHeader("Permissions-Policy"),
};
const missingHeaders = Object.entries(securityHeaders)
    .filter(([_, v]) => v == null)
    .map(([k]) => k);

// HTTPS / mixed content check from Lighthouse
const httpsAudit = audit("is-on-https");
const mixedContent = httpsAudit?.score === 1 ? "ok" : (httpsAudit?.displayValue || "issue detected");

// ---- axe violations --------------------------------------------------------
// axe-cli output is an array of result objects (one per URL audited); each
// has .violations[]. Bucket by impact.
const axeViolations = (Array.isArray(axe) ? axe : []).flatMap((r) => r.violations ?? []);
const axeByImpact = { critical: [], serious: [], moderate: [], minor: [] };
for (const v of axeViolations) {
    const bucket = axeByImpact[v.impact] ?? axeByImpact.minor;
    bucket.push({
        id: v.id,
        help: v.help,
        count: v.nodes?.length ?? 0,
        helpUrl: v.helpUrl,
    });
}

// ---- linkinator broken-link summary ----------------------------------------
const links = link.links ?? [];
const broken = links.filter((l) => l.state === "BROKEN");
const internalBroken = broken.filter((l) => {
    try {
        return new URL(l.url).host === new URL(url).host;
    } catch {
        return false;
    }
});
const externalBroken = broken.filter((l) => !internalBroken.includes(l));

// ---- Recommendations -------------------------------------------------------
const recommendations = [];

function rec(priority, area, fix) {
    recommendations.push({ priority, area, fix });
}

if (scores.performance != null && scores.performance < 70) {
    rec("high", "Performance", `Lighthouse perf score ${scores.performance}/100. Check LCP=${cwv.LCP}, TBT=${cwv.TBT}. Common fixes: optimize images, defer JS, reduce server response time.`);
}
if (scores.accessibility != null && scores.accessibility < 90) {
    rec("high", "Accessibility", `Lighthouse a11y score ${scores.accessibility}/100. Address axe-core critical/serious violations first.`);
}
if (axeByImpact.critical.length > 0) {
    rec("high", "Accessibility", `${axeByImpact.critical.length} critical axe violations: ${axeByImpact.critical.slice(0, 3).map((v) => v.id).join(", ")}.`);
}
if (scores.seo != null && scores.seo < 90) {
    rec("medium", "SEO", `Lighthouse SEO score ${scores.seo}/100. Review meta tags and crawlability audits below.`);
}
for (const issue of meta.issues ?? []) {
    rec("medium", "SEO/Meta", issue);
}
if (robotsStatus !== 200) {
    rec("medium", "Crawlability", `robots.txt returned ${robotsStatus}. Add one at /robots.txt or fix the response.`);
}
if (sitemapStatus !== 200) {
    rec("low", "Crawlability", `sitemap.xml returned ${sitemapStatus}. Add one at /sitemap.xml for better indexing.`);
}
if (missingHeaders.length > 0) {
    rec("medium", "Security headers", `Missing: ${missingHeaders.join(", ")}.`);
}
if (internalBroken.length > 0) {
    rec("high", "Broken links", `${internalBroken.length} broken internal links. Fix or remove.`);
}
if (externalBroken.length > 5) {
    rec("low", "Broken links", `${externalBroken.length} broken external links. Consider updating or removing.`);
}
if (mixedContent !== "ok") {
    rec("high", "Security", `Mixed content / non-HTTPS resources detected.`);
}

// ---- Render Markdown -------------------------------------------------------
function fmtScore(s) {
    if (s == null) return "n/a";
    const emoji = s >= 90 ? "🟢" : s >= 70 ? "🟡" : "🔴";
    return `${emoji} ${s}/100`;
}

const out = [];
out.push(`# Website Audit: ${url}`);
out.push("");
out.push(`Composite health score: **${composite ?? "n/a"}/100**${quick ? " *(quick mode — axe and link-check skipped)*" : ""}`);
out.push("");
out.push("## Scorecard");
out.push("");
out.push("| Category | Score |");
out.push("| --- | --- |");
out.push(`| Performance | ${fmtScore(scores.performance)} |`);
out.push(`| Accessibility | ${fmtScore(scores.accessibility)} |`);
out.push(`| SEO | ${fmtScore(scores.seo)} |`);
out.push(`| Best Practices | ${fmtScore(scores["best-practices"])} |`);
out.push("");

out.push("## Performance");
out.push("");
out.push("Core Web Vitals (mobile Lighthouse simulation):");
out.push("");
out.push(`- **LCP** (Largest Contentful Paint): ${cwv.LCP}`);
out.push(`- **INP** (Interaction to Next Paint): ${cwv.INP}`);
out.push(`- **CLS** (Cumulative Layout Shift): ${cwv.CLS}`);
out.push(`- FCP: ${cwv.FCP} · TBT: ${cwv.TBT} · Speed Index: ${cwv.SI}`);
out.push("");

out.push("## SEO");
out.push("");
out.push(`- Title: ${meta.title ? `"${meta.title.value}" (${meta.title.length} chars)` : "**missing**"}`);
out.push(`- Description: ${meta.description ? `"${meta.description.value}" (${meta.description.length} chars)` : "**missing**"}`);
out.push(`- Canonical: ${meta.canonical ?? "**missing**"}`);
out.push(`- Viewport meta: ${meta.viewport ?? "**missing**"}`);
out.push(`- Robots meta: ${meta.robotsMeta ?? "(none — defaults to index,follow)"}`);
out.push(`- robots.txt: HTTP ${robotsStatus}`);
out.push(`- sitemap.xml: HTTP ${sitemapStatus}`);
out.push(`- JSON-LD blocks: ${meta.jsonLd?.length ?? 0}${meta.jsonLd?.length ? ` (${meta.jsonLd.map((j) => j.type || "?").join(", ")})` : ""}`);
out.push("");
out.push("OpenGraph / Twitter:");
out.push("");
out.push("| Tag | Value |");
out.push("| --- | --- |");
for (const [k, v] of Object.entries(meta.og ?? {})) out.push(`| og:${k} | ${v ?? "**missing**"} |`);
for (const [k, v] of Object.entries(meta.twitter ?? {})) out.push(`| twitter:${k} | ${v ?? "**missing**"} |`);
out.push("");

out.push("## Accessibility");
out.push("");
if (quick) {
    out.push("*Skipped axe-core in --quick mode. Lighthouse a11y score above is the only signal.*");
} else if (axeViolations.length === 0) {
    out.push("No axe-core violations detected.");
} else {
    out.push(`axe-core found **${axeViolations.length}** violation rule(s) across ${axeViolations.reduce((s, v) => s + (v.nodes?.length ?? 0), 0)} node(s).`);
    out.push("");
    for (const impact of ["critical", "serious", "moderate", "minor"]) {
        const list = axeByImpact[impact];
        if (!list.length) continue;
        out.push(`**${impact.toUpperCase()}** (${list.length})`);
        out.push("");
        for (const v of list) {
            out.push(`- \`${v.id}\` — ${v.help} (${v.count} node${v.count === 1 ? "" : "s"}) [docs](${v.helpUrl})`);
        }
        out.push("");
    }
}

out.push("## Security & Best Practices");
out.push("");
out.push(`- HTTPS / mixed content: ${mixedContent}`);
out.push("");
out.push("Response headers:");
out.push("");
out.push("| Header | Value |");
out.push("| --- | --- |");
for (const [k, v] of Object.entries(securityHeaders)) {
    out.push(`| ${k} | ${v ?? "**missing**"} |`);
}
out.push("");

out.push("## Broken Links");
out.push("");
if (quick) {
    out.push("*Skipped linkinator in --quick mode.*");
} else if (broken.length === 0) {
    out.push(`Scanned ${links.length} link(s). None broken.`);
} else {
    out.push(`Scanned ${links.length} link(s). **${broken.length} broken** (${internalBroken.length} internal, ${externalBroken.length} external).`);
    out.push("");
    const sample = broken.slice(0, 20);
    out.push("| Status | URL | Parent |");
    out.push("| --- | --- | --- |");
    for (const l of sample) {
        out.push(`| ${l.status ?? "?"} | ${l.url} | ${l.parent ?? ""} |`);
    }
    if (broken.length > 20) out.push(`| … | _${broken.length - 20} more_ | |`);
}
out.push("");

out.push("## Top Recommendations");
out.push("");
if (recommendations.length === 0) {
    out.push("No major issues detected. Nice work.");
} else {
    const order = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => order[a.priority] - order[b.priority]);
    for (const r of recommendations) {
        out.push(`- **[${r.priority}] ${r.area}** — ${r.fix}`);
    }
}
out.push("");

console.log(out.join("\n"));
