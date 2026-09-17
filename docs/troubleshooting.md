# Troubleshooting

Run machine diagnostics first. These commands redact secrets:

```sh
c2c machine status --json
c2c machine doctor --no-fix --json
```

When repair is appropriate, let the managed lifecycle restart the one gateway:

```sh
c2c machine doctor --json
```

Do not start a second gateway for a workspace and do not kill the gateway process
directly. C2C does not own or supervise your tunnel; start and stop that with the
tunnel provider's own client.

## Workspace state and sandbox cleanup

Run the update check from the affected workspace root and clean obsolete global
write grants once after setup or when migrating from an older release:

```sh
c2c update-check -w <workspace-root> --json
c2c sandbox-clean --json
```

Current mutable workspace state is stored at
`<git-common-dir>/codex-with-chatgpt` for Git checkouts and at
`<workspace-root>/.codex-with-chatgpt` for non-Git workspaces. Current commands
do not use the legacy machine-wide state directory.

## Enable or inspect macOS autostart

Autostart is one machine-level LaunchAgent. Enable and verify it once after
machine setup:

```sh
c2c autostart enable --json
c2c autostart status --json
```

launchd runs hidden `c2c autostart run --quiet`; this only invokes
`ensureMachineGateway` and restarts the one `c2c serve-http` gateway if it is
down. It does not create a per-workspace gateway, a browser-page queue, or a
second gateway. It does not start your tunnel. To remove the LaunchAgent:

```sh
c2c autostart disable --json
```

This command is currently supported on macOS LaunchAgents. It is optional on
other platforms and does not change the machine connection itself.

## Updating an existing installation

From the updated, clean source checkout, install the current runtime and start
the gateway again:

```sh
node bin/c2c.js machine setup --json
```

`machine setup` takes only `--json`. The `--tunnel-id`, `--runtime-key-file` and
`--reuse-existing` options were removed with the Secure Tunnel transport and are
now rejected. Setup reuses the recorded public endpoint and the existing bearer
token, so no original credential path is needed. Do not use the older globally
installed entrypoint for this update. Re-record the endpoint with
`c2c machine endpoint set --url <https-url>` only when the tunnel's public URL
has actually changed.

## `machine endpoint get` reports no public URL

C2C does not start your tunnel, so it cannot know the address by itself. Start
the tunnel, point it at the gateway's loopback port `48765` (the default
`C2C_HTTP_PORT`), and record the HTTPS base address it reports:

```sh
c2c machine endpoint set --url https://<your-tunnel-public-base-url> --json
c2c machine endpoint get --json
```

Use the base URL without `/mcp`; C2C appends that itself. A quick tunnel's public
address changes on every reconnect, so repeat this step each time; a Cloudflare
named tunnel keeps the same hostname. The connector must be updated to match
whenever the address changes.

## The tunnel client refuses to start because of a proxy

The general rule: the tunnel client needs its own egress, and a proxy on the
machine can make it refuse to start or fail to connect. Give the process that
runs the tunnel client a direct route.

One verified provider-specific case: **ngrok's free plan refuses to run when
proxy environment variables are set**. Unset `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, and `NO_PROXY` in the shell or service definition that starts
ngrok, then start it again; ngrok reports `ERR_NGROK_9009`. The C2C gateway
itself binds loopback only and does not need a proxy.

## `/mcp` returns `401`

The request reached the gateway but the bearer token did not match. Compare the
connector header with the current local token:

```sh
c2c machine auth show
c2c machine auth show --reveal
```

If they differ, update the connector, or rotate both sides together so the old
value is invalidated:

```sh
c2c machine auth rotate --json
```

A `401` after a rotation is expected until the connector is updated.

## The machine is not ready

Inspect the JSON fields `transport`, `connector`, `ready`, `gateway` and
`checks`. `machine doctor` reports three separate checks — `gateway`,
`endpoint` and `auth` — so the failure is distinguishable: a stopped gateway, a
missing public URL, or a missing bearer token. Run:

```sh
c2c machine doctor --json
```

If the gateway is unhealthy, `machine doctor` repairs it. If two processes report
the same machine runtime, stop the managed owner cleanly and run doctor again; do
not delete a runtime record belonging to an unknown process.

## ChatGPT cannot call the connector, but the machine looks healthy

This is the most common failure and it is usually not a C2C problem. Work
through the four layers in order; each has its own evidence.

1. **Is the gateway listening?** `c2c machine status --json` must report
   `ready: true` with a healthy `gateway`. A stopped gateway is repaired with
   `c2c machine doctor --json`.

2. **Is the HTTP leg itself working?** Send an authenticated request to the
   public URL C2C has recorded:

   ```sh
   MCP_URL="$(c2c machine endpoint get --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).mcpUrl))')"
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$MCP_URL" \
     -H "Authorization: Bearer $(c2c machine auth show --reveal)" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"0"}}}'
   ```

   `401` means the token is wrong; `502`/`504`/a connection failure means the
   tunnel is not forwarding to loopback port `48765`. A successful
   `initialize` proves only this leg. It does **not** prove that ChatGPT is
   reaching it — that requires a real connector call.

   Repeat the request against `"$MCP_URL/$(c2c machine auth show --reveal)"` with
   **no** `Authorization` header. It must succeed too: that is the exact shape
   the ChatGPT connector sends, so a `401` here while the header form passes
   means the connector's URL is missing its token.

3. **Is the tunnel actually running and pointed at the right port?** C2C does
   not own the tunnel process. Check it with the provider's own client and
   confirm its target is `127.0.0.1:48765`. A quick tunnel's public address
   changes on every reconnect, so an old address pasted into the connector will
   fail even though everything local is healthy. Re-record it:

   ```sh
   c2c machine endpoint set --url https://<current-public-base-url> --json
   ```

   A Cloudflare named tunnel keeps its hostname, so it does not have this
   failure mode. Proxy variables are a separate trap: the tunnel client needs
   its own egress, and ngrok's free plan specifically refuses to start when
   proxy variables are set (`ERR_NGROK_9009`); unset `HTTP_PROXY`,
   `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` for the process that runs it.

4. **Is ChatGPT itself using current metadata?** Restarting the tunnel does not
   refresh the platform's cached tool schema. In ChatGPT Plugins, open the
   existing app's action menu and choose **Manage** → **Refresh**.

A previously documented failure mode is now historical: the official OpenAI
Secure MCP Tunnel depended on a long poll of `api.openai.com`, and on this
network that endpoint is reset at the TLS SNI layer, so the tunnel spent hours
timing out while the local gateway reported healthy. That transport was removed
because no DNS or proxy change could fix it. If you are looking for
`controlPlaneDown`, `controlPlaneDetail`, or
`/Users/<you>/Library/Application Support/tunnel-client/logs/...`, they belong
to that removed transport and no longer exist.

Note that plain UDP/53 DNS can still be hijacked on such networks (for example
`api.openai.com` resolving into `2a03:2880::/29`, a Meta range). Changing the
DNS server alone does not help, because the forged answer arrives on the wire;
encrypted DNS (DoH/DoT) is required when the program does not go through a
proxy. This no longer affects C2C's own transport — the tunnel only has to reach
the tunnel provider, not `api.openai.com`.

## Connector cannot connect

In ChatGPT connector settings verify exactly:

```text
Name:            Codex with ChatGPT
Connection:      Server URL
MCP Server URL:  <public-base-url>/mcp/<token from `c2c machine endpoint get --reveal`>
Authentication:  No authentication
```

That form offers only `OAuth`, `No authentication`, and `Mixed`, and keeps no
field for a static token — the Apps SDK documents that ChatGPT cannot present
custom API keys — so `No authentication` is the correct choice and the token
rides in the URL. `OAuth` cannot work: this gateway runs no authorization server
for ChatGPT to discover. `Mixed` is a per-tool `noauth` + `oauth2` declaration
and ends in that same OAuth flow. Do not select `Tunnel`: the official Secure
MCP Tunnel is not part of this transport.

A `401` means the token in the URL is stale or missing — compare it with
`c2c machine auth show --reveal`, or rotate both sides with
`c2c machine auth rotate` and update the connector URL in the same step. A
connection that points at a bare `/mcp` (the token lost on a copy/paste) is the
other common cause. Do not create a connector per workspace or alter a connector
belonging to another purpose. After the connector reports connected, test it in
the owned chat with `workspace_info`. Note that a valid token alone grants no
workspace access; the turn still needs a live `context_id`.

The active comparison mode intentionally exposes no result callback tools. If
the app still lists `get_control_result_status`, `report_control_progress`, or
`submit_control_result`, or a read-only tool shows an older input schema, keep
the gateway healthy, open the existing app's action menu in ChatGPT Plugins,
choose **Manage**, and select **Refresh**. Confirm only the current read-only C2C
tools remain before starting a fresh authorized request. Restarting the tunnel
alone does not refresh ChatGPT's cached app metadata, and creating another
connector is not the repair.

If ChatGPT instead returns `BLOCKED` only because one of those callback tools is
absent, the connection is not missing a tool: the page followed an obsolete
mailbox instruction from earlier conversation context. Do not restore the
callbacks. Finish that exact request as the observed `BLOCKED` result, then open
a fresh request whose delivery prompt includes `RESULT_TRANSPORT:
COMPUTER_USE_ONLY` and `MAILBOX_CALLBACKS: DISABLED_EXPECTED`. After the required
read-only checks succeed, BOOT must return `{"kind":"BOOT","payload":{}}`; no
mailbox receipt exists in this mode.

## `workspace_info` reports the wrong workspace

Stop sending control messages. Check the local route and page lease:

Run these commands from the affected workspace root. Workspace commands derive
the target from the trusted `cwd`; an optional `-w` may only resolve to that
same directory.

```sh
c2c workspace --json
c2c session get --local-session <session-id> --json
c2c surface get --local-session <session-id> --json
```

The Project URL, chat URL and `tabId` must all belong to the current workspace
and local session. First call `cua.getTab(tabId, { browser: "iab" })` for the
stored exact tab and validate both URLs. If that call fails or the URL is
wrong, create a hidden replacement with
`cua.createBrowserTab("iab", targetUrl, { visible: false })`, where `targetUrl`
is the saved chat URL or Project URL. Claim only the returned tab for this
`localSessionId`, supplying the exact current replacement generation and tab
id when required. Never repair this by selecting a tab by URL or sending to a
foreground page.

## `surface claim` rejects the page

Check these values:

- The chat URL is inside the supplied Project URL.
- The exact browser is the built-in in-app browser.
- The `tabId` is current and was read from that browser.
- An existing binding is not being replaced without its exact
  `--replace-generation` and `--replace-tab-id` pair.
- The replacement generation equals the current lease exactly.

The session owns one page. The machine permits 100 unexpired session/page
leases, counted by unique `(projectId, localSessionId)` identities, each
representing one workspace-local session owner. A different session should
create its own Project chat and claim its own tab instead of reusing this one.
If all 100 leases are held, a new-session claim is rejected with a retryable
capacity result; wait, back off, and retry after a lease is released, expires,
or the owning session is retired. Renewing, idempotently reclaiming, or
replacing a page for an existing session reuses its slot.

## `control open` reports `CONTROL_REQUEST_ALREADY_OPEN`

This protects the context token already sent to ChatGPT. Inspect the exact
request:

```sh
c2c control status \
  --local-session <session-id> --request <request-id> \
  --task <task-id> --iteration <n> --phase <phase> --json
```

Wait for it or cancel it. Do not open a replacement while the owned page is
still generating, and do not resend the same question in another chat.

## A control result never arrives

First call `cua.getTab(tabId, { browser: "iab" })` for the exact owned tab and
confirm the Project/chat URL and that the page is finished. Then wait on the
local request again:

```sh
c2c control wait \
  --local-session <session-id> --request <request-id> \
  --task <task-id> --iteration <n> --phase <phase> --json
```

Verify ChatGPT used `context_id` on every read-only MCP call and ended the exact
response with `C2C_HOST_OBSERVED_RESULT`, the matching request ID, and one valid
`{kind,payload}` object. Computer Use must inspect the bound response, not the
page's latest arbitrary text. A timeout alone is not permission to resend;
resume observation or cancel the exact control request.

## A context is rejected as stale

Issue a new context after any of these events:

- Machine gateway restart or changed `bootEpoch`.
- Workspace unregister/re-register.
- Page rotation or changed `generation`.
- Session compaction and changed `compactionEpoch`.
- Capability expiry or cancellation.

Never extend or reuse a stale context. Re-run `control open` after the local
surface and workspace checks pass.

## One session is slow

Backoff and retry only that session. Other sessions do not share its queue or
page lease. Up to 100 unique `(projectId, localSessionId)` identities can hold
unexpired session/page leases concurrently. When all 100 slots are occupied, a new-session
claim is rejected with a retryable capacity result and retries after a lease is
released, expires, or the owning session is retired. Renewals, idempotent
claims, and page replacements for an existing session reuse its slot. ChatGPT
or the browser may have external service limits; those must be diagnosed from
the affected session's page and request.

## The page was closed or moved

Do not claim a random foreground tab or search for a replacement by URL. Use
the host CUA runtime to create a hidden page with
`cua.createBrowserTab("iab", savedChatUrl ?? projectUrl, { visible: false })`.
Claim the returned exact tab for the same `localSessionId`; if a stored lease
exists, supply its exact `--replace-generation` and `--replace-tab-id`. Re-read
that exact tab with `cua.getTab(tabId, { browser: "iab" })`, verify the Project
and chat URL, then issue a new control context and leave the old one cancelled
or expired. Keep the repaired page in the background.

## A human verification screen appears

Only a login page, CAPTCHA, 2FA prompt, or explicit consent screen may require
user interaction. Temporarily make only that session's page visible and ask for
the one required user action. After it is complete, return the page to the
background, re-read the exact `tabId` with `getTab`, verify the Project/chat
URL, and issue a new context if the page generation changed. Do not make a
normal control turn visible.

## Build or type errors

Use the repository's supported toolchain:

```sh
corepack pnpm install
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Check that Node.js is version 20 or newer. Do not mix generated `dist/` output
from another checkout with the current source.

## Safe reset

Prefer `machine stop`, then `machine start`. If the machine state is malformed,
preserve the diagnostic output and remove only the C2C machine-state files after
confirming no other C2C process is running. Removing the state also discards the
recorded public endpoint and the bearer token, so a fresh `machine setup` will
need a new `machine endpoint set` and a newly revealed token in the connector;
it does not affect ChatGPT ordinary chats or your tunnel process.
