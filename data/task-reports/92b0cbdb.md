# Task 92b0cbdb: [Feature] Outbound media support for connector_message_tool

- Status: completed
- Agent: fcd98bac
- Session: a15f53b5

## Description
Add ability to send images/files via connector_message_tool.

Current state:
- connector_message_tool only supports text messages
- WhatsApp connector can receive images (fixed) but can't send them
- Other connectors (Slack, Telegram, Discord) also need outbound media

Implementation:
1. Add mediaPath/mediaUrl parameter to connector_message_tool
2. Update WhatsApp connector to send media (use Baileys sendMessage with media)
3. Support Slack file uploads, Telegram sendPhoto, Discord attachments
4. Handle readFromDisk for screenshots/files saved locally

Use case: Agent takes screenshot and sends to user via WhatsApp.

Priority: medium (feature gap, not breaking anything)

## Result Summary
TypeScript compiles cleanly with zero errors.

## Changed Files
- Not provided

## Commands Run
- Not provided

## Verification
- Not provided
