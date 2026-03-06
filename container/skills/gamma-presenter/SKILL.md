---
name: gamma-presenter
description: Create AI-powered presentations, documents, webpages, and social posts using the Gamma API. Use when the user asks to create a presentation, deck, slides, document, or any visual content.
allowed-tools: Bash(gamma-presenter:*)
---

# Gamma Presenter

Create professional presentations, documents, webpages, and social posts using the Gamma API.

## Quick Start

```bash
gamma-presenter create "Your topic or content"
```

## Commands

```bash
gamma-presenter create "Topic" [options]   # Create presentation
gamma-presenter status <generationId>      # Check generation status
gamma-presenter themes [search]            # Browse available themes
gamma-presenter folders [search]           # List folders
gamma-presenter help                       # Show help
```

## Create Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `--format` | presentation, document, webpage, social | presentation | Output format |
| `--cards` | 1-60 | 10 | Number of cards/slides |
| `--theme` | theme ID | auto | Use `themes` command to find IDs |
| `--tone` | free text | auto | e.g. "professional, upbeat" |
| `--audience` | free text | auto | e.g. "investors", "students" |
| `--language` | ISO code | en | e.g. "it", "es", "de", "fr" |
| `--images` | aiGenerated, pexels, noImages | aiGenerated | Image source |
| `--image-model` | see models below | flux-1-quick | AI image model |
| `--image-style` | free text | auto | e.g. "minimal, corporate" |
| `--text-amount` | brief, medium, detailed, extensive | medium | Text density |
| `--text-mode` | generate, condense, preserve | generate | How to process input |
| `--export` | pdf, pptx | none | Also export file |
| `--instructions` | free text | none | Extra AI guidance |
| `--no-wait` | flag | wait | Don't poll, return ID only |

## Image Models (by credit cost)

**Basic (2 credits):** `flux-1-quick`, `flux-kontext-fast`, `imagen-3-flash`
**Advanced (8-15 credits):** `flux-1-pro`, `imagen-3-pro`, `ideogram-v3-turbo`, `leonardo-phoenix`
**Premium (20-30 credits):** `flux-kontext-pro`, `ideogram-v3`, `imagen-4-pro`, `recraft-v3`, `gpt-image-1-medium`

## Examples

### Business presentation
```bash
gamma-presenter create "Q4 2025 Revenue Report: 15% YoY growth, new markets in APAC, product launches" \
  --cards 15 --tone "professional, data-driven" --audience "board of directors" \
  --images aiGenerated --image-style "corporate, minimal, dark blue"
```

### Italian document
```bash
gamma-presenter create "Guida al Machine Learning per principianti" \
  --format document --language it --cards 20 --text-amount detailed
```

### Social media post
```bash
gamma-presenter create "5 AI Trends for 2026" \
  --format social --cards 5 --tone "engaging, visual" \
  --images aiGenerated --image-model ideogram-v3-turbo
```

### From detailed content (preserve mode)
```bash
gamma-presenter create "$(cat my_content.md)" \
  --text-mode preserve --cards 12 --export pptx
```

### Quick theme search + create
```bash
gamma-presenter themes professional
# Pick a theme ID from the list, then:
gamma-presenter create "AI Strategy 2026" --theme abc123def
```

## Tips

1. **generate** mode works best with brief topics — AI expands them
2. **condense** mode works best with long text — AI summarizes
3. **preserve** mode keeps your exact text, just adds structure
4. Use `\n---\n` in input text to force card breaks
5. Include image URLs in input text and they'll be placed inline
6. The `--instructions` flag is great for specific layout requests
7. Generation typically takes 30-90 seconds depending on complexity
