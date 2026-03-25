"""
triage_engine.py — Gemini 2.5 Flash triage via Vertex AI.
Classifies emails and chat messages into: IGNORE / NOTIFY / DRAFT / RESPOND / ESCALATE.
"""
import json
import logging
import os
import urllib.error
import urllib.request

import cost_tracker

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = "gemini-2.5-flash"


def call_gemini(prompt: str, system: str = "", agent_id: str = "unknown") -> str:
    """Call Gemini 2.5 Flash via Google AI API. Returns response text."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_API_KEY}"

    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        },
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    req_data = json.dumps(body).encode()
    logger.info(f"[{agent_id}] Gemini request -> {MODEL} ({len(req_data)} bytes)")

    req = urllib.request.Request(url, data=req_data, headers={
        "Content-Type": "application/json",
    }, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()[:500]
        logger.error(f"[{agent_id}] Gemini HTTP {e.code}: {error_body}")
        raise

    text = result["candidates"][0]["content"]["parts"][0]["text"]
    logger.info(f"[{agent_id}] Gemini response OK ({len(text)} chars)")

    # Track cost (use usageMetadata if available, fallback to char estimate)
    usage = result.get("usageMetadata", {})
    input_tokens = usage.get("promptTokenCount", (len(prompt) + len(system)) // 4)
    output_tokens = usage.get("candidatesTokenCount", len(text) // 4)
    cost_tracker.track(agent_id, "gemini", MODEL, input_tokens, output_tokens)

    return text


def parse_json_response(raw: str) -> list:
    """Parse Gemini JSON response, handling markdown code blocks and trailing commas."""
    clean = raw.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1].rsplit("```", 1)[0]
    # Fix trailing commas before } or ] (common Gemini quirk)
    import re
    clean = re.sub(r',\s*([}\]])', r'\1', clean)
    return json.loads(clean)


# ---------- Email triage ----------

EMAIL_TRIAGE_SYSTEM = """You are an email triage assistant. Classify each email into exactly one action:

- IGNORE: newsletters, automated notifications, spam, noreply, marketing.
- NOTIFY: important emails the user should know about but that don't need a reply.
- DRAFT: emails that need a response but the agent cannot send directly (external contacts, sensitive topics). Draft a suggested reply.
- RESPOND: emails from internal team/known contacts that expect a reply. Include suggested_reply.
- ESCALATE: complex emails requiring strategic thinking, contract decisions, sensitive topics.

Return a JSON array. Each element:
{"id": "msg_id", "action": "IGNORE|NOTIFY|DRAFT|RESPOND|ESCALATE", "urgency": "LOW|MEDIUM|HIGH", "summary": "1 line", "suggested_reply": "if DRAFT or RESPOND"}

Be conservative: when in doubt, NOTIFY rather than IGNORE, ESCALATE rather than RESPOND."""


def triage_emails(emails: list, agent_config: dict) -> list:
    """Classify a batch of emails via Gemini Flash."""
    if not emails:
        return []

    agent_id = agent_config.get("name", "unknown")
    context = f"Agent: {agent_config.get('display_name', agent_id)}"

    urgent = agent_config.get("gmail_urgent_senders", [])
    important = agent_config.get("gmail_important_senders", [])
    whitelist = agent_config.get("recipient_whitelist", [])
    ext_mode = agent_config.get("external_comms", "blocked")

    if urgent:
        context += f"\nUrgent senders: {', '.join(urgent)}"
    if important:
        context += f"\nImportant senders: {', '.join(important)}"
    context += f"\nExternal comms mode: {ext_mode}"
    if ext_mode != "autonomous":
        context += "\nFor external senders not in whitelist, use DRAFT (never RESPOND)"

    email_text = "\n\n".join([
        f"[ID: {e['id']}]\nFrom: {e['from']}\nSubject: {e['subject']}\n"
        f"Date: {e.get('date', '')}\nSnippet: {e.get('snippet', '')}"
        for e in emails
    ])

    prompt = f"Agent context:\n{context}\n\nEmails to classify:\n\n{email_text}"

    try:
        raw = call_gemini(prompt, system=EMAIL_TRIAGE_SYSTEM, agent_id=agent_id)
        result = parse_json_response(raw)
        logger.info(f"[{agent_id}] Gemini triage OK: {len(result)} classifications")
        return result
    except json.JSONDecodeError as exc:
        logger.error(f"[{agent_id}] Gemini JSON parse failed: {exc}\nRaw response: {raw[:500] if 'raw' in dir() else 'N/A'}")
        return [{"id": em["id"], "action": "NOTIFY", "urgency": "MEDIUM",
                 "summary": em.get("subject", "")} for em in emails]
    except Exception as exc:
        logger.error(f"[{agent_id}] Gemini email triage FAILED (fallback to NOTIFY): {exc}", exc_info=True)
        return [{"id": em["id"], "action": "NOTIFY", "urgency": "MEDIUM",
                 "summary": em.get("subject", "")} for em in emails]


# ---------- Chat triage ----------

CHAT_TRIAGE_SYSTEM = """You are a chat message triage assistant. For each message, decide:

- IGNORE: bot messages, automated notifications, messages not directed at the agent.
- RESPOND: messages from team members that expect a reply. Provide the reply text. Concise and professional.
- ESCALATE: complex questions requiring strategic analysis or sensitive decisions.

Return a JSON array. Each element:
{"id": "msg_id", "action": "IGNORE|RESPOND|ESCALATE", "summary": "1 line", "reply": "only if RESPOND"}

All chat is internal — reply directly when appropriate."""


CHAT_BATCH_SIZE = 15


def triage_chat(messages: list, agent_config: dict) -> list:
    """Classify chat messages via Gemini Flash, batched to avoid output truncation."""
    if not messages:
        return []

    all_results = []
    for i in range(0, len(messages), CHAT_BATCH_SIZE):
        batch = messages[i:i + CHAT_BATCH_SIZE]
        results = _triage_chat_batch(batch, agent_config)
        all_results.extend(results)
    return all_results


def _triage_chat_batch(messages: list, agent_config: dict) -> list:
    agent_id = agent_config.get("name", "unknown")
    context = f"Agent: {agent_config.get('display_name', agent_id)}"

    msg_text = "\n\n".join([
        f"[ID: {m['id']}] [Space: {m.get('space_name', '')}]\n"
        f"Sender: {m.get('sender_name', 'unknown')}\n"
        f"Text: {m.get('text', '')}"
        for m in messages
    ])

    prompt = f"Agent context:\n{context}\n\nMessages:\n\n{msg_text}"

    try:
        raw = call_gemini(prompt, system=CHAT_TRIAGE_SYSTEM, agent_id=agent_id)
        result = parse_json_response(raw)
        logger.info(f"[{agent_id}] Gemini chat triage OK: {len(result)} classifications")
        return result
    except json.JSONDecodeError as exc:
        logger.error(f"[{agent_id}] Gemini chat JSON parse failed: {exc}\nRaw: {raw[:500] if 'raw' in dir() else 'N/A'}")
        return [{"id": m["id"], "action": "IGNORE", "summary": ""} for m in messages]
    except Exception as exc:
        logger.error(f"[{agent_id}] Gemini chat triage FAILED (fallback to IGNORE): {exc}", exc_info=True)
        return [{"id": m["id"], "action": "IGNORE", "summary": ""} for m in messages]
