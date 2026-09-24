# codex-channels Project Rules

## Scope and Sources of Truth

- These rules apply to the entire repository. More specific `AGENTS.override.md` or `AGENTS.md` files take precedence.
- Establish the applicable rules when starting work. Read material needed for the task, rather than requiring a full read before every edit.
  For user operations, use the entry points in `README.md` and relevant sections of `docs/user-guide.md`.
  For module boundaries, use `src/README.md` and affected module READMEs. For implementation changes, inspect relevant public interfaces and existing tests.
- Do not reread unchanged material already in context. After compaction, a model switch or an interruption, restore missing applicable rules.
  When the workspace, rules or task scope changes, read the newly relevant parts. Editing, committing, continuing across turns or elapsed time alone does not trigger rereading.
- This file defines stable development boundaries. User-facing behavior is defined by the guides and topic documents linked from the root README; module responsibilities are defined by module READMEs.
- Support only interfaces explicitly defined by current documentation, configuration examples, protocol baselines and storage schemas. Reject unsupported inputs explicitly; do not add implicit aliases, migrations or fallbacks.

## Consulting Official Sources

- Before adding or changing WeChat or Feishu platform interactions, locate the relevant sources through `docs/upstream-sources.md`.
  If the referenced local `upstream/` repository exists and its HEAD matches the locked baseline, consult its source and tests first;
  do not search online for the same version first. Online queries are allowed only when local sources are missing, the baseline differs,
  required information is absent from the locked source, dynamic platform documentation needs checking, or the user explicitly requests an update. Explain the reason first.
- `upstream/` contains read-only reference repositories ignored by the main project. Do not modify, commit or push their contents,
  silently `fetch` or switch versions, or substitute remote `main` for the locked baseline. Before upgrading an upstream baseline,
  review differences under `docs/upstream-sources.md`, then update the relevant source index, implementation and tests together.
- Before adding, changing or removing Codex App Server RPC methods, business dependencies on `codex-protocol` types, or behavior involving
  Transport, initialization, Thread, Turn, Item, Notification, Server Request, approvals, model settings, Fast, Goal, Review, account usage,
  Skill, MCP, Plugin or the Codex CLI version, consult the relevant `docs/index.md` entries and check local generated types, module public interfaces and project tests.
  When adding or changing protocol semantics, also check official source and tests at the locked version; official documentation supplements the contract.
  Read only the affected methods, fields and call chains. Copy edits, formatting and cleanup that do not change protocol behavior do not trigger upstream reading.
  Do not implement protocol fields or behavior from memory.
- If official documentation, locked source and local implementation are unclear or appear inconsistent, perform a targeted investigation and identify version differences first.
  Do not substitute official `main` for the locked version or infer the protocol through repeated trial edits.
- When a protocol upgrade or the above behavior, official source locations or local implementation entry points change, update the affected versions,
  counts, pinned links, support matrix entries, implementation mappings or verification commands in `docs/index.md`.
  Before adding a protocol capability, record its official method, local entry point and verification in the matrix.
  Generated types do not establish local support; they remain the final source of truth for protocol fields of the locked CLI.

## Codex CLI Upgrades and Releases

- Read and follow [`docs/codex-cli-upgrade.md`](docs/codex-cli-upgrade.md) for upgrade or release tasks only.
  Use official stable Codex CLI releases, review generated differences and complete business adaptations without retaining old-protocol compatibility layers.
- Keep upgrade proposals in Draft. Do not mark Ready, merge, release or deploy without explicit authorization.
  Preserve complete validation, failure reports and minimal workflow permissions. Execution details are defined by the upgrade guide and `.github/workflows/README.md`.
- Do not publish new Gateway npm packages. Keep the root package private; npm remains required for dependencies and local source installation.
- Published tags and historical npm packages must not be overwritten. Restoring the development baseline after a candidate or fix release is part of release completion;
  finish it under the upgrade guide before preparing the next release.

## Current Architecture

- The repository contains one modular TypeScript Gateway. The official local entry point is `codexc`, installed from source through npm.
- Codex App Server runs independently. Default or fixed mode uses one primary instance; switching mode may add Provider-isolated instances supervised by the same service entry point.
  Native Codex TUI and Gateway connect to the corresponding Provider instance and share its Threads and live state.
- App Server is the sole source of truth for Thread, Turn, Item, Goal and conversation history.
- Stopping or restarting Gateway must not actively terminate the shared App Server.
- The local primary App Server and optional Provider App Servers each use a private Unix WebSocket. Runtime and service installation scripts manage socket lifecycle and permissions.
- Native terminal interaction is provided by `codex --remote`; Gateway does not implement a second terminal session interface.
- Gateway does not read, parse or modify Codex internal session files or duplicate complete conversation history.

## Module Boundaries

Top-level module responsibilities and file indexes are documented in [`src/README.md`](src/README.md) and each module README. Preserve this dependency direction:

```text
Surface -> Application/Core <- Codex Client
                     ^
       Policy / Storage / Scheduled Tasks
```

- `bootstrap` is the composition root; concrete implementation selection and lifecycle coordination belong there.
- Each top-level module exposes public capabilities through its own `index.ts`. Do not import another module's internal implementation files across module boundaries.
- Top-level dependencies are limited to directions explicitly allowed by `tests/module-boundaries.test.ts`.
  Establish responsibility before adding a dependency and update the allowlist accordingly; do not expand it merely to pass tests.
- Conversation Core must not depend on platform SDKs, concrete databases, service managers or the underlying JSON-RPC Transport.
- Surfaces must not directly operate the underlying Transport or introduce platform SDK types into core modules.
- Codex Client must not call platform APIs, generate platform-facing copy or store business bindings.
- Do not duplicate state reduction, protocol parsing, approval coordination or authorization logic to bypass module interfaces.

## App Server Protocol

- Generate protocol types from the supported Codex CLI. Do not handwrite protocol fields from memory.
- Record and validate the exact Codex CLI version associated with generated types.
- On protocol upgrades, review generated differences before updating controlled exports in `codex-protocol`, implementation and tests.
- Stable business code must not depend on unapproved experimental protocol capabilities. Before changing related capabilities, read
  [controlled protocol boundaries in `docs/index.md`](docs/index.md#受控协议边界). Use only the capabilities, controlled exports and purposes explicitly allowed there,
  and retain real App Server contracts. A generated type does not imply project support.
- Runtime may negotiate only experimental capabilities required by current functionality and covered by the exact current version's stable generated types or the indexed controlled exceptions.
  Before enabling them, review the Notifications, Server Requests and fields enabled together. New privileged inputs must be explicitly presented or fail closed;
  add real App Server contract tests.
- Each Transport connection performs `initialize` once, then sends `initialized` after success. Send no other requests before initialization.
- Handle JSON-RPC Responses, Notifications and Server Requests separately.
- Request IDs must uniquely correlate pending responses, with cleanup on timeout, disconnection and close.
- Unknown Notifications may be logged and ignored. Unknown Server Requests must receive an explicit error or safe rejection; never leave them hanging.
- Only provably safe read-only or idempotent requests may be retried automatically after overload. Do not blindly retry creation or write operations.

## Threads and Sessions

- Query sessions using App Server `thread/list`; do not maintain a parallel session index.
- Ordinary Thread list queries must explicitly pass server-allowed `cwd` and `sourceKinds`.
- Local session archive previews must scope descendants by explicit `ancestorThreadId` and explicitly cover official source kinds, rather than truncating descendants by the parent's `cwd`.
  Before archiving, check the Workspace, Provider and protection state of queryable descendants. Do not claim this enumerates all official internal agents.
- Before automatic continuation, check Thread source, Workspace, running state and existing bindings.
- A Thread cannot be bound to multiple external Conversations simultaneously. Do not unconditionally append a new Turn to an active Thread.
- When switching, exiting, creating, archiving or unbinding, cancel old subscriptions through the protocol; deleting local mappings alone is insufficient.
- `thread/resume`, `thread/read`, request responses and state notifications are authoritative. Local caches serve routing and presentation only.
- Do not infer state transitions that App Server has not explicitly returned from a single request invocation.

## State and Persistence

- SQLite StateStore stores only minimal bindings for Conversation identity, authorized Actor, Workspace, Thread and Session.
- A Conversation is uniquely identified by `surface + accountId + conversationId`.
- StateStore must not persist message bodies, Turn/Item history, Diff, Plan, approval content or copies of Codex session files.
- Runtime accepts only the current schema and performs no implicit migration; unsupported versions must fail closed.
  Database schema changes must ship an explicit upgrade process with a defined supported range, backup, failure handling and verification. Do not replace upgrades with database deletion.
- Keep StateStore replaceable. Business modules may depend only on its public interface.
- Do not store user configuration, databases, sockets, logs or temporary uploads in package directories replaced by npm upgrades.
- Surface user OAuth Tokens must not be stored in configuration files or StateStore. Use the system Keychain on macOS;
  on Linux, use a private AES-256-GCM credential file under Gateway's data directory, protected by an independent random master key.
  Tokens must not enter logs, platform messages or Application/Core. Provide revocation for the current Surface Actor and cancellation on process shutdown.
- The sole source of user-level Gateway configuration is `~/.codex-connect/config.toml` or a TOML file explicitly selected by `CODEX_CONNECT_CONFIG_FILE`.
  Shared proxy settings are stored separately in Codex Home's `.env`; read only the four proxy variables, never the old Gateway `.env`.
  The old `[network]` table is unsupported, and the updater does not migrate proxy configuration.
- Only after structural and runtime semantic validation of the current configuration version may Gateway atomically fill missing safe defaults explicitly defined by the strict schema.
  Never overwrite existing values or fill channel credentials, identities or allowlists. Do not use defaults to accept unknown fields or migrate unsupported versions.
- When proxy fields are not explicitly configured, standard proxy environment variables and supported current system proxy settings may be read.
  Explicit Codex `.env` values take precedence. Automatic discovery affects process environment only; do not write it back to user configuration or service definitions.
- `codexc doctor` is read-only. Use current TOML for Gateway configuration and Codex `.env` for shared proxies.
  Do not support old configuration formats, rewrite configuration or output sensitive content.
- When adding project dependencies, explain necessity, impact and removal, and reuse applicable user authorization; ask first if not authorized.
  Temporary tool dependencies used only for the current task, without changing project configuration or user data, follow environment permissions rather than data-upgrade approval procedures.
- Before changing persistence formats, provide a concrete plan for data handling, backup, failure recovery and rollback, and obtain applicable authorization.
  Do not reconfirm an approved plan unless its scope or risk changes materially.

## Surfaces, Approvals and Concurrency

- Integrate Surfaces explicitly through a built-in plugin registry defined at compile time, invoking Application/Core through shared input, output, authorization and approval interfaces.
  Each plugin ID must match its returned Surface ID, and `surface + accountId` must be unique.
  Do not scan directories, dynamically load npm packages or let plugins register directly around the composition root.
- Codex capabilities exposed by a Surface must already appear in the current `docs/index.md` support matrix, backed by the locked official protocol,
  controlled types, local implementation and verification. Platform SDK capabilities alone do not authorize new Thread, Turn, Item, tool, approval or history semantics.
- Setup, Doctor, menus, input status, connection health and platform media transfer are channel operations or presentation capabilities and must remain within Surface boundaries.
  They must not duplicate Codex state, fabricate App Server events or establish parallel semantics for unsupported protocol behavior.
- App Server Reader only reads, parses, correlates responses and dispatches events; it must not wait for platform network requests.
- Use bounded queues for platform output. Preserve ordering within each Conversation; different Conversations may run concurrently.
- On overload, noncritical intermediate events may be merged or dropped, but approvals, errors, Item completion and Turn completion must never be silently dropped.
- Platform API timeouts, rate limits or failures must not block App Server Reader.
- Background tasks need a clear owner, cancellation path, bounded retries and a shutdown wait limit.
- Additional input for the next Turn uses the current Thread's App Server Queue. Gateway must not store a second message-body queue.
  Add, list, update, delete, reorder and start through the controlled Queue port; explain App Server persistence semantics when enqueueing.
- Bind approval state to Thread, the protocol-provided Turn and request identifier. MCP elicitation may use `turnId: null` when no active Turn can be associated,
  but must retain Thread and App Server request ID. Interaction tokens must be unpredictable, single-use and expiring.
- Promptly invalidate interactions for requests already resolved by another client.
- Reject or cancel unrecognized, unroutable or unattributed privileged requests by default.
- Map command or file approval to persistent authorization for the current App Server session only when the protocol supports it and the user explicitly selects it.
  Never silently promote a one-time approval. Temporary permission approvals remain limited to the current Turn.
- Display persistent command-prefix authorization separately from session authorization. Offer it only when App Server provides matching
  `proposedExecpolicyAmendment` and `acceptWithExecpolicyAmendment`; return the proposal unchanged only after explicit user selection.
  Gateway must not write or broaden Codex execution rules itself.
- Persistent network-rule authorization must show the exact host and allow/deny action. Offer it only when
  `proposedNetworkPolicyAmendments` and `applyNetworkPolicyAmendment` match exactly and every rule host equals `networkApprovalContext.host`; otherwise fail closed.
  Network session authorization must show its target host. Return only one explicitly selected rule unchanged at a time. Gateway must not merge, infer or broaden network rules.

## Security

- External users may select only preconfigured Workspaces, never arbitrary absolute working directories.
- Authorize every external input against the Surface Actor and Workspace before invoking Thread, Turn, command, file or permission capabilities.
- Restrict Unix Socket parent-directory permissions to the current user; sockets must not be accessible to unrelated users.
  Current CLI rendezvous links may target only the official deterministic destination. Shared Runtime must validate link ownership, canonical path hashes,
  protected directories, and the real socket's type, permissions and owner. Transport and service supervision must not independently relax checks or follow arbitrary links.
- Unauthenticated App Server must not listen on non-loopback network addresses.
- Do not automatically approve commands, file writes, additional filesystem permissions or network permissions by default.
- Configuration errors must fail closed, never fall back to broader permissions, directories or network defaults.
- Logs, exceptions and platform messages must not contain Tokens, Cookies, Authorization Headers, sensitive forms or unconstrained upstream responses.
- External user messages may expose only explicitly designated structured errors; never send unknown internal exceptions verbatim.

## Implementation and Changes

- Make the smallest complete change that meets the current goal, reusing existing modules, public interfaces and types.
- Do not add abstraction layers, general frameworks, configuration options or extension mechanisms for needs that have not arisen.
- Do not repeatedly parse or validate the same trusted data. Check as needed when crossing a new trust boundary, protecting a different business invariant or handling resources whose state may change.
- Use explicit types and discriminated unions in the protocol core; avoid unconstrained `any`.
- Preserve actionable error context without sensitive information. Degraded behavior must be observable.
- Do not concentrate networking, protocol, state, rendering and storage responsibilities in one large module.
- When changing public commands, configuration keys, protocol baselines, persistence formats or defaults, check and update the documentation, examples and tests actually affected.
- When deleting or replacing implementations, remove orphaned entry points, dependencies, configuration, scripts and tests together.
- When using a plan tool, update it promptly after stage completion or plan changes. Reflect actual progress; do not mark unfinished work complete.

## Commands and Permission Escalation

- Follow the current environment's permission policy. Reuse applicable authorization rather than adding confirmation for every Git, npm or verification command.
  Request escalation directly when outside-sandbox permissions are known to be required. Handle sandbox restrictions as the tool requires; never bypass permission controls.
- Escalation requests must explain the command's purpose and remain within this repository and task. They must not expand permission to modify, commit or write remotely.
- Escalation grants execution permission, not user authorization. Commits, pushes, dependency changes and other external writes still follow their corresponding rules here.
- Public `codexc` commands and subcommands must support both `-h` and `--help`. Keep only documented canonical names; do not add implicit aliases.
  `gateway` and `service-app-server` are internal service-template entry points, excluded from public help.
- Manage background processes through `codexc service`. Start, stop, restart, status and logs use the targets `gateway`, `app-server` and `all`.
  Start, stop and status default to `all`; restart and logs default to `gateway`.
- Project Codex command presets live in `.codex/rules/default.rules`. They may preauthorize only read-only Git inspections, existing repository verification scripts,
  and the explicitly listed `codexc channel send-image` operation, which sends a local image that has passed shared validation to a bound channel conversation.
  Do not preauthorize Git staging, commits, pushes, dependency installation, releases, service management, arbitrary shell commands or destructive commands.
- Rules belong to the on-disk project and must not be stored in or depend on Workspace Registry.

## Verification

- Match verification to risk and stage. Do not repeat checks for every save or small edit. After a verifiable batch, run the smallest directly relevant test set.
  Do not proactively repeat successful development checks when their inputs and environment are unchanged. Commit and CI gates still run through their own entry points.
- During development, choose targeted tests, `check`, `lint` or `docs:check` according to impact; do not default to full tests, builds, packaging or installation smoke tests.
  Add specialized checks when their corresponding boundaries change, such as protocol, Transport, service templates or package installation.
- Build requirements depend on test inputs. Tests loading source directly may run alone; CLI, installation or integration tests reading `dist/` must use current build output.
  `npm test -- <test-file>` already builds; do not add another build.
- Authorized development includes relevant local verification using disposable fixtures and fixing failures caused by the requested change, without approval at every step.
  For integration operations touching the user's current App Server, account, specific Thread or service state, check actual effects and existing authorization.
  Do not extend isolated-test authorization to live environments.
- New behavior, security boundaries, failure paths and regression fixes need effective test coverage and relevant execution. Add or adjust tests only when coverage is insufficient.
  Do not mechanically add duplicate tests for moves, renames, deduplication or internal refactors already covered by behavioral tests; add one shared contract suite when needed.
- Ordinary commits run the full `verify:commit` once through `.githooks/pre-commit`; do not run it manually beforehand.
  `npm ci`, `npm install` or `npm run hooks:install` must install the hook. If missing or unusable, repair it with `npm run hooks:install`, then let the normal commit run validation.
  Manual runs are allowed when changing CI or gates, explicitly requested, or needed to diagnose a failure independently.
  Never bypass gates with `--no-verify` or reduced checks.
- `npm run verify:commit` is the shared full-check entry point for local commits and GitHub CI. In order, it covers staged diff formatting, types and versions,
  production and test Lint, WebUI build and Lint, documentation links and indexes, the full test suite, shell syntax,
  npm tarball installation smoke tests and service-template checks executable on the current platform.
  Clean-source global installation is excluded from routine commit and PR gates, but remains required in full `npm run test:package`, explicitly authorized source releases and Codex CLI upgrade validation.
- When changing check scripts, Git hooks or CI, keep `verify:commit`, `.githooks/pre-commit`, GitHub Actions and affected script indexes and workflow documentation consistent.
  Update the root README only when user-facing development entry points change.
- Protocol, Transport or shared App Server behavior changes require real App Server smoke verification covering the change. Extend existing contracts if insufficient; mocks alone are not enough.
- Core protocol tests should cover initialization, message routing, request cleanup, primary Thread/Turn paths and subscription cancellation.
- Session tests should cover bidirectional discovery and continuation, exclusive binding, active state and recovery after Gateway restart.
- Surface tests should cover authorization, approval expiry and invalidation, output ordering, platform timeout isolation and sensitive-data sanitization.
- If required verification cannot run, report the missing checks, reasons and executable follow-up checks in the delivery.

## Documentation Placement

Determine the document's responsibility before adding or changing content. Do not accumulate topic details in the root README.

- Root `README.md` is the user entry point: installation, configuration, common operations, troubleshooting and upgrade conclusions with topic links.
  Protocol methods, internal state, data definitions, security checks, channel differences and complete parameter descriptions belong in their topic documents, not a feature changelog in the README.
- `docs/display.md`: channel presentation conventions, completion cards, `/metrics` behavior, information-command formatting and debug mode.
- `docs/index.md`: Codex protocol baseline, support matrix, official source and implementation mappings. Mention non-protocol capabilities such as CLI export briefly in the relevant implementation description; do not expand the support matrix for them.
- `docs/deepseek.md`, `docs/errors.md` and similar files: single-topic documentation limited to that topic.
- `src/**/README.md`: module responsibilities, file indexes and public interfaces; do not duplicate user-facing command or configuration documentation.
- `index.md`: the project-wide documentation index. Update it when adding or moving any `docs/` document or module README.
- If placement is unclear, prefer the most specific document and update `index.md`; do not put details in the root `README.md`.
- Update documentation only for changes to public behavior, interfaces, configuration, commands, deployment or file indexes. Do not expand feature lists or test descriptions for internal refactoring.
  When adding, deleting or moving files, update only the index responsible for that directory; avoid duplicating implementation details across documents.
- Routine documentation review excludes `.codex/skills/**` and `.agents/skills/**`. Handle skill directories separately only when the user explicitly requests skill installation, updates or review.
- Rules must stay consistent with source, interfaces, tests and documentation. Remove references to deleted implementations, old names, migration-stage descriptions, unimplemented capabilities and conflicting requirements.
  Review these aspects again after changing rules.

## Git and Delivery

- Preserve Git history. Do not delete or reinitialize the repository to avoid review.
- Do not overwrite, revert or mix in the user's existing uncommitted changes. Stop and explain if they cannot be safely avoided.
- Before committing, review relevant root README sections, affected directory READMEs and documentation indexes against the staged diff.
  Do not traverse unrelated modules or reread unchanged documents already read for the task.
- Staged documentation changes must follow the responsibilities above. Review only affected content, not unrelated topics again.
- Fix index gaps, orphaned links, old names and inconsistent behavior descriptions introduced or directly affected by this change.
  Record unrelated existing issues separately without automatically broadening cleanup. Report existing gate failures honestly and resolve them or obtain an appropriate disposition; never claim a failed check passed.
- Review staged scope and content before committing. The pre-commit `verify:commit` handles diff formatting, documentation indexes and full verification.
- Do not commit, push, rewrite history or perform other remote writes unless explicitly requested by the user.
- Use the PR categories “新增” (Added), “修复” (Fixed) and “改动” (Changed) as applicable. Empty categories may be omitted;
  at least one must describe a concrete change, and retained sections must not be empty or contain only placeholders.
  Formal Codex CLI upgrade PRs must also explain project benefits, adopted changes, excluded changes, risks and verification.
- When merging a PR, use its final title and body as the merge commit title and description, rather than an automatically generated commit list.
- On delivery, explain affected modules and behavior, verification performed, public interfaces or security boundaries involved and remaining risks.
- Do not repeat work rules in the delivery. Unless requested, present only results, evidence and limitations.

## Completion and Persistence

- Continue authorized development through implementation, necessary verification, relevant documentation and identified regressions within scope; do not stop automatically after the first implementation to seek confirmation.
  Decide routine implementation choices, test boundaries and reversible local fixes independently. Ask only when missing information materially affects the result,
  scope must expand or an action exceeds existing authorization. Do not reconfirm permissions or preferences already given.
- After repeated failures, reconsider evidence, hypotheses and methods rather than stopping at a fixed attempt count.
  Report concrete blocked dependencies while completing independent work. Do not claim full verification when required checks remain missing.
- Completion means the requested scope is implemented, applicable checks pass, related interfaces and documentation agree, and remaining limitations are stated.
  Do not expand indefinitely for optional improvements. Commits, pushes, releases and deployment are completion conditions only when explicitly requested.
- Read-only review is complete when it supplies issue locations, impacts, evidence and proposed adjustments. When the user requests confirmation before edits, deliver review findings first.
- When changing Skills, preserve project-specific constraints, trigger them by concrete tasks and load references as needed.
  Do not discard rules wholesale because of a model upgrade, or substitute fixed reading routines, repeated confirmations or per-file checks for judgment about results.
  Specialized workflows follow applicable project rules and current user authorization.
