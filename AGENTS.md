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

| Phase | State                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P0    | Baselines inspected and integrated; regression ownership recorded                                                                          |
| P1    | In progress: package/config/error/schema/URI names changed; private CLI and bridge source separation; role and plugin declaration resolver |
| P2    | In progress: native SQLite conformance, explicit-context server bootstrap, neutral blob storage boundary                                   |
| P3    | In progress: selected Void/Drizzle/native SQLite adapters, separate ORM versions, CLI tooling and Nuxt host dispatch                       |
| P4–P8 | Pending; shared Query/Form groundwork exists, full acceptance remains                                                                      |

Configuration tests cover empty input, plugin order, collisions, missing references, opaque schemas, and whole-provider replacement.
The CLI help/version entry is lazy and does not evaluate project configuration. Generation delegates to the selected database tooling; init, plugin management and upgrade remain.
The build produces the private CLI and Vue/Nuxt bridges inside the public package. Packed dependency independence remains to be verified.

The new physical namespace is `liti_*`, the asset URI is `liti://asset/<id>`, configuration is `liti.config.ts`, and errors use `LITI_*`.
There is no reader for the former asset URI or automatic adoption of existing database histories.
No existing application data has been converted or modified. Any required carryover must be performed outside the SDK against an isolated target; unknown historical dates must not be inferred.

## Verification and outstanding work

Before implementation, the local baseline ran 424 passing tests, one skipped test and four failures.
Three failures were loopback `EACCES` under the sandbox; one CLI test timed out.
Baseline CI independently reported a Nuxt generated-server-type failure (`useServerFiles` and server hook augmentation).
These results are historical evidence, not acceptance of the new contracts.

The core, Vue/Nuxt bridge and SQLite/Void packages build together with declarations.
Native Bun SQLite runs the same 31 domain conformance cases as the existing storage implementations.
The Node storage/schema suites verify rollback before commit and read snapshots while another connection holds a writer lock.
The explicit server bootstrap shares authorization and write-only receipts between HTTP and trusted operation contexts.
Files SDK identity and Workers' known-length streaming belong to the Void storage adapter.
Streaming SHA-256 uses the shared incremental implementation; it does not buffer an entire file.
Public Query and Form changes have targeted runtime, type and SSR coverage; the full packed-consumer matrix is still outstanding.

The root configuration still exposes the old AI configuration contract; it must move into the AI plugin.
Void owns its native Nuxt auth/Files integration; Nuxt setup and builds do not install missing dependencies.
The independent Drizzle profile owns ORM/Kit 1.0.0-rc.4 while Void keeps its own 0.45.4 ORM. No global Drizzle override is used.
The shared D1 conformance suite passes 33 cases for this profile; Bun native schema/storage checks pass 31 cases.
Nuxt production build and local Worker HTTP checks, Files configuration (14 cases), and live HMR/config reload/server types pass.
The broad unit run passed 483 cases with three source-alias type-fixture failures; those fixtures were corrected and passed separately.
Complete CLI commands, blog/AI plugins, application migration, dependency isolation and final consumer checks remain required.
The current extraction is implementation groundwork, not completion of P1 or P2.

The transferred repository initially lacked pkg-pr-new GitHub App access. The user has enabled it; publication must be rerun and its returned artifact URLs verified.
Stable publication must retain the existing uppt release PR/tag/pack/publish workflow. No release tag or npm publish has been requested or performed.
