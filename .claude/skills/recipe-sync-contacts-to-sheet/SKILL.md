---
name: recipe-sync-contacts-to-sheet
description: "Export Google Contacts directory to a Google Sheets spreadsheet."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "productivity"
    requires:
      bins:
        - gws
      skills:
        - gws-people
        - gws-sheets
---

# Export Google Contacts to Sheets

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-people`, `gws-sheets`

Export Google Contacts directory to a Google Sheets spreadsheet.

## Steps

1. List contacts: `gws people people listDirectoryPeople --params '{"readMask": "names,emailAddresses,phoneNumbers", "sources": ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"], "pageSize": 100}' --format json`
2. Create a sheet: `gws sheets +append --spreadsheet SHEET_ID --range 'Contacts' --values '["Name", "Email", "Phone"]'`
3. Append each contact row: `gws sheets +append --spreadsheet SHEET_ID --range 'Contacts' --values '["Jane Doe", "jane@company.com", "+1-555-0100"]'`

