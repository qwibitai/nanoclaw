/**
 * MCP tool: transcribe audio files.
 *
 * Wraps the core transcribeAudio() function as an explicit tool so agents can:
 *   - Transcribe arbitrary files outside the auto-injection inbound flow
 *   - Override the default fallback/approval policy from env vars
 *   - Access the raw result (source, durationMs, model) for disclosure to the user
 *
 * Auto-injection in the poll loop is the default UX — this tool is for
 * advanced cases where the agent needs explicit control.
 */
import { transcribeAudio } from '../transcription.js';
import { registerTools } from './server.js';

registerTools([
  {
    tool: {
      name: 'transcribe',
      description:
        'Transcribe an audio file to text. Uses local Whisper by default (sovereign: audio stays on-device). ' +
        'Set allowFallback:true to permit OpenAI Whisper API when local is unavailable. ' +
        'Returns the transcript text plus the source (local-whisper or openai-fallback) for disclosure.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the audio file (e.g. /workspace/attachments/abc123)',
          },
          allowFallback: {
            type: 'boolean',
            description:
              'Allow OpenAI Whisper API fallback when local Whisper is unavailable. ' +
              'Default: WHISPER_OPENAI_FALLBACK env var (default false — local-only).',
          },
          requireApproval: {
            type: 'boolean',
            description:
              'When true, throw rather than silently calling OpenAI — use this to surface the decision to the user. ' +
              'Default: WHISPER_REQUIRE_APPROVAL env var (default false).',
          },
        },
        required: ['filePath'],
      },
    },
    async handler(args) {
      const { filePath, allowFallback, requireApproval } = args as {
        filePath: string;
        allowFallback?: boolean;
        requireApproval?: boolean;
      };

      try {
        const result = await transcribeAudio(filePath, { allowFallback, requireApproval });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  },
]);
