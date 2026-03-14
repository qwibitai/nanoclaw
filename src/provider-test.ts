/**
 * Multi-Provider AI Tester
 * Usage: npx tsx src/provider-test.ts
 * Opens at http://localhost:3002
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3002;
const ENV_PATH = path.join(__dirname, '..', '.env');

app.use(express.json());

// Provider key → .env variable name
const ENV_VAR_NAMES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  cohere: 'COHERE_API_KEY',
  together: 'TOGETHER_API_KEY',
};

function readEnvKey(provider: string): string {
  const varName = ENV_VAR_NAMES[provider];
  if (!varName) return '';
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const match = content.match(new RegExp('^' + varName + '=(.*)$', 'm'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

interface ProviderConfig {
  name: string;
  defaultModel: string;
  testFn: (apiKey: string, message: string, model: string) => Promise<Response>;
  extractText: (body: any) => string;
}

const providers: Record<string, ProviderConfig> = {
  anthropic: {
    name: 'Anthropic',
    defaultModel: 'claude-3-5-haiku-20241022',
    extractText: (b) => b?.content?.[0]?.text ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 256,
          messages: [{ role: 'user', content: message || 'Say OK' }],
        }),
      }),
  },
  openai: {
    name: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  xai: {
    name: 'xAI (Grok)',
    defaultModel: 'grok-beta',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  google: {
    name: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    extractText: (b) => b?.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    testFn: (apiKey, message, model) =>
      fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          model +
          ':generateContent?key=' +
          apiKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: message || 'Say OK' }] }],
          }),
        },
      ),
  },
  deepseek: {
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  fireworks: {
    name: 'Fireworks AI',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  nvidia: {
    name: 'NVIDIA NIM',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  groq: {
    name: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  cohere: {
    name: 'Cohere',
    defaultModel: 'command-r-plus',
    extractText: (b) => b?.message?.content?.[0]?.text ?? b?.text ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.cohere.com/v2/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
        }),
      }),
  },
  together: {
    name: 'Together AI',
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
    extractText: (b) => b?.choices?.[0]?.message?.content ?? '',
    testFn: (apiKey, message, model) =>
      fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          max_tokens: 256,
        }),
      }),
  },
  ollama: {
    name: 'Ollama (Local)',
    defaultModel: 'llama3.2',
    extractText: (b) => b?.message?.content ?? '',
    testFn: (_apiKey, message, model) =>
      fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: message || 'Say OK' }],
          stream: false,
        }),
      }),
  },
};

// GET / — serve the UI
app.get('/', (_req, res) => {
  const htmlPath = path.join(__dirname, 'provider-test.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res
      .status(500)
      .send('provider-test.html not found next to provider-test.ts');
  }
});

// GET /api/providers — provider list + defaults for the frontend
app.get('/api/providers', (_req, res) => {
  res.json({
    providers: Object.entries(providers).map(([key, p]) => ({
      key,
      name: p.name,
    })),
    defaults: Object.fromEntries(
      Object.entries(providers).map(([key, p]) => [key, p.defaultModel]),
    ),
  });
});

// GET /api/saved-keys — which providers have a key saved in .env (no values exposed)
app.get('/api/saved-keys', (_req, res) => {
  const saved: Record<string, boolean> = {};
  for (const provider of Object.keys(ENV_VAR_NAMES)) {
    saved[provider] = !!readEnvKey(provider);
  }
  res.json(saved);
});

// POST /api/fetch-models — fetch available models; falls back to saved .env key
app.post('/api/fetch-models', async (req, res) => {
  const { provider } = req.body as { provider: string; apiKey?: string };
  const apiKey = (req.body.apiKey as string) || readEnvKey(provider);

  if (!provider || !apiKey) {
    return res.json({ success: false, models: [] });
  }

  try {
    let models: string[] = [];

    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (r.ok) {
        const d: any = await r.json();
        models = (d.data as any[])
          .map((m: any) => m.id as string)
          .filter(
            (id) =>
              id.startsWith('gpt') ||
              id.startsWith('o1') ||
              id.startsWith('o3'),
          )
          .sort();
      }
    } else if (provider === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (r.ok) {
        const d: any = await r.json();
        models = (d.data as any[]).map((m: any) => m.id as string).sort();
      }
    } else if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (r.ok) {
        const d: any = await r.json();
        models = (d.data as any[]).map((m: any) => m.id as string).sort();
      }
    } else if (provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/models', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (r.ok) {
        const d: any = await r.json();
        models = (d.data as any[]).map((m: any) => m.id as string).sort();
      }
    } else if (provider === 'together') {
      const r = await fetch('https://api.together.xyz/v1/models', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (r.ok) {
        const d: any = await r.json();
        models = (d as any[]).map((m: any) => m.id as string).sort();
      }
    } else if (provider === 'google') {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey,
      );
      if (r.ok) {
        const d: any = await r.json();
        models = (d.models as any[])
          .map((m: any) => (m.name as string).replace('models/', ''))
          .filter((id) => id.startsWith('gemini'))
          .sort();
      }
    } else if (provider === 'ollama') {
      const r = await fetch('http://localhost:11434/api/tags');
      if (r.ok) {
        const d: any = await r.json();
        models = (d.models as any[]).map((m: any) => m.name as string).sort();
      }
    } else {
      const def = providers[provider]?.defaultModel;
      if (def) models = [def];
    }

    res.json({ success: models.length > 0, models });
  } catch (err) {
    res.json({ success: false, models: [], error: String(err) });
  }
});

// POST /api/test-provider — test a provider; falls back to saved .env key
app.post('/api/test-provider', async (req, res) => {
  const { provider, model, message } = req.body as {
    provider: string;
    model: string;
    apiKey?: string;
    message: string;
  };
  const apiKey = (req.body.apiKey as string) || readEnvKey(provider);

  if (!provider || !model || !apiKey) {
    return res.json({
      success: false,
      error: 'Missing provider, model, or API key',
    });
  }

  const cfg = providers[provider];
  if (!cfg) {
    return res.json({ success: false, error: 'Unknown provider: ' + provider });
  }

  try {
    const t0 = Date.now();
    const response = await cfg.testFn(apiKey, message, model);
    const responseTime = Date.now() - t0;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let errMsg = response.statusText;
      try {
        const j: any = JSON.parse(text);
        errMsg = j?.error?.message || j?.message || j?.error || text;
      } catch {}
      return res.json({
        success: false,
        provider: cfg.name,
        status: response.status,
        details: String(errMsg).slice(0, 300),
      });
    }

    const body = await response.json();
    const responseText = cfg.extractText(body);

    res.json({ success: true, provider: cfg.name, responseTime, responseText });
  } catch (err) {
    res.json({
      success: false,
      provider: cfg.name,
      status: 0,
      details: String(err),
    });
  }
});

// POST /api/save-key — upsert a provider API key in .env
app.post('/api/save-key', (req, res) => {
  const { provider, apiKey } = req.body as { provider: string; apiKey: string };
  const envVar = ENV_VAR_NAMES[provider];

  if (!envVar || !apiKey) {
    return res.json({
      success: false,
      error: 'No env var mapping for provider: ' + provider,
    });
  }

  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    // file doesn't exist yet
  }

  const line = envVar + '=' + apiKey;
  const pattern = new RegExp('^' + envVar + '=.*$', 'm');

  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + line + '\n';
  }

  try {
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    res.json({ success: true, envVar });
  } catch (err) {
    res.json({ success: false, error: String(err) });
  }
});

const server = app.listen(PORT, () => {
  console.log('\n🧪 Multi-Provider Tester → http://localhost:' + PORT + '\n');
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
