import os
import time
import logging
from typing import Optional

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from authlib.integrations.starlette_client import OAuth

from .config import ALLOWED_EMAILS, ACCESS_PIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

logger = logging.getLogger(__name__)

oauth_router = APIRouter(prefix="/auth")

oauth = OAuth()

# Only register Google OAuth if credentials are configured
if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


PIN_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Botti Voice - PIN</title>
    <style>
        body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
        .card { background: #1a1a1a; padding: 2rem; border-radius: 12px; text-align: center; }
        input { font-size: 1.5rem; padding: 0.5rem 1rem; text-align: center; letter-spacing: 0.3em; width: 8rem; border: 1px solid #333; border-radius: 8px; background: #0a0a0a; color: #fff; }
        button { font-size: 1rem; padding: 0.5rem 2rem; margin-top: 1rem; border: none; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
        button:hover { background: #1d4ed8; }
        .error { color: #ef4444; margin-top: 0.5rem; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Code PIN</h2>
        <form method="POST" action="/auth/verify-pin">
            <input type="password" name="pin" maxlength="8" autofocus inputmode="numeric" pattern="[0-9]*">
            <br>
            <button type="submit">Valider</button>
        </form>
    </div>
</body>
</html>"""

LOGIN_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Botti Voice - Login</title>
    <style>
        body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
        .card { background: #1a1a1a; padding: 2rem; border-radius: 12px; text-align: center; }
        a { display: inline-block; padding: 0.75rem 2rem; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-size: 1.1rem; }
        a:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Botti Voice</h2>
        <p>Connexion requise</p>
        <a href="/auth/google-login">Se connecter avec Google</a>
    </div>
</body>
</html>"""


@oauth_router.get("/login")
async def login_page(request: Request):
    if not GOOGLE_CLIENT_ID:
        # Dev mode: skip auth
        request.session["user_email"] = "dev@local"
        request.session["pin_verified"] = True
        return RedirectResponse("/")
    return HTMLResponse(LOGIN_PAGE)


@oauth_router.get("/google-login")
async def google_login(request: Request):
    if not GOOGLE_CLIENT_ID:
        request.session["user_email"] = "dev@local"
        request.session["pin_verified"] = True
        return RedirectResponse("/")
    redirect_uri = request.url_for("auth_callback")
    return await oauth.google.authorize_redirect(request, str(redirect_uri))


@oauth_router.get("/callback")
async def auth_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    user_info = token.get("userinfo")

    if not user_info:
        raise HTTPException(status_code=403, detail="Could not retrieve user info")

    email = user_info.get("email", "")
    if email not in ALLOWED_EMAILS:
        logger.warning(f"Access denied for email: {email}")
        raise HTTPException(status_code=403, detail="Access denied")

    request.session["user_email"] = email
    request.session["user_name"] = user_info.get("name", "")
    request.session["authenticated_at"] = time.time()

    if ACCESS_PIN:
        return RedirectResponse("/auth/pin")

    request.session["pin_verified"] = True
    return RedirectResponse("/")


@oauth_router.get("/pin")
async def pin_page(request: Request):
    if "user_email" not in request.session:
        return RedirectResponse("/auth/login")
    return HTMLResponse(PIN_PAGE)


@oauth_router.post("/verify-pin")
async def verify_pin(request: Request):
    if "user_email" not in request.session:
        return RedirectResponse("/auth/login")
    form = await request.form()
    if form.get("pin") != ACCESS_PIN:
        raise HTTPException(status_code=403, detail="Invalid PIN")
    request.session["pin_verified"] = True
    return RedirectResponse("/", status_code=303)


@oauth_router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/auth/login")


def verify_session(request: Request) -> Optional[str]:
    """Check if request has valid session. Returns email or None."""
    email = request.session.get("user_email")
    if not email:
        return None
    # In dev mode (no OAuth configured), allow any session
    if not GOOGLE_CLIENT_ID:
        return email
    if email not in ALLOWED_EMAILS:
        return None
    if ACCESS_PIN and not request.session.get("pin_verified"):
        return None
    return email
