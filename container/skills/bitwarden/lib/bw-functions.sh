#!/bin/bash
# Bitwarden shell functions — source this file in .bashrc/.zshrc
# Part of the bitwarden-bwe skill: https://clawhub.com/skills/bitwarden-bwe
#
# Usage:
#   source /path/to/bw-functions.sh
#   bwss          # unlock vault
#   bwe my-note   # load secrets from Secure Note into env

# Unlock vault and set BW_SESSION
bwss(){
    eval $(bw unlock | grep export | awk -F"\$" {'print $2'})
}

# Load secrets from a Secure Note into env
bwe(){
    eval $(bw get item "$1" | jq -r '.notes')
}

# Safe version — only evals lines matching export VAR=value
bwe_safe(){
    bw get item "$1" | jq -r '.notes' | grep -E '^export [A-Za-z_][A-Za-z0-9_]*=.*$' | while IFS= read -r line; do eval "$line"; done
}

# Create Secure Note from a .env file
bwc(){
    local FF="${2:-.env}"
    local TMPF
    TMPF=$(mktemp)
    chmod 600 "$TMPF"
    awk -F= '{key=$1; val=substr($0,index($0,"=")+1); print "export " key "=\047" val "\047"}' "$FF" > "$TMPF"
    bw get template item | jq --rawfile notes "$TMPF" --arg name "$1" \
      '.type = 2 | .secureNote.type = 0 | .notes = $notes | .name = $name' \
      | bw encode | bw create item
    rm -f "$TMPF"
}

# Create Secure Note from current shell exports
bwce(){
    local TMPF
    TMPF=$(mktemp)
    chmod 600 "$TMPF"
    export | awk '{print "export " $0}' > "$TMPF"
    bw get template item | jq --rawfile notes "$TMPF" --arg name "$1" \
      '.type = 2 | .secureNote.type = 0 | .notes = $notes | .name = $name' \
      | bw encode | bw create item
    rm -f "$TMPF"
}

# Delete item by name
bwdd(){
    bw delete item "$(bw get item "$1" | jq -r '.id')"
}

# Aliases
alias bwl="bw list items | jq '.[] | .name'"
alias bwll="bw list items | jq '.[] | .name' | grep"
alias bwg="bw get item"
