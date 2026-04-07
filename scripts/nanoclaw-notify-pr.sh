#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
if [[ -z "${payload}" ]]; then
  echo "empty payload" >&2
  exit 1
fi

group_folder="$(printf '%s' "${payload}" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(String(data.groupFolder || ''));" )"

if [[ ! "${group_folder}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  echo "invalid groupFolder: ${group_folder}" >&2
  exit 1
fi

data_root="${XDG_DATA_HOME:-$HOME/.local/share}/nanoclaw"
task_dir="${data_root}/ipc/${group_folder}/tasks"
mkdir -p "${task_dir}"
chmod 700 "${data_root}" "${data_root}/ipc" "${data_root}/ipc/${group_folder}" "${task_dir}" 2>/dev/null || true

tmp_file="$(mktemp "${task_dir}/pr-event.XXXXXX.tmp")"
final_file="${task_dir}/pr-event-$(date +%s)-$RANDOM.json"

printf '%s\n' "${payload}" > "${tmp_file}"
chmod 600 "${tmp_file}"
mv "${tmp_file}" "${final_file}"
