---
name: google-workspace
description: Use Google Workspace CLI (`gws`) for Drive, Docs, Sheets, Gmail, Calendar, Chat, and related Workspace API tasks.
homepage: https://github.com/googleworkspace/cli
metadata:
  openclaw:
    requires:
      bins: [gws]
---

# Google Workspace CLI

Use `gws` when the task is about Google Workspace resources or Google Workspace API automation.

Prefer `gws` over generic HTTP calls when possible because it already knows the Workspace API surface and returns structured JSON by default.

## Rules

1. Start with read/list/get commands before mutating Workspace state.
2. Confirm IDs first: document IDs, spreadsheet IDs, file IDs, message IDs, calendar IDs, space IDs.
3. Do not run interactive auth flows from an agent tool call. If auth is missing, report that `gws` needs to be configured in plugin settings or via a manual terminal login.
4. Keep commands machine-readable. Prefer JSON output and parse it instead of scraping human text.
5. For large list operations, limit the scope first, then page or filter.

## Common Commands

Check installation and health:

```bash
gws doctor
```

Inspect help for a resource or method:

```bash
gws help
gws drive help
gws drive files help
```

Google Docs:

```bash
gws docs get --document-id <DOC_ID>
```

Google Drive:

```bash
gws drive files list --params '{"pageSize":10}'
gws drive files get --file-id <FILE_ID>
```

Google Sheets:

```bash
gws sheets spreadsheets get --spreadsheet-id <SPREADSHEET_ID>
```

Gmail:

```bash
gws gmail users messages list --user-id me --params '{"maxResults":10}'
gws gmail users messages get --user-id me --message-id <MESSAGE_ID>
```

Google Calendar:

```bash
gws calendar events list --calendar-id primary --params '{"maxResults":10,"singleEvents":true}'
```

Google Chat:

```bash
gws chat spaces messages list --parent spaces/<SPACE_ID>
```

## Tool Usage In SwarmClaw

When using the `google_workspace` tool:

- Put the `gws` command after the binary into `args`, for example:
  `{"args":["drive","files","list"],"params":{"pageSize":5}}`
- Use `params` for `--params`
- Use `jsonInput` for `--json`
- Use `pageAll: true` when you intentionally want all pages
- Use `dryRun: true` before risky mutations if you are unsure

## Error Handling

- If `gws` is missing: tell the user to install Google Workspace CLI.
- If auth is missing or expired: tell the user to configure the plugin settings or authenticate `gws` manually.
- If a command fails because an ID is missing: switch to a list/search command first and find the right ID.
