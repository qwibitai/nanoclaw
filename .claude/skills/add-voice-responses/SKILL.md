# Skill: add-voice-responses

Adds voice response capability to NanoClaw: when a user sends a voice message,
the agent's text reply is automatically synthesized to speech and sent back as
a voice note (PTT).

Requires `add-local-stt` to already be applied (voice input must work first).

Uses XTTS v2 (Coqui TTS) for high-quality, multilingual, local text-to-speech.
No cloud API keys required.

## Prerequisites

### 1. Local STT must be working

Apply `add-local-stt` first. Voice responses only trigger when the incoming
message was a voice note — the STT flag drives this.

### 2. XTTS v2 server

A local XTTS v2 HTTP server with a `/synthesize-ogg` endpoint:

```bash
# The server must accept:
# POST /synthesize-ogg
#   JSON body: { "text": "...", "language": "de", "speaker": "Sofia Hellen" }
# Returns: audio/ogg (Opus codec, ready to send as WhatsApp PTT)
```

The `/synthesize-ogg` endpoint must:
1. Synthesize WAV via XTTS v2
2. Trim trailing silence with ffmpeg (`silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-35dB`)
3. Convert to OGG/Opus with ffmpeg (`-c:a libopus -b:a 32k`)

Silence trimming is critical — XTTS v2 often appends garbled audio at the end
that STT would misread as garbage text.

Example minimal `/synthesize-ogg` implementation (Python/FastAPI):
```python
@app.post("/synthesize-ogg")
async def synthesize_ogg(request: SynthesizeRequest):
    wav = _synthesize(request.text, request.language, request.speaker, speaker_wav)
    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = os.path.join(tmpdir, "out.wav")
        trimmed_path = os.path.join(tmpdir, "trimmed.wav")
        ogg_path = os.path.join(tmpdir, "out.ogg")
        sf.write(wav_path, wav, SAMPLE_RATE, format="WAV")
        subprocess.run(["ffmpeg", "-y", "-i", wav_path,
            "-af", "silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-35dB",
            trimmed_path], check=True)
        subprocess.run(["ffmpeg", "-y", "-i", trimmed_path,
            "-c:a", "libopus", "-b:a", "32k", ogg_path], check=True)
        ogg_bytes = open(ogg_path, "rb").read()
    return StreamingResponse(io.BytesIO(ogg_bytes), media_type="audio/ogg")
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XTTS_URL` | `http://localhost:8082` | Base URL of the XTTS server |
| `XTTS_SPEAKER` | `Sofia Hellen` | Speaker voice name |
| `XTTS_LANGUAGE` | `de` | Language code for synthesis |

## Implementation

### 1. Add constants to `src/channels/whatsapp.ts`

```typescript
const XTTS_URL = process.env.XTTS_URL || 'http://localhost:8082';
const XTTS_SPEAKER = process.env.XTTS_SPEAKER || 'Sofia Hellen';
const XTTS_LANGUAGE = process.env.XTTS_LANGUAGE || 'de';
```

### 2. Add `synthesizeVoice()` function to `src/channels/whatsapp.ts`

```typescript
async function synthesizeVoice(text: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${XTTS_URL}/synthesize-ogg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: XTTS_LANGUAGE, speaker: XTTS_SPEAKER }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'XTTS TTS failed');
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn({ err }, 'XTTS TTS error');
    return null;
  }
}
```

### 3. Add `sendVoiceMessage` to `Channel` interface in `src/types.ts`

```typescript
export interface Channel {
  // ... existing methods ...
  sendVoiceMessage?(jid: string, text: string): Promise<boolean>;
}
```

### 4. Add `botSentPttIds` tracking and `sendVoiceMessage()` to `WhatsAppChannel`

The bot sends PTT messages with `fromMe=true` — same as the user's own voice messages
on a shared number. Track sent IDs to avoid re-processing bot responses as new messages.

In the class body:
```typescript
private botSentPttIds = new Set<string>();
```

Add method:
```typescript
async sendVoiceMessage(jid: string, text: string): Promise<boolean> {
  const audio = await synthesizeVoice(text);
  if (!audio) return false;
  try {
    const result = await this.sock.sendMessage(jid, {
      audio,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
    if (result?.key?.id) this.botSentPttIds.add(result.key.id);
    logger.info({ jid, length: audio.length }, 'Voice message sent');
    return true;
  } catch (err) {
    logger.warn({ err, jid }, 'Failed to send voice message');
    return false;
  }
}
```

### 5. Skip bot-sent PTTs in `messages.upsert`

Replace any `fromMe`-based PTT skip with ID-based tracking:

```typescript
// Skip PTT sent by the bot itself (our own TTS voice responses)
if (isPtt && msg.key.id && this.botSentPttIds.has(msg.key.id)) {
  this.botSentPttIds.delete(msg.key.id);
  continue;
}
```

**Do NOT use `if (isPtt && msg.key.fromMe) continue;`** — on a shared number,
all messages (including the user's own voice notes) have `fromMe=true`, so this
would silently drop all incoming voice messages.

### 6. Track `lastMessageWasVoice` in `src/index.ts`

Add a map to track whether the last message per chat was a voice note:

```typescript
const lastMessageWasVoiceMap: Record<string, boolean> = {};
```

In the `onMessage` callback, set the flag (only for non-bot messages):
```typescript
onMessage: (_chatJid, msg) => {
  storeMessage(msg);
  if (!msg.is_bot_message) {
    lastMessageWasVoiceMap[msg.chat_jid] = msg.is_voice_message === true;
  }
},
```

In the streaming response callback, read the flag at send-time and try voice first:
```typescript
const lastMessageWasVoice = lastMessageWasVoiceMap[chatJid] === true;
let voiceSent = false;
if (lastMessageWasVoice && channel.sendVoiceMessage) {
  voiceSent = await channel.sendVoiceMessage(chatJid, text);
}
if (!voiceSent) {
  await channel.sendMessage(chatJid, text);
}
```

Read the flag inside the callback (at send-time), not before the agent runs —
the map may be updated while the agent is processing.

### 7. Update CLAUDE.md files

Add to `groups/global/CLAUDE.md`:
```markdown
## Sprachnachrichten

Nachrichten die mit `[Sprachnachricht]:` beginnen sind automatisch transkribierte Sprachnachrichten.
Nanoclaw sendet die Antwort automatisch als Sprachnachricht zurück.
Auf Sprachnachrichten antworte KURZ und GESPRÄCHSSPRACHLICH — keine Markdown-Formatierung, keine Listen, keine Headers.
```

### 8. Build and restart

```bash
npm run build
systemctl --user restart nanoclaw
```

## Available XTTS v2 Speakers

XTTS v2 includes these built-in speakers (no reference audio needed):
Claribel Dervla, Daisy Studious, Gracie Wise, Tammie Ema, Alison Dietlinde,
Ana Florence, Annmarie Nele, Asya Anara, Brenda Stern, Gitta Nikolina,
Henriette Usha, Sofia Hellen, Tammy Grit, Tanja Adelina, Vjollca Johnnie,
Andrew Chipper, Badr Odhiambo, Dionisio Schuyler, Royston Min, Viktor Eka,
Abrahan Mack, Adde Michal, Baldur Sanjin, Craig Gutsy, Damien Black,
Gilberto Mathias, Ilkin Urbano, Kazuhiko Atallah, Ludvig Milivoj,
Suad Qasim, Torcull Diarmuid, Viktor Menelaos, Zacharie Aimilios,
Nova Hogarth, Maja Ruoho, Uta Obando, Lidiya Szekeres, Chandra MacFarland,
Szofi Granger, Camilla Holmström, Lilya Stainthorpe, Zofija Kendrick,
Narelle Moon, Barbora MacLean, Alexandra Hisakawa, Alma María, Rosemarie Bhatt,
Ige Behringer, Filip Traverse, Damjan Chapman, Wulf Carlevaro, Aaron Dreschner,
Kumar Dahl, Eugenio Mataracı, Ferran Simen, Xavier Hayasaka, Luis Moray,
Marcos Rudaski

## Troubleshooting

- **No voice response**: Check XTTS server is running, `XTTS_URL` is correct
- **Garbled tail in audio**: The `/synthesize-ogg` endpoint must apply ffmpeg silence trimming
- **Bot re-processes its own voice response**: Ensure `botSentPttIds` tracking is in place (see step 5)
- **User voice messages not received**: Do NOT use `fromMe`-based PTT filtering (see step 5)
