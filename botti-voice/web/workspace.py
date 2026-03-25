import asyncio
import base64
import json
import logging
import urllib.request
import urllib.error
from email.utils import parseaddr
from typing import Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from . import config

logger = logging.getLogger(__name__)


class WorkspaceClient:
    """Google Workspace API client using OAuth user credentials."""

    def __init__(self, refresh_token: str, client_id: str, client_secret: str):
        self._credentials = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
            scopes=[
                "https://www.googleapis.com/auth/gmail.modify",
                "https://www.googleapis.com/auth/calendar",
                "https://www.googleapis.com/auth/drive.readonly",
            ],
        )
        self._gmail = None
        self._calendar = None
        self._drive = None

    def _get_gmail(self):
        if not self._gmail:
            self._gmail = build("gmail", "v1", credentials=self._credentials)
        return self._gmail

    def _get_calendar(self):
        if not self._calendar:
            self._calendar = build("calendar", "v3", credentials=self._credentials)
        return self._calendar

    def _get_drive(self):
        if not self._drive:
            self._drive = build("drive", "v3", credentials=self._credentials)
        return self._drive

    async def dispatch(self, function_name: str, args: dict) -> dict:
        """Dispatch a function call from Gemini to the appropriate handler."""
        handlers = {
            "search_emails": self.search_emails,
            "read_email": self.read_email,
            "list_calendar_events": self.list_calendar_events,
            "create_calendar_event": self.create_calendar_event,
            "search_drive": self.search_drive,
            "send_email": self.send_email,
        }
        handler = handlers.get(function_name)
        if not handler:
            return {"error": f"Unknown function: {function_name}"}
        try:
            return await handler(**args)
        except Exception as e:
            logger.error(f"Workspace API error in {function_name}: {e}")
            return {"error": str(e)}

    async def search_emails(self, query: str, max_results: int = 5) -> dict:
        """Search Gmail messages."""
        def _search():
            gmail = self._get_gmail()
            result = gmail.users().messages().list(
                userId="me", q=query, maxResults=max_results
            ).execute()
            messages = result.get("messages", [])
            emails = []
            for msg in messages:
                detail = gmail.users().messages().get(
                    userId="me", id=msg["id"], format="metadata",
                    metadataHeaders=["Subject", "From", "Date"],
                ).execute()
                headers = {h["name"]: h["value"] for h in detail.get("payload", {}).get("headers", [])}
                emails.append({
                    "id": msg["id"],
                    "subject": headers.get("Subject", "(no subject)"),
                    "from": headers.get("From", ""),
                    "date": headers.get("Date", ""),
                    "snippet": detail.get("snippet", ""),
                })
            return emails

        emails = await asyncio.to_thread(_search)
        return {"emails": emails, "count": len(emails)}

    async def read_email(self, message_id: str) -> dict:
        """Read full email content."""
        def _read():
            gmail = self._get_gmail()
            msg = gmail.users().messages().get(
                userId="me", id=message_id, format="full"
            ).execute()
            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            body = _extract_body(msg.get("payload", {}))
            return {
                "id": message_id,
                "subject": headers.get("Subject", ""),
                "from": headers.get("From", ""),
                "to": headers.get("To", ""),
                "date": headers.get("Date", ""),
                "body": body[:3000],  # Limit body size for Gemini context
            }

        return await asyncio.to_thread(_read)

    async def list_calendar_events(self, time_min: str, time_max: str) -> dict:
        """List calendar events in a time range."""
        def _list():
            cal = self._get_calendar()
            result = cal.events().list(
                calendarId="primary",
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime",
                maxResults=20,
            ).execute()
            events = []
            for ev in result.get("items", []):
                start = ev.get("start", {}).get("dateTime", ev.get("start", {}).get("date", ""))
                end = ev.get("end", {}).get("dateTime", ev.get("end", {}).get("date", ""))
                attendees = [a.get("email", "") for a in ev.get("attendees", [])]
                events.append({
                    "id": ev.get("id", ""),
                    "summary": ev.get("summary", "(no title)"),
                    "start": start,
                    "end": end,
                    "location": ev.get("location", ""),
                    "attendees": attendees,
                })
            return events

        events = await asyncio.to_thread(_list)
        return {"events": events, "count": len(events)}

    async def create_calendar_event(
        self, summary: str, start: str, end: str, attendees: Optional[list] = None
    ) -> dict:
        """Create a calendar event."""
        def _create():
            cal = self._get_calendar()
            body = {
                "summary": summary,
                "start": {"dateTime": start},
                "end": {"dateTime": end},
            }
            if attendees:
                body["attendees"] = [{"email": email} for email in attendees]
            event = cal.events().insert(calendarId="primary", body=body).execute()
            return {
                "id": event.get("id", ""),
                "summary": event.get("summary", ""),
                "htmlLink": event.get("htmlLink", ""),
                "status": "created",
            }

        return await asyncio.to_thread(_create)

    async def send_email(self, to: str, subject: str, body: str, cc: str = "") -> dict:
        """Send email via agent-hub Cloud Run endpoint."""
        def _send():
            payload = json.dumps({
                "action": "send-email",
                "agent": "botti",
                "params": {"to": to, "subject": subject, "body": body, "cc": cc},
            }).encode()
            req = urllib.request.Request(
                f"{config.AGENT_HUB_URL}/agent-action",
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {config.AGENT_HUB_API_KEY}",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return {"error": f"HTTP {e.code}: {e.read().decode()[:200]}"}

        result = await asyncio.to_thread(_send)
        logger.info(f"send_email to={to} subject={subject}: {result.get('status', 'unknown')}")
        return result

    async def search_drive(self, query: str) -> dict:
        """Search Google Drive files."""
        def _search():
            drive = self._get_drive()
            # Escape single quotes in query
            safe_query = query.replace("'", "\\'")
            result = drive.files().list(
                q=f"name contains '{safe_query}'",
                pageSize=10,
                fields="files(id, name, mimeType, webViewLink, modifiedTime)",
            ).execute()
            return result.get("files", [])

        files = await asyncio.to_thread(_search)
        return {"files": files, "count": len(files)}


def _extract_body(payload: dict) -> str:
    """Extract plain text body from Gmail message payload."""
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")

    # Check parts recursively
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
        # Recurse into multipart
        if part.get("parts"):
            result = _extract_body(part)
            if result:
                return result

    # Fallback: try HTML
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/html" and part.get("body", {}).get("data"):
            html = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
            # Strip HTML tags (basic)
            import re
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text).strip()
            return text

    return ""
