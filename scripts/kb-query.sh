#!/bin/bash
# 知识库查询 — 供 host-tasks 调用
# 用法: kb-query.sh --q "关键词" [--top-k 10] [--no-llm]
cd ~/nanoclaw/store/knowledge-base
exec .venv/bin/python3 query.py "$@"
