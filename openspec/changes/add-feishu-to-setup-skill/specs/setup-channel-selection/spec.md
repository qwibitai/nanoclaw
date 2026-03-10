# Spec: Setup Channel Selection — Feishu

## MODIFIED Requirements

### Requirement: Feishu Channel Option
The setup skill's channel selection prompt MUST include Feishu as a selectable option.

#### Scenario: User selects Feishu
Given the user reaches Step 5 (Set Up Channels),
Then Feishu appears in the multiSelect list alongside WhatsApp, Telegram, Slack, and Discord,
And if selected, the skill invokes `/add-feishu` to handle installation, authentication, registration, and verification.
