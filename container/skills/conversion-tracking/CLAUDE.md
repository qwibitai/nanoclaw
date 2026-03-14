# Conversion Tracking

Track customer journey from inquiry to completion.

## When to Use
- When a customer makes an initial inquiry → create conversion with stage 'inquiry'
- When you send a quote/pricing → update to 'quoted'
- When customer is actively discussing terms → update to 'negotiating'
- When customer confirms booking/order → update to 'booked'
- When service is delivered → update to 'completed'

## Tool
Use `/workspace/tools/conversions/track-conversion.ts` to manage conversions.

## Examples
```bash
# New inquiry from vending customer
npx tsx /workspace/tools/conversions/track-conversion.ts --action create --jid "group@g.us" --business "snak-group" --stage inquiry --notes "Wants breakroom vending for 50-person office"

# Customer accepted quote
npx tsx /workspace/tools/conversions/track-conversion.ts --action update --id "conv_123" --stage quoted --notes "Quoted $150/month, interested"

# Get stats
npx tsx /workspace/tools/conversions/track-conversion.ts --action stats --business "snak-group" --days 30
```

## Important
- ALWAYS create a conversion when a new customer inquiry comes in
- Update the stage as the conversation progresses
- Include value_usd when a deal is quoted or booked
- This data drives follow-up automation and business reporting
