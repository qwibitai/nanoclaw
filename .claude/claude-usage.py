#!/usr/bin/env python3
"""
Obtiene el uso de sesión de Claude Code desde la API de claude.ai
usando las cookies de Arc. Cachea el resultado 5 minutos.
Output: utilization_pct|resets_at_iso  (o vacío si falla)
"""
import sqlite3, subprocess, hashlib, json, http.client, ssl, os, sys, time
from datetime import datetime, timezone

CACHE_FILE = "/tmp/nanoclaw_claude_usage.json"
CACHE_TTL = 300  # 5 minutos

def get_cached():
    try:
        with open(CACHE_FILE) as f:
            d = json.load(f)
        if time.time() - d.get("ts", 0) < CACHE_TTL:
            return d.get("data")
    except Exception:
        pass
    return None

def save_cache(data):
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump({"ts": time.time(), "data": data}, f)
    except Exception:
        pass

def decrypt_cookie(encrypted_value, key):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend
    b = bytes(encrypted_value)
    if b[:3] != b'v10':
        return None
    cipher = Cipher(algorithms.AES(key), modes.CBC(b' ' * 16), backend=default_backend())
    decryptor = cipher.decryptor()
    raw = decryptor.update(b[3:]) + decryptor.finalize()
    pad_len = raw[-1]
    if 0 < pad_len <= 16:
        raw = raw[:-pad_len]
    if b'sk-ant-' in raw:
        idx = raw.find(b'sk-ant-')
        return raw[idx:].decode('ascii', errors='ignore')
    raw = raw[16:]
    for i in range(len(raw)):
        chunk = raw[i:i+8]
        if all(32 <= c < 127 for c in chunk):
            return raw[i:].decode('ascii', errors='ignore')
    return None

def fetch_usage():
    try:
        pw = subprocess.run(
            ['security', 'find-generic-password', '-s', 'Arc Safe Storage', '-w'],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if not pw:
            return None
        key = hashlib.pbkdf2_hmac('sha1', pw.encode(), b'saltysalt', 1003, dklen=16)
    except Exception:
        return None

    db_path = os.path.expanduser(
        "~/Library/Application Support/Arc/User Data/Default/Cookies"
    )
    try:
        conn = sqlite3.connect(f"file:{db_path}?immutable=1", uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name, encrypted_value FROM cookies "
            "WHERE host_key LIKE '%claude.ai%' AND name IN ('sessionKey', 'cf_clearance')"
        )
        cookies = {}
        for name, enc_val in cursor.fetchall():
            val = decrypt_cookie(enc_val, key)
            if val:
                cookies[name] = val
        conn.close()
    except Exception:
        return None

    if 'sessionKey' not in cookies:
        return None

    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    headers = {
        "Cookie": cookie_str,
        "Accept": "application/json",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Referer": "https://claude.ai/",
    }

    try:
        ctx = ssl.create_default_context()

        # Obtener org_id
        c = http.client.HTTPSConnection("claude.ai", context=ctx, timeout=8)
        c.request("GET", "/api/organizations", headers=headers)
        resp = c.getresponse()
        if resp.status != 200:
            return None
        orgs = json.loads(resp.read().decode())
        org_id = (orgs[0] if isinstance(orgs, list) else orgs).get("uuid")
        if not org_id:
            return None

        # Obtener usage
        c2 = http.client.HTTPSConnection("claude.ai", context=ctx, timeout=8)
        c2.request("GET", f"/api/organizations/{org_id}/usage", headers=headers)
        resp2 = c2.getresponse()
        if resp2.status != 200:
            return None
        usage = json.loads(resp2.read().decode())
        return usage
    except Exception:
        return None

def format_time_remaining(resets_at_iso):
    """Devuelve tiempo restante como '1h23m' o '45m'"""
    try:
        reset_time = datetime.fromisoformat(resets_at_iso)
        now = datetime.now(timezone.utc)
        diff = reset_time - now
        total_seconds = int(diff.total_seconds())
        if total_seconds <= 0:
            return "now"
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        if hours > 0:
            return f"{hours}h{minutes:02d}m"
        return f"{minutes}m"
    except Exception:
        return ""

def main():
    cached = get_cached()
    if cached is None:
        data = fetch_usage()
        if data:
            save_cache(data)
            cached = data

    if not cached:
        print("")
        return

    five_h = cached.get("five_hour") or {}
    utilization = five_h.get("utilization")
    resets_at = five_h.get("resets_at", "")

    parts = []
    if utilization is not None:
        parts.append(f"🔋{int(utilization)}%")
    if resets_at:
        remaining = format_time_remaining(resets_at)
        if remaining:
            parts.append(f"↺{remaining}")

    print(" ".join(parts))

if __name__ == "__main__":
    main()
