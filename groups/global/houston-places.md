# Houston Area — Facebook Place IDs

> Use `--place-id` when posting to Facebook to geo-tag posts. Each business group should use the place ID closest to their service area.

## SNAK Group — Houston Metro

| Area | Place ID | Facebook Page | Use For |
|------|----------|---------------|---------|
| Houston, TX | 100063789966682 | City of Houston | General Houston posts |
| Galleria/Uptown | 100063789966682 | City of Houston | Office/corporate posts (use Houston) |
| The Woodlands | 100064422352928 | The Woodlands Township | Suburban office posts |
| Katy, TX | 100064439239982 | City of Katy | West Houston installs |
| Cypress, TX | 107602962595896 | Cypress, Texas (place) | Northwest Houston |
| Sugar Land | 100064414012667 | City of Sugar Land | Southwest Houston |

## Sheridan Rentals — Tomball Area

| Area | Place ID | Facebook Page | Use For |
|------|----------|---------------|---------|
| Tomball, TX | 100064234223259 | City of Tomball | **Default for all Sheridan posts** |
| Spring, TX | 111815465501969 | Spring, Texas (place) | Nearby area |
| Magnolia, TX | 100069302490776 | City of Magnolia TX | Nearby area |
| Conroe, TX | 100064814193470 | City of Conroe | Northern service area |

## Instagram Location IDs

Instagram locations can be searched via:
```bash
npx tsx /workspace/project/tools/social/post-instagram.ts --search-location "Houston, TX"
```

Common locations (to be populated after first search):
- Houston, TX: [to be discovered]
- Tomball, TX: [to be discovered]
- The Woodlands, TX: [to be discovered]
- Katy, TX: [to be discovered]
- Cypress, TX: [to be discovered]
- Sugar Land, TX: [to be discovered]
- Spring, TX: [to be discovered]
- Magnolia, TX: [to be discovered]
- Conroe, TX: [to be discovered]

## Usage

```bash
# Sheridan post with Tomball geo-tag (default)
post-facebook.ts --message "..." --source /tmp/rv.jpg --place-id "100064234223259"

# SNAK Group post with Houston geo-tag (default)
post-facebook.ts --message "..." --source /tmp/photo.jpg --place-id "100063789966682"

# SNAK Group post for Katy install
post-facebook.ts --message "..." --source /tmp/photo.jpg --place-id "100064439239982"
```
