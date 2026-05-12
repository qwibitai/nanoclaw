import { marked } from 'marked';

// `marked` defaults: GFM enabled, raw HTML in source escaped (safe-by-default
// for our content shape — agents can produce arbitrary text but cannot inject
// raw HTML through the markdown source without it being escaped to entities).
marked.setOptions({
  gfm: true,
  breaks: true, // single newline → <br>; matches Slack/Discord visual rhythm
});

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}
