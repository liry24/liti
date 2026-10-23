All releases must use uppt through the existing `.github/workflows/release.yml`, including its release PR, tag creation, packing, and publishing actions.

Develop liti on main. Do not release v0.1.0 yet; validate commit-specific packages through pkg.pr.new.
Implement the new liti contracts without compatibility aliases, old configuration discovery, legacy URI readers, or dual writes.
Keep README examples focused on liti, with minimal prose and primarily code snippets. Do not describe other packages there.

Do not create a docs/ directory. Keep engineering guidance in AGENTS.md or skills; user documentation will be a separate web docs project.

# liti implementation record

The 2026-10-20 integrated implementation plan is the acceptance contract. Work continues on `main`.
v0.1.0 publication and production deployment are deferred. Package verification uses commit-specific pkg.pr.new artifacts.
Intermediate commits need not pass CI; the completed integration must pass the consumer matrix.

## Baseline

| Source           | Commit                                     | Status                                             |
| ---------------- | ------------------------------------------ | -------------------------------------------------- |
| Original main    | `0af14f428606dd9b6f512b89be1e6033f47ba1ae` | Integration base                                   |
| PR #39           | `ae6ad1c83cfab71d2d192696a217b1bdee7e9a3b` | Ancestor of the existing consumer SDK              |
| Consumer SDK     | `e9edfccd00df546b9c236686c98536e36f103a15` | Includes activity snapshots and dependency cleanup |
| liry24.com dev   | `95913dfee88e973a4df1c07e1ebebf75a5e0e139` | Unmodified application baseline                    |
| Main integration | `bce049c`                                  | PR #40, identical tree to the consumer SDK         |

The old and transferred GitHub URLs resolve to repository ID `1359246723`. The working remote is `liry24/liti`.
The separate checkout at `E:/git/liti` has unrelated uncommitted application changes and is not used.

## Retained behavior and destination

| Behavior                                                                               | Regression evidence                                                      | Destination                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| Shared HTTP/service authorization, redaction, version checks, write-only receipts      | `admin-server.test.ts`                                                   | Core operations                        |
| Atomic revisions, publication/schedule pointers, routes, references, search and assets | `adapter.test.ts`, `model-features.test.ts`                              | Core contract and adapter conformance  |
| Sparse translation snapshots, fallback and current-rule restore validation             | `translation-snapshots.test.ts`, `translation-validation.test.ts`        | Core                                   |
| Generation-consistent public projection, bounded page parsing and summary scope        | `public-seo.test.ts`, `nuxt-public-batch.test.ts`                        | Core and framework cache bridge        |
| Commit receipts survive refresh/hook failures; draft and identity race protection      | `model.test.ts`, `form-hooks.test.ts`, `nuxt-management-runtime.test.ts` | Shared Vue resource/form               |
| Nested asset uploads retain row identity and streaming/lease constraints               | `form-controller.test.ts`, `native-stream.mjs`                           | Vue form, core ledger, storage adapter |
| Activity snapshots only after commit; schema declaration order                         | `lifecycle-events.test.ts`, `form.test.ts`                               | Core lifecycle and Vue form            |
| AI input/output validation, cancellation, no inference during import                   | `ai-actions.test.ts`, `ai-client.test.ts`                                | AI plugin and core action boundary     |
| Actor-scoped descriptors and localized public SEO                                      | `presentation.test.ts`, `public-seo.test.ts`                             | Core and framework bridge              |

Application-specific game validation, IGDB import, composer/handoff and UI remain in liry24.com.
Generic proofreading, article dates and slug preparation move to the feature packages. Existing authentication and Worker WASM patches must be verified individually.

## Progress

| Phase | State                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Baselines integrated and regression ownership recorded                                                                                             |
| P1    | Six public packages and three bundled private workspaces; new config, plugin, adapter and generated type contracts implemented                     |
| P2    | Explicit-context service, canonical SQLite storage, publication history and neutral streaming storage implemented and covered by conformance tests |
| P3    | Independent Drizzle 1.0.0-rc.4 and Void 0.45.4 isolation verified; packed pnpm Void Worker integration passed                                      |
| P4    | init, plugin add/remove, generate and upgrade implemented, including dry-run and partial-failure reporting                                         |
| P5    | Query/Models/Form migration implemented; isolated Vue 3.5/3.6 SSR hydration and packed Nuxt public queries verified                                |
| P6    | Optional AI/blog packages, publication preparation, article dates and native-form proofreading implemented                                         |
| P7    | liry24.com migration in application PR #54; 147 ordinary tests and built Worker/browser suites passed against commit-specific previews             |
| P8    | Packed npm/pnpm/Bun matrix, Windows/Ubuntu Nuxt and Cloudflare CI passed; first-release artifact verification is prepared                          |

Configuration tests cover empty input, plugin order, collisions, missing references, opaque schemas, and whole-provider replacement.
The CLI help/version entry is lazy and does not evaluate project configuration. Generation delegates to the selected database tooling and never applies migrations.
Nuxt owns client type generation in its build directory during prepare/dev/build. The CLI does not emit a root `liti.generated.ts` when a standard Nuxt config exists; standalone CLI consumers retain their generated registry file.
The build includes private CLI and Vue/Nuxt bridges and their declarations in liti; Vue and Nuxt remain host-owned optional peers.
Packed core, blog-only, AI-only, SQLite and Vue consumers install normally without forced peer resolution or a workspace source alias.
Third-party code bundled in each public artifact has a generated `THIRD_PARTY_LICENSES.txt`; every public tarball includes the project license.

The new physical namespace is `liti_*`, the asset URI is `liti://asset/<id>`, configuration is `liti.config.ts`, and errors use `LITI_*`.
There is no reader for the former asset URI or automatic adoption of existing database histories.
No existing application data has been converted or modified. Any required carryover must be performed outside the SDK against an isolated target; unknown historical dates must not be inferred.

## Verification and outstanding work

Before implementation, the local baseline ran 424 passing tests, one skipped test and four failures.
Three failures were loopback `EACCES` under the sandbox; one CLI test timed out.
Baseline CI independently reported a Nuxt generated-server-type failure (`useServerFiles` and server hook augmentation).
These results are historical evidence, not acceptance of the new contracts.

The core, Vue/Nuxt bridge and SQLite/Void packages build together with declarations.
Native Bun SQLite runs the same 33 domain conformance cases as the existing storage implementations.
The Node storage/schema suites verify rollback before commit and read snapshots while another connection holds a writer lock.
The explicit server bootstrap shares authorization and write-only receipts between HTTP and trusted operation contexts.
Files SDK identity and Workers' known-length streaming belong to the Void storage adapter.
Streaming SHA-256 uses the shared incremental implementation; it does not buffer an entire file.
Public Query and Form changes have runtime, type and SSR coverage; the full packed-consumer matrix passed in PR #41.

AI is declared through `@litijs/ai` plugins and named actions; the former root AI configuration is rejected.
Text, native decision and native extraction have separate provider contracts. Nuxt production and local Worker HTTP checks pass after this extraction, with mocked providers and no real inference.
First publication history is entry-wide: a revision publishes the original and its translations atomically.
`firstPublishedAt` is written only by the first successful publication commit and survives unpublish, restore and later translations.
`updatedAt` tracks content saves; the public projection uses the published revision's creation time, so draft edits do not expose an unpublished update date.
Void owns its native Nuxt auth/Files integration; Nuxt setup and builds do not install missing dependencies.
The independent Drizzle profile owns ORM/Kit 1.0.0-rc.4 while Void keeps its own 0.45.4 ORM. No global Drizzle override is used.
The shared D1 conformance suite passes 33 cases for this profile; Bun native schema/storage checks pass 33 cases.
Nuxt production build and local Worker HTTP checks, Files configuration (14 cases), and live HMR/config reload/server types pass.
The final Linux CI unit run passed 536 tests. Source type checking, lint, workspace checks and both unused-code checks passed.
Blog now contributes manual/automatic article models, publication preparation, shared dates/SEO and proofreading through the common form controller.
Publication transforms run only for new draft candidates; existing revisions and publishDue only validate. Save preparation receives the real entry ID, actor, locale, previous entry, field issues and authorized read services.
The runtime retains up to 32 successful publication action results keyed by actor, model, entry/version, operation, locale and input. Repeated commits reuse action results while preparation and route availability checks run again.
This is bounded in-process retry protection, not durable exactly-once inference across Worker instances or restarts.
Automatic blog slugs treat AI as optional: provider failures, invalid output and AI timeouts fall back to an ASCII kebab-case title, or a six-character lowercase alphanumeric Nano ID when empty. Published and historical routes are checked through `PreparationRead.published.routeAvailable`; occupied generated slugs receive a six-character suffix. Drafts and scheduled-only entries do not reserve URLs. Manual and established slugs remain unchanged, and parent cancellation, authorization and commit conflicts still fail normally.
Scheduled Nuxt jobs use the trusted `liti:task:publishDue` system actor for preparation reads; request-triggered jobs retain the authenticated actor.
Blog Vue extensions expose stable review/proofread/apply/discard operations, use the native form, preserve unrelated edits and guard publish/schedule.
Form success callbacks receive `hasUnsavedChanges` after reconciling the save and any edits made in flight. It shares `draft.isDirty`'s same-group, cross-locale check; it is a boolean snapshot at callback invocation. Consumers can await and destructure forms and model-specific extension namespaces in one expression without capturing their own return value in the callback.
Blog/AI-only consumers import without Vue, Nuxt or the AI SDK installed. No production AI requests have run.
Packed standalone Vue checks cover native Field/Subscribe, reset, array operations, redisplay, stable handles and reuse of the server-rendered DOM.
Packed Nuxt checks cover public error status/code, SSR deduplication, hydration, cancellation, timeouts and reactive query races.
Nuxt 4.6.2 has 592 native strict declaration diagnostics and Drizzle 1.0.0-rc.4 has 44 in the tested dependency graph.
The fixtures run with `skipLibCheck: false` and compare against the same native dependencies without liti, requiring no added SDK diagnostics. This does not mean upstream declarations pass strict checking.
Packed Void generation exposes the schema to its native CommonJS Drizzle loader; the fixture verifies SQL exists and boots the resulting Worker.
Many-query handles retain the server's total independently of transformed items. The imperative client also exposes paginated DTOs through `queryPage`.
Model `unique` tuples constrain non-null, non-translated scalar values among current entries in the atomic commit. This replaces app triggers against private content tables without weakening concurrent-save protection.
The first implementation scans current revisions; add a dedicated keyed index only when write profiling warrants it.
Application Node development/browser acceptance is tracked in [application PR #54](https://github.com/liry24/liry24.com/pull/54), using synthetic D1/R2 and mocked AI. The app remains on its local dev checkout; only the feature branch is pushed, because remote dev automatically deploys. Its fresh baseline must not be applied to existing development or production data without a separately reviewed transition.

The transferred repository's pkg-pr-new GitHub App is enabled. All six returned commit-specific archives were downloaded and their dependency/peer versions verified; preview publication uses `--peerDeps` with `--previewVersion`. The application pins the verified preview and uses preview-only liti/SQLite overrides while those names remain unpublished. CI consumer fixtures use the pinned native package managers, and Vite's compatible esbuild peer, without forced peer resolution.
Stable publication must retain the existing uppt release PR/tag/pack/publish workflow. No release tag or npm publish has been requested or performed.

The 2026-10-23 dependency refresh targets Bun 1.4.4, Better Auth/auth/Drizzle adapter 1.7.12, Void 1.2.1 and the independent Drizzle ORM/Kit 1.0.0-rc.5 pair. Void retains its own Drizzle 0.45.4 profile. Keep the Nuxt auth module at 0.3.11: 0.3.12's Nitro 2 shim reads the mocked Node request as an async iterable, which fails in Workers with `Readable.asyncIterator is not implemented yet!`. Remove the taze exclusion and recheck native D1 signup/session handling when upstream fixes it. Earlier version-specific diagnostics above are historical results. Comark 0.8.1 preserves component tag casing; liti registers its current parser with comark-content because that dependency still uses Comark 0.7 internally. Keep parser plugins on the same current instance instead of coercing their types or globally overriding transitive dependencies. The application's normal `liti generate` command runs through the Node CLI shebang and produces the existing auth schema unchanged; no database migration is required. Do not compare its output with explicitly executing the CLI through Bun, which serializes date defaults differently.

Nuxt generates separate shared-client and form entry points. Public queries and model descriptors use the shared client; only form consumers register Vue form extensions. Keep public auto-imports, form types and await/destructure behavior unchanged when editing these templates. Packed public-only consumers assert that form and extension code is absent from their browser output.
Model descriptors reuse successful initial results only within one SSR request and matching authorization/language scope. Refreshes and retries after errors still fetch, and browser consumers retain Nuxt's native cache disposal when their final component unmounts. Do not replace this with a process-wide cache.
Public Nuxt payload keys use the configured origin, or `same-origin` when omitted, because Nitro's cached SSR strips the Host header. HTTP requests still use the actual request origin. Keep explicit-origin and authorization separation, refreshes and mutation invalidation intact when changing these keys.
Automatic public-query authorization scope uses the SSR payload snapshot until Nuxt finishes hydration, then follows the current user, role and session. Explicit public scopes and management/form/action authorization must still switch immediately.
D1 adapters rely on native atomic batches and SQL commit guards. Never serialize their operations through a shared JavaScript promise queue: a canceled Worker request can leave that queue unresolved and block later requests. The native Worker fixture verifies subsequent reads and batches after Workerd cancels a stalled request, for both SQLite D1 and Void.

## Deferred first release

The first stable target is `0.1.0` for every public workspace. Keep the current development versions until uppt opens the lockstep release PR; the breaking-change commit makes its pre-1.0 bump `0.1.0`. Review the generated PR's versions and first-party ranges (`^0.1.0`), then regenerate the lockfile before merging. CLI version output reads the installed manifest.

The publishable set is `packages/*` excluding manifests with `private: true`, used by uppt and the artifact fixtures. Private CLI/Vue/Nuxt workspaces stay bundled inside liti. Pack runs only after the tagged commit's required CI succeeds. The exact archives are checked, hashed into `release-manifest.json`, and installed by the consumer matrix before being passed to uppt/publish.

Before authorizing a stable release, verify npm ownership/team access for all six names, public access, provenance, and each trusted-publisher binding to `liry24/liti`, `release.yml`, environment `npm`. GitHub repository transfer does not establish npm permissions. No credentials belong in repository files. The workflow uses Node 24 and uppt's npm setup.

Approve staged packages in dependency order: liti, sqlite, then drizzle/void/ai, then blog. Prerelease identifiers use the matching dist-tag; a numeric identifier uses `next`. If publication partially succeeds, rerun only the failed publish job while the original artifacts remain available. Its registry check skips already published versions only when their integrity matches the verified archive; mismatches and registry errors stop the run. Pending npm stages must be resolved before retrying. Never overwrite a published version or rebuild a replacement archive during that retry. See the pinned [uppt publish implementation](https://github.com/danielroe/uppt/blob/6ec27140623aa835e362f866d8ab0018ab057f4d/scripts/publish.ts).
