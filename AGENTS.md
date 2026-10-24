# codex-channels Project Rules

## Scope and Task Context

- These rules apply to the entire repository. More specific `AGENTS.override.md` or `AGENTS.md` files take precedence, subject to higher-priority instructions and user authorization.
- Establish applicable rules at task start. Use the task table to select required sections of `docs/development-rules.md` for implementation, review, diagnosis or design. Read all affected boundaries before acting, following actual call chains rather than filenames or a fixed checklist; reading rules does not expand authorization.
- Read relevant contracts: user entry points in `README.md` and `docs/user-guide.md`, module responsibilities in `src/README.md` and affected module READMEs, and affected interfaces and call chains. Unchanged presentation or internal refactoring does not alone require upstream investigation.
- Reuse valid context. Restore missing rules after compaction, model switches or interruptions; read newly applicable material when scope, rules or workspace changes. Routine edits, commits, elapsed time and new turns do not alone require rereading.
- Support only interfaces defined by current documentation, configuration examples, protocol baselines and storage schemas. Explicitly reject unsupported inputs; do not add implicit aliases, migrations or fallbacks.
- Make the smallest complete fix across the root cause, affected contracts and paths, from input to consumption or persistence. Reuse existing modules, interfaces and types; add abstractions, options or extension mechanisms only for a current need. Remove entry points, dependencies, configuration and scripts orphaned by the replacement. Keep unrelated work outside scope.
- Validate trusted data again only at a new trust boundary, for a different business invariant or when resource state may change. Use explicit types and discriminated unions in protocol code; avoid unconstrained `any`. Preserve actionable, nonsensitive error context and make degraded behavior observable.
- Keep any plan tool current. Read-only reviews produce findings with locations, impacts, evidence and proposed adjustments, without edits. Skills and model changes do not override project constraints or justify fixed reading routines, repeated confirmations or per-file checklists.

## Architecture and Module Boundaries

- One modular TypeScript Gateway is installed from source through npm and entered through `codexc`. Keep the root package private; do not publish new Gateway npm packages.
- App Server is the sole source of truth for Thread, Turn, Item, Goal and conversation history. Gateway must not read, parse or modify Codex internal session files, duplicate complete history or maintain a parallel session index.
- App Server runs independently: default/fixed mode uses one primary instance; switching mode may add Provider-isolated instances under the same service entry point. Native TUI and Gateway share each instance's Threads and live state. Gateway stop/restart must not terminate shared App Server.
- Each App Server uses a private Unix WebSocket; runtime/service installation owns socket lifecycle and permissions. Use `codexc remote` to hold a lifecycle lease and invoke native `codex --remote`; direct native connections lack that lease and may lose the instance to idle release. Gateway must not implement another terminal interface.
- Optional Model Relay runs independently, exposes only the documented model API and submits metrics through private IPC to Gateway's sole database writer. It must not expose or connect to App Server conversation capabilities.

```text
Surface -> Application/Core <- Codex Client
                     ^
       Policy / Storage / Scheduled Tasks
```

- `bootstrap` owns composition, implementation selection and lifecycle coordination. Top-level modules expose capabilities through their own `index.ts`; cross-module imports must use these public exports, never internal files. Follow module READMEs and `scripts/check-runtime-boundaries.mjs`; new dependencies and allowlist changes require a justified module responsibility.
- Conversation Core must not depend on platform SDKs, concrete databases, service managers or underlying JSON-RPC Transport. Surfaces must not operate Transport directly or introduce platform SDK types into core. Codex Client must not call platform APIs, generate platform-facing copy or store business bindings.
- Keep networking, protocol, state, rendering and storage responsibilities separate; do not duplicate reduction, parsing, approval or authorization to bypass interfaces.

## Safety and Authorization

- Authorize every external input against its Surface Actor and Workspace before invoking Thread, Turn, command, file or permission capabilities. External users may select only preconfigured Workspaces, never arbitrary absolute working directories.
- Unrecognized, unroutable or unattributed privileged requests fail closed. Do not automatically approve commands, file writes, filesystem or network permissions by default; explicit authorization must remain within the supported protocol and its stated scope. Never silently promote one-time approval. Configuration errors must not fall back to broader permissions, directories or network defaults.
- Keep Unix Socket parent directories private to the current user and sockets inaccessible to unrelated users. Unauthenticated App Server must not listen on non-loopback addresses.
- Logs, exceptions and platform messages must not expose Tokens, Cookies, Authorization Headers, sensitive forms or unconstrained upstream responses. External users receive only designated structured errors, never unknown internal exceptions verbatim.
- StateStore contains only bindings, preferences and recovery state explicitly allowed by the current schema, never message bodies, Turn/Item history, Diff, Plan, approval content or session-file copies. Unsupported versions fail closed without modifying data; no implicit migration, legacy cleanup or deletion to bypass compatibility checks.
- Before changing user-data formats, compatibility or recovery, provide a data-handling, backup, failure-recovery and rollback plan; obtain authorization only beyond existing scope. Read-only queries and disposable data are exempt from this approval, as are internal changes preserving both the on-disk contract and user-data selection, overwrite, deletion and recovery semantics.
- Do not store user configuration, databases, sockets, logs or uploads in package directories replaced by npm upgrades. OAuth Tokens stay outside configuration and StateStore; use the documented platform credential backend and never pass Tokens into Application/Core.
- Project dependencies require an explanation of necessity, impact and removal and applicable authorization. Task-only tools that do not change project configuration or user data follow environment permissions.
- `upstream/` is read-only reference material. Do not modify, commit, push, silently fetch or switch its versions, or substitute remote `main` for a locked baseline.
- Command escalation grants no additional authorization for commits, remote writes, deployment or dependency changes. `.codex/rules/default.rules` may preauthorize only read-only Git, existing verification scripts and the explicitly listed validated `codexc channel send-image`. Keep rules on disk, outside Workspace Registry.
- Preserve unrelated work and Git history. Do not commit, push, rewrite history, create/update remote PRs, merge, release or deploy without explicit authorization. Upgrade proposals remain Draft until authorized; published tags and historical npm packages must not be overwritten.

## Task-Specific Details

Select every applicable boundary, including for read-only work. Links below lead to required sections of `docs/development-rules.md`; topic references are scoped to the affected behavior.

| Task boundary | Required section and contract |
| --- | --- |
| Feature planning, review, diagnosis, implementation, repair or refactoring | [Development Workflow](docs/development-rules.md#development-workflow) |
| OS branches, shared runtime, process ownership, Transport lifecycle, credentials, service templates or installation paths | [Cross-Platform Changes](docs/development-rules.md#cross-platform-changes) |
| WeChat/Feishu API calls, events, authentication or lifecycle; official semantics or upstream baselines | [Consulting Official Sources](docs/development-rules.md#consulting-official-sources); affected `docs/upstream-sources.md` baseline |
| RPC methods/fields, encoding, response interpretation, event reduction, upstream lifecycle, generated types or controlled `codex-protocol` dependencies | [Consulting Official Sources](docs/development-rules.md#consulting-official-sources), [App Server Protocol](docs/development-rules.md#app-server-protocol); affected `docs/index.md` contracts |
| Thread listing, archive, continuation, bindings, subscriptions or authoritative state | [Threads and Sessions](docs/development-rules.md#threads-and-sessions) |
| Persistence, credentials, Gateway configuration/defaults, proxy discovery or Doctor | [State and Persistence](docs/development-rules.md#state-and-persistence) |
| Surface registration/capabilities, platform output, concurrency, background tasks, Thread Queue or approvals | [Surfaces, Approvals and Concurrency](docs/development-rules.md#surfaces-approvals-and-concurrency) |
| Socket/rendezvous validation, runtime connections, service supervision or external security/errors | [Security](docs/development-rules.md#security) |
| Public commands/help, services, command presets or background service operations | [Commands and Permission Escalation](docs/development-rules.md#commands-and-permission-escalation); affected `docs/user-guide.md` contracts |
| Downloads, source copies, dependency caches, disposable artifacts or task-owned processes | [Temporary Files](docs/development-rules.md#temporary-files) |
| Verification selection, checks/hooks/CI, installation, packaging, npm lifecycle, commit preparation or failed CI | [Verification](docs/development-rules.md#verification) |
| Linux browser observation, page extraction or screenshots | [Linux Browser Verification](docs/development-rules.md#linux-browser-verification); installed `playwright-cli` skill |
| Public behavior, interfaces, configuration, commands, deployment, documents or file indexes | [Documentation Placement](docs/development-rules.md#documentation-placement) |
| Authorized commit, PR, push or merge | [Git and Delivery](docs/development-rules.md#git-and-delivery) |
| Codex CLI upgrade or release | [Codex CLI Upgrades and Releases](docs/development-rules.md#codex-cli-upgrades-and-releases); `docs/codex-cli-upgrade.md` and affected workflow documentation |

## Evidence and Completion

- Do not write tests: no new unit, integration, contract, snapshot or E2E files or guard scripts, including equivalents renamed as probes or smoke checks. Existing tests are frozen historical assets; do not expand, maintain or repair red results or recreate deleted suites, fixtures, test dependencies or guard scripts. Bulk deletion requires explicit user authorization naming the scope.
- For implementation, perform Hack plus a real user path: challenge relevant failures or adversarial inputs, record actual outputs, and observe the entry point through to a usable result. For rules/documents, inspect content and its loading or consumption path; for read-only analysis, use source-backed findings without unrelated runtime exercises.
- Tests, static checks and CI report workflow status, not usability or completion. Preserve existing static checks and gates without bypasses. Reuse valid evidence; repeat checks only for changed inputs, failures or unresolved concerns. Repeated failures require revisiting evidence and methods, not blind retries or arbitrary stopping counts.
- Verification does not authorize damage, charges, external messages or broader access to user App Server, accounts, Threads or services. If observation is unavailable, finish authorized work and report the unobserved behavior, reason and risk without claiming functional verification.
- Complete requested work, necessary related fixes, interfaces, documentation and checks. Record unrelated issues separately; optional improvements do not extend scope. Commits, pushes, releases and deployment are completion conditions only when requested.
- Report results, concrete evidence and limitations, including Hack findings and real-path observations for implementation. Never fabricate observations or label failed/pending checks as passing. Do not repeat work rules unless asked.
