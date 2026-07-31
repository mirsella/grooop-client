# Grooop Party PWA

Private, one-phone client for two Grooop accounts. It supports Proximo and
TTMC: the browser manages two local teams while a Cloudflare Worker keeps each
Grooop identity and party socket isolated on the server.

## Architecture

- React/Vite installable PWA served by Workers Static Assets
- Cloudflare Worker API protected by Cloudflare Access
- D1 for encrypted account material, login challenges, matches, team presets,
  and observed Proximo questions
- One Durable Object per live match for the two outbound Grooop WebSockets
- AES-256-GCM encryption for account identities and Grooop sessions; only
  masked account data reaches the browser

The browser never receives Grooop session tokens. API responses use no-store
behavior for private data. The service worker caches only same-origin static
assets, never `/api/`, and supports an offline application shell after one
controlled online load.

## Local Development

Requirements: Node.js, pnpm 11, and a Cloudflare account.

```bash
pnpm install
pnpm exec wrangler d1 migrations apply grooop-party-pwa --local
pnpm dev:worker
```

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:worker
pnpm build
pnpm test:e2e
```

Unit tests cover Access JWT validation, encryption, validation, redacted error
handling, the shared-state reducer, party sockets, reconnect and room
idempotency, and sanitized production Proximo and TTMC protocol replays.
Worker tests use real local D1 migrations with a deterministic mocked Grooop
boundary for account, preset, history, mode-specific quote and paid-create,
join, origin, and idempotency flows.

The default Playwright matrix runs desktop Chromium plus Pixel 7 and iPhone 15
touch layouts on Chromium. It tests quote retry idempotency, account
re-authentication, team presets, live-match restoration after reload, the
visible countdown, all-category selection, one-click dual-team lock-in,
TTMC setup, pre-reveal answer secrecy, next-topic behavior, question history,
service-worker cache boundaries, responsive overflow, and the absence of
browser-stored session material. Normal CI is fully mocked and cannot spend
Grooopies.

True WebKit is opt-in for a compatible Ubuntu CI runner:

```bash
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e
```

Playwright's Ubuntu WebKit binary is not ABI-compatible with this project's
Arch Linux development host.

Production tests are separate, serial, and never run in CI. First save a
manually authenticated Cloudflare Access browser state at an absolute path
outside the repository with mode `0600`. The live configuration enforces those
conditions, accepts only the production HTTPS origin, and disables Playwright
traces so Access cookies cannot be retained. Read-only verification requires:

```bash
LIVE_BASE_URL=https://grooop-party-pwa.mirsella.workers.dev \
LIVE_STORAGE_STATE=/absolute/path/to/access-state.json \
  pnpm test:live
```

The paid test is skipped unless spending is authorized twice: an explicit flag
and a positive hard cap. It requotes immediately and refuses a cost above that
cap:

```bash
LIVE_BASE_URL=https://grooop-party-pwa.mirsella.workers.dev \
LIVE_STORAGE_STATE=/absolute/path/to/access-state.json \
LIVE_ALLOW_SPEND=1 LIVE_SPEND_CAP=100 pnpm test:live
```

## Cloudflare Deployment

The dedicated D1 database, Durable Object namespace, Access application, and
encryption configuration are configured in the Proton-owned Cloudflare account:

```text
https://grooop-party-pwa.mirsella.workers.dev
```

`pnpm deploy` builds the application, applies pending remote D1 migrations, and
only then deploys the Worker:

```bash
pnpm deploy
```

The self-hosted Access application protects the exact `workers.dev` hostname.
Its Allow policy contains only the configured owner identity, requires the
configured identity provider, and lasts eight hours. Preview URLs are disabled.
Unauthenticated requests to both `/` and `/api/health` redirect to Access. The
Worker then independently verifies the Access JWT signature, issuer, audience,
subject, and configured owner identity for both static and API requests.

All static and API requests run through the Worker. Static responses include a
frame-denying CSP, `X-Frame-Options: DENY`, no-sniff, no-referrer, and restrictive
Permissions Policy headers. Production returns 503 for every route while the
encryption configuration, key version, or either Access value is invalid. The
authenticated health route also verifies that the latest match schema exists.

Verify each deployment in a private browser window before adding or using
Grooop accounts:

1. Unauthenticated navigation is denied by Access.
2. The owner identity can load the PWA and `/api/health`.
3. Another identity cannot load either the static application or API.
4. Account Settings exposes only masked account identities.

## Account And Match Flow

Settings verifies a Grooop login challenge and requires `/user/retrieve` to
return a real user before storing the encrypted session. Refresh revalidates
identity. Re-authentication does not expose the stored account identity to the
browser. Removal is blocked during an active match and intentionally rejected
when match history still references the account, rather than failing at a
database foreign key. Settings also saves, applies, updates, and deletes named
team-roster presets.

Creating a match refreshes both selected accounts, obtains a mode-specific
server quote, and requires confirmation of that exact cost. Proximo creation
selects a content pack and duration. TTMC creation loads the host's currently
available packs, selects all of them by default, and selects two to ten rounds.
An All packs shortcut restores the complete selection after a custom choice.
The setup catalog is the host's sanitized live party parameters; it contains
only TTMC ownership and available pack titles/slugs. Refreshes preserve every
still-available selection. Each mode uses the corresponding upstream parameters
and paid-create payload. A quote retains the exact setup it priced, and a
unique idempotency key is claimed before spending; browser retries return the
same match and cannot call `party/create` again. The host creates one two-player
party and the guest joins it. Party metadata is persisted immediately after
creation. Join or relay initialization failures remain recoverable and never
automatically repeat paid party creation. A persisted `joining` match can be
resumed by match ID after reload without the original browser idempotency key;
this only retries guest query/join and room initialization, never `party/create`.
The socket route also idempotently binds its Durable Object before every browser
upgrade.

Grooop exposes neither create idempotency nor a party lookup by client request
ID. A transport failure during the paid `party/create` call therefore has an
irreducibly unknown outcome. The app records `party-create-outcome-unknown`,
blocks every new paid match, and requires manual operator reconciliation rather
than risking a second charge.

On page load the PWA retrieves the authenticated match list and automatically
reopens the newest live match. The match ID is rediscovered from the API; no
Grooop credential or live state is stored in browser storage. The Durable Object
reconnects and resynchronizes both upstream accounts. Every new upstream socket
reads the account's current encrypted session from D1, so a successful
re-authentication is used on the next reconnect. Persisted per-action markers
make retries safe: an already accepted action is reused, and an uncertain
upstream outcome is reconciled from synchronized state or left blocked rather
than repeated. The browser keeps only one command in flight; synchronized room
state remains the sole authority after acknowledgements and reconnects.

Proximo can use one granted category or `all`, which sends all four granted
content slugs: `300`, `299`, `geographie`, and `sciences`. The live room adds
Proximo only after the upstream party is running, then maps Team A and Team B
answers to their corresponding accounts. Both accounts become ready together;
production validation proved the second successful `ready` automatically
starts round 0, so normal play does not send `force-start`.

When the continuously connected room first observes a new question, it persists a deadline in
Durable Object storage from the server-provided question duration. The browser
renders that deadline as a prominent `MM:SS` countdown, including urgent and
expired states. Browser reloads and room reconnections do not restart it.
If an active question is first discovered during reconnection without a stored
deadline, answering fails closed rather than granting a fresh window. Grooop's
reveal remains authoritative because the observed protocol does not include an
absolute server start timestamp.

The browser can privately lock either complete team answer before handing the
phone over; it sends only complete, unresolved sides. The room submits batched
account-specific requests concurrently and retains its
per-player, per-round deduplication, so a retry cannot intentionally submit the
same answer twice. Partial success remains recoverable: after reload, only the
unresolved team's answer is sent. Official answers, score details, and the
next-question control remain hidden until authoritative `showAnswer: true`; a
mere `finished` label or early score delta is insufficient. After reveal, `Next
question` follows the official-client model:
it adds a new Proximo game to the same running party while retaining completed
games in party history; it does not reuse the finished game or call
`finish-current-game`. Revealed questions are stored once by content fingerprint
and can be reviewed in History. The room verifies both expected Grooop user IDs,
reconnects and fully resynchronizes upstream sockets, and deduplicates
ready/answer actions across retries.

TTMC sends the persisted pack selection as upstream `selectedContents`; the
canonical sorted selection is part of the paid request's idempotency identity.
TTMC begins when the host starts the first topic. On the same phone, each team
independently selects difficulty 1–10, receives its own question, and
submits its own answer. After a finished round, `Next topic` creates the next
round; after the configured final round, the upstream party completes
automatically. Supported TTMC answer types are yes/no, multiple-choice,
word-order, one-word text, and bounded numeric input. The browser receives only
the public prompt and answer controls for each team. Correct answers, success,
and points remain hidden until the authoritative finished round; raw question
data stays in Durable Object storage.

A live match in waiting, playing, or revealed state can be cancelled from
History. Grooop does not let the game master leave an IRL party, so cancellation
uses the controlled guest's official `give-up` command. If the party has not
started, the room first performs the normal idempotent game bootstrap required
by Grooop. The local match is cancelled only after Grooop confirms the leave.
Its terminal snapshot is persisted before D1 projection so a database retry
never sends `give-up` twice.

Before finalizing a match in D1, the room stores its sanitized terminal snapshot
in Durable Object storage. A Durable Object alarm retries a failed terminal D1
projection across process eviction, and a restarted room can serve the final
state read-only without reconnecting to the finished upstream party.

Production also proved that the Proximo game object lives in application 0's
dereferenced `games` list while per-player scores live in application
`<gameId>`. Answer requests return an object containing the official answer and
delta; the room intentionally normalizes that transport reply to `accepted`
and exposes results only from synchronized reveal state. Score updates call the
answer gap `answerDelta`. The UI presents it as a gap, not as awarded points.
`finish-current-game` cannot reset a party for another Proximo game. During the
first discovery it transitioned the party to finished; after an already
finished Proximo round it returned `no-running-game`, so the local match closes
and the upstream party expires normally rather than being probed with an
unverified cancel endpoint.

Sanitized, credential-free Proximo and TTMC production fixtures are replayed in
the unit suite. The Proximo fixture covers dual sockets, party/game creation,
both ready actions, automatic question start, both answers, scoring, reveal,
and completion. The TTMC fixture covers the two-account flow, independently
started team questions, recovery requests, completed rounds, and automatic final
party completion. It observes boolean, selection-array, and text answers.
Numeric TTMC support is implemented from the decompiled official-client schema,
not observed in this capture. Correlations, entity references, player IDs, and
identity fields are pseudonymized; live rooms do not retain protocol traffic.

## Operations

Back up D1 before schema or encryption-key changes using Cloudflare's D1 export
facility, and keep the export outside the repository with restrictive file
permissions. Apply every pending migration before deploying the Worker that
depends on it. The current schema stores only mode-native match settings:
Proximo rows have content and duration, while TTMC rows have a round count and
the selected content-pack array. TTMC matches created before pack selection was
introduced are migrated to the standard `included` pack.

Extension purchases are claimed in D1 before the upstream mutation. Their
idempotency fingerprint includes the account, product, and expected price;
concurrent requests with the same key converge on that one claim, while a
different key cannot claim an active product. Ambiguous outcomes remain blocked
until ownership can be reconciled read-only.

The Worker runs the ad-reward claim once daily at 06:00 UTC. Accounts are
isolated and processed concurrently; each account's ads remain sequential with
the upstream-required 20-second wait. A finish request is never retried because
its outcome may be ambiguous. Grooop authorization failures mark only that
account as requiring reauthentication.

## Current Limitations

- Proximo and TTMC have fixture-backed two-account evidence and replay coverage.
  The separately guarded paid live test currently completes a Proximo round;
  TTMC has not yet been exercised by that live test.
- Selecting all four Proximo categories and adding another Proximo game after a
  reveal are both behaviors recovered from the official client. The local
  deterministic suite covers them, but those exact two requests have not yet
  been captured in a production party.
- The opt-in paid live test remains separately guarded because every invocation
  creates a newly charged party. Preserve only sanitized protocol fixtures;
  never retain credentials.
- There is no supported bulk question endpoint. Questions are observed during
  normal authorized games and deduplicated after reveal.
- Deploying or restarting the Worker disconnects outbound Grooop sockets. The
  room reconnects and performs a full shared-state sync while a browser remains
  attached.
- Grooop provides a question duration but no verified absolute question start.
  There is no verified request that configures per-question answer time.
  Proximo's party duration is the whole match duration, and TTMC's round setting
  is a topic count. Server reveal remains authoritative.
- Ad rewards run on the daily schedule above. Match creation uses Grooop's paid
  party endpoint only after an explicit quote and confirmation; retries remain
  protected by persisted idempotency state.
