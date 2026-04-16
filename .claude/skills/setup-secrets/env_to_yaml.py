#!/usr/bin/env python3
"""
env_to_yaml.py — Convert a .env file to sops-compatible YAML format

Usage: python3 env_to_yaml.py .env

Why this exists:
  sops encrypts YAML files natively. But .env files use their own quoting
  convention (KEY='value' or KEY="value") which must be stripped before
  encoding as YAML, otherwise the quotes become part of the stored value
  and break services that read the env vars.

Pipe the output into sops --encrypt to produce an encrypted secrets.yaml:
  python3 env_to_yaml.py .env | sops --encrypt --input-type yaml --output-type yaml /dev/stdin > secrets.yaml
"""

import re
import sys

if len(sys.argv) < 2:
    print(f"Usage: {sys.argv[0]} <.env file>", file=sys.stderr)
    sys.exit(1)

for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    key, _, val = line.partition('=')
    # Strip surrounding single or double quotes (.env quoting convention)
    val = re.sub(r'^([\'"])(.*)\1$', r'\2', val)
    # Escape any double quotes inside the value for YAML
    val = val.replace('"', '\\"')
    print(f'{key}: "{val}"')
