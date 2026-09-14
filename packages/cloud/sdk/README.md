# @elizaos/cloud-sdk

TypeScript SDK for Eliza Cloud API access, CLI login, API-key auth, agent management, model APIs, containers, billing credits, and generic endpoint calls.

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
});

const models = await cloud.listModels();
const credits = await cloud.getCreditsBalance();
const agents = await cloud.listAgents();

// Curated public Cloud API routes are also exposed through cloud.routes.
const app = await cloud.routes.getApiV1AppsById({
  pathParams: { id: "app_123" },
});
const stream = await cloud.routes.postApiV1ChatCompletionsRaw({
  json: { model: "gpt-4o-mini", messages: [], stream: true },
});
```

## Individual app billing account status

With an interactive owner session, `registerAppBilling(appId, "test")` records
an unconfigured registration whose infrastructure payer is the registered app
owner. It accepts no Stripe identifiers. After the buyer approves the existing
app consent flow, `getAppBillingAccount(appId, "test")` returns the buyer's
individual account and explicit unavailable subscription state. Reads support
interactive sessions and current mobile credentials issued by that exact app;
general developer API keys do not grant buyer authority. The environment is
required and may be `test` or `live`; registration performs no provider calls.
This does not start a trial, create checkout, or grant credits or entitlements.

## Sign in with Eliza Cloud (web app) + app-credits

A third-party web app can let users sign in with their Eliza Cloud account — no
API key pasting — and bill inference to a registered app's credits (the app
owner earns the configured markup). The client exposes the whole flow:

```ts
const cloud = new ElizaCloudClient(); // no key needed to start the login

// 1. Start a login session and open the hosted login (a tab works well).
const { sessionId, browserUrl } = await cloud.startCliLogin();
window.open(browserUrl, "_blank");

// 2. Poll until the user authorizes (handles the deadline/interval/terminal
//    states for you; throws on expiry/error/timeout).
const { apiKey, userId } = await cloud.waitForCliLogin(sessionId);
cloud.setApiKey(apiKey!);

// 3. Show/buy app-credits for your registered app.
const balance = await cloud.getAppCreditsBalance("app_123");
const checkout = await cloud.createAppCreditsCheckout({
  app_id: "app_123",
  amount: 5,
  success_url: location.origin,
  cancel_url: location.origin,
});

// 4. Run inference billed to the app's credits via the `appId` option
//    (sends the `X-App-Id` header). Omit `appId` to bill the caller's own credits.
//    Add `affiliateCode` to attribute the call to an affiliate for revenue share
//    (sends `X-Affiliate-Code`; read by the credit-billed inference routes).
const reply = await cloud.createChatCompletion(
  { model: "anthropic/claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
  { appId: "app_123", affiliateCode: "aff_xyz" },
);
```

For a third-party OAuth-style app sign-in, send the user to the canonical
Eliza Cloud app authorization route. Use the SDK helper so your app does not
accidentally link to bare `/authorize`, which is not a Cloud app-auth route:

```ts
import { buildAppAuthorizeUrl } from "@elizaos/cloud-sdk";

const authorizeUrl = buildAppAuthorizeUrl({
  appId: "app_123",
  redirectUri: "https://example.app/auth/eliza/callback",
  state: crypto.randomUUID(),
});

window.location.assign(authorizeUrl);
```

The generated URL is
`https://eliza.app/app-auth/authorize?app_id=...&redirect_uri=...&state=...`.
Use `/app-auth/authorize`; do not use `/authorize`.

`waitForCliLogin(sessionId, { timeoutMs?, intervalMs?, signal? })` and the
`{ appId, affiliateCode }` options on `createChatCompletion` / `createResponse` /
`createEmbeddings` / `generateImage` / `transcribeAudio` exist so browser apps
don't have to hand-roll the polling loop or a raw `fetch` to send `X-App-Id` /
`X-Affiliate-Code`. `appId` bills the app and credits the creator markup;
`affiliateCode` credits the affiliate's revenue share. Both are per-call and
sent only when set.

> Browser note: `startCliLogin` / `pollCliLogin` are CORS-friendly (token auth,
> no cookies). `pairWithToken` is server/agent-only — it sets an `Origin` header
> that browsers forbid `fetch` from overriding.

`cloud.routes` is generated from the public Cloud API route tree under
`packages/cloud/api`, including both Next-style exported HTTP handlers and Hono
`app.get` / `app.post` / `app.all` route modules. It intentionally excludes
admin, cron, webhook, internal, dashboard, auth, and MCP transport routes from
the package root SDK surface. The route audit still inventories the full route
tree so stale generated wrappers fail before publish.

JSON endpoints expose a typed method plus a `Raw` variant. Always-stream,
binary, and text routes return `Response` from the primary generated method;
mixed routes such as chat completions keep the JSON method and use `Raw` when
the request asks for streaming.

Parsed `request()` calls require an explicit JSON media type
(`application/json` or a structured `+json` type) and preserve every JSON
value, including primitives and `null`. Successful text, missing media types,
malformed JSON, and unexpectedly empty data responses throw `CloudApiError`;
use `requestRaw()` for text or binary bodies. `HEAD`, `204`, and `205`
responses are the deliberate bodyless exceptions and resolve to `undefined`.
The generic `get`, `post`, `put`, `patch`, `delete`, and
`postUnauthenticated` helpers preserve this behavior. Use `requestData` when
a caller requires JSON data even on a successful status.
Generated endpoints that deliberately return either JSON or `204` expose the
same `T | undefined` result, while data-required helpers reject a bodyless
response instead of hiding it behind their DTO type.
Older SDK releases could replace successful text or empty bodies with an
invented `{ success: true }` object; callers relying on that fallback must use
an explicit bodyless status or return a JSON response instead.

`InsufficientCreditsError` preserves HTTP402 and its error body. Its
`requiredCredits` field is `number | undefined`: render an unavailable amount
when the server omits it, and preserve an explicitly reported zero.

`pollJob` and `waitForCliLogin` enforce a total timeout through every request,
response-body read, and polling interval. Their timeout and interval options
accept integers from 0 through 2,147,483,647 milliseconds; zero timeout expires
immediately. Login cancellation also interrupts an in-flight request or wait.
Direct `getJob` and `pollCliLogin` calls accept optional `timeoutMs` and `signal`.

Refresh and verify route coverage after adding or changing API routes:

```bash
node packages/cloud/sdk/scripts/generate-public-routes.mjs
node packages/cloud/sdk/scripts/audit-api-routes.mjs
```

Run live e2e tests against the real API with:

```bash
ELIZA_CLOUD_SDK_LIVE=1 ELIZAOS_CLOUD_API_KEY=eliza_... bun run test:e2e
```

The live suite is intentionally split by capability:

- `ELIZA_CLOUD_SDK_LIVE=1` runs public real-API checks for CLI login bootstrap and model listing.
- `ELIZAOS_CLOUD_API_KEY` or `ELIZA_CLOUD_API_KEY` enables authenticated read checks.
- `ELIZA_CLOUD_SESSION_TOKEN` enables browser-session-only API key management checks.
- `ELIZA_CLOUD_SDK_LIVE_GENERATION=1` enables paid generation checks.
- `ELIZA_CLOUD_SDK_LIVE_RELAY=1` enables gateway relay lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_DESTRUCTIVE=1` must be combined with the specific resource flag before tests create or mutate resources.
- `ELIZA_CLOUD_SDK_LIVE_CONTAINERS=1` and `ELIZA_CLOUD_SDK_CONTAINER_IMAGE_URI=...` enable container lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_AGENT=1` enables Eliza agent lifecycle checks.
- `ELIZA_CLOUD_SDK_LIVE_PROFILE_WRITE=1`, `ELIZA_CLOUD_SDK_PROFILE_FIELD=...`, and `ELIZA_CLOUD_SDK_PROFILE_VALUE=...` enable profile write checks.
- `ELIZA_CLOUD_SDK_LIVE_OPENAPI=1` forces the OpenAPI check when testing an environment where `/api/openapi.json` is public. The hosted production endpoint currently requires auth.

Build and publish:

```bash
bun run build
npm publish --access public
```

## Organization subscription cancellation

With a current owner/admin session, `submitOrganizationSubscriptionCancellation`
accepts the expected local subscription UUID, its expected revision, and a stable
`idempotencyKey`. It requests cancellation at the current period end. Retain the
same key when checking an uncertain request; contradictory pending commands are
rejected. The UUID and revision are preconditions on the organization’s canonical
subscription, not provider identifiers. Stripe identity comes only from server
authority.
`readOrganizationSubscriptionCancellation(commandId)` polls the durable outcome
without repeating a provider mutation. `OUTCOME_UNKNOWN` is unresolved;
`APPLIED` supplies an immutable result revision. Recovery retrieves an uncertain
provider outcome without sending an unattended mutation. Current billing state remains
available from the existing billing snapshot. Developer API keys cannot authorize
these methods, and no provider identifiers or credentials are returned.

To undo a scheduled cancellation before its period ends, call
`submitOrganizationSubscriptionCancellationUndo` with the current subscription
revision and a stable idempotency key. Poll with
`readOrganizationSubscriptionCancellationUndo`; the original cancellation poll
endpoint continues to read only cancellation commands. Undo uses the same
session-manager authorization and explicit uncertain-outcome contract.

Returning billing managers can discover outstanding cancel/undo commands with
`listPendingOrganizationSubscriptionCommands({ limit: 20 })`. Pass a returned
`nextCursor` explicitly to request another page. Each page observes current
primary state; the cursor does not preserve a snapshot across requests, and a
command completed between pages can disappear. Lease expiry describes the
stored worker lease, not whether Stripe accepted an operation. The report makes
no provider request and does not retry a command.


### Accepting a new Dedicated runtime charge

Before starting paid Dedicated compute, show the current running rate and minimum successful-start charge from `AGENT_PRICING` and obtain the caller's acceptance. Send `X-Eliza-Dedicated-Price` with the value returned by `getDedicatedComputePriceAcceptance()` from `@elizaos/cloud-sdk/browser-contracts`. The header is required on Dedicated `provision`, `resume`, `wake`, and eager agent creation. Creating an offline record, using Shared, or retrieving an already-running agent does not start a new session and does not require it.

A missing or outdated value returns HTTP428 with code `DEDICATED_PRICE_CONFIRMATION_REQUIRED` and the current pricing. No paid start is admitted. Review the new terms before retrying; do not silently attach acceptance in a generic HTTP interceptor. API-key callers follow the same contract as signed-in app callers. The startup minimum counts toward running charges and applies again after stopping and starting; an uninterrupted billing renewal is not a new activation.

New provision/resume/wake/restart jobs persist the tariff at admission. A worker with different terms rejects the job before dispatching runtime actions; legacy jobs without a tariff are also rejected. Reusing or recovering a job does not refresh its tariff. A rejected start needs a new request after price review, not automatic retry. During rollout, drain old workers and reconcile their in-flight operations before switching versions; this check does not make an old worker understand the new contract.
