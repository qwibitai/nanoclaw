# Intent: src/router.ts modifications

## What changed
Extended `formatMessages()` to include `<attachment>` XML elements for messages with media.

## Key changes

### formatMessages()
Changed from simple string interpolation to a block that:
1. Escapes message content as before
2. If `m.attachments` is non-empty, appends `<attachment>` elements for each:
   ```xml
   <attachment id="..." name="..." type="..." size="..." />
   ```
3. Size attribute is only included when `att.size != null`
4. All attribute values are XML-escaped

This allows the container agent to see media references inline with messages and use the `get_media` MCP tool to download them.

## Invariants
- The outer `<messages>...</messages>` wrapper is unchanged
- The `<message sender="..." time="...">` format is unchanged
- Messages without attachments produce identical output to before

## Must-keep
- escapeXml function
- stripInternalTags and formatOutbound
- routeOutbound and findChannel
