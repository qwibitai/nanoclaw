#!/bin/bash
# Export macOS Contacts + Outlook contacts to JSON for nanoclaw agent access
# Runs via launchd every hour

set -euo pipefail

OUTPUT_DIR="$HOME/projects/nanoclaw/data/contacts"
mkdir -p "$OUTPUT_DIR"

# Find all AddressBook sources and merge
CONTACTS_JSON="[]"
for db in "$HOME/Library/Application Support/AddressBook/Sources"/*/AddressBook-v22.abcddb; do
    [ -f "$db" ] || continue

    BATCH=$(sqlite3 "$db" "
        SELECT json_group_array(json_object(
            'name', COALESCE(r.ZFIRSTNAME, '') || CASE WHEN r.ZFIRSTNAME IS NOT NULL AND r.ZLASTNAME IS NOT NULL THEN ' ' ELSE '' END || COALESCE(r.ZLASTNAME, ''),
            'organization', COALESCE(r.ZORGANIZATION, ''),
            'title', COALESCE(r.ZJOBTITLE, ''),
            'emails', COALESCE((SELECT json_group_array(e.ZADDRESS) FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK AND e.ZADDRESS IS NOT NULL), '[]'),
            'phones', COALESCE((SELECT json_group_array(p.ZFULLNUMBER) FROM ZABCDPHONENUMBER p WHERE p.ZOWNER = r.Z_PK AND p.ZFULLNUMBER IS NOT NULL), '[]')
        ))
        FROM ZABCDRECORD r
        WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL;
    " 2>/dev/null || echo "[]")

    # Merge into main array using python (available on macOS)
    CONTACTS_JSON=$(python3 -c "
import json, sys
existing = json.loads(sys.argv[1])
new = json.loads(sys.argv[2])
# Fix nested JSON strings from sqlite
for c in new:
    if isinstance(c.get('emails'), str):
        c['emails'] = json.loads(c['emails'])
    if isinstance(c.get('phones'), str):
        c['phones'] = json.loads(c['phones'])
    # Skip empty entries
    if c.get('name','').strip() or c.get('organization','').strip():
        existing.append(c)
print(json.dumps(existing))
" "$CONTACTS_JSON" "$BATCH")
done

# Write formatted JSON
python3 -c "
import json, sys
contacts = json.loads(sys.argv[1])
# Deduplicate by name
seen = {}
for c in contacts:
    key = c['name'].strip().lower()
    if not key:
        key = c.get('organization','').strip().lower()
    if not key:
        continue
    if key in seen:
        # Merge emails/phones
        seen[key]['emails'] = list(set(seen[key]['emails'] + c['emails']))
        seen[key]['phones'] = list(set(seen[key]['phones'] + c['phones']))
        if not seen[key]['organization'] and c['organization']:
            seen[key]['organization'] = c['organization']
        if not seen[key]['title'] and c['title']:
            seen[key]['title'] = c['title']
    else:
        seen[key] = c
result = sorted(seen.values(), key=lambda x: x['name'].lower())
with open(sys.argv[2], 'w') as f:
    json.dump(result, f, indent=2, ensure_ascii=False)
print(f'Exported {len(result)} contacts')
" "$CONTACTS_JSON" "$OUTPUT_DIR/macos-contacts.json"

echo "$(date): Done"
