---
name: cs-rankings
description: Query computer science university rankings from CSRankings.org — publication counts, global rank, by conference and country. Use whenever the user asks about CS university rankings, publication metrics, or academic conference standings.
allowed-tools: Bash(csrankings-query:*)
---

# CS Rankings Query

## Quick start

```bash
csrankings-query "Stanford" --conferences=NeurIPS,ICML,ICLR
csrankings-query "MIT" --conferences=POPL,PLDI --json
csrankings-query "ETH Zurich" --conferences=ICML,NeurIPS --country=CH
```

## Usage

```
csrankings-query <university_name> --conferences=<CONF1,CONF2,...> [options]
```

### Required arguments

| Argument | Description |
|----------|-------------|
| `university_name` | Free-text name (fuzzy-matched against CSRankings database) |
| `--conferences` | Comma-separated conference shorthands (e.g., `NeurIPS,ICML,ICLR,POPL`) |

### Optional arguments

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | flag | off | Output JSON instead of plain text |
| `--country` | string | all | Filter by country (ISO alpha-2 code or name, e.g., `US`, `CH`, `Germany`) |
| `--max-matches` | integer | unlimited | Fail if more than N institutions match (ambiguity guard) |
| `--threshold` | float | 50 | Minimum fuzzy match score (0-100) |
| `--refresh` | flag | off | Bypass cache, fetch fresh data from CSRankings |

## Examples

### Basic lookup

```bash
csrankings-query "Carnegie Mellon" --conferences=NeurIPS,ICML,ICLR
```

### JSON output for structured processing

```bash
csrankings-query "Berkeley" --conferences=ICML,NeurIPS --json
```

### Filter by country

```bash
csrankings-query "Technical University" --conferences=ICML,NeurIPS --country=DE
```

### Strict matching (fail if ambiguous)

```bash
csrankings-query "MIT" --conferences=POPL --max-matches=1
```

### Force fresh data

```bash
csrankings-query "Stanford" --conferences=NeurIPS --refresh
```

## Common conference shorthands

### AI / Machine Learning
`NeurIPS`, `ICML`, `ICLR`, `AAAI`, `IJCAI`

### Systems
`SOSP`, `OSDI`, `NSDI`, `EuroSys`, `ASPLOS`

### Programming Languages
`POPL`, `PLDI`, `OOPSLA`, `ICFP`

### Security
`CCS`, `Oakland` (IEEE S&P), `USENIX Security`, `NDSS`

### Databases
`SIGMOD`, `VLDB`, `ICDE`

### Theory
`STOC`, `FOCS`

### Networking
`SIGCOMM`, `NSDI`, `IMC`

### HCI
`CHI`, `UIST`

### Computer Vision
`CVPR`, `ICCV`, `ECCV`

### NLP
`ACL`, `EMNLP`, `NAACL`

## Notes

- **Always cite the source**: mention that rankings are from [CSRankings.org](https://csrankings.org/) in your response.
- **Always use `--max-matches=5`** to catch ambiguous matches. The tool fuzzy-matches university names, so short or common queries (e.g., "MIT", "Technical University") may match multiple institutions. With `--max-matches=5`, the tool returns up to 5 matches — review them and clarify with the user if the intended institution is ambiguous.
- Results show publication counts adjusted by author count (fractional counting).
- The tool caches data for 24 hours. Use `--refresh` to force fresh data.
- Low-confidence matches (score < 80) produce a warning.
