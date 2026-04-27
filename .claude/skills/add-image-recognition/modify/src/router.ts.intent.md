# Intent: src/router.ts modifications

## What changed
Updated `formatMessages()` to accept an optional image path transformer and output `image` attributes on `<message>` tags when images are present.

## Key sections

### formatMessages()
- Added: second parameter `imagePathTransformer?: (hostPath: string) => string`
- Added: `image` attribute to `<message>` tags when `m.image_path` is set
- Image paths are XML-escaped and optionally transformed (host path -> container path)
- Messages without images are unchanged

## Invariants
- `escapeXml()` is unchanged
- `stripInternalTags()` is unchanged
- `formatOutbound()` is unchanged
- `routeOutbound()` is unchanged
- `findChannel()` is unchanged
- Callers that don't pass `imagePathTransformer` get the same behavior as before

## Must-keep
- All other exported functions
- The XML escaping logic
- The `<messages>` wrapper format
