# Tone Profile: Direct

**Use for:** Engineers who work for/with you daily, personal contacts, internal team, anyone you message daily.

## Voice

Terse, action-oriented, zero ceremony. Commands and questions only. Reads like a DM that happens to be in an email. The reader already has context; you just need to move things forward.

## Formality: 1/5

## Structure

- Fragments dominate
- Often just a verb phrase
- One-line questions
- Numbered lists for multiple points, no introductory sentence

## Greeting

None. Start with content.

## Sign-off

None. Or "[Name]" if email format demands it.

## Sample Phrases

- "Did you run the migrations?"
- "Status update?"
- "Not what I asked. I want [X] and [Y]."
- "Make it 8am Eastern."
- "Do you have access to [X]?"
- "Can you confirm [X]?"
- "Already did this. We were on [next step]."
- "Yes. Go ahead."
- "Checking in."

## Examples

<examples>

<example type="contrast">
<context>Reply to an engineer on your team asking if you want the migration run today.</context>
<bad>Hi Alex,

Thank you for checking in on this. I've given it some thought, and I believe it would be best to proceed with running the migration today. However, I want to make sure we're being thorough about this, so could you please ensure that all the necessary precautions are in place? Additionally, it might be worth noting that we should have a rollback plan ready, just in case.

Please don't hesitate to reach out if you run into any issues during the process.

Best,
[Name]</bad>
<why_bad>Everything. Greeting, "Thank you for checking in", "I've given it some thought", "I believe", "However", "Additionally", "it might be worth noting", "Please don't hesitate". 80 words to say "yes".</why_bad>
<good>Yes, run it. Make sure you have the rollback script ready before you start.</good>
</example>

<example>
<context>Check in on a task you assigned yesterday.</context>
<output>Status on the FTS5 index rebuild?</output>
</example>

<example>
<context>Redirect an engineer who solved the wrong problem.</context>
<output>Not what I asked. I want the query to filter by group_id first, then apply the FTS match. The current version scans every group.

Rewrite it and test against the production dataset before pushing.</output>
</example>

</examples>

## Anti-Patterns (NEVER use)

- Any greeting beyond recipient's name
- "When you get a chance"
- "No rush"
- "Hope you're doing well"
- Softening language of any kind
- Explaining things the reader already knows
- Excessive exclamation marks (sparingly is fine)
- Any emojis
