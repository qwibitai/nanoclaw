import matter from 'gray-matter';

export interface ParsedNote {
  data: Record<string, unknown>;
  content: string;
}

export function parseFrontmatter(markdown: string): ParsedNote {
  const result = matter(markdown);
  return { data: result.data, content: result.content.trim() };
}

export function serializeFrontmatter(
  data: Record<string, unknown>,
  content: string,
): string {
  return matter.stringify(content, data);
}

export function updateFrontmatter(
  markdown: string,
  updates: Record<string, unknown>,
): string {
  const { data, content } = parseFrontmatter(markdown);
  const merged = { ...data, ...updates };
  return serializeFrontmatter(merged, content);
}
