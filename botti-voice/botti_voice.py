"""
## Documentation
Quickstart: https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LiveAPI.py

## Setup

To install the dependencies for this script, run:

```
pip install google-genai opencv-python pyaudio pillow mss
```
"""

import os
import sys
import asyncio
import base64
import io
import traceback

import cv2
import pyaudio
import PIL.Image

import argparse

from google import genai
from google.genai import types
from google.genai.types import Type

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024

MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"

DEFAULT_MODE = "camera"

client = genai.Client(
    http_options={"api_version": "v1beta"},
    api_key=os.environ.get("GEMINI_API_KEY"),
)

tools = [
    types.Tool(google_search=types.GoogleSearch()),
    types.Tool(
        function_declarations=[
        ]
    ),
]

CONFIG = types.LiveConnectConfig(
    response_modalities=[
        "AUDIO",
    ],
    media_resolution="MEDIA_RESOLUTION_MEDIUM",
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
        )
    ),
    context_window_compression=types.ContextWindowCompressionConfig(
        trigger_tokens=104857,
        sliding_window=types.SlidingWindow(target_tokens=52428),
    ),
    tools=tools,
    system_instruction=types.Content(
        parts=[types.Part.from_text(text="""Tu es Botti, l'assistant IA personnel de Yacine Bakouche, en mode vocal.

## Identité et ton
- Français par défaut. Anglais si Yacine parle anglais ou si le contexte l'exige.
- Factuel, direct, dense. Zéro flatterie, zéro emojis, zéro "bien sûr", zéro "excellente question".
- Si tu ne sais pas, dis "je ne sais pas" et cherche immédiatement.
- Tutoie toujours Yacine. Jamais de vouvoiement.
- Réponses courtes en vocal : 3-4 phrases max sauf demande explicite de développement.
- Quand tu listes, 3 items max. Si il y en a plus, demande si tu continues.
- Pas de markdown en vocal — tu parles, tu ne rédiges pas.

## Qui est Yacine
PDG de Botler 360 (SaaS IA) et Best of Tours (tour opérateur UK/FR/Australie). Basé à Entraigues-sur-la-Sorgue, France. Fuseau Europe/Paris.

Yacine est HPI. Il pense en concepts et en structures, pas en images. Il fait des connexions transversales entre domaines — quand il passe du tourisme à la physique des marchés en une phrase, suis le fil, c'est intentionnel. Quand il propose une idée, c'est un plancher pas un plafond — ton rôle c'est d'étendre, croiser, challenger, pas de valider. Ne simplifie jamais sauf demande explicite. Si tu détectes une incohérence, dis-le directement sans diplomatie. Ses idées vont vite — si tu ne comprends pas un saut logique, demande une clarification plutôt que d'interpréter au rabais. Traite chaque échange comme une conversation entre pairs. Il code avec Claude Code (terminal), utilise ClaudAlex (Chrome) pour la navigation assistée, et Coco (Cowork) pour l'automatisation de fichiers et tâches desktop.

Il dicte souvent par voix — ses phrases peuvent être non-linéaires avec des artefacts de transcription. Interprète l'intention, ne demande pas de clarification sauf si c'est vraiment ambigu.

Emails : yacine@bestoftours.co.uk (pro), bakoucheyacine@gmail.com (perso).

## L'écosystème Botler / Best of Tours

### Les entités
- Best of Tours Ltd (UK) : tour opérateur, groupes internationaux, opérations UK/FR/Australie/Tunisie. Cœur historique du business.
- Best of Tours SAS (FR) : entité française
- Botler 360 SAS : véhicule tech/IA. Solutions SaaS — chatbots, assistants IA, plateformes de réservation et distribution pour tourisme et alimentaire.
- Teletravel : marque voyage
- Your Local Eye : plateforme d'expériences locales authentiques, connecte voyageurs et acteurs locaux
- Bot Events : gestion de délégations pour grands événements (COP notamment)
- TrobelAI : média IA/tourisme, ton éducatif + pragmatique + futuriste

### La vision long terme
Botler 360 construit l'infrastructure IA pour la distribution locale et le tourisme. Zero marginal cost appliqué à la circulation de l'information — connecter producteurs, distributeurs et consommateurs via l'IA. BigQuery + data sectorielle qualifiée = moat à 2-4 ans.

### Projets en cours (mars 2026)
- Marie Blachère B2B : marketplace commande/livraison boulangeries, en prod à Sorgues, commission 2-2,5%, cible 900 franchises via Rémi (responsable franchisés siège)
- NGE/SHIBA : partenariat innovation avec Josselin Quignon (Directeur Innovation NGE), agent "Accoucheur" déployé, lancement juin 2026
- COP31 Antalya : gestion hébergement délégations, novembre 2026, centre de conférence Sergi Alanı 2016
- Distribution locale : agrégation producteurs locaux (Marie Blachère, Marius, Maison Battue, Le Poisson Bleu, Clauvallis) vers B2B → B2B2C → B2C
- NanoClaw/Botti : agent IA personnel proactif, opérationnel depuis le 17 mars 2026

## Équipe Direction
- Eline Engelbracht : Directrice/COO, eline@bestoftours.co.uk — pilier stabilisateur, supervise opérations
- Ahmed Amdouni : CTO, ahmed@bestoftours.co.uk — catalyseur technique, stack GCP/Vertex AI/Cloud Run/BigQuery

## Équipe élargie
- Adam Nechab : commercial
- Maëva Proux : marketing
- Bernice Tomekowou : IA/prompts/chatbots
- Emna Amdouni : automatisation (sœur d'Ahmed)
- Vera/Flavera : data/analytics
- Pedro : apps/Matterport
- Firas : dev senior freelance
- Sabrina : opérations UK
- Équipes Indonésie (Charissa, Rika) et Tunisie (Emna, Amani)

## Stack technique
Claude Enterprise (stratégique via COSY), Claude Code (terminal/coding), ClaudAlex (Claude in Chrome, extension navigateur), Coco (Cowork, automatisation desktop), Vertex AI, GCP/Cloud Run, BigQuery, Firebase/Firestore, Google Workspace, GitHub (Yacine0801), Next.js/React/TypeScript/Tailwind, Stripe, Expo/React Native

## Le COSY
Le COSY est le Chief of Staff IA stratégique de Yacine, séparé de toi. Il tourne sur Claude Enterprise avec mémoire longue depuis janvier 2026. Son rôle : stratégie, décisions de direction, cadrage projets, conseil. Ton rôle : exécution opérationnelle — briefings, recherches, alertes, tâches concrètes. Complémentaires, pas en concurrence. Si Yacine pose une question stratégique profonde, suggère-lui d'en parler avec le COSY.

## Principes
- Commercial : NE PAS expliquer, FAIRE et apporter les résultats. Zéro risque client.
- Technique : Prod = Pipeline Only. Pas de Zapier/Make si on peut faire avec Apps Script. Dates ISO.
- Organisation : Mode Usine. Builders vs Maintainers. Démontrer > Expliquer.
- Productivité : Yacine/Ahmed + IA = production réelle. Ne jamais estimer en dev humain classique.

## Règles critiques
- Utilise TOUJOURS la recherche Google quand tu ne connais pas un fait ou que le sujet est récent. Ne mentionne jamais ta date de coupure de connaissances — cherche.
- Relis attentivement tout ton contexte avant de dire "je ne sais pas" — la réponse est peut-être déjà dans tes instructions.
- Signe les emails avec "Yacine Bakouche" et "Best of Tours" ou "Botler 360" selon le contexte, sauf indication contraire.
- Si Yacine dit "note ça" ou "retiens ça", confirme et écris-le en mémoire (Firestore ou CLAUDE.md).
- Si Yacine te demande d'envoyer un message ou un email, reformule ce que tu vas envoyer et attends sa confirmation.
- Quand tu proposes une action, donne le "et ensuite?" — l'étape d'après.
- Ne partage jamais d'informations personnelles de Yacine avec des tiers.

## Ce que tu ne sais PAS
- Détails financiers des sociétés (CA, marges, trésorerie)
- Tensions RH ou évaluations individuelles
- Historique des conversations COSY
- Données médicales ou personnelles de la famille
- Accords contractuels confidentiels COP31

Si on te pose une question sur ces sujets, dis que tu n'as pas cette information et propose de demander au COSY.""")],
        role="user"
    ),
)

pya = pyaudio.PyAudio()


def list_audio_devices():
    """Print all available audio devices and exit."""
    print("\nAvailable audio devices:\n")
    for i in range(pya.get_device_count()):
        info = pya.get_device_info_by_index(i)
        direction = []
        if info["maxInputChannels"] > 0:
            direction.append("IN")
        if info["maxOutputChannels"] > 0:
            direction.append("OUT")
        print(f"  [{i}] {info['name']}  ({'/'.join(direction)})")
    print()


class AudioLoop:
    def __init__(self, video_mode=DEFAULT_MODE, input_device=None, output_device=None):
        self.video_mode = video_mode
        self.input_device = input_device
        self.output_device = output_device

        self.audio_in_queue = None
        self.out_queue = None

        self.session = None

        self.send_text_task = None
        self.receive_audio_task = None
        self.play_audio_task = None

        self.audio_stream = None

        # Half-duplex: mic is suppressed while audio plays back
        self._mic_enabled = asyncio.Event()
        self._mic_enabled.set()  # Start with mic enabled

    async def send_text(self):
        while True:
            text = await asyncio.to_thread(
                input,
                "message > ",
            )
            if text.lower() == "q":
                break
            if self.session is not None:
                await self.session.send(input=text or ".", end_of_turn=True)

    def _get_frame(self, cap):
        ret, frame = cap.read()
        if not ret:
            return None
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = PIL.Image.fromarray(frame_rgb)
        img.thumbnail([1024, 1024])

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        mime_type = "image/jpeg"
        image_bytes = image_io.read()
        return {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}

    async def get_frames(self):
        cap = await asyncio.to_thread(
            cv2.VideoCapture, 0
        )

        while True:
            frame = await asyncio.to_thread(self._get_frame, cap)
            if frame is None:
                break

            await asyncio.sleep(1.0)

            if self.out_queue is not None:
                await self.out_queue.put(frame)

        cap.release()

    def _get_screen(self):
        try:
            import mss
        except ImportError as e:
            raise ImportError("Please install mss package using 'pip install mss'") from e
        sct = mss.mss()
        monitor = sct.monitors[0]

        i = sct.grab(monitor)

        mime_type = "image/jpeg"
        image_bytes = mss.tools.to_png(i.rgb, i.size)
        img = PIL.Image.open(io.BytesIO(image_bytes))

        image_io = io.BytesIO()
        img.save(image_io, format="jpeg")
        image_io.seek(0)

        image_bytes = image_io.read()
        return {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode()}

    async def get_screen(self):

        while True:
            frame = await asyncio.to_thread(self._get_screen)
            if frame is None:
                break

            await asyncio.sleep(1.0)

            if self.out_queue is not None:
                await self.out_queue.put(frame)

    async def send_realtime(self):
        while True:
            if self.out_queue is not None:
                msg = await self.out_queue.get()
                if self.session is not None:
                    await self.session.send(input=msg)

    async def listen_audio(self):
        if self.input_device is not None:
            device_index = self.input_device
        else:
            mic_info = pya.get_default_input_device_info()
            device_index = mic_info["index"]

        self.audio_stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=SEND_SAMPLE_RATE,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=CHUNK_SIZE,
        )
        if __debug__:
            kwargs = {"exception_on_overflow": False}
        else:
            kwargs = {}
        while True:
            data = await asyncio.to_thread(self.audio_stream.read, CHUNK_SIZE, **kwargs)
            # Half-duplex: only send mic data when not playing back audio
            if self._mic_enabled.is_set() and self.out_queue is not None:
                await self.out_queue.put({"data": data, "mime_type": "audio/pcm"})

    async def receive_audio(self):
        "Background task to reads from the websocket and write pcm chunks to the output queue"
        while True:
            if self.session is not None:
                turn = self.session.receive()
                async for response in turn:
                    if data := response.data:
                        self.audio_in_queue.put_nowait(data)
                        continue
                    if text := response.text:
                        print(text, end="")

                # If you interrupt the model, it sends a turn_complete.
                # For interruptions to work, we need to stop playback.
                # So empty out the audio queue because it may have loaded
                # much more audio than has played yet.
                while not self.audio_in_queue.empty():
                    self.audio_in_queue.get_nowait()

    async def play_audio(self):
        output_kwargs = {}
        if self.output_device is not None:
            output_kwargs["output_device_index"] = self.output_device

        stream = await asyncio.to_thread(
            pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=RECEIVE_SAMPLE_RATE,
            output=True,
            **output_kwargs,
        )
        while True:
            if self.audio_in_queue is not None:
                bytestream = await self.audio_in_queue.get()
                # Suppress mic while playing to prevent echo
                self._mic_enabled.clear()
                await asyncio.to_thread(stream.write, bytestream)
                # Re-enable mic after a brief grace period if no more audio queued
                if self.audio_in_queue.empty():
                    await asyncio.sleep(0.15)
                    self._mic_enabled.set()

    async def run(self):
        try:
            async with (
                client.aio.live.connect(model=MODEL, config=CONFIG) as session,
                asyncio.TaskGroup() as tg,
            ):
                self.session = session

                self.audio_in_queue = asyncio.Queue()
                self.out_queue = asyncio.Queue(maxsize=5)

                send_text_task = tg.create_task(self.send_text())
                tg.create_task(self.send_realtime())
                tg.create_task(self.listen_audio())
                if self.video_mode == "camera":
                    tg.create_task(self.get_frames())
                elif self.video_mode == "screen":
                    tg.create_task(self.get_screen())

                tg.create_task(self.receive_audio())
                tg.create_task(self.play_audio())

                await send_text_task
                raise asyncio.CancelledError("User requested exit")

        except asyncio.CancelledError:
            pass
        except ExceptionGroup as EG:
            if self.audio_stream is not None:
                self.audio_stream.close()
                traceback.print_exception(EG)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        type=str,
        default=DEFAULT_MODE,
        help="pixels to stream from",
        choices=["camera", "screen", "none"],
    )
    parser.add_argument(
        "--input-device",
        type=int,
        default=None,
        help="PyAudio input device index (use --list-devices to see)",
    )
    parser.add_argument(
        "--output-device",
        type=int,
        default=None,
        help="PyAudio output device index (use --list-devices to see)",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio devices and exit",
    )
    args = parser.parse_args()

    if args.list_devices:
        list_audio_devices()
        sys.exit(0)

    main = AudioLoop(
        video_mode=args.mode,
        input_device=args.input_device,
        output_device=args.output_device,
    )
    asyncio.run(main.run())
