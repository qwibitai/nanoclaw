#!/usr/bin/env node
// meta-check.mjs — fetch a URL and extract SEO-relevant <head> info.
//
// Output (stdout, JSON):
// {
//   status, finalUrl,
//   title: { value, length },
//   description: { value, length },
//   canonical,
//   viewport, robotsMeta,
//   og: { title, description, image, url, type },
//   twitter: { card, title, description, image },
//   jsonLd: [ { type, raw } ],
//   issues: [ "missing canonical", ... ]
// }
//
// Uses regex parsing — no DOM dependency, so it works on any Node ≥18.

import { argv } from "node:process";

const url = argv[2];
if (!url) {
    console.error("usage: meta-check.mjs <url>");
    process.exit(2);
}

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 15000);

let res, body;
try {
    res = await fetch(url, {
        redirect: "follow",
        signal: ac.signal,
        headers: {
            // Identify as a real browser so anti-bot WAFs don't 403 the audit.
            "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) NanoClaw-Audit/1.0",
        },
    });
    body = await res.text();
} catch (err) {
    console.log(JSON.stringify({ error: String(err.message || err), url }));
    process.exit(0);
} finally {
    clearTimeout(timer);
}

const head = body.split(/<\/head>/i)[0] ?? body;

function getTag(re) {
    const m = head.match(re);
    return m ? m[1].trim() : null;
}
function getAttr(tagRe, attr) {
    const m = head.match(tagRe);
    if (!m) return null;
    const tag = m[0];
    const a = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
    return a ? a[1].trim() : null;
}
function getMeta(name) {
    const re = new RegExp(
        `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`,
        "i",
    );
    return getAttr(re, "content");
}

const title = getTag(/<title[^>]*>([^<]*)<\/title>/i);
const description = getMeta("description");
const canonical = (() => {
    const m = head.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i);
    if (!m) return null;
    const a = m[0].match(/href\s*=\s*["']([^"']*)["']/i);
    return a ? a[1] : null;
})();
const viewport = getMeta("viewport");
const robotsMeta = getMeta("robots");

const og = {
    title: getMeta("og:title"),
    description: getMeta("og:description"),
    image: getMeta("og:image"),
    url: getMeta("og:url"),
    type: getMeta("og:type"),
};
const twitter = {
    card: getMeta("twitter:card"),
    title: getMeta("twitter:title"),
    description: getMeta("twitter:description"),
    image: getMeta("twitter:image"),
};

// JSON-LD blocks
const jsonLd = [];
const jsonLdRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = jsonLdRe.exec(body))) {
    const raw = m[1].trim();
    let type = null;
    try {
        const parsed = JSON.parse(raw);
        type = Array.isArray(parsed)
            ? parsed.map((x) => x["@type"]).filter(Boolean).join(",")
            : parsed["@type"] ?? null;
    } catch {
        type = "<unparseable>";
    }
    jsonLd.push({ type, length: raw.length });
}

const issues = [];
if (!title) issues.push("missing <title>");
else if (title.length < 20) issues.push(`title too short (${title.length} chars)`);
else if (title.length > 70) issues.push(`title too long (${title.length} chars)`);
if (!description) issues.push("missing meta description");
else if (description.length < 70) issues.push(`description too short (${description.length} chars)`);
else if (description.length > 160) issues.push(`description too long (${description.length} chars)`);
if (!canonical) issues.push("missing canonical link");
if (!viewport) issues.push("missing viewport meta (mobile rendering)");
if (!og.title || !og.description || !og.image) issues.push("incomplete OpenGraph (need og:title, og:description, og:image)");
if (!twitter.card) issues.push("missing twitter:card");
if (jsonLd.length === 0) issues.push("no JSON-LD structured data");

console.log(
    JSON.stringify(
        {
            status: res.status,
            finalUrl: res.url,
            title: title ? { value: title, length: title.length } : null,
            description: description
                ? { value: description, length: description.length }
                : null,
            canonical,
            viewport,
            robotsMeta,
            og,
            twitter,
            jsonLd,
            issues,
        },
        null,
        2,
    ),
);
