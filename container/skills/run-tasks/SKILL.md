---
name: run-tasks
description: Führe alle offenen Anytype-Tasks aus Michael's Space aus. Triggered by /run-tasks or the daily scheduled task at 05:00 CEST.
---

# /run-tasks — Anytype Aufgaben ausführen

Führe alle offenen Tasks aus Michael's Anytype Space aus. Identisch für manuellen Aufruf (`/run-tasks`) und den täglichen Scheduled Task um 05:00 CEST.

## Anytype Referenzdaten

```
Space ID:          bafyreictsp2ahpo3f2ep32tsps74ah2r2fq2r77kojq2pzltrrpdbzqwwa.1w9mqjykj7ob2
API Base URL:      $ANYTYPE_API_BASE_URL
Auth:              Bearer $ANYTYPE_API_KEY
Task Type Key:     task
Ergebnis Type Key: ergebnis
Status Prop Key:   status
  → "To Do"          key: 63454ad0c493f68e301890db
  → "In Bearbeitung" key: (beim ersten Run prüfen / aus API ermitteln)
  → "Done"           key: 63454af7c493f68e301890dd
```

## Workflow

### Schritt 1: Alle Tasks mit Status "To Do" abrufen

```bash
curl -s --noproxy '*' \
  -H "Authorization: Bearer $ANYTYPE_API_KEY" \
  "$ANYTYPE_API_BASE_URL/v1/spaces/bafyreictsp2ahpo3f2ep32tsps74ah2r2fq2r77kojq2pzltrrpdbzqwwa.1w9mqjykj7ob2/objects?limit=100"
```

Filtere: `type.key == "task"` UND `properties[status].select.key == "63454ad0c493f68e301890db"`

Falls kein Task mit "To Do" gefunden: Kurze Meldung an Michael und Ende.

### Schritt 2: Für jeden Task

**a) Status auf "In Bearbeitung" setzen:**
```bash
curl -s --noproxy '*' -X PATCH \
  -H "Authorization: Bearer $ANYTYPE_API_KEY" -H "Content-Type: application/json" \
  "$ANYTYPE_API_BASE_URL/v1/spaces/{SPACE_ID}/objects/{TASK_ID}" \
  -d '{"properties": [{"key": "status", "select": {"key": "{IN_BEARBEITUNG_KEY}"}}]}'
```

**b) Task-Inhalt aus `object.markdown` lesen und ausführen.**
- Der Markdown enthält die eigentliche Aufgabenbeschreibung.
- Dateien/Bilder unter `http://127.0.0.1:47800/` sind aus dem Container nicht erreichbar → im Ergebnis vermerken.
- Aufgaben können sein: Recherche, Dokumente erstellen, Daten analysieren, API-Abfragen, etc. — eigenständig beurteilen und ausführen.

**c) Ergebnis-Objekt in Anytype erstellen:**
```bash
curl -s --noproxy '*' -X POST \
  -H "Authorization: Bearer $ANYTYPE_API_KEY" -H "Content-Type: application/json" \
  "$ANYTYPE_API_BASE_URL/v1/spaces/{SPACE_ID}/objects" \
  -d '{
    "type_key": "ergebnis",
    "name": "Ergebnis: {TASK_NAME}",
    "body": "## Ergebnis\n**Task:** {TASK_NAME} ({TASK_ID})\n**Erstellt:** {DATUM}\n\n{ERGEBNIS_INHALT}"
  }'
```

Format des Ergebnis-Inhalts:
```
## Ergebnis
**Task:** <Name> (<ID>)
**Erstellt:** <kurze Beschreibung was erstellt/gefunden wurde>

<Detaillierter Inhalt / Zusammenfassung der Ergebnisse>

Quelle: <genutzte Quellen>
```

**d) Status auf "Done" setzen + Done-Checkbox aktivieren:**
```bash
curl -s --noproxy '*' -X PATCH \
  -H "Authorization: Bearer $ANYTYPE_API_KEY" -H "Content-Type: application/json" \
  "$ANYTYPE_API_BASE_URL/v1/spaces/{SPACE_ID}/objects/{TASK_ID}" \
  -d '{"properties": [{"key": "status", "select": {"key": "63454af7c493f68e301890dd"}}, {"key": "done", "checkbox": true}]}'
```

### Schritt 3: Abschlussbericht an Michael

Nach allen Tasks eine Zusammenfassung senden:
- Anzahl gefundener / abgearbeiteter Tasks
- Je Task: Name + Kurzbeschreibung des Ergebnisses + Link zum Ergebnis-Objekt (falls verfügbar)
- Allfällige Probleme (nicht erreichbare Dateien, API-Fehler, etc.)

## Limitierungen

- Dateien/Bilder die in Tasks via `http://127.0.0.1:47800/` referenziert werden, sind aus dem Container heraus nicht lesbar. Dies im Ergebnis-Objekt und im Bericht vermerken.
- Aufgaben die externe Services erfordern, die nicht verfügbar sind, entsprechend kennzeichnen.
