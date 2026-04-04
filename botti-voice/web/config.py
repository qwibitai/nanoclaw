import os
import logging
from typing import Optional
from dotenv import load_dotenv
from google.genai import types

load_dotenv()

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "models/gemini-2.5-flash-native-audio-latest")

# NanoClaw memory integration — load CLAUDE.md from agent groups
NANOCLAW_MEMORY_PATHS = {
    "botti": os.environ.get("NANOCLAW_BOTTI_MEMORY", "/app/memory/botti/CLAUDE.md"),
    "sam": os.environ.get("NANOCLAW_SAM_MEMORY", "/app/memory/sam/CLAUDE.md"),
    "thais": os.environ.get("NANOCLAW_THAIS_MEMORY", "/app/memory/thais/CLAUDE.md"),
}

VOICE_PREAMBLE = """Tu es en mode vocal.
- Tutoie toujours Yacine. Jamais de vouvoiement.
- Français par défaut. Anglais si Yacine parle anglais ou si le contexte l'exige.
- Factuel, direct, dense. Zéro flatterie, zéro "bien sûr", zéro "excellente question".
- Réponses courtes : 3-4 phrases max sauf demande explicite de développement.
- Quand tu listes, 3 items max. Si il y en a plus, demande si tu continues.
- Pas de markdown en vocal — tu parles, tu ne rédiges pas."""


def load_agent_memory(agent_name: str) -> Optional[str]:
    """Load CLAUDE.md for the given agent from NanoClaw group folder."""
    path = NANOCLAW_MEMORY_PATHS.get(agent_name)
    if not path:
        return None
    try:
        with open(path, "r") as f:
            return f.read()
    except FileNotFoundError:
        logger.warning("Memory file not found for %s: %s", agent_name, path)
        return None

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REFRESH_TOKEN = os.environ.get("GOOGLE_REFRESH_TOKEN", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", os.urandom(32).hex())

# Only these emails can access the app
ALLOWED_EMAILS = {
    "bakoucheyacine@gmail.com",
    "yacine@bestoftours.co.uk",
}

# Optional PIN as second factor (empty = disabled)
ACCESS_PIN = os.environ.get("BOTTI_PIN", "")

SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000

# Google Workspace function declarations for Gemini Live
WORKSPACE_FUNCTIONS = [
    types.FunctionDeclaration(
        name="search_emails",
        description="Chercher des emails dans Gmail (boîte de yacine@bestoftours.co.uk). Syntaxe Gmail : from:, subject:, after:YYYY/MM/DD, newer_than:1h, is:unread, etc. IMPORTANT : pour les emails récents, utilise 'newer_than:2h' ou 'newer_than:1d' plutôt que 'after:' qui ignore l'heure. Fuseau Europe/Paris.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "query": types.Schema(type="STRING", description="Requête de recherche Gmail. Ex: 'newer_than:2h' pour les 2 dernières heures, 'is:unread' pour non lus, 'from:eline' pour les emails d'Eline"),
                "max_results": types.Schema(type="INTEGER", description="Nombre max de résultats (défaut 5)"),
            },
            required=["query"],
        ),
    ),
    types.FunctionDeclaration(
        name="read_email",
        description="Lire le contenu complet d'un email par son ID (obtenu via search_emails)",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "message_id": types.Schema(type="STRING", description="ID du message Gmail"),
            },
            required=["message_id"],
        ),
    ),
    types.FunctionDeclaration(
        name="list_calendar_events",
        description="Lister les événements du calendrier entre deux dates. Utilise le fuseau Europe/Paris.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "time_min": types.Schema(type="STRING", description="Date/heure de début (ISO 8601, ex: 2026-03-18T00:00:00+01:00)"),
                "time_max": types.Schema(type="STRING", description="Date/heure de fin (ISO 8601, ex: 2026-03-19T00:00:00+01:00)"),
            },
            required=["time_min", "time_max"],
        ),
    ),
    types.FunctionDeclaration(
        name="create_calendar_event",
        description="Créer un événement dans le calendrier Google. Utilise le fuseau Europe/Paris.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "summary": types.Schema(type="STRING", description="Titre de l'événement"),
                "start": types.Schema(type="STRING", description="Date/heure de début (ISO 8601, ex: 2026-03-19T14:00:00+01:00)"),
                "end": types.Schema(type="STRING", description="Date/heure de fin (ISO 8601, ex: 2026-03-19T15:00:00+01:00)"),
                "attendees": types.Schema(
                    type="ARRAY",
                    items=types.Schema(type="STRING"),
                    description="Liste d'emails des participants (optionnel)",
                ),
            },
            required=["summary", "start", "end"],
        ),
    ),
    types.FunctionDeclaration(
        name="search_drive",
        description="Chercher des fichiers dans Google Drive par nom",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "query": types.Schema(type="STRING", description="Terme de recherche"),
            },
            required=["query"],
        ),
    ),
    types.FunctionDeclaration(
        name="send_email",
        description="Envoyer un email depuis sam@bestoftours.co.uk. Emails internes (@bestoftours.co.uk) envoyés directement. Emails externes créés en brouillon pour review.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "to": types.Schema(type="STRING", description="Adresse email du destinataire"),
                "subject": types.Schema(type="STRING", description="Sujet de l'email"),
                "body": types.Schema(type="STRING", description="Corps de l'email en texte brut"),
                "cc": types.Schema(type="STRING", description="CC optionnel"),
            },
            required=["to", "subject", "body"],
        ),
    ),
]

# Agent Hub Cloud Run endpoint for outbound actions
AGENT_HUB_URL = os.environ.get("AGENT_HUB_URL", "https://agent-hub-215323664878.europe-west1.run.app")
AGENT_HUB_API_KEY = os.environ.get("AGENT_HUB_API_KEY", "")

SYSTEM_PROMPT = """Tu es Botti, l'assistant IA personnel de Yacine Bakouche, en mode vocal.

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

Si on te pose une question sur ces sujets, dis que tu n'as pas cette information et propose de demander au COSY."""
