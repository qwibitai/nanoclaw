# NanoClaw Agent Organization — Design Spec

**Date:** 2026-04-02
**Author:** Claude (session med Fredrik)
**Status:** Draft — awaiting CEO approval

---

## Vision

Transformera NanoClaw från en enskild assistent (Göran P) till en AI-organisation med CTO, PM, och specialistteam. Fredrik är CEO — ger uppdrag och godkänner. Göran P (CTO) orkestrerar teamet.

## Organisationsstruktur

```
Fredrik (CEO)
  └── Göran P (CTO, Opus) — kritisk, krävande, delegerar allt utom urgent
        │
        ├── PM/Scrum Master (Sonnet) — bryter ner, tilldelar, följer upp
        │     ├── Arkitekten (Opus) — systemdesign, specs, stack-val
        │     ├── Byggaren (Sonnet) — implementation, kodning
        │     ├── Designern (Sonnet) — UI/UX, visuell kvalitet
        │     ├── Testaren (Sonnet) — tester, QA, edge cases
        │     ├── Databasagenten (Sonnet) — schema, migrations, optimering
        │     ├── Copywritern (Haiku) — texter, SEO, content
        │     └── Researcher (Haiku) — docs-sökning, library-utvärdering
        │
        ├── DevOps (Sonnet) — deploy, CI/CD, infra, monitoring
        ├── Säkerhetsagenten (Sonnet) — OWASP, dependency audit, secrets
        └── Reviewern/GAMET (Opus) — slutgranskning, kvalitetsgrind

11 roller + CEO
```

## Modellstrategi

| Roll | Modell | Motivering |
|------|--------|-----------|
| Göran P (CTO) | Opus | Strategiska beslut, orkestrering |
| PM/Scrum Master | Sonnet | Planering, task-nedbrytning |
| Arkitekten | Opus | Djup systemförståelse |
| Byggaren | Sonnet | Kodning — snabb och kapabel |
| Designern | Sonnet | Frontend-implementation |
| Testaren | Sonnet | Testskrivning, QA |
| Databasagenten | Sonnet | Schema, migrations |
| Copywritern | Haiku | Snabba texter, billigt |
| Researcher | Haiku | Docs-sökning, jämförelse |
| DevOps | Sonnet | Deploy, infra |
| Säkerhetsagenten | Sonnet | Granskning |
| Reviewern (GAMET) | Opus | Slutgiltig kvalitetsgrind |

## Arbetsflöde

### Default (delegering)
1. CEO ger uppdrag via Telegram/WhatsApp
2. Göran (CTO) bedömer scope
3. PM bryter ner i tasks med deadlines
4. PM tilldelar roller via TeamCreate/Task
5. Teamet jobbar parallellt
6. Säkerhetsagenten granskar
7. GAMET reviewar
8. Göran sammanfattar → PR + rapport till CEO

### Urgent ("asap", "nu", "urgent")
1. CEO flaggar urgent
2. Göran gör det SJÄLV direkt med Opus
3. Skippar PM/team — direkt implementation
4. Rapporterar när klart

## Telegram Swarm

Varje agent får en egen Telegram-bot med namn och avatar. Körs i en dedikerad Telegram-grupp så CEO kan följa teamets arbete.

**Botar som behövs (via @BotFather):**
1. Göran P (redan finns: @Goran_P_bot)
2. PM Bot
3. Arkitekt Bot
4. Byggar Bot
5. Designer Bot
6. Testar Bot
7. DB Bot
8. Copy Bot
9. Researcher Bot
10. DevOps Bot
11. Säkerhets Bot
12. GAMET Reviewer Bot

**Setup:** `/add-telegram-swarm` skill mergar koden. Konfigureras med bot-tokens i `.env`.

## Parallella Containrar

NanoClaw stöder redan `MAX_CONCURRENT_CONTAINERS = 5` (konfigurerbart). Två containrar kan köras samtidigt på olika uppgifter.

**Hur det funkar:**
- Göran spawnar sub-agenter via Task — dessa körs som separata processer INUTI samma container
- Om vi vill ha ÄKTA parallellism (två separata containrar) behöver vi antingen:
  a. Två registrerade grupper (t.ex. telegram_main + whatsapp_main) som processar samtidigt
  b. Scheduled tasks som körs parallellt med interaktiva sessioner

**Rekommendation:** Agent Teams inuti containern räcker för de flesta fall. Äkta multi-container behövs bara för helt oberoende projekt.

## Voice Integration

Återanvänder teknik från `Fruset/discord-roast-bot`:

**Befintlig stack:**
- **STT:** Whisper.cpp (lokal, kb-whisper-small) — svenska
- **TTS:** ElevenLabs + MsEdge TTS fallback
- **Audio:** ffmpeg + OpusScript

**Plan för Göran:**
- Telegram Voice Messages → Whisper.cpp transkriberar → Göran processar → TTS → Voice reply
- NanoClaw har redan `/add-voice-transcription` skill (Whisper API) — byt till lokal whisper.cpp
- Lägger till TTS-svar via ElevenLabs med Görans egen röst

**Krav:**
- ElevenLabs API-nyckel (för TTS)
- Whisper.cpp binary (redan byggd i discord-bot Docker-image)
- ffmpeg i containern

## Self-Improvement Loop

### Datainsamling
- **Implicit:** Parsea användarens svar — "bra", "funkar inte", frustrerad ton
- **Explicit:** 👍/👎 reaktioner på Görans meddelanden loggas i `reactions`-tabellen
- **Automatisk:** GAMET review-score på varje leverans

### Schemalagd review
Var timme kör en scheduled task:
```
"Gå igenom senaste konversationerna och leveranserna.
 - Vad gick bra? Vad gick dåligt?
 - Uppdatera memories/mistakes.md med nya lärdomar
 - Uppdatera memories/user.md med nya preferenser
 - Ge dig själv en score 1-10 och motivera"
```

### Feedback-lagring
```
memories/
  mistakes.md        — Vad som gick fel och varför
  improvements.md    — Vad som fungerat bra (förstärk)
  scores.md          — Self-review scores med datum
  user.md            — Uppdaterade preferenser
```

### After-action review
Efter varje avslutat uppdrag (triggered automatiskt):
1. Vad var uppdraget?
2. Vad levererades?
3. Vad gick bra/dåligt?
4. Vad ska göras annorlunda nästa gång?
5. Spara i conversations/ + uppdatera memories/

## Dashboard

Göran bygger en NanoClaw dashboard (Next.js 16, React 19) som visar:
- **Organisation:** Vem har vilka roller, vem jobbar med vad
- **Tasks:** Aktiva, avslutade, schemalagda
- **Status:** Container-hälsa, uptime, fellog
- **Historik:** Konversationer, leveranser, scores
- **Self-improvement:** Trendgrafer på scores, vanligaste misstag

Körs lokalt via port 4000 (exponerad från container) eller deployad till Vercel.

Datakälla: SQLite DB (`store/messages.db`) — messages, tasks, reactions, sessions.

## Implementation — Faser

### Fas 1: Agent Team Profiles (CLAUDE.md)
- Definiera varje rolls persona, prompt, modell i CLAUDE.md
- Göran instrueras att delegera via TeamCreate med rollbeskrivningar
- Self-improvement loop + scheduled review task

### Fas 2: Telegram Swarm
- Installera `/add-telegram-swarm` skill
- Skapa 12 botar via @BotFather
- Konfigurera bot-tokens
- Testa i dedikerad grupp

### Fas 3: Voice Integration
- Installera Whisper.cpp i container
- Integrera ElevenLabs TTS
- Telegram voice message → text → Göran → TTS → voice reply

### Fas 4: Dashboard
- Bygga Next.js 16 dashboard
- Koppla till SQLite + NanoClaw API
- Deploy till Vercel + lokal dev på port 4000

### Fas 5: Multi-Container Parallellism
- Konfigurera concurrent container-stöd
- Testa två agenter som jobbar på olika delar samtidigt

## Vad som INTE ingår
- Fine-tuning av modeller (inte möjligt med Claude)
- Extern databas (SQLite räcker)
- Kubernetes/cloud hosting (kör lokalt på Fredriks Mac)
- Betalningssystem eller extern access
