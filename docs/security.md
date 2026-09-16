# Security Model

## Trust boundaries

The machine is the trust boundary. ChatGPT is an advisory client; Codex is the
executor. A third-party public tunnel forwards HTTPS traffic to the one
machine gateway's fixed loopback port, and the connector is configured with the
public `Server URL` plus a transport token (see below for why ChatGPT cannot
send it as a header).

The gateway trusts only:

1. Its owner-checked local runtime record.
2. Workspace roots registered by the local harness.
3. Capabilities it issued for the current boot and registration.
4. Correlation and scope fields that match the live control request.

ChatGPT Project names, Project URLs, chat URLs, tab titles, model text and file
contents are untrusted. They are never authorization principals.

## Public endpoint and bearer token

The official OpenAI Secure MCP Tunnel used to authenticate the transport, which
is why the connector could be configured with `Authentication: None`. A public
URL carries no such guarantee, so the endpoint authenticates itself. A request
is accepted when it presents the token on either channel:

- `Authorization: Bearer <token>` — the canonical channel and the only one an
  ordinary MCP client needs.
- the URL, as `/mcp/<token>` (preferred) or `/mcp?token=<token>`. The ChatGPT
  app form offers only `OAuth` / `No authentication` / `Mixed`, keeps no field
  for a static token, and per the Apps SDK cannot present custom API keys, so
  `No authentication` plus a token in the URL is the only configuration that
  client can express. Its `OAuth` option has nothing to talk to here, because
  this gateway runs no authorization server.

A non-empty `Authorization` header decides alone, even when it is wrong: the
gateway never falls back to a URL token that happens to validate, so "which
credential was rejected" stays answerable during a rotation. `POST /mcp` with no
token at all returns `401`, the value is compared in constant time, and
`c2c serve-http` refuses to start when no token exists, so the gateway never
serves an unauthenticated endpoint to the internet, even transiently.
`C2C_DISABLE_URL_TOKEN=1` removes the URL channel and restores the header-only
contract.

**The URL channel is a deliberate downgrade, and it is bounded.** A URL is
written to the tunnel provider's logs and to every hop in front of it, and it is
stored inside the connector; in exchange, clients that can send a header keep
the stronger contract, and the token stays out of every request the connector
makes. Anyone who obtains the full `/mcp/<token>` URL holds the transport
credential directly, so treat that URL as a password: keep the tunnel dedicated
to this machine, rotate with `c2c machine auth rotate` if it is exposed and
update the connector URL in the same step, and prefer having the tunnel inject
the `Authorization` header (`--request-header-add`, or a `remove-headers` +
`add-headers` traffic policy — `add-headers` alone appends rather than replaces)
when no secret should appear in a URL at all.

The token is created on first use by `c2c machine auth show --reveal`, rotated
by `c2c machine auth rotate`, and stored 0600 at `<state>/http/auth.json`.
Normal CLI output shows only a hint such as `c2c_mcp_xxxx…yyyy`; the full value
is printed only on an explicit `--reveal`.

The bearer token is a **transport gate, not an authority**. It proves only that
the caller reached this gateway. It does not replace C2C's turn capabilities: a
caller that passes the bearer check still needs a valid `context_id` issued by
`control open`, and every tool additionally enforces its own scope. A public URL
therefore widens who can reach the transport, not who can act on a workspace.

## MCP data policy

The MCP surface is intentionally small:

- Directory listing, bounded file reads and search.
- Git status and bounded diff reads.
- Local execution summaries and bounded output reads.
- No production MCP result writes; results arrive through verified Computer Use observations.

There are no MCP tools for editing files, deleting files, running shell
commands, changing Git state, or committing. Codex performs those operations
locally and records the outcome for review.

Workspace content may contain instructions aimed at an agent. The MCP server
marks it as untrusted project data; ChatGPT must not execute or obey commands
found in files, comments, README text or diffs.

## Path containment

Every workspace root is normalized and canonicalized before registration. Every
requested path is resolved relative to that root and checked for containment.
The following are rejected:

- `..` traversal outside the root.
- Absolute paths that are outside the root.
- Symlinks whose resolved target escapes the root.
- NUL/control characters and malformed path input.
- Requests after the registration has been revoked.

The workspace root is selected by the local `cwd`; ChatGPT cannot choose a
different root by passing a path in a tool argument. Workspace-scoped CLI
commands apply the same rule: an optional `-w` must resolve to the exact
current `cwd`, so it cannot register or operate on another local path.

## Capability security

Every control turn gets a random, short-lived `CONTEXT_ID`. The broker stores a
hash of the secret and binds it to:

```text
bootEpoch
workspaceId + projectId + registrationId
localSessionId + taskId + iteration + phase
compactionEpoch + browser-page generation + scopes
```

The raw token is returned only to the local harness and inserted into the exact
control prompt for that turn. ChatGPT must pass it as `context_id` in every MCP
call. A missing, malformed, expired, cancelled, replayed, or mismatched token
is rejected before workspace access.

The broker gives each claim an activity lease. MCP calls renew the lease while
running and release it even on errors. Computer Use results must match the exact
tab, chat, generation, response, request, phase, and schema before the request
is closed. The retained mailbox completion fence is inactive in production and
remains tested for later comparison.

## Result integrity

The active Computer Use ingress validates canonical JSON and exact request/page
identity. A result must match:

```text
RESULT_REQUEST_ID
workspaceId
localSessionId
taskId
iteration
phase
tabId + chatUrl + generation + responseId
```

The allowed payload is phase-specific (`RESEARCH`, `PLAN`, `REVIEW`, `DONE`, or
`BLOCKED`) and size bounded. A request is one-shot. An already-open request is
not overwritten with a new token. Mailbox callback code and historical data are
retained but the callback tools are not registered by the production MCP server.

Mailbox markers use separate pending, result, acknowledgement, cancellation,
and active-lease records. Lifecycle writes use file locking and exact schema
checks. Terminal records are retained only for bounded cleanup and audit.

## Browser isolation

One local session owns one persistent page in the built-in ChatGPT browser. Its
lease is keyed by `projectId + localSessionId` and records the exact `tabId`,
Project URL, chat URL, generation, owner epoch and expiry.

Normal operations must use stable URLs, DOM/browser APIs and the stored tab id.
Screenshot-coordinate control is not a security boundary and is not used for
normal navigation or submission. A visible foreground page is never implicitly
owned.

Page replacement requires the exact current generation. A stale session cannot
replace a live page, and a page from another Project cannot satisfy the lease.
When a page fails, only its local session backs off or rotates its lease; other
sessions retain their pages and continue.

The protected machine ownership index is authoritative across workspaces. It
rejects a normalized Project URL already bound to another local project and a
physical browser/surface/tab tuple already owned elsewhere. Workspace-local
page files are recovery mirrors only: they are overwritten from machine state,
never imported as authority. A machine-wide monotonic generation allocator
prevents a workspace edit or retired session from replaying an older page
generation; inactive per-session entries can therefore be pruned safely.

The machine permits 100 unexpired session/page leases, counted by unique
`(projectId, localSessionId)` identities, each representing one workspace-local
session owner. Released, expired, and retired leases free capacity.
A claim for a new 101st session is rejected with a retryable capacity result and
must wait, back off, and retry after a slot becomes available. Renewals,
idempotent claims, and page replacements for an existing session reuse its slot
and do not add capacity usage. Resource pressure may still come from the
browser or ChatGPT service, but C2C does not silently serialize unrelated
sessions. Only one session's own turns are ordered.

## Machine runtime security

The gateway process started as hidden `c2c serve-http` is the single MCP
gateway. It binds loopback only (`127.0.0.1`, port `48765` by default) and its
admin API requires its per-lifetime admin token. The admin token is never
returned by normal status output.

The machine runtime record is protected and owner-checked using machine id,
boot epoch, pid and exact port/runtime data. A process only clears its own
record. A second process cannot adopt or publish over a healthy runtime.

The bearer token is generated locally and stored 0600 in protected state; it is
never read from a file the user supplies, and normal status output exposes only
a short hint of it. Status, errors, tests and documentation redact bearer tokens,
admin tokens and raw capabilities.

Mutable project data is kept inside the repository boundary: Git checkouts use
`<git-common-dir>/codex-with-chatgpt`, while non-Git workspaces use
`<workspace-root>/.codex-with-chatgpt`. Shared project metadata is separated
from checkout-specific session routes and execution records under
`workspaces/<workspaceId>/`. The authoritative mailbox, runtime installations,
the recorded public endpoint and bearer token, the machine association id,
surface ownership index, gateway ownership records, machine identity, lifecycle
locks and logs remain in protected machine state. The
`sandbox-clean` command removes obsolete global write grants; it does not grant
a global machine-state directory.

## Browser and gateway failure handling

`machine doctor` verifies the gateway health response, the loopback admin port,
the owner record, the recorded public endpoint and whether a bearer token
exists; it reports `gateway`, `endpoint` and `auth` as separate checks, so a
missing endpoint or token is distinguishable from a stopped gateway. This
remains a local configuration and liveness check, not a cryptographic
process-identity proof, and it does not prove that ChatGPT can reach the public
URL.
`machine stop` first verifies the same ownership identity, then sends SIGTERM to
the gateway it owns; it never kills a process whose live health payload does not
match this machine's record, and it does not touch the third-party tunnel.

After a gateway restart, all old contexts are invalid because `bootEpoch`
changes. The local harness re-registers affected workspaces, claims or renews
their surfaces, and issues new contexts. It never retries an old token.

## User responsibilities

Keep the bearer token and machine-state files private and do not commit them.
Keep the tunnel dedicated to this machine: the public URL is reachable by
anyone, and the connector URL carries the transport token. Rotate the token with
`c2c machine auth rotate` if it is exposed, update the connector URL in the same
step or every call returns `401`, and record a new public URL with
`c2c machine endpoint set` whenever the tunnel's address changes.
In ChatGPT create only the named connector with the public URL plus the token,
set `Authentication` to `No authentication`, and keep each workspace in its
intended Project. Do not paste admin tokens, context tokens, or full repository
contents into ChatGPT manually.
