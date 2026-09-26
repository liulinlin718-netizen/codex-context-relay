# App Server connection and delivery contract

The public contract was checked against Codex CLI `0.154.0-alpha.6.2`, then `0.155.0-alpha.2.6` schemas and [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server). The implementation uses `initialize` → `initialized`, `thread/list`, `thread/read`, `thread/resume`, `turn/start`, and `turn/completed`. Public paginated history methods are `thread/turns/list` and `thread/items/list`; account/provider checks use `account/read` and `config/read`. New pagination/target checks have contract-fixture coverage, not successful desktop read/transfer evidence.

No public contract for native message bubble selection, context menus or composer chips was established. This package does not inject Electron, inspect private databases, or assume that third-party plugins have the desktop's `mcp__codex_app__*` tools. Copying the package into Codex is explicitly a degraded entry point.

## Local plugin installation

Verified with Codex CLI `0.155.0-alpha.2.6` in a separate profile: plugin installation, cached Skill discovery, 15 MCP tools and the schema resource. No model request or desktop transfer was made.

Choose a marketplace root on your own machine. Place the complete extracted release at `<marketplace-root>/plugins/codex-context-relay/`. Create `<marketplace-root>/.agents/plugins/marketplace.json` with the following content in this **new** marketplace; do not overwrite an existing marketplace:

If the chosen CLI profile already has a marketplace named `personal`, choose an unused name, for example `context-relay-local`. Change all three matching places: JSON `name`, install suffix `@personal`, and list option `--marketplace personal`. A different directory does not resolve a duplicate marketplace name. Preserve existing marketplace files and registration.

```json
{
  "name": "personal",
  "interface": {"displayName": "Local Context Relay"},
  "plugins": [{
    "name": "codex-context-relay",
    "source": {"source": "local", "path": "./plugins/codex-context-relay"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
    "category": "Productivity"
  }]
}
```

In PowerShell, these settings affect this shell and its children only:

```powershell
$market = (Get-Location).Path # Run from your chosen marketplace root.
$env:CODEX_HOME = Join-Path $market 'codex-profile'
$env:CODEX_SQLITE_HOME = Join-Path $env:CODEX_HOME 'sqlite'
$env:TEMP = Join-Path $market 'temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME, $env:CODEX_SQLITE_HOME, $env:TEMP | Out-Null
node "$market/plugins/codex-context-relay/scripts/configure-plugin.mjs"
codex plugin marketplace add "$market" --json
codex plugin add codex-context-relay@personal --json
codex plugin list --marketplace personal --json
codex mcp list --json
```

Use an **absolute** marketplace root; the inspected CLI rejected the tested bare relative path. `personal` must match the JSON name. The desktop will not automatically adopt this separate CLI profile. Installation alone does not log in the separate model profile or enable cross-task delivery.

Keep the extracted source directory: the Skill is cached, while MCP runs the configured Node entrypoint in the source directory. After moving the package, update its marketplace source, run configuration again, and reinstall so the cached MCP configuration uses the new path. Preserve a full draft backup before moving user data.

Three locations have distinct roles: the `CODEX_HOME` selected above installs/discovers the plugin for that CLI profile; `<extracted-source>/.runtime/` stores Relay data; `<extracted-source>/.runtime/codex-profile/` is the optional model/managed-server account. Installing a plugin does not log in the model profile or change the desktop profile.

### First useful result

From an extracted release, run `node scripts/configure-plugin.mjs` directly; do not run the source-only packaging command again. Setup checks Node 22+, required files, immutable file hashes, and matching package/plugin/release versions before changing configuration. It updates only the `context-relay` command/arguments, preserving its existing options/environment and other servers. Writes use a lock and temporary-file replacement; malformed JSON is not overwritten. Repeated setup accepts its own generated manifest pointer. `configured: true` is local setup success, not client installation/discovery.

In an existing conversation of a client that actually loaded the tools, attach an explicit history file and request:

> Use the Context Relay skill to import this supplied history, select these specific messages or snippets, and show the actual outgoing preview. Open the companion selector if interactive selection is needed. Do not send to another task.

Expect `relay_capabilities`, then `relay_import`/`relay_pack` or `relay_selector`. Offline import, preview and export need no model login. If tools are unavailable, the known original release can still run `node <extracted-source>/src/cli.mjs serve`; open its loopback URL and import JSON/JSONL history or ContextPack. This does not grant access to current desktop messages.

### Diagnosing an installed or moved copy

An installed Skill may live in a cache while its MCP command points to source elsewhere. Do not start the cache's `src/cli.mjs` as fallback: it may be older and would create a different `.runtime`.

```sh
node <directory-containing-the-loaded-SKILL.md>/../../scripts/configure-plugin.mjs --locate
```

This read-only command follows that copy's `.mcp.json`, reporting `sourceRoot`, `dataRoot`, `cliEntry`, `nodeExecutable` and package `version`. It does not create runtime data, install, authenticate or start a server. Use those returned paths. A first unconfigured release needs normal setup before locating. If the config/source/helper is missing, restore or explicitly locate the original extraction; do not substitute a cache copy.

After moving source or changing Node: back up needed drafts, configure the chosen source again, update marketplace/client configuration, then reinstall/reload it. Setup alone does not update cached `.mcp.json`. If an old installed Skill lacks `--locate`, use the known original extraction and refresh the installed package.

| Diagnostic | Next action |
| --- | --- |
| `MCP_NOT_CONFIGURED` | Run setup in the original chosen extraction, then add/reload its client configuration. |
| `MCP_SOURCE_MISSING` / `MCP_NODE_MISSING` | Restore the configured path, or configure the moved source/current Node and reinstall/reload. |
| `CONFIG_INVALID` | Repair/restore the named local JSON; its previous bytes were not overwritten. |
| `RELEASE_INCOMPLETE`, `RELEASE_INTEGRITY`, `RELEASE_VERSION_MISMATCH` | Re-extract a complete release or rebuild from source; do not edit the file manifest to bypass validation. |
| `CONFIGURE_BUSY` | Wait for active setup. If none is running, inspect the leftover `.configure-plugin.lock` before removing it and retrying. |

## Configure an explicit connection

Use `node src/cli.mjs connection --help` from the source release. Without `--save`, the command only probes and does not replace current configuration. Host modes require an existing thread ID:

```sh
node src/cli.mjs connection --mode host-ws --endpoint ws://127.0.0.1:6401 --thread EXISTING_THREAD_ID
node src/cli.mjs connection --mode host-ws --endpoint ws://127.0.0.1:6401 --thread EXISTING_THREAD_ID --save
```

Use an endpoint actually supplied for your host; do not scan ports. For the proxy, use `--mode host-proxy --sock <explicit-socket> --thread EXISTING_THREAD_ID`. An isolated server uses `--mode managed-app-server [--codex-path <executable>]` with optional `--thread <existing-id>`. Restore offline mode with `connection --mode export-only --save`.

Output separates `saved`, `restartRequired`, `verification.readVerified` and `verification.canSend`. Host saving requires a successful read of the exact ID, even if absent from the current list page. Login may still prevent sending. Managed mode can save a successful handshake/list without an ID, but remains an independent profile. `nextStep` and `sendRequirement` give the continuation: host login belongs to that host; `node src/cli.mjs login` logs in the package's isolated profile.

`--save` backs up original config bytes as `relay.backup-<UUID>.json`, atomically replaces only bridge settings, and preserves model/other fields. Invalid JSON, concurrent edits, a lock, or failed verification leave old configuration intact. Restart selector/MCP after saving; there is no silent hot switch. Failed saving includes its safe `verification` result, so repeating the same probe is unnecessary.

## Connection modes

| Configuration | Reported capability | Meaning |
| --- | --- | --- |
| No configuration | `export-only` | JSON/Markdown export and copy are available offline. |
| `managed-app-server` | `managed-app-server` after handshake | Starts an isolated stdio App Server in this package's isolated profile. It is not the running desktop server. |
| `host-ws` plus explicit `endpoint` | `verified-host-bridge` only after handshake/list and a successful read of the specified existing thread | Loopback WebSocket on a user-selected port 6400–6409. No endpoint scanning. URL credentials/query tokens are refused. |
| `host-proxy` plus explicit `sock` | Same verification requirement | Runs the installed CLI's documented `app-server proxy --sock` command. A socket path alone is not evidence of a successful connection. |

`canSend` additionally requires public account information reporting `chatgpt` and a compatible OpenAI provider configuration. `probe()` without an ID only handshakes/lists and checks public account/config; it does not read the first conversations in the list. `probe({threadId})` or a successful explicit `read(threadId)` records `readVerified`, `readThreadId` and `readVerifiedAt` for this connection. An empty list/missing list entry does not prevent reading a supplied ID. Reading can be verified while authentication keeps `canSend:false`; a failed ID or disconnect clears earlier proof. Managed history is not desktop history; thread creation/forking are not implemented.

Reads first inspect metadata. For `historyMode:paginated`, the reader uses public experimental `thread/turns/list` in ascending order with full items; summary/notLoaded turns use `thread/items/list` for the same thread and turn. Default bounds: 40 pages, 2,000 turns, 10,000 items, 16 MiB and 45 seconds. Repeated cursors/IDs, wrong returned turn IDs or unsupported pagination return `HISTORY_INCOMPLETE`; excess size/time returns `HISTORY_LIMIT`. Partial history is not returned as complete. Recovery keeps uncertain delivery unknown and never resends on these failures. `experimentalApi:true` enables these inspected read methods, not private storage access.

The library defaults to export-only. The explicit read-only probe intentionally defaults to managed mode:

```powershell
node scripts/probe-app-server.mjs
```

Probe results are saved in `.runtime/validation/app-server-probe.json`. The probe never starts a model turn and never authenticates on behalf of the user. No real send or model quality is proven by this probe.

## Library API

```js
const bridge = createBridge({mode: 'managed-app-server'});
await bridge.probe();
const {data, nextCursor} = await bridge.list({limit: 30});
const thread = await bridge.read(data[0].id);
const draft = await bridge.prepare({pack, targetThreadId: thread.id});
// Show draft.preview in full, including the visible recovery receipt marker.
// Call only after the user explicitly chooses to send this exact preview.
const result = await bridge.send(draft.id);
const recovered = await bridge.reconcile(draft.id); // read-only; never resends
await bridge.close();
```

`receipt(id)`, `receipts()`, and `capabilities()` read local receipt/capability state. `prepare` validates the ContextPack and renders its canonical prompt. An optional `body` must match that prompt exactly. It persists a preview, pack snapshot, target, body hash, timestamps and deterministic receipt ID. Re-preparing the same body and target on the same connection returns the existing receipt across process restarts.

## Delivery and recovery

For a blocked pre-send receipt, call `diagnoseReceiptLock(id)` (CLI `lock-diagnose <id>`; MCP `relay_lock_diagnose`). The diagnostic includes `ownerState`, `recoverable`, `reason` and an exact `lockToken`. If recoverable, an explicit `recoverReceiptLock(id, {expectedLockToken: diagnostic.lockToken, confirm: true})` releases only that inactive lock. CLI: `lock-recover <id> <token> --confirm`; MCP: `relay_lock_recover`. This does not modify the preview or receipt, contact a target, or send; sending remains a separate explicit action. An old diagnostic cannot release a later lock generation.

Recovery uses the same local kernel exclusion guard as sending and rechecks receipt integrity, connection identity and durable `deliveryAttempted:false` while holding it. PID and file age alone are not recovery evidence. Windows uses a named pipe; Linux uses an abstract socket scoped to the current network namespace. Windows subprocess crash/recovery behavior is tested; Linux and other-platform compatibility remain separate validation boundaries. Legacy, malformed, unsupported-platform or ambiguous locks are not automatically removed. Attempted, submitted and unknown receipts stay on read-only reconciliation.

`prepared` means no send was attempted. A failed readiness check records `failed` with `deliveryAttempted: false`; the user can fix the issue and explicitly send again. Immediately before `turn/start`, `submitted` with `deliveryAttempted: true` is fsynced to disk. A returned turn ID is stored and the bridge waits for completion evidence. Completion is `completed`; an explicit RPC rejection or failed/interrupted turn is `failed`. Timeout, disconnect or malformed acknowledgement produces `unknown`. A per-receipt exclusive file lock prevents concurrent local submissions. A stale lock is deliberately not removed automatically.

After a submission attempt, the same receipt is never submitted again. `reconcile` reads the existing target and matches its turn ID, or matches the exact user-input preview if the acknowledgement was lost. Assistant text cannot confirm delivery. An absent match stays unknown: unavailable or partial history does not prove failure. The draft and complete preview remain available. This is local duplicate suppression, not a claim of server-side exactly-once delivery. `clientUserMessageId` is sent as a correlation value; no undocumented server deduplication guarantee is assumed.

Targets are checked for idle status before and after resume and again before starting. Busy or unknown states are refused. **The inspected public schema has no atomic “start only if still idle” precondition. Another client starting a turn between the final read and `turn/start` remains a race; exclusive ownership of the target during send is required to rule it out.** The bridge never calls `turn/steer`, never grants approvals, and rejects unsupported server requests. Sends request the fixed `gpt-6-astra` / `ultra`, with read-only sandbox and no approval grants.

## Authentication and storage

CLI commands use argument arrays with `shell: false`. Each CLI child assigns this package’s `.runtime/codex-profile/` to `CODEX_PROJECT_PROFILE_DIR` and `CODEX_HOME`, sets `CODEX_SQLITE_HOME`, explicitly overrides `sqlite_home`, and uses `cli_auth_credentials_store="file"`. Temporary directories and process-controlled artifacts remain under this copy of the project. Output paths reject traversal and symlinks/junctions. The bridge removes inherited API-key/token variables, custom OpenAI base-URL variables, and host session/thread/originator/tool-pipe identifiers from a copied child environment; the parent environment is unchanged and secret values are never printed.

An unlogged-in or API-authenticated profile receives an explicit configuration error. The bridge does not read auth files, copy C-drive credentials, promise account quota, or fall back to API billing. Independently configured external API generation belongs to the separate model provider module. A verified host connection uses its existing server account; the local proxy's child environment cannot alter that host's environment, so the host's public account/provider checks remain mandatory. Host desktop logs are outside the project's storage control.

## Validation boundary

`tests/integrations.test.mjs` uses clearly labelled offline transports. It covers normal completion, persisted-before-network intent, lost acknowledgements, timeout/disconnect, concurrent and restart deduplication, stale locks, inaccessible targets, busy targets, account/provider mismatch, explicit rejection, exact preview validation, read-only recovery, and protocol error handling. Fixture success is not real message delivery. A probe writes local results only; login, host delivery and model quality remain unverified.
