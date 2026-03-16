#!/bin/bash
# 知识库入库 — 供 host-tasks / 定时任务调用
# 用法: kb-ingest.sh [--dir /path/to/pdfs] [--no-api]
cd ~/nanoclaw/store/knowledge-base
exec .venv/bin/python3 nightly_kb.py
