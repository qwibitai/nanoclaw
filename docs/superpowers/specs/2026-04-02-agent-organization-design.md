# NanoClaw Agent Organization — Design Spec v2

**Date:** 2026-04-02
**Author:** Claude (session med Fredrik)
**Status:** Approved — reviewed by superpowers:code-reviewer
**Review fixes:** Concurrency model, bot consolidation, dashboard API, phase 1 detail

---

## Vision

Transformera NanoClaw från en enskild assistent (Göran P) till en AI-organisation med CTO, PM, och specialistteam. Fredrik är CEO — ger uppdrag och godkänner. Göran P (CTO) orkestrerar teamet.

## Organisationsstruktur

```
Fredrik (CEO)
  └── Göran P (CTO) — kritisk, krävande, delegerar allt utom urgent
        │
        ├── PM/Scrum Master — bryter ner, tilldelar, följer upp
        │     ├── Arkitekten — systemdesign, specs, stack-val
        │     ├── Byggaren — implementation, kodning
        │     ├── Designern — UI/UX, visuell kvalitet
        │     ├── Testaren — tester, QA, edge cases
        │     ├── Databasagenten — schema, migrations, optimering
        │     ├── Copywritern — texter, SEO, content
        │     └── Researcher — docs-sökning, library-utvärdering
        │
        ├── DevOps — deploy, CI/CD, infra, monitoring
        ├── Säkerhetsagenten — OWASP, dependency audit, secrets
        └── Reviewern/GAMET — slutgranskning, kvalitetsgrind

11 roller + CEO. Körs SEKVENTIELLT, inte parallellt (max 3-5 sub-agenter aktiva åt gången).
```

## Concurrency Model

**Viktigt:** Sub-agenter spawnas inuti SAMMA container som Göran (via Agent Teams). De är processer, inte separata containrar.

- Max 3-5 samtida sub-agenter (4GB RAM-begränsning)
- PM serialiserar arbetet i VÅGOR — inte fan-out till alla 11 samtidigt
- Våg 1: Arkitekt + Researcher → spec
- Våg 2: Byggare + Designer + DB → implementation
- Våg 3: Testare + Säkerhet → QA
- Våg 4: GAMET → final review

## Modellstrategi

**Nuläge:** Claude Agent SDK kör samma modell för alla sub-agenter. Per-agent modellval stöds inte ännu.

**Aspirationellt** (när SDK stöder det):

| Roll | Modell | Motivering |
|------|--------|-----------|
| Göran P (CTO) | Opus | Strategiska beslut |
| PM | Sonnet | Planering |
| Arkitekten | Opus | Djup systemförståelse |
| Byggaren | Sonnet | Snabb kodning |
| Designern | Sonnet | Frontend |
| Testaren | Sonnet | QA |
| Databasagenten | Sonnet | Schema |
| Copywritern | Haiku | Snabba texter |
| Researcher | Haiku | Docs-sökning |
| DevOps | Sonnet | Deploy |
| Säkerhetsagenten | Sonnet | Granskning |
| GAMET Reviewer | Opus | Kvalitetsgrind |

**Idag:** Alla kör den modell som containern använder (Opus via OAuth-token).

## Görans Beteende

### Default (delegering)
1. CEO ger uppdrag via Telegram/WhatsApp
2. Göran bedömer scope, kallar in PM
3. PM bryter ner i tasks med deadlines
4. PM tilldelar roller via TeamCreate/Task (i vågor)
5. Teamet jobbar sekventiellt
6. Säkerhetsagenten granskar
7. GAMET reviewar
8. Göran sammanfattar → PR + rapport till CEO

### Urgent ("asap", "nu", "urgent")
1. CEO flaggar urgent
2. Göran gör det SJÄLV direkt
3. Skippar PM/team — direkt implementation
4. Rapporterar när klart

### Görans CTO-personlighet
- Kritisk — accepterar inte halvdant arbete från sub-agenter
- Delegerar — gör aldrig utförande själv (utom urgent)
- Kräver tester och security review innan varje PR
- Pushar tillbaka mot CEO om deadline är orealistisk
- Dokumenterar alla beslut i memories/decisions.md

## Telegram Swarm — 5 Botar

Pool-approach med dynamisk namngivning. Färre botar, enklare underhåll.

| Bot | Fasta roller | Dynamiska roller |
|-----|-------------|-----------------|
| **Göran P** (@Goran_P_bot, finns) | CTO | — |
| **PM Bot** | PM/Scrum Master | — |
| **Generalist 1** | — | Arkitekt, Byggare, DB, DevOps |
| **Generalist 2** | — | Designer, Copywriter, Researcher, Testare |
| **GAMET Bot** | Reviewer | Säkerhetsagent |

Generalist-botarna byter namn via `setMyName` baserat på vilken roll de fyller just nu. I Telegram-gruppen ser det ut som att rätt specialist svarar.

**Botar att skapa via @BotFather:**
1. PM Bot (ny)
2. Generalist 1 (ny)
3. Generalist 2 (ny)
4. GAMET Bot (ny)

**Setup:** `/add-telegram-swarm` skill + 4 nya bot-tokens i `.env`.

## Voice Integration

### Transkribering (STT)
Återanvänder befintlig NanoClaw-skill (`/add-voice-transcription` eller `/use-local-whisper`).
- Telegram voice → transkriberas på HOST (inte i containern)
- Redan stöd via WhatsApp voice transcription skill

### Text-to-Speech (TTS) — NY
Ny funktionalitet. Återanvänder stack från `Fruset/discord-roast-bot`:
- **ElevenLabs** för högkvalitativ TTS med Görans egen röst
- **MsEdge TTS** som gratis fallback
- ElevenLabs API-nyckel behövs i `.env`
- Göran svarar med voice message i Telegram när användaren skickar voice

### Krav
- ElevenLabs API-nyckel
- ffmpeg i containern (behöver läggas till i Dockerfile)
- Voice clone setup i ElevenLabs dashboard

## Self-Improvement Loop

### Trigger: After-Action Review
Körs automatiskt efter varje avslutat uppdrag (inte schemalagt):

1. Vad var uppdraget?
2. Vad levererades?
3. Fungerade det? (kontrollera build, tester, deploy)
4. Vad gick bra/dåligt?
5. Spara i conversations/ + uppdatera memories/

### Feedback-signaler
- **Implicit:** Parsea användarens svar — ton, nöjdhet
- **Explicit:** 👍/👎 reaktioner loggas i reactions-tabellen
- **GAMET score:** Strukturerad kodgranskning med score

### Minnesstruktur
```
memories/
  mistakes.md        — Vad som gick fel och varför
  improvements.md    — Vad som fungerat bra
  scores.md          — After-action scores med datum
  user.md            — Användarpreferenser
  team-performance.md — Vilka roller presterade bra/dåligt
```

## Dashboard

### Arkitektur
HTTP API i NanoClaw-huvudprocessen (localhost only) som exponerar DB-data.

```
NanoClaw process
  ├── Credential proxy (:3001)
  ├── Dashboard API (:4100)        ← NY
  ├── Channel connections
  └── Container management

Dashboard (Next.js 16)
  └── fetch('http://localhost:4100/api/...')
```

### API Endpoints
```
GET /api/groups          — Registrerade grupper
GET /api/messages/:jid   — Meddelanden för en grupp
GET /api/tasks           — Aktiva/avslutade/schemalagda tasks
GET /api/status          — Container-hälsa, uptime
GET /api/team            — Organisationsöversikt, roller, tilldelningar
GET /api/scores          — Self-improvement scores och trender
```

### Vyer
- **Organisation:** Roller, vem jobbar med vad
- **Tasks:** Kanban-board med aktiva/avslutade
- **Status:** Container-hälsa, uptime, fellog
- **Historik:** Konversationer, leveranser
- **Self-improvement:** Trendgrafer, vanligaste misstag

### Hosting
- Lokalt: port 4000 (exponerad från container) under utveckling
- Produktion: Vercel deploy med API proxy till localhost

## Implementation — Faser

### Fas 1: Agent Team Profiles & CTO Delegation (GRUND)
**Mest kritisk fas — allt annat bygger på denna.**

1. **Uppdatera `groups/global/CLAUDE.md`:**
   - Görans CTO-persona med delegerings-regler
   - Rollbeskrivningar för alla 11 roller (prompts sub-agenter får)
   - Urgent-detection (regex för "asap", "nu", "urgent", etc.)
   - Våg-baserad exekvering (Arkitekt → Byggare → Testare → Review)

2. **Skapa `groups/global/team-roles.md`:**
   - Detaljerade prompts per roll
   - Vad varje roll får/inte får göra
   - Kvalitetskriterier per roll

3. **Self-improvement setup:**
   - Skapa memories/improvements.md, scores.md, team-performance.md
   - After-action review instruktioner i CLAUDE.md
   - Uppdatera mistakes.md-logiken

4. **Testa:** Be Göran delegera en enkel uppgift och verifiera att teamet fungerar.

### Fas 2: Telegram Swarm
1. Skapa 4 nya botar via @BotFather
2. Installera `/add-telegram-swarm` skill (merge branch)
3. Konfigurera bot-tokens i `.env`
4. Skapa Telegram-grupp för teamet
5. Testa: Be Göran köra ett uppdrag med synligt team i gruppen

### Fas 3: Dashboard API + Frontend
1. Lägg till HTTP API i NanoClaw-huvudprocess (:4100)
2. Skapa Next.js 16 dashboard
3. Koppla till API endpoints
4. Deploy till Vercel + lokal dev på port 4000

### Fas 4: Voice Integration
1. Konfigurera ElevenLabs API-nyckel
2. Lägg till ffmpeg i container Dockerfile
3. Implementera TTS-svar för Telegram voice messages
4. Voice clone setup för Görans röst
5. Testa: Skicka voice → få voice tillbaka

### Fas 5: Optimering & Skalning
1. Finjustera container-resurser baserat på användning
2. Utvärdera per-agent modellval om SDK stöder det
3. Optimera self-improvement baserat på insamlad data
4. Multi-container parallellism om behov uppstår

## Failure Modes

| Scenario | Hantering |
|----------|-----------|
| Sub-agent misslyckas | PM rapporterar till Göran, som reassignar eller gör själv |
| Container OOM (137) | Watchdog dödar, NanoClaw restartar, meddelande till CEO |
| Context overflow | Göran kör /compact eller startar ny session |
| Två urgent samtidigt | Göran prioriterar och gör en i taget |
| API rate limit | Retry med backoff (befintlig mekanism) |
| Bot-token ogiltig | Channel loggar varning, skippar den boten |

## Vad som INTE ingår
- Fine-tuning av modeller
- Extern databas (SQLite räcker)
- Cloud hosting (kör lokalt)
- Betalningssystem
- Automatisk skalning av containrar
