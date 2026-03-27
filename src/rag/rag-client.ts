import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RagConfig {
  workingDir: string;
  vaultDir: string;
  pythonBin?: string;
}

export interface RagResult {
  answer: string;
  sources: string[];
}

export class RagClient {
  constructor(private config: RagConfig) {}

  buildQuery(query: string, filters?: Record<string, string>): string {
    let enriched = query;
    if (filters) {
      const filterStr = Object.entries(filters)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      enriched = `[Context: ${filterStr}] ${query}`;
    }
    return enriched;
  }

  async query(
    question: string,
    mode: 'naive' | 'local' | 'global' | 'hybrid' = 'hybrid',
    filters?: Record<string, string>,
  ): Promise<RagResult> {
    const enrichedQuery = this.buildQuery(question, filters);
    try {
      const { stdout } = await execFileAsync(
        this.config.pythonBin || 'python3',
        [
          '-c',
          `
import json
from lightrag import LightRAG, QueryParam
rag = LightRAG(working_dir="${this.config.workingDir}")
result = rag.query("${enrichedQuery.replace(/"/g, '\\"')}", param=QueryParam(mode="${mode}"))
print(json.dumps({"answer": result, "sources": []}))
`,
        ],
        { timeout: 60_000 },
      );
      return JSON.parse(stdout.trim()) as RagResult;
    } catch {
      return {
        answer: `RAG query failed. Falling back to general knowledge. Original question: ${question}`,
        sources: [],
      };
    }
  }

  async index(text: string): Promise<void> {
    await execFileAsync(
      this.config.pythonBin || 'python3',
      [
        '-c',
        `
from lightrag import LightRAG
rag = LightRAG(working_dir="${this.config.workingDir}")
rag.insert("""${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}""")
print("indexed")
`,
      ],
      { timeout: 120_000 },
    );
  }
}
