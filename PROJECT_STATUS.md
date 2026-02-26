# PROJECT STATUS
> Última atualização: 2026-02-25

---

## O Que Está Instalado e Funcionando

| Componente | Status | Observação |
|---|---|---|
| **NanoClaw** (agente WhatsApp) | ✅ Rodando | launchd `com.nanoclaw` |
| **Claude Code Agent** | ✅ Operacional | Dentro do container Docker, modelo `claude-sonnet-4-6` |
| **Groq Whisper** (transcrição de voz) | ✅ Funcionando | `whisper-large-v3-turbo` via API |
| **Docker Desktop** | ✅ Rodando | Daemon ativo |
| **Ollama** | ✅ Rodando | launchd `com.ollama.ollama` |
| **AnythingLLM Desktop** | ✅ Instalado | 3 workspaces criados |
| **N8N** | ⚠️ Instalado, não ativo | Imagem Docker baixada, container nunca iniciado |
| **Unibot** | ⚠️ Instalado, não ativo | Repositório local, dependências Python instaladas |
| **GitHub CLI (gh)** | ✅ Autenticado | conta `eugestornet` |

---

## Versões

| Ferramenta | Versão |
|---|---|
| macOS | Darwin 24.6.0 |
| Node.js | 25.6.1 |
| npm | 11.9.0 |
| Git | 2.53.0 |
| GitHub CLI | 2.87.3 |
| Docker Desktop | 29.2.1 |
| N8N | `n8nio/n8n:latest` (imagem, 1.95GB) |
| nanoclaw-agent (container) | `latest` (2.42GB, built ~15h atrás) |
| Groq SDK | via `groq-sdk` npm |
| Ollama | instalado via App |
| AnythingLLM | Desktop Edition |

### Modelos Ollama instalados

| Modelo | Tamanho |
|---|---|
| `gemma3:4b` | 3.3 GB |
| `gemma3:latest` | 3.3 GB |
| `llama3:latest` | 4.7 GB |

---

## Estrutura de Pastas

```
~/
├── github/
│   ├── nanoclaw/               # Agente WhatsApp (projeto principal)
│   │   ├── src/
│   │   │   ├── index.ts        # Orquestrador principal
│   │   │   ├── channels/
│   │   │   │   └── whatsapp.ts # Conexão WhatsApp + transcrição de voz
│   │   │   ├── transcription.ts# Módulo Groq Whisper (NOVO)
│   │   │   └── config.ts       # Configurações gerais
│   │   ├── groups/
│   │   │   ├── global/
│   │   │   │   └── CLAUDE.md   # Memória/persona global do Neo
│   │   │   └── main/
│   │   │       └── CLAUDE.md   # Memória do canal principal
│   │   ├── container/          # Dockerfile do agente
│   │   ├── store/
│   │   │   ├── auth/           # Credenciais WhatsApp (não commitar)
│   │   │   └── messages.db     # Banco SQLite de mensagens
│   │   ├── logs/
│   │   │   └── nanoclaw.log    # Logs do serviço
│   │   ├── docs/
│   │   │   └── SETUP-EUGESTOR.md # Guia de instalação completo
│   │   └── .env                # Secrets (não commitar)
│   │
│   ├── unibot/                 # Sistema multi-agente Python
│   │   ├── core/
│   │   │   └── agents/         # DevOps, QA, especializados
│   │   ├── cli/                # Interface de linha de comando
│   │   ├── docs/               # Guias e wiki
│   │   └── venv/               # Ambiente virtual Python
│   │
│   └── unibot_output/          # Artefatos gerados pelo Unibot
│
├── .n8n/                       # Dados do N8N (local)
│   └── database.sqlite         # Banco de dados N8N (vazio)
│
└── Library/Application Support/
    └── anythingllm-desktop/    # Dados do AnythingLLM
        └── storage/
            └── anythingllm.db  # Workspaces e documentos
```

---

## N8N — Workflows

> **Status atual:** Nenhum workflow criado. O N8N tem sua imagem Docker baixada (`n8nio/n8n:latest`) mas o container nunca foi iniciado e o banco de dados está vazio.

Para iniciar o N8N:
```bash
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n:latest
# Acessar em http://localhost:5678
```

---

## AnythingLLM — Workspaces

| Workspace | Criado em |
|---|---|
| **Nexus-lab** | 2026-02-25 |
| **Assistant Chats** | 2026-02-25 |
| **neo-brain** | 2026-02-25 |

---

## NanoClaw — Configuração Atual

| Parâmetro | Valor |
|---|---|
| Número do bot | +55 79 9664-1188 |
| Canal monitorado | +55 51 9331-9857 (pessoal) |
| JID registrado | `555193319857@s.whatsapp.net` |
| Nome do agente | Neo |
| Trigger obrigatório | Não (responde a qualquer mensagem) |
| Transcrição de voz | Groq `whisper-large-v3-turbo` |
| Modelo Claude | `claude-sonnet-4-6` |
| Repositório | https://github.com/eugestornet/nanoclaw |
| Upstream original | https://github.com/qwibitai/nanoclaw |

---

## Problemas Conhecidos / Pendências

| # | Descrição | Prioridade |
|---|---|---|
| 1 | **N8N nunca foi iniciado** — imagem baixada mas sem workflows nem container rodando | Média |
| 2 | **Unibot não integrado ao NanoClaw** — roda de forma isolada, sem comunicação com o Neo | Média |
| 3 | **TTS (resposta em áudio) não implementado** — Neo só responde em texto. Opções avaliadas: ElevenLabs, Groq PlayAI | Baixa |
| 4 | **`git config --global` não configurado** — commits mostram "configured automatically". Corrigir com `git config --global user.name` e `user.email` | Baixa |
| 5 | **AnythingLLM não conectado ao Neo** — workspaces criados mas sem integração com o agente WhatsApp | Média |
| 6 | **N8N sem integração com NanoClaw** — potencial para criar workflows que o Neo possa acionar | Média |

---

## Últimas Decisões Técnicas

| Data | Decisão | Motivo |
|---|---|---|
| 2026-02-25 | **Groq Whisper** para transcrição de voz, não OpenAI | Tier gratuito generoso; usuário não tinha key OpenAI |
| 2026-02-25 | **JID do canal = número pessoal** (`555193319857`), não o número do bot | Bug identificado: bot monitorava a si mesmo; mensagens nunca chegavam |
| 2026-02-25 | **`readEnvFile` diretamente** em `transcription.ts` para ler `GROQ_API_KEY` | Padrão do projeto: secrets não entram em `process.env` para não vazar para processos filhos |
| 2026-02-25 | **Fork em `eugestornet/nanoclaw`** | Sem permissão de escrita no upstream `qwibitai/nanoclaw`; PR #487 aberto com fix de testes |
| 2026-02-25 | **launchd** como gerenciador de serviço | macOS nativo; inicia com o sistema automaticamente |
| 2026-02-25 | **Número dedicado** ao bot (+55 79 9664-1188) | Separação entre uso pessoal e o agente |
| 2026-02-25 | **`--no-trigger-required`** no canal main | Canal DM dedicado; trigger `@Neo` é desnecessário em conversa direta |
