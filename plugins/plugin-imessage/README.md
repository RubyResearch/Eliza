# @elizaos/plugin-imessage

iMessage plugin for elizaOS agents. Uses Apple's Messages app on macOS or a
Blooio channel on any supported server platform.

Native mode requires macOS. Blooio mode supports Linux servers.

## Features

- **Send Messages**: Send text messages via iMessage
- **Direct & Group Chats**: Support for direct messages and group conversations
- **Attachments**: Rehost inbound Messages files into the canonical media store and send bounded local or SSRF-guarded remote media through Messages.app
- **Message Polling**: Receive incoming messages via polling
- **Policy Controls**: Configure DM and group policies
- **Blooio Webhook**: Receive signed events at `/api/imessage/webhook/blooio`
- **Channel Isolation**: Dispatch only the configured Blooio channel

## Native transport requirements

- **macOS**: The native transport only works on macOS
- **Messages App Access**: Full Disk Access is required for reads; Automation permission is required for sends
- **No Relay Required**: BlueBubbles, local servers, auxiliary CLIs, and external services are not used

## Installation

```bash
# npm
npm install @elizaos/plugin-imessage

# bun
bun add @elizaos/plugin-imessage
```

## Delivery receipts

Hosted sends retain every accepted provider message ID in order, including IDs from chunks accepted before a later failure. Native AppleScript acceptance does not supply a provider receipt; the connector leaves the message ID absent instead of inventing one. Callers must reconcile uncertain results before retrying.

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `IMESSAGE_DB_PATH` | Path to iMessage database | No |
| `IMESSAGE_POLL_INTERVAL_MS` | Polling interval in ms | No |
| `IMESSAGE_HEARTBEAT_INTERVAL_MS` | Heartbeat health-check interval in ms (default `60000`) | No |
| `IMESSAGE_DM_POLICY` | DM policy: open, pairing, allowlist, disabled | No |
| `IMESSAGE_GROUP_POLICY` | Group policy: open, allowlist, disabled | No |
| `IMESSAGE_ALLOW_FROM` | Comma-separated handles for allowlist | No |
| `IMESSAGE_ENABLED` | Enable/disable the plugin | No |
| `IMESSAGE_BACKFILL` | Rows before current DB tip to replay on startup | No |
| `IMESSAGE_TRANSPORT` | `native` (default) or `blooio` | No |
| `IMESSAGE_BLOOIO_API_KEY` | Blooio API key; falls back to `BLOOIO_API_KEY` | Blooio |
| `IMESSAGE_BLOOIO_WEBHOOK_SECRET` | Webhook signing secret; falls back to `BLOOIO_WEBHOOK_SECRET` | Blooio |
| `IMESSAGE_BLOOIO_FROM_NUMBER` | E.164 sender number; falls back to `BLOOIO_FROM_NUMBER` | Blooio |
| `IMESSAGE_BLOOIO_CHANNEL_ID` | Exact Blooio channel accepted by this agent | Blooio |

### Agent Configuration

```json
{
  "plugins": ["@elizaos/plugin-imessage"],
  "pluginParameters": {
    "IMESSAGE_DM_POLICY": "pairing",
    "IMESSAGE_GROUP_POLICY": "allowlist",
    "IMESSAGE_POLL_INTERVAL_MS": "5000"
  }
}
```

## Setup

### Blooio on Linux

Set `IMESSAGE_TRANSPORT=blooio` and all four Blooio settings above. Create a
channel-scoped Blooio webhook for the configured channel pointing to:

```text
https://YOUR_AGENT_HOST/api/imessage/webhook/blooio
```

Blooio v4 subscriptions deliver all event types. The route handles only
`message.received` and verifies `X-Blooio-Signature`
against the unmodified request body and silently ignores other channel IDs.

Startup and the existing recurring heartbeat verify API access and that the sender
number resolves to the configured channel. This check does not prove webhook or
message delivery; complete an inbound and outbound test before client handoff.

### Permissions

1. Open System Settings > Privacy & Security > Full Disk Access
2. Grant Full Disk Access to:
   - Your terminal app (or the Eliza process)
3. Allow Messages app to be controlled via AppleScript (Automation permission)

## Usage

### Actions

iMessage sending is exposed through the canonical message connector action. Use
`source: "imessage"` when a request needs to target iMessage explicitly.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send a text message to a phone number, email, contact, or chat |

### Providers

iMessage does not register standalone planner providers. Chat and contact
context is exposed through the iMessage message connector hooks.

## How It Works

The plugin uses two local macOS surfaces: read-only SQLite access to
`~/Library/Messages/chat.db` for inbound history and Apple's built-in
AppleScript interface to Messages.app for outbound delivery. It does not run a
relay server or delegate to a third-party executable.

### AppleScript Method

```applescript
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "+1234567890" of targetService
  send "Hello!" to targetBuddy
end tell
```

## Message Targets

iMessage supports multiple target types:

- **Phone Numbers**: `+1234567890`, `1234567890`
- **Email Addresses**: `user@example.com`
- **Chat IDs**: `chat_id:UUID` (for existing chats)

## Policies

### DM Policies

| Policy | Description |
|--------|-------------|
| `open` | Accept DMs from anyone |
| `pairing` (default) | Accept senders in `IMESSAGE_ALLOW_FROM` immediately; hold unknown senders through the core PairingService handshake — they are admitted once the owner approves their pairing code (`pairing approve imessage <code>` or the pairing UI). The pairing-code reply is only texted to the sender when `IMESSAGE_AUTO_REPLY=true` |
| `allowlist` | Only accept from IMESSAGE_ALLOW_FROM list |
| `disabled` | Don't accept any DMs |

### Group Policies

| Policy | Description |
|--------|-------------|
| `open` | Respond to anyone in groups |
| `allowlist` | Only respond to allowed users |
| `disabled` | Don't respond in groups |

## Limitations

- **Native mode is macOS-only**: Blooio mode is the supported server transport
- **No Official API**: Sending uses Messages.app's supported AppleScript dictionary
- **Permissions**: Message history requires Full Disk Access, sending through
  Messages requires Automation, and contact resolution/editing requires
  Contacts access
- **Rate Limits**: Apple may throttle excessive automation

## Development

### Building

```bash
bun run --cwd plugins/plugin-imessage build
```

### Testing

Testing requires a macOS environment with Messages app configured:

```bash
bun run --cwd plugins/plugin-imessage test
```

## Troubleshooting

### "Cannot access Messages app"

1. Ensure Full Disk Access is granted
2. Ensure Automation permissions are granted if sending through Messages fails
3. Try opening Messages app manually first

### "Service not available"

1. Check that you're running on macOS
2. Verify the Messages app is installed and configured

### Messages not sending

1. Check that iMessage is signed in and working
2. Verify the recipient has iMessage enabled
3. Check for rate limiting (try again later)
