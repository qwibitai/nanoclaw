---
name: run-tasks
description: Führe alle offenen Anytype-Tasks aus Alfred's Anytype Space aus. Triggered by /run-tasks or the daily scheduled task at 05:00 CEST.
---

# /run-tasks — Anytype Aufgaben ausführen

Führe alle offenen Tasks aus Alfred's Anytype Space aus. Identisch für manuellen Aufruf (`/run-tasks`) und den täglichen Scheduled Task um 05:00 CEST.

## Anytype Referenzdaten

```
Space ID:      bafyreictsp2ahpo3f2ep32tsps74ah2r2fq2r77kojq2pzltrrpdbzqwwa.1w9mqjykj7ob2
Type Key:      task
Ergebnis Key:  ergebnis

Status-Tag-IDs (für properties[].select):
  To Do:       bafyreigfstw523yrjoosmj32kqgsf52tdt4syxsxwcw6xxjbpmfb7pusc4
  In Progress: bafyreic5v5kryg4iyxqr2jemutj2ndsfzavrvhuvuwli3tsdvspeksmv4a
  Done:        bafyreiguvcivobecabxrfjaaargqeo2hhbn3nxqwgr4vqgueypbxyj4tiy

Properties:
  status:      select (Tag-ID)
  done:        checkbox
```

## Workflow

### Schritt 1: Tasks abrufen und filtern

```
mcp__anytype__API-search-space(space_id=..., types=["task"])
```

Filtere: Tasks mit Status "To Do" oder "In Progress". Tasks ohne Status werden ignoriert.

Falls keine relevanten Tasks: Ende ohne Benachrichtigung.

### Schritt 2: Für jeden Task

**a) Status auf "In Progress" setzen** (nur wenn aktuell "To Do"):
```
mcp__anytype__API-update-object(
  space_id=..., object_id=<TASK_ID>,
  properties=[{"key": "status", "select": "bafyreic5v5kryg4iyxqr2jemutj2ndsfzavrvhuvuwli3tsdvspeksmv4a"}]
)
```

**b) Task-Inhalt lesen:**
```
mcp__anytype__API-get-object(space_id=..., object_id=<TASK_ID>)
```

Den `markdown`-Inhalt lesen und eigenständig ausführen mit allen verfügbaren Tools.

Einschränkungen: Dateien/Bilder unter `http://127.0.0.1:47800/` nicht erreichbar → im Ergebnis vermerken.

**c) Bestehendes Ergebnis-Objekt suchen:**
```
mcp__anytype__API-search-space(space_id=..., query="Ergebnis: <TASK_NAME>", types=["ergebnis"])
```

**Fall 1 — Ergebnis existiert bereits:** Aktuelles Markdown lesen, Changelog-Tabelle oben ergänzen:
- Bei neuen Ergebnissen: neue Changelog-Zeile + aktualisierten Ergebnis-Abschnitt anhängen
- Bei keinen neuen Ergebnissen (z.B. wiederkehrender Task ohne Änderungen): nur neue Changelog-Zeile, kein neuer Content-Block

```
mcp__anytype__API-update-object(
  space_id=..., object_id=<ERGEBNIS_ID>,
  markdown=<aktualisiertes Markdown>
)
```

**Fall 2 — Ergebnis existiert noch nicht:** Neues Objekt erstellen:
```
mcp__anytype__API-create-object(
  space_id=..., type_key="ergebnis",
  name="Ergebnis: <TASK_NAME>",
  body="<vollständiges Markdown (siehe Format)>"
)
```

**Ergebnis-Dokument Format:**
```markdown
## Changelog
| Datum | Status | Zusammenfassung |
|-------|--------|-----------------|
| 2026-05-05T05:00 | Done | <einzeilige Zusammenfassung> |

## Ergebnis

**Task:** <TASK_NAME> (anytype://object/<TASK_ID>)

<Detaillierter Inhalt des letzten relevanten Laufs>

Quelle: <genutzte Quellen>
```

Bei mehreren Läufen wird eine neue Zeile **oben** in die Changelog-Tabelle eingefügt (neuester Eintrag zuerst). Falls keine neuen Ergebnisse: Changelog-Zeile mit Zusammenfassung "Keine neuen Ergebnisse", kein neuer Ergebnis-Abschnitt.

**d) Status abschliessend setzen:**

- **Einmalige Aufgabe** → Done + Checkbox:
```
mcp__anytype__API-update-object(
  space_id=..., object_id=<TASK_ID>,
  properties=[
    {"key": "status", "select": "bafyreiguvcivobecabxrfjaaargqeo2hhbn3nxqwgr4vqgueypbxyj4tiy"},
    {"key": "done", "checkbox": true}
  ]
)
```

- **Wiederkehrende Aufgabe** → "In Progress" belassen (kein Statuswechsel nötig).

### Schritt 3: Benachrichtigung

#### Bei scheduled run: 
**Nur bei Fehlern:** Michael benachrichtigen mit Fehlerbeschreibung und betroffenen Tasks. Bei fehlerfreiem Lauf: keine Benachrichtigung.

#### Bei manual run via /run-tasks:
Sende Michael eine kurze Zusammenfassung: Wie viele Tasks bearbeitet, wie viele beendet ("Done"), wie viele weiterhin aktiv ("In Progress"), ggf. Fehlerbericht bei Problemen.
