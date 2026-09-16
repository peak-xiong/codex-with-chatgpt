# Machine-Wide Architecture

## Goal

C2C connects any number of local Codex workspaces to ChatGPT with one machine
configuration. The transport is shared, while workspace data and conversation
state remain isolated.

The key distinction is:

- **Machine scope:** one public endpoint backed by one third-party tunnel, one
  connector, one gateway process and one machine identity.
- **Workspace scope:** one trusted local root, one stable Project identity and
  one registration in the machine gateway.
- **Session scope:** one local Codex session, one ChatGPT Project chat and one
  owned browser page.
- **Turn scope:** one short-lived capability, one correlated request and one
  ordered control message.

## Components

```text
                ChatGPT web
       Project A       Project B
       chat/page       chat/page
           |               |
           +-------+-------+
                   |
      Connector: Codex with ChatGPT
      Server URL: /mcp/<token>, no auth header
                   |
      third-party public tunnel
            <public-url>/mcp/<token>
                   |
   c2c serve-http on 127.0.0.1:48765 (token-gated /mcp)
                   |
     Machine Gateway (loopback admin API)
       |          |             |
  registry   capability      MCP server
             broker             |
     control/result records     |
                   +------------+
                   |
            local workspace roots
             execution records
```

### Public HTTP transport

C2C does not implement or supervise the tunnel. The gateway is started directly
as hidden `c2c serve-http`, which binds the fixed loopback port `48765`
(`DEFAULT_MACHINE_HTTP_PORT`, overridable only through `C2C_HTTP_PORT`). The port
is recorded rather than ephemeral because the tunnel's configuration points at
it. A third-party tunnel the operator runs forwards to that port, and the MCP
URL is `<public-base-url>/mcp`. Any tunnel that forwards a public HTTPS URL to
the loopback port is valid; a Cloudflare named tunnel is preferred because its
hostname is stable across reconnects, while a quick tunnel (Cloudflare
`trycloudflare.com` or ngrok) gets a new hostname on every reconnect and the
recorded endpoint then has to be updated.

The official OpenAI Secure MCP Tunnel used to authenticate this transport,
which is why the connector could use `Authentication: None`. A public URL has no
such guarantee, so `POST /mcp` requires a transport token: a missing or wrong
token gets `401`, and `serve-http` refuses to start without a token. The token
is accepted from the `Authorization: Bearer` header or from the URL
(`/mcp/<token>`, `/mcp?token=<token>`) because the ChatGPT app form has no field
for a static token and cannot present custom API keys; a non-empty header always
decides alone, and `C2C_DISABLE_URL_TOKEN=1` removes the URL channel. The token
is created lazily by `c2c machine auth show --reveal` (rotated with
`c2c machine auth rotate`) and stored 0600 at `<state>/http/auth.json`; the
public URL is recorded at `<state>/http/endpoint.json`.

This network resets the OpenAI endpoint at the TLS SNI layer — TCP to the real
`api.openai.com` address succeeds, and the handshake dies only when SNI is
`api.openai.com` — so the tunnel transport cannot connect here at all and was
removed with no fallback path. `serve-machine --stdio` no longer exists.

The gateway keeps a persistent `associationId` in machine state. The tunnel
configuration used to carry that value across restarts; the gateway now
generates and persists its own, because an id that changed on every start would
make the stored connector binding report `stale` after each restart.

ChatGPT is configured with the public Server URL, the token appended to the
`/mcp` path, and `Authentication: No authentication`, instead of selecting a
tunnel. The token is a transport gate only: a caller that
passes it still needs a valid `context_id` issued by `control open` before any
tool acts on a workspace, and each tool keeps its own scope check.

### Machine autostart

On macOS, one LaunchAgent may be enabled for the whole machine after setup:

```sh
c2c autostart enable --json
c2c autostart status --json
```

launchd runs hidden `c2c autostart run --quiet`. That entry point only invokes
`ensureMachineGateway`, which restarts the one `c2c serve-http` gateway if it is
down. It does not start a per-workspace process, the tunnel, or browser pages.
Disable it with `c2c autostart disable --json`.

### Machine Gateway

The gateway owns the in-memory capability broker and workspace registry. A
machine lifetime record contains `machineId`, `bootEpoch`, `pid`, port and an
admin secret. Startup is exclusive; cleanup is allowed only when all of those
owner fields still match.

The MCP server does not infer a workspace from a global “active project” or
from a ChatGPT URL. It accepts only a valid `context_id`, resolves the context
to a registered workspace, and performs the requested read within that root.

Machine state is split by privilege. Mutable project state stays inside the
repository boundary: Git checkouts use `<git-common-dir>/codex-with-chatgpt`,
while non-Git workspaces use `<workspace-root>/.codex-with-chatgpt`. Linked
worktrees share project metadata and a non-authoritative page recovery mirror;
session routes and execution records are isolated below
`workspaces/<workspaceId>/`. Runtime installations, the authoritative mailbox,
the recorded public endpoint and bearer token, the machine association id, the
authoritative cross-workspace Project URL, physical-tab and generation ownership
index, gateway ownership records, machine identity, locks and logs remain in
protected machine state.
`sandbox-clean` removes obsolete global write grants and does not expose a
machine-wide state directory to Codex.

### Workspace registry

Registration canonicalizes the root and records:

```text
workspaceId     checkout-specific identity
projectId       stable project identity
registrationId  current registration generation
root            trusted local filesystem root
workspace name  display metadata
```

The registry verifies the current root on every data-plane claim. Re-registering
after a checkout move or replacement creates a new registration and revokes
capabilities issued to the old registration. A path or Project name supplied by
ChatGPT cannot create or select a registration.

Every explicit or stale-registration removal uses the same lifecycle path. It
revokes capabilities for the exact registration, then removes machine surface
ownership only when no valid checkout for that stable `projectId` remains.

## Browser and conversation ownership

Each Project has one C2C connector association, but each local session has its
own conversation. The protected machine index stores the Project association
independently:

```text
projectId -> normalized projectUrl
```

That association remains after the last session is retired, so a new session
or linked worktree can discover and reuse the existing Project. It is removed
only when the last registered checkout for the project is unregistered. A
surface lease maps:

```text
projectId + localSessionId
  -> browserId + surfaceId + tabId + projectUrl + chatUrl
  -> generation + ownerProcessEpoch + expiresAt
```

The mapping is persistent. A new session creates a new Project chat and a new
owned page even if another C2C page is open. A page rotation must present the
exact current generation, so a stale session cannot steal a replacement.
The Gateway serializes updates under one machine lock and enforces one local
project per normalized ChatGPT Project URL plus one owner per physical page.
Workspace mirrors are never imported into this authority. A machine-wide
allocator keeps generations monotonic across release, expiry, and session
retirement while inactive per-session entries are pruned.

The machine-wide capacity is 100 unexpired session/page leases, counted by
unique `(projectId, localSessionId)` identities, each representing one
workspace-local session owner. Up to 100 independent local sessions can own
pages and run concurrently. When all 100 leases are held, a claim for a new
101st session is rejected with a retryable capacity result; the caller must
wait, back off, and retry after a lease is released, expires, or the owning
session is retired. Renewing, idempotently reclaiming, or replacing a page for
an existing session reuses its slot and does not increase the count. Only
messages belonging to the same `localSessionId` are serialized; independent
sessions are never queued behind one another.

The Skill keeps the owned pages in the built-in browser. Computer Use targets
the exact `tabId` and uses stable URLs plus semantic DOM operations. The CUA
host runtime executes the browser calls; TypeScript persists and validates the
lease but cannot invoke the host CUA APIs directly. For a saved route, it first
executes `cua.getTab(tabId, { browser: "iab" })` and validates the returned
Project/chat URL. If that exact tab is unavailable or its URL is wrong, it
executes `cua.createBrowserTab("iab", targetUrl, { visible: false })`, where
`targetUrl` is the saved chat URL or Project URL, and replaces the lease only
for the same `localSessionId` using the exact current generation and tab id.
A saved route without a `tabId` is invalid and follows this same replacement
branch; it never authorizes choosing an existing tab by URL.
With no saved route, it creates a hidden Project candidate the same way. It
never selects another tab by URL, title, recency, or foreground state, and it
never reuses the user's ordinary ChatGPT page.

Normal control stays in the background: immediately before sending and after
sending, the Skill re-reads the same exact `tabId` and verifies the Project/chat
URL. It uses semantic DOM operations and does not focus or activate the page.
It never passes `visible: true` for a normal control turn.
Only login, CAPTCHA, 2FA, or explicit consent may temporarily require a
visible page; after that user action the page returns to the background and
the exact-tab and URL checks run again.

## Turn capability lifecycle

Before a control message, the local harness:

1. Confirms the session route and surface generation.
2. Opens one correlated request for `(workspaceId, localSessionId, taskId,
   iteration, phase)`.
3. Issues a capability bound to the same correlation, current registration,
   exact `requestId`, compaction epoch, surface generation and requested scopes.
   BOOT uses the same request binding and its verified Computer Use result gates
   the first route commit.
4. Places `CONTEXT_ID` and `RESULT_REQUEST_ID` in the prompt sent to the owned
   chat.

ChatGPT passes `context_id` to every read-only MCP call. The gateway claims a
lease, renews it during a long operation, and releases it in a `finally` path.
On completion, Computer Use verifies the exact bound page response and submits
its schema-valid marker through the host-only observation endpoint. The retained
mailbox completion path is dormant in production and remains covered by tests.

Completion or cancellation revokes the capability. Gateway restart changes the
boot epoch and invalidates all prior capabilities. Compaction or a page
generation change invalidates a stale turn even when its token has not expired.

## Concurrency model

The system has two independent ordering rules:

```text
Session A: turn 1 -> turn 2 -> turn 3
Session B: turn 1 -> turn 2
Session C: turn 1 -> turn 2 -> ...

A, B, and C execute independently.
```

The control and capability records do not consume additional page-capacity
slots. Surface ownership has one machine-wide capacity of 100 unexpired
session/page leases, with one slot per unique `(projectId, localSessionId)`
identity. Released,
expired, and retired leases free their slot; a new-session claim at capacity is
rejected with a retryable result and retries only after one becomes available.
Renewals, idempotent claims, and page replacements for an existing session
reuse its slot. Bounded terminal tombstones and per-turn activity leases
remain cleanup protections. Backoff, retry, and browser recovery are scoped
to the affected session only.

Normal request open, observe, and cancel operations use a lifecycle lock for the
specific `localSessionId`; they do not serialize the whole workspace. Dormant
mailbox result and acknowledgment operations retain the same lock discipline.
The surface metadata ownership lock is only a brief atomic uniqueness guard for
lease commits/replacements; it never limits browser turns.

## Data boundaries

ChatGPT receives no pasted repository dump. It uses read-only MCP tools for
directory listing, bounded file reads, search, Git state/diff, and execution
records. Codex keeps write operations and command execution local.

The Project URL and chat URL provide continuity and navigation. They are not
trusted authorization values. Authorization comes from the machine gateway's
capability binding and the trusted local root.

## Recovery ownership

`machine start` and `machine doctor` operate on the one machine runtime. They
check gateway health, the owner record, the bound admin port, the recorded public
endpoint and the bearer token.
`machine stop` sends SIGTERM to the gateway process it owns; the process clears
its own runtime record on the way out. C2C never stops a process whose live
health payload does not match this machine's ownership record.

If one browser page fails, only that session renews or replaces its surface
lease. Other sessions, pages, workspace registrations and their conversations
continue unaffected.

## Design decisions

- One connector reduces user configuration to one machine-level action.
- A public URL plus a transport-level token keeps connector setup
  independent of workspace credentials; the token is only a gate, and each turn
  still needs its own `context_id` capability.
- The token is accepted from the URL as well as from a header, because ChatGPT's
  app form cannot send a static credential. The header keeps precedence, the URL
  channel can be disabled, and `docs/security.md` states the cost instead of
  treating the two channels as equivalent.
- `c2c serve-http` is spawned directly by the machine daemon, so the MCP gateway
  lifecycle is unambiguous, the tunnel stays replaceable, and there is no
  split-brain broker.
- Explicit context capabilities prevent a Project, URL, path, or visible tab
  from becoming an accidental security principal.
- Persistent session pages preserve independent ChatGPT histories without
  taking over the user's ordinary conversations.
