# SkillNet — Skill Discovery & Execution

SkillNet ist ein öffentliches Repository mit 200.000+ KI-Agent-Skills ("npm für AI").
Nutze es wenn Klaus eine Aufgabe stellt, für die kein mcporter-Tool existiert und die
sich durch fertigen Code besser lösen lässt als durch reine LLM-Logik.

API: `http://api-skillnet.openkg.cn/v1/search`
Portal: `http://skillnet.openkg.cn`

---

## 1. Skill suchen

```bash
# Keyword-Suche
curl -s "http://api-skillnet.openkg.cn/v1/search?q=SUCHBEGRIFF&limit=5"

# Semantische Suche (besser bei beschreibenden Queries)
curl -s "http://api-skillnet.openkg.cn/v1/search?q=SUCHBEGRIFF&mode=vector&limit=5&threshold=0.80"
```

Bewerte Ergebnisse nach:
- `stars` — Community-Rating (>= 10 bevorzugen)
- `skill_description` — passt es wirklich zur Aufgabe?
- `skill_url` — GitHub-URL für Dependency-Analyse

---

## 2. Dependency-Analyse (PFLICHT vor jedem Install)

```bash
# requirements.txt oder pyproject.toml vom GitHub-Repo fetchen
REPO_URL="https://raw.githubusercontent.com/USER/REPO/main/requirements.txt"
curl -s "$REPO_URL" > /tmp/skill-requirements.txt
cat /tmp/skill-requirements.txt

# Vollständigen Dependency-Tree auflösen (kein Install, nur Analyse)
uv pip compile /tmp/skill-requirements.txt --dry-run 2>&1
```

### Package-Kategorien

**GRUEN — direkt installierbar:**

*Stdlib (immer sicher):*
os, sys, pathlib, json, re, csv, datetime, math, random, hashlib, base64,
urllib, http, sqlite3, logging, collections, itertools, functools, typing,
dataclasses, io, tempfile, shutil, glob, time, threading, subprocess,
zipfile, gzip, pickle, uuid, textwrap, contextlib, copy, struct, enum

*Daten & Wissenschaft:*
numpy, pandas, scipy, scikit-learn, polars, pyarrow, dask, xarray, h5py,
matplotlib, seaborn, plotly, bokeh, altair,
openpyxl, xlrd, xlwt, xlsxwriter, python-docx, pypdf, pypdf2, pdfplumber,
pytesseract, pillow, opencv-python, imageio, scikit-image,
tabulate, rich, tqdm, loguru, click, typer, humanize, arrow, python-dateutil, pytz

*Web & Netzwerk:*
requests, httpx, aiohttp, httpcore, urllib3, certifi,
beautifulsoup4, lxml, html5lib, scrapy, playwright, selenium,
fastapi, flask, django, starlette, uvicorn, gunicorn, werkzeug,
pydantic, marshmallow, attrs, cattrs, msgspec, orjson, ujson,
paramiko, cryptography, PyYAML, toml, tomli, python-dotenv, jinja2

*Datenbanken & Storage:*
sqlalchemy, alembic, psycopg2, pymongo, redis, motor, aiosqlite,
boto3, google-cloud-storage, azure-storage-blob, google-cloud-bigquery

*ML & AI (CPU-Modus):*
transformers, tokenizers, datasets, accelerate, sentence-transformers,
huggingface-hub, safetensors, einops, peft, timm,
langchain, langchain-core, langchain-community, openai, anthropic,
llama-index, chromadb, qdrant-client, faiss-cpu, annoy,
spacy, nltk, gensim, textblob, flair,
mlflow, optuna, wandb, joblib, cloudpickle, dill

*Testing & Dev:*
pytest, hypothesis, black, isort, mypy, ruff, packaging, setuptools,
more-itertools, cachetools, diskcache, filelock, platformdirs

**GELB — vor Install Klaus fragen:**

*GPU-Pakete (kein GPU-Zugriff im Container — laufen nur auf CPU, meist langsam):*
torch, torchvision, torchaudio, tensorflow, tensorflow-cpu, jax, jaxlib,
keras, onnxruntime, onnxruntime-gpu, paddle, paddlepaddle,
cupy, numba, rapids, cudf, cuml

*Pakete mit vielen C-Extensions oder unklaren Deps:*
pywin32, winreg (Windows-only, schlaegt fehl),
pycuda, pyopencl (GPU-required),
wx, tkinter (GUI, kein Display),
pyaudio, sounddevice (Audio-Hardware)

*Schwergewichtige Pakete (> 500 MB download):*
tensorflow (vollstaendig), torch (vollstaendig), detectron2, mmcv

**ROT — ablehnen:**

*Typosquats bekannter Pakete (Beispiele — nie installieren):*
reqeusts, urllib4, numpy1, pandaas, colourama, colourama, py-request,
noblesse, ctx, setup-tools, python-requests, openai-unofficial

*Allgemeine Ablehnungskriterien:*
- Paket nicht auf PyPI auffindbar
- Paketname ist offensichtlicher Typosquat (1-2 Buchstaben-Abweichung von bekanntem Paket)
- requirements.txt laed Pakete von privaten URLs / Git-Repos mit unbekannten Autoren
- Paket installiert post-install hooks die shell-commands ausfuehren (erkennbar in setup.py)
- Paket hat < 100 Stars auf GitHub UND < 1000 PyPI-Downloads

### PyPI Download-Check
```bash
# Downloads pruefen (gibt JSON mit download-Statistiken)
curl -s "https://pypistats.org/api/packages/PAKETNAME/recent" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Downloads letzte Woche: {d[\"data\"][\"last_week\"]}')
"
```

---

## 3. Install & Ausfuehren mit uv

```bash
# Isoliertes venv erstellen (schnell mit uv)
uv venv /tmp/skillnet-env --python 3.11

# Pakete installieren (10-100x schneller als pip)
uv pip install -r /tmp/skill-requirements.txt --python /tmp/skillnet-env/bin/python

# Skill ausfuehren
source /tmp/skillnet-env/bin/activate
python /tmp/skill-code/run.py --input "..." --output "/tmp/skill-output"

# Output lesen und an Klaus weitergeben
cat /tmp/skill-output
```

---

## 4. GPU-Einschraenkung

**Wichtig:** Agent-Container haben KEINEN GPU-Zugriff (`--gpus all` ist nicht gesetzt).

- Torch/TF laufen im CPU-Modus — langsam, aber funktional fuer kleine Datenmengen
- Fuer GPU-intensive Aufgaben (Bildgenerierung, grosse Modelle): Klaus informieren,
  dass die Verarbeitung auf CPU langsam sein wird, und Alternativen vorschlagen
  (z.B. mcporter-Aufruf auf einen GPU-Service wie Whisper/vLLM)

---

## 5. Entscheidungsbaum

```
Aufgabe unklar loesbar mit mcporter?
  └─ Ja → SkillNet suchen
       └─ Guter Treffer (>= 10 Stars, passt zur Aufgabe)?
            ├─ Nein → Selbst implementieren
            └─ Ja → requirements.txt analysieren
                 ├─ Alle GRUEN → direkt installieren
                 ├─ GELB dabei → Klaus kurz fragen ("Darf ich X installieren?")
                 └─ ROT dabei → ablehnen, selbst implementieren oder Alternative suchen
```

---

## 6. Ergebnis melden

Nach Ausfuehrung:
- Kurze Zusammenfassung was der Skill gemacht hat
- Output-Dateien wenn vorhanden benennen
- Bei Fehlern: Fehlermeldung + was stattdessen moeglich waere
