# NanoClaw Voice Daemon

Hands-free voice input pro NanoClaw. Používá Picovoice Porcupine pro detekci wake wordu a OpenAI Whisper pro transkripci.

## Jak to funguje

1. Daemon poslouchá mikrofon a čeká na wake word **"Hey Gimme"**
2. Po detekci přehraje zvuk **Purr** (nahrávání začalo)
3. Nahrává hlas uživatele
4. Po druhém **"Hey Gimme"** přehraje **Pop** (nahrávání skončilo)
5. Audio se přepíše přes OpenAI Whisper API
6. Transkripce se vloží do NanoClaw DB jako `[Voice: ...]` zpráva
7. NanoClaw zpracuje zprávu, odpoví hlasem (OpenAI TTS) do Telegramu + přehraje na Macu přes `ffplay`

## Prerekvizity

- Python 3.10+ s venv
- Picovoice AccessKey (zdarma na https://console.picovoice.ai/)
- Natrénovaný wake word `.ppn` soubor (aktuálně `Hey-Gimme_en_mac_v4_0_0.ppn`)
- OpenAI API klíč (pro Whisper transkripci)
- `ffplay` (z ffmpeg, pro přehrávání TTS odpovědí — instaluje NanoClaw)

## Proměnné v .env

| Proměnná | Popis |
|----------|-------|
| `PICOVOICE_ACCESS_KEY` | AccessKey z Picovoice konzole |
| `OPENAI_API_KEY` | OpenAI API klíč (sdílený s NanoClaw transkripce + TTS) |

## Instalace

```bash
# Vytvořit venv a nainstalovat závislosti
python3 -m venv porcupine/venv
source porcupine/venv/bin/activate
pip install pvporcupine pvrecorder openai
```

## Spuštění

### Ručně (pro ladění)

```bash
cd ~/nanoclaw
PYTHONUNBUFFERED=1 porcupine/venv/bin/python3 porcupine/voice-daemon.py
```

### Jako služba (launchd)

```bash
# Instalace
cp porcupine/com.nanoclaw.voice-daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.voice-daemon.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.voice-daemon

# Zastavení
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.voice-daemon.plist

# Logy
tail -f logs/voice-daemon.log
```

## Konfigurace

### Wake word

Aktuálně je natrénováno pouze **"Hey Gimme"** (jako start i stop). Po měsíci lze zdarma natrénovat další slovo na Picovoice konzoli (např. "Konec" pro ukončení nahrávání).

Pro změnu wake wordu:
1. Natrénuj nové slovo na https://console.picovoice.ai/
2. Stáhni `.ppn` soubor do `porcupine/`
3. Uprav `KEYWORD_PATH` v `voice-daemon.py`

### Zvuky

- **Start nahrávání**: `/System/Library/Sounds/Purr.aiff`
- **Stop nahrávání**: `/System/Library/Sounds/Pop.aiff`

Konfigurovatelné v `SOUND_START` a `SOUND_STOP` konstantách v `voice-daemon.py`.

### Chat JID

Daemon vkládá zprávy do Telegram main chatu (`tg:8253215818`). Pro změnu upravit `CHAT_JID` v `voice-daemon.py`.

## Architektura

```
Mikrofon → Porcupine (wake word) → Nahrávání → Whisper API (STT)
    → SQLite DB → NanoClaw message loop → Claude Agent (kontejner)
    → OpenAI TTS → Telegram voice + ffplay (lokální přehrání)
```

Voice daemon je samostatný Python proces, nezávislý na NanoClaw Node.js procesu. Komunikuje pouze přes SQLite DB — vloží zprávu a NanoClaw ji zpracuje v dalším poll cyklu.

## Soubory

| Soubor | Popis |
|--------|-------|
| `voice-daemon.py` | Hlavní daemon skript |
| `Hey-Gimme_en_mac_v4_0_0.ppn` | Natrénovaný wake word model |
| `com.nanoclaw.voice-daemon.plist` | launchd konfigurace |
| `venv/` | Python virtual environment (v .gitignore) |
