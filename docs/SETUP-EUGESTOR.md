# Guia de Instalação e Configuração — NanoClaw (eugestor)

Documentação do ecossistema configurado: agente pessoal Claude rodando no WhatsApp com transcrição de áudio via Groq.

---

## Visão Geral

```
Seu WhatsApp (55 51 9331-9857)
       ↓ mensagem (texto ou áudio)
Número do bot (55 79 9664-1188)
       ↓ Baileys (WhatsApp Web)
NanoClaw (Node.js — macOS launchd)
       ↓ transcreve áudio via Groq Whisper
       ↓ spawna container Docker
Claude Code Agent (claude-sonnet-4-6)
       ↓ resposta em texto
Seu WhatsApp
```

---

## Pré-requisitos

| Componente | Versão mínima | Como verificar |
|---|---|---|
| macOS | 12+ | `sw_vers` |
| Node.js | 22+ | `node --version` |
| Docker Desktop | qualquer | `docker --version` |
| Git | 2.28+ | `git --version` |
| GitHub CLI (`gh`) | qualquer | `gh --version` |

### Instalar Homebrew (se necessário)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Instalar Node.js 22
```bash
brew install node@22
```

### Instalar Docker Desktop
Baixar em https://www.docker.com/products/docker-desktop — instalar e abrir para que o daemon inicie.

### Instalar GitHub CLI
```bash
brew install gh
gh auth login  # autenticar com sua conta GitHub
```

---

## 1. Clonar o Repositório

O repositório está forkado em `eugestornet/nanoclaw` (fork de `qwibitai/nanoclaw`).

```bash
git clone https://github.com/eugestornet/nanoclaw.git
cd nanoclaw
```

Adicionar o upstream original para receber atualizações futuras:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

---

## 2. Instalar Dependências

```bash
npm install
```

Verifica se tudo está OK:
```bash
bash setup.sh
# Esperar: NODE_OK=true, DEPS_OK=true, NATIVE_OK=true, STATUS=success
```

---

## 3. Configurar o Arquivo `.env`

Criar o arquivo `.env` na raiz do projeto:

```bash
cat > .env << 'EOF'
# Autenticação Claude (assinatura Pro/Max)
# Gerar com: claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=<seu-token-aqui>

# Transcrição de áudio via Groq Whisper
# Criar em: https://console.groq.com/keys
GROQ_API_KEY=<sua-groq-api-key>

# Configuração do agente
TRIGGER_NAME=@Neo
ASSISTANT_NAME="Neo"

# Logs
LOG_LEVEL=info
EOF
```

### Obter o CLAUDE_CODE_OAUTH_TOKEN

1. Instalar o Claude Code: `npm install -g @anthropic-ai/claude-code`
2. Executar em outro terminal: `claude setup-token`
3. Copiar o token gerado e colar no `.env`

### Obter o GROQ_API_KEY

1. Acessar https://console.groq.com/keys
2. Clicar em **Create API Key**
3. Copiar a key (começa com `gsk_`) e colar no `.env`

---

## 4. Construir o Container Docker

O agente Claude roda dentro de um container Docker isolado.

```bash
npx tsx setup/index.ts --step container -- --runtime docker
# Aguardar: BUILD_OK=true, TEST_OK=true, STATUS=success
# Pode demorar vários minutos na primeira vez
```

Verificar se a imagem foi criada:
```bash
docker images | grep nanoclaw-agent
```

---

## 5. Autenticação WhatsApp

O número do bot é **+55 79 9664-1188** (número dedicado ao NanoClaw).

```bash
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser
```

Abrir o link exibido no terminal, escanear o QR code com o WhatsApp do celular do bot (numero 79 9664-1188) em:
**WhatsApp > Aparelhos conectados > Conectar um aparelho**

Após autenticar, as credenciais ficam salvas em `store/auth/`.

---

## 6. Registrar o Canal Principal

O canal principal escuta mensagens vindas do número pessoal (+55 51 9331-9857).

```bash
npx tsx setup/index.ts --step register -- \
  --jid "555193319857@s.whatsapp.net" \
  --name "main" \
  --trigger "@Neo" \
  --folder "main" \
  --no-trigger-required \
  --assistant-name "Neo"
```

**Parâmetros:**
- `--jid`: JID do número que envia mensagens ao bot (seu número pessoal)
- `--no-trigger-required`: responde a qualquer mensagem, sem precisar digitar `@Neo`
- `--assistant-name "Neo"`: nome do agente

---

## 7. Configurar Mount Allowlist

Define quais diretórios o agente pode acessar. Configuração restritiva (só o projeto):

```bash
npx tsx setup/index.ts --step mounts -- --empty
```

---

## 8. Iniciar o Serviço (macOS launchd)

O NanoClaw roda como serviço em background, iniciando automaticamente com o macOS.

```bash
npx tsx setup/index.ts --step service
# Esperar: SERVICE_LOADED=true, STATUS=success
```

Verificar se está rodando:
```bash
launchctl list | grep nanoclaw
# PID diferente de "-" = rodando
```

---

## 9. Verificar Instalação Completa

```bash
npx tsx setup/index.ts --step verify
```

Resultado esperado:
```
SERVICE: running
CONTAINER_RUNTIME: docker
CREDENTIALS: configured
WHATSAPP_AUTH: authenticated
REGISTERED_GROUPS: 1
MOUNT_ALLOWLIST: configured
STATUS: success
```

---

## 10. Testar

Enviar uma mensagem de texto para **+55 79 9664-1188** pelo WhatsApp.
O Neo deve responder em alguns segundos.

Para mensagens de voz: gravar e enviar normalmente — o Groq Whisper transcreve automaticamente.

---

## Gerenciamento do Serviço

```bash
# Reiniciar
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Parar
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Iniciar
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Ver logs em tempo real
tail -f logs/nanoclaw.log

# Ver apenas erros de transcrição
tail -f logs/nanoclaw.log | grep -i "voice\|transcri\|groq"
```

---

## Atualizar o NanoClaw

Para receber atualizações do projeto upstream:

```bash
# No Claude Code, dentro da pasta do projeto:
/update
```

Ou manualmente:
```bash
git fetch upstream
git merge upstream/main
npm install
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Troubleshooting

### Bot não responde
1. Verificar se Docker está rodando: `docker info`
2. Verificar serviço: `launchctl list | grep nanoclaw`
3. Ver logs: `tail -f logs/nanoclaw.log`
4. Reiniciar: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Transcrição de áudio não funciona
1. Verificar se `GROQ_API_KEY` está no `.env`
2. Testar a key: `curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY" | head -c 100`
3. Ver logs: `tail -f logs/nanoclaw.log | grep -i groq`

### WhatsApp desconectou
```bash
# Reautenticar
npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser

# Depois reiniciar
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Container Docker falha
```bash
# Reconstruir do zero
docker builder prune -f
./container/build.sh

# Verificar imagem
docker run --rm nanoclaw-agent:latest echo ok
```

---

## Arquitetura de Arquivos

```
nanoclaw/
├── .env                    # Variáveis de ambiente (secrets)
├── src/
│   ├── index.ts            # Orquestrador principal
│   ├── channels/
│   │   └── whatsapp.ts     # Conexão WhatsApp + transcrição de áudio
│   ├── transcription.ts    # Módulo Groq Whisper (voz → texto)
│   └── config.ts           # Configurações gerais
├── groups/
│   ├── global/CLAUDE.md    # Memória/persona global do agente
│   └── main/CLAUDE.md      # Memória do canal principal
├── store/
│   ├── auth/               # Credenciais WhatsApp (não commitar)
│   └── messages.db         # Banco de dados SQLite
├── container/              # Dockerfile e scripts do agente
└── logs/
    └── nanoclaw.log        # Logs do serviço
```

---

## Componentes e Credenciais

| Componente | Onde gerenciar |
|---|---|
| Claude OAuth Token | `claude setup-token` → `.env` |
| Groq API Key | https://console.groq.com/keys → `.env` |
| WhatsApp Auth | `store/auth/` (gerado pelo setup) |
| Repositório | https://github.com/eugestornet/nanoclaw |
