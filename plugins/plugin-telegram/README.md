# @elizaos/plugin-telegram

Telegram connector for elizaOS. Gives an Eliza agent the ability to send and receive messages across Telegram private chats, groups, supergroups, channels, and forum topics.

## What it does

- Runs a Telegraf long-poll bot connected to the Telegram Bot API.
- Routes incoming messages and reactions through the elizaOS runtime so configured actions, providers, and evaluators can respond.
- Syncs Telegram chats, users, and group membership into the runtime as Worlds, Rooms, and Entities.
- Handles forum topics as separate Rooms (channelId format: `<chatId>-<threadId>`).
- Supports outgoing buttons (`login` and `url` kinds) via the `TelegramContent.buttons` field.
- Provides HTTP setup routes for bot-token configuration and GramJS user-account login.
- Supports multiple bot accounts per agent via `character.settings.telegram.accounts`.
- Preserves complete outbound text across Telegram's field limits: long messages are split losslessly, and media captions over 1024 UTF-16 units are delivered as follow-up text instead of clipped.

## Delivery evidence

Text and interactive text sends return ordered provider IDs and local memory receipts. A later chunk failure retains earlier accepted IDs; a database failure after delivery is reported separately. Legacy attachment sends do not yet return a complete receipt and must not be treated as confirmed delivery by approval callers.

## Prerequisites

Create a bot via [@BotFather](https://t.me/BotFather) and copy the token it provides.

## Configuration

### Minimal (single bot, environment variable)

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

The plugin reads the token from the runtime setting `TELEGRAM_BOT_TOKEN` or `process.env.TELEGRAM_BOT_TOKEN`.

### Via character settings

```json
{
  "name": "MyAgent",
  "settings": {
    "telegram": {
      "botToken": "123456:ABC-DEF...",
      "apiRoot": "https://api.telegram.org"
    }
  }
}
```

### Multi-account

```json
{
  "settings": {
    "telegram": {
      "accounts": {
        "supportBot": { "botToken": "111:aaa", "allowedChats": ["-100123456"] },
        "announcementsBot": { "botToken": "222:bbb" }
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes (default account) | Bot token from @BotFather |
| `TELEGRAM_API_ROOT` | No | Override Bot API base URL (e.g. local Bot API server). Default: `https://api.telegram.org` |
| `TELEGRAM_ALLOWED_CHATS` | No | JSON array of chat ID strings the bot will respond to; authoritative for every chat type when set. Example: `["-100123456789"]` |
| `TELEGRAM_DM_POLICY` | No | `open` / `pairing` / `allowlist` / `disabled` — gates private chats when no allowlist is configured. Default `pairing`: unknown senders get a one-time pairing code (core PairingService handshake) instead of full bot access, so an unconfigured bot is never default-open. Group chats are unaffected; a bot only sees groups it was invited to. |
| `TELEGRAM_TEST_CHAT_ID` | No | Chat ID used by the live smoke-test suite |

## Enabling the plugin

The plugin auto-enables when the `telegram` connector key is present in the agent connector config. To load it explicitly, add it to the agent's plugin list:

```json
{
  "plugins": ["@elizaos/plugin-telegram"]
}
```

## Setup UI routes

The plugin mounts these HTTP routes (no plugin-name prefix) for the dashboard setup wizard:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/setup/telegram/status` | Current pairing state |
| POST | `/api/setup/telegram/start` | Validate + save bot token |
| POST | `/api/setup/telegram/cancel` | Remove saved token |
| GET | `/api/setup/telegram-account/status` | GramJS user-account auth state |
| POST | `/api/setup/telegram-account/start` | Begin GramJS login |
| POST | `/api/setup/telegram-account/submit-code` | Submit OTP or 2FA password |
| POST | `/api/setup/telegram-account/cancel` | Tear down GramJS session |

## Sending buttons

Include a `buttons` array in any `Content` object returned to Telegram:

```typescript
callback({
  text: "Welcome! Click below to authenticate.",
  buttons: [
    {
      kind: "login",
      text: "Authenticate",
      url: "https://your-app.example.com/auth",
    },
  ],
});
```

Supported `kind` values: `"login"` (Telegram login widget), `"url"` (plain URL button).

## Owner pairing

The plugin registers a `/eliza_pair <code>` bot command that lets the Telegram user matching a 6-digit code shown in the agent dashboard bind their Telegram identity to the owner account. Rate-limited to 5 attempts per minute per user.

## 409 Conflict errors

The Telegram Bot API permits only one active long-poll connection per token. If two agent processes share the same token simultaneously, Telegram rejects the second with a 409 error. Full and standalone pollers share a process-local lock keyed by a fingerprint of the token; a live, starting, retrying, or merely quiet owner remains a hard launch failure. The lock becomes reclaimable only after that poller reaches an explicit terminal state. Across separate processes, operators must still ensure that only one process uses a given token at a time.

## Development

```bash
bun run --cwd plugins/plugin-telegram build
bun run --cwd plugins/plugin-telegram test
bun run --cwd plugins/plugin-telegram lint
```
