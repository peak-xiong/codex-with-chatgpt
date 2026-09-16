# Codex with ChatGPT

[English](README.md) | [简体中文](README.zh-CN.md) | [Installation](#install-and-setup)

> ChatGPT thinks. Codex works.

Use ChatGPT web as the first-choice research, analysis, planning, synthesis, and
review partner for local Codex sessions. When the ChatGPT page or its read-only
MCP tools can answer a task, C2C delegates it there and returns a concise,
structured result through exact Computer Use page observation. Codex retains all workspace
writes, shell execution, tests, git operations, and recovery locally.

## ChatGPT-first delegation

The default delegation policy is `CHATGPT_FIRST`, but only for evidence-closed
subtasks whose required inputs are available to the ChatGPT page or its current
authorized tools:

- `RESEARCH` covers Web Search, current facts, external documentation, source
  comparison, and read-only workspace discovery.
- `PLAN` covers architecture, implementation options, migrations, API design,
  documentation, and other synthesis based on MCP reads.
- `REVIEW` covers the current working-tree diff and execution evidence already
  recorded for the same local session, task, and iteration.

Task labels do not establish capability. The connector does not read arbitrary
commits, refs, PR diffs, parent commits, historical source snapshots, sensitive
files, or data outside the registered workspace. It also cannot edit files, run
commands or tests, mutate Git/PR state, deploy services, change accounts or
permissions, or verify final runtime success. Codex keeps those responsibilities
and either performs them locally or prepares a bounded, verified workspace
artifact before delegating only the remaining analysis.

For mixed tasks, Codex first resolves refs and gathers or records missing
evidence; ChatGPT then researches, plans, or reviews the supported read-only
question; Codex finally applies changes and verifies the result. A known
capability gap is not sent merely to produce a predictable `BLOCKED` response.

Web Search is a built-in ChatGPT capability rather than a Connector MCP tool.
In the current comparison mode, the resulting answer is collected from the
exact bound response by Computer Use. Control
prompts contain only the task goal and correlation fields. They never paste
repository contents, diffs, logs, credentials, or full command output.

## Machine-wide setup

The connection is configured once per machine:

- One connector per device, with an exact device-specific name recorded locally.
  One ChatGPT account can contain several devices' C2C connectors.
- The connector points at a **public HTTPS URL** that a third-party tunnel
  forwards to this machine, and sends an
  `Authorization: Bearer <token>` header. The token is a transport gate only;
  it is not a project credential and does not replace C2C's turn capabilities.
- The C2C daemon starts one `c2c serve-http` gateway that binds loopback port
  `48765` (override with `C2C_HTTP_PORT`). That gateway is the only MCP gateway
  and can serve every registered workspace on the machine.
- Each workspace maps to one ChatGPT Project. Each local Codex session maps to
  one persistent ChatGPT chat/page inside that Project.
- Browser operations target the exact owned `tabId`; a visible or recently used
  ChatGPT tab is never treated as the target by accident.
- The machine supports at most 100 unexpired session/page leases, counted by
  unique `(projectId, localSessionId)` identities, each representing one
  workspace-local session owner. Released, expired, and retired leases free
  capacity. Up to 100 different sessions can run independently; a claim for a
  new 101st session is rejected with a retryable capacity result and retries
  after capacity frees. Renewing, idempotently reclaiming, or replacing a page
  for an existing session reuses its slot. Only turns within the same local
  session are serialized, because one chat has one ordered conversation.

The design keeps the user's ordinary ChatGPT conversations separate. C2C owns
only the page recorded for a local session, and never takes over another tab.

## Install and setup

This is a self-hosted project: each user installs it on their own computer and
uses their own tunnel and credentials. A public Git repository does not give
other users access to the maintainer's machine, endpoint, or token.

The transport is a **public HTTPS endpoint** — a third-party tunnel you run
forwards to the gateway's fixed loopback port, and the ChatGPT connector uses
`<public-base-url>/mcp` with an `Authorization: Bearer <token>` header. C2C
does not use the official OpenAI Secure MCP Tunnel, because this network resets
that endpoint at the TLS SNI layer: TCP to the real `api.openai.com` address
succeeds, then the handshake fails only when SNI is `api.openai.com`. No DNS or
proxy change works around that. The bearer token authenticates the transport;
C2C's short-lived, task-scoped `context_id` authorization is separate and still
required. `POST /mcp` returns `401` without a valid token, and the token is
created and stored by C2C, not by ChatGPT.

### Install through Codex

Start with an **ordinary local task in Codex desktop**, not
`$codex-with-chatgpt`: the Skill is not installed yet, and installation cannot
depend on a ChatGPT connection that does not exist. Send Codex:

```text
Install the main branch of https://github.com/peak-xiong/codex-with-chatgpt
for the current OS user. First read the installation section of README.md,
check the OS, Git, Node.js, Corepack, this task's in-app browser capability,
and any existing C2C installation.
Confirm the source directory before cloning and building. Preserve existing
changes, installation settings, and sessions; do not overwrite or clean them.
Reuse an existing valid device-to-app binding. If it is missing or stale, ask
which exact ChatGPT app belongs to this computer, record its confirmed name and
observed stable plugin URL with `machine connector set`, and reuse that binding
for all projects. Never choose another computer's app by a similar name.
Otherwise, after preflight and a clean source build, run `machine setup --json`,
tell me the exact MCP URL and bearer-token hint it reports, and guide me through
starting the tunnel and recording its public URL.
Do not guess accounts, organizations, workspaces, URLs, or credentials.
Do not print the bearer token unless I explicitly ask for it. If permissions,
login, or consent are missing, explain the user action needed. Do not switch
accounts, expand permissions, or substitute another tunnel provider or OAuth.
```

Steps 1–6 below are also the sequence Codex should follow. **Do not repeat local
commands that Codex has already completed**; the command blocks are execution
references for Codex or users checking its work.

| Operation | Responsible party |
| --- | --- |
| Log in to a tunnel provider and start one tunnel that forwards to the gateway's loopback port | User starts and keeps the tunnel running; a Cloudflare named tunnel needs an account and a domain, a Cloudflare quick tunnel needs neither, and ngrok's free plan needs an account |
| Record the public base URL and keep the bearer token out of chat | Codex records the URL with `machine endpoint set`; the user controls who sees the token |
| Check the environment, build, install globally, run diagnostics | Codex executes locally, not in a ChatGPT conversation |
| Create or reuse the ChatGPT connector with the public URL and the Authorization header | User in the confirmed ChatGPT workspace; Codex then verifies it |

### 1. Check prerequisites

- Git, a supported Node.js LTS release satisfying Node.js >= 20, and Corepack.
  Check `node --version`, `git --version`, and `corepack --version`. If Corepack
  is absent, install a version compatible with your Node.js release before
  continuing. The repository pins its pnpm version in `package.json`.
- Codex desktop with the in-app browser and Computer Use available to the
  session. Installing the CLI alone does not supply browser automation.
- A ChatGPT account/workspace with developer-mode custom apps. Availability and
  administrator permissions must be checked in your own account; a subscription
  alone is not proof of access.
- A third-party tunnel client that can expose a local port over HTTPS. Any tunnel
  that forwards a public HTTPS URL to the gateway's loopback port works. Prefer a
  **Cloudflare named tunnel**: it gives a stable hostname, one tunnel can serve
  several hostnames, and it reconnects without changing the URL. Use a quick
  tunnel (Cloudflare `trycloudflare.com` or ngrok) only when no Cloudflare
  account and domain are available; those hand out a new hostname on every
  reconnect, so the recorded endpoint must be updated each time. A Cloudflare
  quick tunnel needs no account, while ngrok's free plan does.
- Outbound HTTPS access to the tunnel provider and to GitHub and the package
  registry for installation. The computer must remain awake and online while
  ChatGPT uses local tools, and the tunnel plus the C2C gateway must both keep
  running.

The current live validation environment is **macOS with Codex desktop**. The
code includes other platform targets, but native Windows/Linux installation and
the complete browser workflow are not yet verified. The shell examples below
use macOS/POSIX syntax; they are not PowerShell instructions.

See your tunnel provider's documentation for current account, permission, and
networking requirements. A public endpoint is for private use with a
developer-mode app; it does **not** satisfy public plugin-store submission
requirements. Publishing this source for self-hosting is different from
distributing one public ChatGPT plugin.

### 2. Clone and build a clean source checkout

For the machine-gateway preview tracked in [PR #409](https://github.com/XiaoDuoYa/codex-with-chatgpt/pull/409),
the following fork's `main` contains this implementation. Do not assume another
repository or branch already includes it. Use `git clone`, not Download ZIP:
the installer builds from a clean, committed Git revision.

```sh
git clone --branch main --single-branch https://github.com/peak-xiong/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --help
git status --short
```

Keep this checkout for future updates. `git status --short` must be empty
before installation. If you have changes, preserve them or use a separate clean
clone; do not reset or delete your work just to satisfy the installer.

### 3. Start your own tunnel and record its public URL (first installation only)

This stage happens in your tunnel provider's own UI and client, **not through
local `machine setup`**. Skip it when preflight confirms a healthy existing C2C
installation with a recorded public endpoint and a running tunnel.

Any tunnel that forwards a public HTTPS URL to the gateway's loopback port is
valid. Prefer a **Cloudflare named tunnel**: it gives a stable hostname, one
tunnel can serve several hostnames, and it reconnects without changing the URL.
Use a quick tunnel (Cloudflare `trycloudflare.com` or ngrok) only when no
Cloudflare account and domain are available.

1. Set up your tunnel provider and reserve or reuse one tunnel dedicated to this
   computer. Do not reuse another computer's tunnel or its public URL. A
   Cloudflare named tunnel needs an account and a domain; a quick tunnel needs
   neither.
2. Point that tunnel at the gateway's loopback port, `48765` (the default
   `C2C_HTTP_PORT`). This value is fixed on purpose: the tunnel configuration
   points at it, so a port that changes between starts silently breaks the
   endpoint. Run the tunnel on the same machine as the gateway.
3. Copy the HTTPS base URL the tunnel reports, for example
   `https://<your-subdomain>.example.com`, without the `/mcp` suffix.
   `c2c machine endpoint set --url <https-url>` appends `/mcp` itself.
4. Keep the tunnel running. A quick tunnel's public URL changes on every
   reconnect, and the recorded endpoint must then be updated again with
   `machine endpoint set`; the ChatGPT connector must be updated to match. A
   Cloudflare named tunnel avoids this.

**Egress and proxy.** The tunnel client needs its own egress. If the machine
routes traffic through a proxy, the tunnel client may refuse to start or fail to
connect; give the process that runs it a direct route. One verified trap is
ngrok-specific: **ngrok's free plan refuses to start when proxy environment
variables are set**. It exits with `ERR_NGROK_9009` and the message that the
ngrok agent cannot be run with proxy environment variables set. Unset
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` in the shell (or the
service definition) that runs ngrok, and let ngrok connect directly.

Do not put the bearer token in a shell argument, a screenshot, a Project
instruction, or Git. The token is generated and stored by C2C; never reuse
another machine's endpoint or token. There is no runtime key and no tunnel ID
to collect in this architecture — the tunnel client is an ordinary
provider-supplied binary that C2C neither installs nor supervises.

### 4. Install once for your local user

After step 3, reply in the **same Codex installation task** with the following.
Do not paste the bearer token:

```text
I have started one tunnel for this computer and pointed it at the gateway's
loopback port. Its public HTTPS base URL is:
<https://your-tunnel-public-base-url>
Run machine setup from the clean source checkout you just built, installing
for the current OS user. Then record the public URL with machine endpoint set
and report the MCP URL. Show only the token hint; do not print the full bearer
token in chat.
Check the global Skill, machine status, and machine doctor --no-fix, and report
the actual results. Then wait for me to create or confirm the ChatGPT connector
before workspace pairing and round-trip acceptance.
```

Codex should run the following from the source checkout built in step 2,
without `sudo`. The global `c2c` may not exist on first install, so use the
source entrypoint:

```sh
node bin/c2c.js machine setup --json
node bin/c2c.js machine endpoint set --url "https://<your-tunnel-public-base-url>" --json
node bin/c2c.js machine auth show
```

`machine setup` takes **only** `--json`; it no longer accepts `--tunnel-id`,
`--runtime-key-file`, or `--reuse-existing`. Re-run it for any later update; it
reuses the recorded endpoint and the existing bearer token, so no original
credential path is needed. Record the endpoint again only when the tunnel's
public URL actually changes.

Expect `ok: true` and `configured: true`. Setup deploys the verified runtime,
installs the global Skill and `c2c` launcher, starts the one `c2c serve-http`
gateway through the machine daemon, and creates the bearer token on first use.
`machine endpoint set` records the public base URL and the loopback port;
`machine auth show` prints a token hint, and `--reveal` prints the full token
that the ChatGPT connector needs. **Setup does not start your tunnel, create a
ChatGPT workspace, or create the ChatGPT connector**; the tunnel must already be
running from step 3.

Rotate the token with `c2c machine auth rotate --json`. The old token stops
working immediately, so update the connector header in the same session or
every call returns `401`.

**Proxy note.** The C2C gateway itself binds loopback only and needs no proxy.
Your tunnel client does need its own egress, and a proxy can make it refuse to
start or fail to connect; ngrok's free plan specifically will not run with proxy
variables set (see step 3). If your network hijacks plain UDP/53 DNS
(for example `api.openai.com` resolving into `2a03:2880::/29`, a Meta range),
changing the DNS server alone does not help, because the forged answer arrives
on the wire; encrypted DNS (DoH/DoT) is required when the program does not go
through a proxy.

Do not run the official OpenAI Secure MCP Tunnel client or its sample MCP
server alongside this setup. That transport was removed from C2C, cannot connect
on this network, and running it would only create a second, unused path.

The launcher is `~/.local/bin/c2c`. If your shell cannot find it, add this to
your shell's startup configuration and reload that shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

For an immediate check without changing PATH, use
`"$HOME/.local/bin/c2c" machine status --json`.

### 5. Connect ChatGPT once per device

In the intended ChatGPT account/workspace, enable developer mode if needed
(currently Settings > Security and login; an administrator may need to grant
access). Open [ChatGPT Plugins](https://chatgpt.com/plugins), use the plus/create
entry for a developer-mode app, and configure the following. Depending on the
UI version, the entry may be called an app, plugin, or connector.

| Field | Value |
| --- | --- |
| Name | A distinct device name, e.g. `Codex with ChatGPT - Laptop`; existing single-device names can be kept |
| Connection | `Server URL` (not `Tunnel`) |
| MCP Server URL | The `/mcp` URL from `c2c machine endpoint get` |
| Authentication | `Bearer token` (or an Authorization header) with the value from `c2c machine auth show --reveal` |

Reuse this connector if it already exists. There is no tunnel to select and no
runtime key: the public URL plus the bearer token are the whole transport
configuration. Keep the tunnel and the gateway running during tool discovery.
If the URL field is rejected, confirm the base URL was recorded without a
trailing `/mcp` (C2C appends it) and that the tunnel is still forwarding.
A `401` response means the token in the connector does not match the machine's
current token — recheck with `c2c machine auth show --reveal`, or rotate both
sides together with `c2c machine auth rotate`.

A valid bearer token only proves the caller reached this gateway. It does not
grant workspace access: ChatGPT must still supply a `context_id` issued by
`c2c control open` before any tool acts on a workspace. Tell Codex the connector
is configured before proceeding to step 6. A connector card alone is not proof
of result delivery.

Tell Codex which exact app belongs to this computer. Codex records it locally:

```sh
c2c machine connector set --name '<exact app name>' \
  --plugin-url 'https://chatgpt.com/plugins/plugin_<observed-id>' --json
c2c machine connector get --json
```

Use the real app URL observed in ChatGPT, not the placeholder. Omit `--plugin-url`
if no stable app URL is exposed; names must then identify the app unambiguously.
The binding is shared by this device's workspaces and sessions, and is preserved
by normal upgrades. It binds `machineId + name + optional pluginUrl`; it does
not create or rename a remote app or verify which URL that app calls by itself.
A real read validates the serving machine.

For two computers, install on each and bind each computer's own app and
endpoint. Both apps may live in the same ChatGPT account. The route is
**device → public endpoint → bound app → workspace/Project → session/Chat/tab**.
Do not copy machine state, credentials or browser ownership files between
devices. A missing binding after upgrade needs this one-time step; binding
against a different machine id marks the old binding `stale`. Codex must resolve
it before local-MCP dispatch, without changing existing sessions or requiring
per-project app installation. See
[Device connector binding](docs/protocol.md#device-connector-binding).

After creating the app or changing its tool schemas, verify the task-needed
read tools and input contracts in the existing app while the gateway is healthy.
Use **Refresh** once if the current UI offers it and discovery needs updating;
do not assume a fixed menu path exists. Opening Manage or restarting the tunnel
does not prove that schemas were refreshed. A real scoped read is verified
separately in step 6. Keep the same global app; do not recreate it per project.

After changing ChatGPT accounts, also check access to the workspace's saved
Project/chat. A bound connector does not migrate old projects. Follow the
[account migration procedure](docs/protocol.md#account-migration) to back up and
clear confirmed stale routes before Codex pairs a new Project/chat. Retain valid
bindings for the new account.

### 6. Verify installation, then the real round trip

Use the global command from now on:

```sh
c2c skill status --json
c2c machine status --json
c2c machine doctor --no-fix --json
```

Expect Skill `installed: true` and `matches: true`, machine `ready: true`,
`machine connector get` status `bound`, and
doctor `ok: true`. These checks do not prove ChatGPT can return results.

Open your actual project in Codex desktop. In a new session, ask:

```text
Use $codex-with-chatgpt to pair this workspace and verify local reads and
structured result delivery. Run two consecutive read-only questions in this
session's dedicated ChatGPT chat. Require Computer Use to validate each exact
response marker against its request and page identity; do not edit business
code or accept uncorrelated page text.
```

The Skill registers the current workspace, creates its ChatGPT Project on
first pairing (or uses an exact existing Project URL you explicitly approve),
and verifies the session's dedicated chat. An existing authoritative binding
is reused. Keep control questions in Chat mode with the connector available
in that exact message. A missing Skill may require reopening Codex desktop;
existing sessions must read the updated Skill, not reinstall it per project.

Acceptance has three separate levels:

| Level | Required evidence |
| --- | --- |
| Installed and connected | Global Skill matches; machine ready; doctor passes |
| Workspace reads | BOOT returns the expected workspace/project IDs and actual local evidence |
| Result delivery | Computer Use validates the exact tab/chat/generation/response and its schema-bound result marker |

Levels one and two are strictly local: a healthy machine, a passing doctor, and a
recorded endpoint only prove the managed components are consistent with each
other. They do **not** prove that ChatGPT can reach this machine. A direct check
that the HTTP transport leg works is an authenticated request against the public
`/mcp` URL from `c2c machine endpoint get --json`:

```sh
MCP_URL="https://<your-tunnel-public-base-url>/mcp"
TOKEN="$(c2c machine auth show --reveal)"
curl -sS -i -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"0"}}}'
```

A `401` means the token does not match; a completed `initialize` response proves
only that this HTTP leg works. It does not prove that a ChatGPT connector can
reach the URL through the tunnel — that requires a real connector call. If calls
fail while the endpoint is reachable, refresh the ChatGPT app's cached tool
schema (Plugins → the app → **Manage** → **Refresh**); restarting the tunnel does
not refresh platform-side metadata.

Mailbox callback code and historical live-return records are retained for a
later comparison. Production currently does not register those callback tools.
The page marker is accepted only after exact Computer Use correlation and schema
validation; arbitrary browser prose is never accepted.
See [current verification boundaries](docs/issue-log.md#最新回传验收修复).

### Use another project or session

Global means **one installation for this OS user and Codex configuration**,
not a shared installation for every user, computer, or ChatGPT account.

| Scope | What happens |
| --- | --- |
| This machine/user | One runtime, Skill, tunnel, and connector |
| New workspace | Register and pair with its own ChatGPT Project once |
| New local session | Bind one dedicated chat/page within that Project |
| Next task in that session | Reuse its page; create only a fresh task authorization |

From the root of the project you want ChatGPT to access:

```sh
cd /absolute/path/to/your-project
c2c machine workspace register --json
c2c workspace --json
```

The Skill performs registration when needed; the commands above are useful for
verification. Do not run `node bin/c2c.js` from a business project that does not
contain the C2C source. Workspace commands use the trusted current directory;
`-w` cannot select a different directory. No extra connector, tunnel, or copied
Skill is needed for another project — the one machine endpoint serves every
registered workspace. New computers/users need their own setup.

### Installation locations and updates

Default locations on macOS (all belong to the current OS user):

| Item | Location |
| --- | --- |
| CLI launcher | `~/.local/bin/c2c` |
| Global Skill | `~/.codex/skills/codex-with-chatgpt/SKILL.md` |
| Managed runtime | `~/Library/Application Support/codex-with-chatgpt/installation/current` |
| Public endpoint record | `<machine state>/http/endpoint.json` (0600) |
| Bearer token | `<machine state>/http/auth.json` (0600) |
| Git project state | `<git-common-dir>/codex-with-chatgpt` |
| Non-Git project state | `<workspace-root>/.codex-with-chatgpt` |

`CODEX_HOME` changes the Skill's configuration root. `C2C_STATE_DIR` changes
machine state, not registered repository-local state; normally leave it unset.
The managed runtime is not the source Git checkout. Do not edit it or run
`git pull` there. The gateway owns the protected mailbox and cross-workspace
page indexes; local project state holds routes/checkpoints and execution records.

To update, let active tasks finish first: setup may restart the shared gateway
and invalidate old authorizations. In the original clean source checkout:

```sh
cd /absolute/path/to/codex-with-chatgpt
git status --short
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --json
c2c skill status --json
c2c machine doctor --no-fix --json
```

Proceed past the status check only when it is empty. Reuse the recorded public
endpoint, the existing bearer token, and the existing connector; updates do not
require the original token, a key-file path, or per-project installs. Re-run
`machine endpoint set` only if the tunnel's public URL changed.
Run setup with the **updated source entrypoint** shown above, not the old
installed `c2c`, which would reuse its own runtime. The Skill obtains fresh
authorizations after restart and preserves established Project/chat mappings.
If the update changes tool contracts, verify discovery in the existing
`Codex with ChatGPT` app as described in step 5. Use Refresh only if offered and
needed; missing UI controls do not justify recreating the connector.
`c2c update-check --json` checks for updates; it does not install them. A
`checked: false` response is not proof that your installation is up to date.

### Optional macOS login autostart

After the first machine setup, enable the one machine-wide LaunchAgent once on
macOS:

```sh
c2c autostart enable --json
c2c autostart status --json
```

The LaunchAgent runs hidden `c2c autostart run --quiet` at its wake interval.
That command only calls `ensureMachineGateway`; it restarts the one `c2c
serve-http` gateway if it is down and never creates a workspace-specific gateway
or a second gateway. It does not start your tunnel. To disable it:

```sh
c2c autostart disable --json
```

Autostart is a machine convenience, not a page scheduler. It does not change
the machine-wide capacity of 100 active session/page leases.

### Common setup problems

| Symptom | Next check |
| --- | --- |
| `corepack` or `c2c` not found | Install Corepack for your Node version; check the launcher and PATH from step 4 |
| `machine setup` is an unknown command | Check the repository/branch and rebuild step 2; older OAuth releases use a different architecture |
| `machine setup` rejects `--tunnel-id` or `--reuse-existing` | Those options were removed with the Secure Tunnel transport; run `machine setup --json` alone |
| `machine endpoint get` shows no URL | Record the running tunnel's HTTPS base URL with `c2c machine endpoint set --url <https-url>` |
| Connector returns `401` | The header token does not match `c2c machine auth show --reveal`; update one side or rotate both |
| Tunnel client exits with a proxy error (for example ngrok's `ERR_NGROK_9009`) | Give the tunnel client a direct egress; for ngrok's free plan unset `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`, which it refuses to run with |
| Installer requires clean Git source | Use a Git clone and preserve your changes before installing; a ZIP download is insufficient |
| Machine not ready | Run `c2c machine doctor --no-fix --json`; it reports `gateway`, `endpoint`, and `auth` checks separately |
| Final response is not detected | Verify the exact owned tab, chat, generation, response id, request id, and `C2C_HOST_OBSERVED_RESULT` marker; do not inspect another page or resend while generation is active |

For controlled repair and exact-session recovery, see [Troubleshooting](docs/troubleshooting.md).

## Runtime model

```text
ChatGPT Project A                 ChatGPT Project B
  session A1 -> owned tab A1        session B1 -> owned tab B1
  session A2 -> owned tab A2        session B2 -> owned tab B2
            \                         /
             \                       /
              one global Connector (Server URL + Bearer token)
                              |
             third-party public tunnel -> <public-url>/mcp
                              |
               c2c serve-http on 127.0.0.1:48765 (bearer-gated /mcp)
                              |
       machine gateway: registry + capability broker + mailbox
                              |
                    trusted local workspaces
```

The local Skill derives the workspace from its trusted `cwd`. The gateway
assigns stable `projectId` and checkout-specific `workspaceId` values and keeps
the registration in a machine registry. ChatGPT Project and chat URLs are
navigation and memory metadata, not filesystem authorization.

Every control turn receives a short-lived `CONTEXT_ID`. Its binding includes:

```text
machine boot + workspaceId + projectId + registrationId
localSessionId + taskId + iteration + phase
requestId (required for every phase, including BOOT)
compactionEpoch + page generation + requested scopes
```

ChatGPT must pass `context_id` to every MCP call. The gateway validates the
capability, claims an activity lease, renews it during long calls, and releases
it when the call ends. Expiry, cancellation, browser-page rotation, compaction,
or gateway restart invalidates the old context.

## Control flow

The normal loop is:

```text
RESEARCH -> INIT -> PLAN -> EXECUTED -> REVIEW -> DONE
```

Codex sends only small control messages to the exact owned chat. It never pastes
file contents, diffs, or logs into ChatGPT. ChatGPT reads bounded data through
read-only MCP tools and ends the exact response with a schema-bound
`C2C_HOST_OBSERVED_RESULT` marker. Computer Use verifies the exact tab, chat,
generation, response id, request id, phase and payload schema before advancing
the session.

This is a temporary comparison mode. Mailbox callback implementation remains in
the source tree, but `get_control_result_status`, `report_control_progress`, and
`submit_control_result` are not registered by the production MCP server and
`c2c.result.write` is not granted by `control open`.

## Browser ownership

The built-in in-app browser is used for ChatGPT operations. On setup, the Skill
claims a tab using the exact browser, surface, Project URL, chat URL, and
`tabId`. The lease has a generation and owner epoch. Replacing a live page
requires the exact current generation; an unrelated tab cannot be claimed.

For each session:

1. Resolve `c2c session get --json` and capture `sessionIdentity.id`.
2. Resolve the session route and current surface lease.
3. Open or return to only that session's saved chat URL.
4. Include `CONTEXT_ID` and `RESULT_REQUEST_ID` in each control prompt.
5. Wait for the exact Computer Use result before sending the next control message.

Computer Use drives each owned in-app browser page through stable URLs and
semantic DOM/browser APIs, always using the exact owned `tabId`. These CUA calls
are Skill host execution steps; the TypeScript CLI only persists and validates
the route/lease. When a saved route exists, the Skill first calls
`cua.getTab(tabId, { browser: "iab" })` and validates the current Project/chat
URL. If the exact tab is missing or invalid, it creates a replacement only for
that local session with
`cua.createBrowserTab("iab", targetUrl, { visible: false })`, then replaces the
lease using the exact generation and tab id. With no saved route, it creates a
hidden Project candidate the same way. It never selects a tab by URL, title, or
foreground state, and never reuses the user's ordinary ChatGPT page.

Normal control remains in the background. The Skill verifies the same exact
`tabId` and Project/chat URL immediately before sending and immediately after
sending, using semantic DOM operations throughout. It does not use
screenshot-coordinate clicking, pass `visible: true`, or focus the page. Only
login, CAPTCHA, 2FA, or explicit consent may temporarily require visibility;
after the user action the page returns to the background and the checks run
again. Do not close or repurpose the owned standby tab when a turn ends.

`surface release` only ends the current lease and keeps the durable session
route for later reuse. When a local Codex session is permanently discarded,
run `c2c surface retire --local-session <id> --json`. Retirement revokes that
session's contexts, terminates its active control request, and removes its page
binding and checkout route. The workspace's ChatGPT Project binding remains
available to other and future sessions.

### Unavailable chats

The Skill inspects the exact owned tab and passes its semantic state to
`c2c surface check`. A missing tab reopens the saved chat; an explicitly
archived or unavailable chat creates a new chat in the same Project without
unarchiving the old conversation. Login or consent is completed by the user:
Codex provides the observed entry or service URL and instructions, without
starting/submitting login, filling credentials/codes, or switching accounts.
After the user reports completion, Codex rechecks the page and authorization;
loading and generation require waiting, not a duplicate send. The CLI evaluates
the host observation; it does not probe ChatGPT independently.

The C2C app does not have to appear in the picker or as a selected chip.
When the route and authorization are healthy, Codex may send the normal
correlated request naming the connector and ask ChatGPT to discover/use its
tools directly. Workspace tasks begin with workspace_info to verify identity.
This uses the same owned chat and request, with no extra discovery message.
Actual tool results establish availability; a model's unsupported claim does not.
Missing UI alone never requires manual selection or chat replacement. Confirmed
tool/authorization failures follow the result protocol, and platform refusals
are not retried through another page.

Before replacing a page, preserve any verified Computer Use result in the local
checkpoint. Only confirmed page failure permits cancelling an exact pending request.
The Gateway blocks rotation while work is unresolved. Recovery preserves task
progress, verifies one replacement through BOOT, and fences stale generations.
It never uses session retirement to recover a page. See [the recovery protocol](docs/protocol.md#page-recovery).

The page's current model is used by default. Model/effort metadata does not
operate its selector or guarantee the newest model; explicit model requests
require selection and verification in the page.

## Security properties

- The transport is a public URL, so `POST /mcp` requires a bearer token; an
  unauthenticated or wrongly authenticated request gets `401`. The gateway
  refuses to start `serve-http` without a token.
- The bearer token is a **transport gate, not an authority**. A caller that
  passes it still needs a valid `context_id` issued by `c2c control open` before
  any tool acts on a workspace, and every tool keeps its own scope check.
- MCP workspace tools are read-only. Computer Use results are bounded by a live,
  schema-checked request and exact page/response identity.
- Workspace paths are resolved and contained under the registered root. Symlink
  and traversal escapes are rejected.
- Capabilities and activity leases are short-lived and bound to session, task,
  iteration, phase, compaction epoch, page generation, and scopes.
- The retained mailbox completion fence is dormant in the current production
  transport and remains covered by tests for later comparison.
- The machine lifetime record is owner-checked by machine id, boot epoch, pid,
  and exact runtime data. A second process cannot silently become the broker.
- Secrets (bearer token, admin token, raw capability) stay in protected machine
  state (mode 0600) and are omitted from normal CLI views; the token is printed
  only by an explicit `machine auth show --reveal`.
- Anyone who can reach the public URL can attempt the bearer check, so rotate
  with `c2c machine auth rotate` if the token leaks and keep the tunnel
  dedicated to this machine.

See [docs/architecture.md](docs/architecture.md),
[docs/protocol.md](docs/protocol.md), and
[docs/security.md](docs/security.md) for contracts and failure handling.

## Useful commands

```sh
c2c machine start
c2c machine status --json
c2c machine doctor --no-fix --json
c2c machine stop
c2c machine endpoint get --json
c2c machine endpoint set --url https://<your-tunnel-public-base-url> --json
c2c machine auth show --json
c2c machine auth rotate --json
c2c workspace --json
c2c surface get --local-session <session-id> --json
c2c session get --local-session <session-id> --json
c2c control status \
  --local-session <session-id> --request <id> --task <id> \
  --iteration <n> --phase <phase> --json
```

`machine stop` stops the shared connection for all workspaces; let their active
tasks finish first. Run source checks from the C2C source checkout:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## License

MIT
