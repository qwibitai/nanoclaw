---
name: research-assistant
description: Conducts structured research on agricultural technology topics, producing summaries with citations from academic papers, documentation, and web sources.
---

## Purpose

Accept a research question or topic, decompose it into sub-questions, gather evidence from multiple sources, and produce a structured report with citations and confidence assessments.

## Domain specialisation

This skill has deep context in the following areas. Prioritise sources within these domains:

- Soil carbon measurement and sequestration
- Remote sensing: Sentinel-2 multispectral imagery, Synthetic Aperture Radar (SAR)
- Crop classification and mapping
- Farmland utilisation analysis
- Digital Soil Mapping (DSM)
- Agricultural machine learning and geospatial modelling

## Step-by-step instructions

### 1. Decompose the question

Break the input question into 3–6 distinct sub-questions that together cover the full scope of the topic. Write these out explicitly before starting any searches.

Example: for "How accurate is Sentinel-2 for soil organic carbon estimation?" the sub-questions might be:
- What spectral bands in Sentinel-2 correlate with soil organic carbon?
- What machine learning methods have been applied to SOC estimation from Sentinel-2?
- What accuracy metrics have been reported in peer-reviewed literature?
- What are the known limitations (cloud cover, soil moisture effects)?

### 2. Search for sources

For each sub-question, gather sources from the following channels. Use the most targeted query possible.

Define a helper to URL-encode queries (used in all search commands below):

```bash
urlencode() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }
```

#### arXiv papers

```bash
curl -s "https://export.arxiv.org/api/query?search_query=all:$(urlencode "$QUERY")&max_results=5&sortBy=relevance" \
  | python3 -c "
import sys, xml.etree.ElementTree as ET
ns = {'a': 'http://www.w3.org/2005/Atom'}
root = ET.parse(sys.stdin).getroot()
for entry in root.findall('a:entry', ns):
    print(entry.find('a:id', ns).text)
    print(entry.find('a:title', ns).text.strip())
    print(entry.find('a:summary', ns).text.strip()[:300])
    print('---')
"
```

#### GitHub repositories

```bash
curl -s \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=$(urlencode "$QUERY")+org:sagri-tokyo&sort=updated&per_page=5" \
  | jq '[.items[] | {name, description, html_url, stargazers_count, updated_at}]'
```

Also search the broader GitHub corpus for relevant open-source tools or datasets:

```bash
curl -s \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/search/repositories?q=$(urlencode "$QUERY")&sort=stars&per_page=5" \
  | jq '[.items[] | {name, full_name, description, html_url, stargazers_count}]'
```

#### Web sources

Use curl to fetch content from authoritative sources in the domain:

- ESA Sentinel Online: `https://sentinel.esa.int`
- FAO GAEZ: `https://www.fao.org/gaez`
- ISRIC World Soil Information: `https://www.isric.org`
- Google Earth Engine documentation: `https://developers.google.com/earth-engine`

```bash
curl -sL --max-time 15 "$URL" | python3 -c "
import sys, html.parser

class TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.result = []
        self._skip_depth = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'nav', 'footer'):
            self._skip_depth += 1
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav', 'footer'):
            self._skip_depth -= 1
    def handle_data(self, data):
        if self._skip_depth == 0:
            self.result.append(data)

p = TextExtractor()
p.feed(sys.stdin.read())
print(' '.join(p.result)[:3000])
"
```

### 3. Extract key findings per source

For each source, extract:
- The core claim or finding relevant to the sub-question
- Supporting evidence (metrics, dataset names, methodology notes)
- Any stated limitations or caveats
- The full URL for citation

Do not paraphrase in ways that alter the meaning. Where a paper states a specific accuracy figure (e.g. R² = 0.82), reproduce it verbatim.

### 4. Assess confidence per finding

Assign a confidence level to each finding:

- **High**: Finding is supported by peer-reviewed publication or official documentation, with a reproducible methodology and a sample size sufficient for the claim.
- **Medium**: Finding is from a credible source but either lacks a reproducible methodology, has a small sample size, or is contradicted by at least one other source.
- **Low**: Finding is from a single non-peer-reviewed source, or the claim is speculative, undated, or unsupported by data.

State confidence explicitly alongside each finding. If confidence is Low, add a note explaining why.

### 5. Format the output report

```
# Research Report: <topic>
Date: <ISO date>

## Executive Summary
<3–5 sentences covering the most important findings and their practical implications for Sagri.>

## Key Findings
- <Finding 1> [Confidence: High] — Source: [<title>](<url>)
- <Finding 2> [Confidence: Medium] — Source: [<title>](<url>)
- <Finding 3> [Confidence: Low — single source, no replication] — Source: [<title>](<url>)

## Detailed Analysis

### Sub-question 1: <text>
<Analysis paragraph with inline citations.>

### Sub-question 2: <text>
<Analysis paragraph with inline citations.>

(repeat for each sub-question)

## Sources
1. [<title>](<url>) — <one-line description>
2. [<title>](<url>) — <one-line description>
…

## Recommended Next Steps
- <Concrete action Sagri could take based on the findings>
- <Follow-up research question worth investigating>
```

## Hard constraints

- Wait at least 3 seconds between consecutive arXiv API requests (`sleep 3`) to comply with arXiv's rate limit policy.
- Never fabricate a citation. If a source cannot be fetched, note the fetch failure and exclude it from the findings rather than inventing content.
- Never omit a Low-confidence label to make findings appear stronger than they are.
- Cite every factual claim with a URL. Claims without a URL are not findings — they are hypotheses and must be labelled as such.
- If fewer than 3 credible sources are found for a sub-question, state this explicitly and do not produce a finding for that sub-question.
