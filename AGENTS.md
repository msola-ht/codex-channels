# codex-channels Project Rules

## Scope and Task Context

- These rules apply to the entire repository. More specific `AGENTS.override.md` or `AGENTS.md` files take precedence, subject to higher-priority instructions and user authorization.
- Establish the applicable rules at task start. Read only the contracts and sections needed for the actual task: user entry points in `README.md` and `docs/user-guide.md`; module responsibilities in `src/README.md` and affected module READMEs; public interfaces and affected call chains for implementation work.
- The task table below points to mandatory details for the affected boundary in [`docs/development-rules.md`](docs/development-rules.md). Read the named sections before acting on that boundary; follow their topic links only as needed. A filename mention alone does not trigger a topic, and the table is not a full-document reading checklist.
- Reuse unchanged material already in context. Restore missing applicable rules after compaction, a model switch or interruption; read newly relevant parts when the workspace, rules or scope changes. Editing, committing, elapsed time and continuing across turns do not alone require rereading.
- Support only interfaces defined by current documentation, configuration examples, protocol baselines and storage schemas. Explicitly reject unsupported inputs; do not add implicit aliases, migrations or fallbacks.
- Make the smallest complete change, reuse modules, public interfaces and types, and avoid abstractions, options or extension mechanisms without a current need. Remove orphaned entry points, dependencies, configuration and scripts when replacing an implementation.
- Validate trusted data again only at a new trust boundary, for a different business invariant or when resource state may change. Use explicit types and discriminated unions in protocol code; avoid unconstrained `any`. Preserve actionable, nonsensitive error context and make degraded behavior observable.
- Keep any plan tool current. Honor read-only review requests before editing; report issue locations, impacts, evidence and proposed adjustments. Skill or model changes do not authorize discarding project constraints or replacing judgment with fixed reading routines, repeated confirmations or per-file checks.

## Architecture and Module Boundaries

- One modular TypeScript Gateway is installed from source through npm; its official local entry point is `codexc`. The root package remains private; do not publish new Gateway npm packages.
- App Server is the sole source of truth for Thread, Turn, Item, Goal and conversation history. Gateway must not read, parse or modify Codex internal session files, duplicate complete history or maintain a parallel session index.
- Codex App Server runs independently. Default or fixed mode uses one primary instance; switching mode may add Provider-isolated instances supervised by the same service entry point. Native TUI and Gateway share the corresponding instance's Threads and live state. Stopping or restarting Gateway must not actively terminate shared App Server.
- Primary and optional Provider App Servers each use a private Unix WebSocket; runtime and service installation own socket lifecycle and permissions. Native terminal interaction is `codex --remote`; Gateway does not implement a second terminal session interface.
- Optional Model Relay runs independently, exposes only the documented model API and submits metrics through private IPC to Gateway's sole database writer. It must not expose or connect to App Server conversation capabilities.

```text
Surface -> Application/Core <- Codex Client
                     ^
       Policy / Storage / Scheduled Tasks
```

- `bootstrap` owns composition, concrete implementation selection and lifecycle coordination. Top-level modules expose public capabilities through their own `index.ts`; do not import another module's internal implementation files.
- Preserve module responsibilities and allowed dependency directions in module READMEs and `scripts/check-runtime-boundaries.mjs`. Establish responsibility before adding a dependency; change the static allowlist only when that responsibility warrants it.
- Conversation Core must not depend on platform SDKs, concrete databases, service managers or underlying JSON-RPC Transport. Surfaces must not operate Transport directly or introduce platform SDK types into core. Codex Client must not call platform APIs, generate platform-facing copy or store business bindings.
- Do not concentrate networking, protocol, state, rendering and storage in one module or duplicate reduction, parsing, approval coordination or authorization to bypass interfaces.

## Safety and Authorization

- Authorize every external input against its Surface Actor and Workspace before invoking Thread, Turn, command, file or permission capabilities. External users may select only preconfigured Workspaces, never arbitrary absolute working directories.
- Unrecognized, unroutable or unattributed privileged requests fail closed. Do not automatically approve commands, file writes, filesystem or network permissions by default; explicit authorization must remain within the supported protocol and its stated scope. Never silently promote one-time approval. Configuration errors must not fall back to broader permissions, directories or network defaults.
- Keep Unix Socket parent directories private to the current user and sockets inaccessible to unrelated users. Unauthenticated App Server must not listen on non-loopback network addresses. Read the detailed socket/rendezvous rules before changing runtime connections or services.
- Logs, exceptions and platform messages must not expose Tokens, Cookies, Authorization Headers, sensitive forms or unconstrained upstream responses. External users receive only designated structured errors, never unknown internal exceptions verbatim.
- StateStore contains only bindings, preferences and recovery state explicitly allowed by the current schema, never message bodies, Turn/Item history, Diff, Plan, approval content or session-file copies. Unsupported versions fail closed without modifying data; no implicit migration, legacy cleanup or deletion to bypass compatibility checks.
- Before changing user-data formats, compatibility or recovery, provide a concrete data-handling, backup, failure-recovery and rollback plan; obtain authorization only when existing scope does not cover it. Read-only queries, disposable data and changes preserving the on-disk contract do not trigger this approval.
- Do not store user configuration, databases, sockets, logs or uploads in package directories replaced by npm upgrades. OAuth Tokens stay outside configuration and StateStore; use the documented OS credential store and never pass Tokens into Application/Core.
- Project dependencies require an explanation of necessity, impact and removal and applicable authorization. Task-only tools that do not change project configuration or user data follow environment permissions.
- `upstream/` is read-only reference material. Do not modify, commit, push, silently fetch or switch its versions, or substitute remote `main` for a locked baseline.
- Command escalation authorizes only the stated task operation, not commits, remote writes, deployment or dependencies. `.codex/rules/default.rules` may preauthorize only read-only Git, existing verification scripts and the explicitly listed validated `codexc channel send-image`; never staging, commits, pushes, installation, releases, service management, arbitrary or destructive commands. Rules stay on disk, outside Workspace Registry.
- Preserve unrelated work and Git history. Do not commit, push, rewrite history, create/update remote PRs, merge, release or deploy without explicit authorization. Upgrade proposals remain Draft until authorized; published tags and historical npm packages must not be overwritten.

## Task-Specific Details

Each row identifies when to read the named section of `docs/development-rules.md`. Read multiple sections when the actual call chain crosses their boundaries; unchanged presentation or internal refactoring does not automatically require upstream protocol investigation.

| Task boundary | Required section and contract |
| --- | --- |
| Change OS branches, shared runtime, process ownership, Transport lifecycle, credentials, service templates or installation paths | [Cross-Platform Changes](docs/development-rules.md#cross-platform-changes), plus the affected rows below. Determine impact from the call chain, not the branch name or the OS where the issue was reported. |
| Change WeChat/Feishu API calls, events, authentication or platform lifecycle; investigate official semantics or update upstream baselines | [Consulting Official Sources](docs/development-rules.md#consulting-official-sources), then the affected `docs/upstream-sources.md` baseline. Matching locked local source and tests come first; permitted online exceptions require an explanation. |
| Change RPC methods/fields, request encoding, response interpretation, event reduction, upstream lifecycle, generated types or controlled `codex-protocol` dependencies | [Consulting Official Sources](docs/development-rules.md#consulting-official-sources) and [App Server Protocol](docs/development-rules.md#app-server-protocol), affected `docs/index.md` entries, generated types, interfaces and locked official source. Generated types alone do not establish local or experimental support. |
| Change Thread listing, archive, continuation, bindings, subscriptions or authoritative state handling | [Threads and Sessions](docs/development-rules.md#threads-and-sessions); protocol changes also trigger the preceding row. |
| Change persistence, credentials, Gateway configuration/defaults, proxy discovery or Doctor | [State and Persistence](docs/development-rules.md#state-and-persistence) and the affected storage/configuration interface. |
| Change Surface registration/capabilities, platform output, concurrency, background tasks, Thread Queue or approvals | [Surfaces, Approvals and Concurrency](docs/development-rules.md#surfaces-approvals-and-concurrency). Approval amendments require exact proposals and explicit selection; Queue must remain App Server-owned. |
| Change socket/rendezvous validation, runtime connections, service supervision or external security/error handling | [Security](docs/development-rules.md#security). Service work also reads the following row. |
| Change public commands, help, services or command authorization presets; operate background services | [Commands and Permission Escalation](docs/development-rules.md#commands-and-permission-escalation) and relevant `docs/user-guide.md` targets, defaults and lifecycle ordering. Do not infer the meaning of `all`. |
| Create downloads, source copies, dependency caches, disposable artifacts or task-owned processes | [Temporary Files](docs/development-rules.md#temporary-files); large Linux temporary work uses a unique `/var/tmp` directory subject to environment permissions. |
| Choose verification commands; change checks/hooks/CI, installation, packaging or npm lifecycle; prepare a commit or diagnose failed CI | [Verification](docs/development-rules.md#verification); hooks and lifecycle controls must be honored, frozen historical tests must not be repaired. |
| Observe UI/browser paths, extract pages or capture screenshots on Linux | [Linux Browser Verification](docs/development-rules.md#linux-browser-verification), then installed `playwright-cli` skill; no test files or E2E scripts. |
| Change public behavior, interfaces, configuration, commands, deployment, documents or file indexes | [Documentation Placement](docs/development-rules.md#documentation-placement). Update only affected documents and the responsible index; internal refactoring does not need feature-list expansion. |
| Prepare an authorized commit, PR, push or merge | [Git and Delivery](docs/development-rules.md#git-and-delivery); review full branch changes from a refreshed merge base before PR writes, preserve existing gates and verify remote state. |
| Upgrade Codex CLI or prepare a release | [Codex CLI Upgrades and Releases](docs/development-rules.md#codex-cli-upgrades-and-releases), `docs/codex-cli-upgrade.md` and affected workflow documentation; no old-protocol compatibility layer. |

## Evidence and Completion

- Do not write tests: no new unit, integration, contract, snapshot or E2E files or guard scripts, including equivalents renamed as probes or smoke checks. Existing tests are frozen historical assets; do not expand, maintain or repair red results or recreate deleted suites, fixtures, test dependencies or guard scripts. Bulk deletion requires explicit user authorization naming the scope.
- For implementation changes, perform Hack plus a real user path: challenge relevant failure cases or adversarial inputs, record actual outputs, and observe the affected entry point through to a usable result. For rules/documents, inspect content and its loading or consumption path. For read-only analysis, report source-backed findings and uncertainty without unrelated runtime exercises. Never fabricate failures or observations.
- Tests, static checks and CI are workflow status, not evidence of usability or completion. Keep existing static checks and enforced controls operational; do not bypass them or write tests to make CI green. Reuse valid evidence, and repeat checks only for changed inputs, failures or unresolved concerns.
- Real-path work stays within authorization: it does not authorize damage, charges, external messages or broader access to user App Server, accounts, Threads or services. If unavailable, deliver authorized changes and identify the missing observation and reason without claiming functional verification.
- Complete requested implementation, related fixes, affected interfaces/documentation and appropriate checks. Optional improvements do not extend scope indefinitely; commits, pushes, releases and deployment are completion conditions only when requested. Repeated failures require revisiting evidence and methods rather than blind retries or arbitrary stopping counts.
- Report results and evidence appropriate to the task, affected behavior and remaining limitations. For implementation work, include concrete Hack findings and real-path observations. Identify unobserved behavior, record unrelated issues separately and never describe failed or pending checks as passing. Do not repeat work rules in delivery unless asked.
