// container/skills/social-monitor/decision-prompt.ts
import fs from 'fs';

export function buildDecisionPrompt(
  personaPath: string,
  formattedItems: string,
): string {
  let persona = '';
  try {
    persona = fs.readFileSync(personaPath, 'utf-8');
  } catch {
    persona = '(No persona file found. Use general good judgment.)';
  }

  return `You are managing a social media account. Your persona and engagement rules are below.

<persona>
${persona}
</persona>

<timeline>
${formattedItems}
</timeline>

For each timeline item, decide what action to take. Options:
- "ignore" — skip this item
- "like" — like/favorite it
- "reply" — reply with a message (provide content)
- "repost" — repost/retweet it
- "quote" — quote it with your own commentary (provide content)

Follow the persona rules strictly:
- "Always Engage" items should get at least a like
- "Never Engage" items must be ignored
- For everything else, use your judgment based on the persona's goals and style

Respond with a JSON array. Each element:
{
  "itemIndex": <number>,
  "action": "ignore" | "like" | "reply" | "repost" | "quote",
  "content": "<reply or quote text, omit for like/repost/ignore>"
}

Only include items where action is NOT "ignore". Respond with ONLY the JSON array, no other text.`;
}
