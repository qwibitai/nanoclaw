/**
 * Academic literature API wrappers.
 * Semantic Scholar + OpenAlex → normalized Paper type.
 */

export interface Paper {
  source: 'semantic_scholar' | 'openalex' | 'zotero';
  sourceId: string;
  title: string;
  authors: string[];
  venue: string;
  year: number;
  abstract: string;
  url: string;
}

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const S2_FIELDS = 'paperId,title,authors,venue,year,abstract,url';

export async function searchSemanticScholar(
  query: string,
  limit = 10,
): Promise<Paper[]> {
  try {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
      fields: S2_FIELDS,
    });
    const res = await fetch(`${S2_BASE}/paper/search?${params}`);
    if (!res.ok) return [];

    const data = (await res.json()) as { data?: Record<string, unknown>[] };
    return (data.data || []).map((p: Record<string, unknown>) => ({
      source: 'semantic_scholar' as const,
      sourceId: p.paperId as string,
      title: p.title as string,
      authors: ((p.authors as { name: string }[]) || []).map((a) => a.name),
      venue: (p.venue as string) || '',
      year: (p.year as number) || 0,
      abstract: (p.abstract as string) || '',
      url: (p.url as string) || '',
    }));
  } catch {
    return [];
  }
}

/**
 * OpenAlex stores abstracts as inverted indices.
 * { "We": [0], "study": [1], "platforms": [2] } → "We study platforms"
 */
function invertedIndexToText(index: Record<string, number[]> | null): string {
  if (!index) return '';
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) {
      words.push([word, pos]);
    }
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(' ');
}

const OA_BASE = 'https://api.openalex.org';

export async function searchOpenAlex(
  query: string,
  limit = 10,
): Promise<Paper[]> {
  try {
    const params = new URLSearchParams({
      search: query,
      per_page: String(limit),
    });
    const res = await fetch(`${OA_BASE}/works?${params}`);
    if (!res.ok) return [];

    const data = (await res.json()) as { results?: Record<string, unknown>[] };
    return (data.results || []).map((w: Record<string, unknown>) => {
      const authorships =
        (w.authorships as { author: { display_name: string } }[]) || [];
      const primaryLocation = w.primary_location as {
        source?: { display_name?: string };
      } | null;
      const oaId = (w.id as string) || '';

      return {
        source: 'openalex' as const,
        sourceId: oaId.replace('https://openalex.org/', ''),
        title: (w.title as string) || '',
        authors: authorships.map((a) => a.author.display_name),
        venue: primaryLocation?.source?.display_name || '',
        year: (w.publication_year as number) || 0,
        abstract: invertedIndexToText(
          w.abstract_inverted_index as Record<string, number[]> | null,
        ),
        url: (w.doi as string) || oaId,
      };
    });
  } catch {
    return [];
  }
}
