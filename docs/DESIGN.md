# Protocol and implementation

## Components

`plugin.js` registers `/sp` in `ctx.commands`, the host's human command plane. `cli.js` invokes the same `engine.js`. There is no browser UI build, separate HTTP API or tool registration. The target can install the CLI alone.

`config.js` fixes identity, trust, recipients, source allowlist, logical GitHub repo/branch and dedicated target root. `artifact.js` reads Git blobs, creates/verifies signed snapshots and calls official crypto binaries. `relay.js` operates a disposable bare Git repository. `workspace.js` stages, reviews, applies and recovers directory transactions.

`setup.js` owns trusted-terminal bootstrap, peer and receiver-profile management. `workspace-init.js` owns workspace discovery, human preview/confirmation and slash-command argument parsing. `profiles.js` serializes configuration transactions and supplies reusable templates. No third-party npm dependency or web form framework is introduced.

## Workspace initialization in 0.2.0 (issue #1)

Device identity, peer trust, and project registration have separate lifetimes. Bootstrap creates or reuses a device identity without asking for a source/target project path. Optional `device` metadata contains `identities`, `peers`, role-specific `defaults`, and `retired` bindings. The existing v1 `projects` entries remain fully resolved, so a default change affects future registrations only. Per-project state still lives at `stateDir/<profile>`; adding metadata does not copy or renumber state.

Publisher workspace discovery uses only `invocation.agent.session.header.cwd`. It requires an absolute, existing directory, rejects symlink aliases, finds the real Git root and Git directory, and fingerprints the index plus current HEAD. A subdirectory session binds to its whole repository root with that scope shown explicitly. There is no host-process-cwd fallback and no chat-controlled source/relay/config path.

`/sp init` creates a proposal using terminal-established identity/peer/defaults. It suggests explicit safe prefixes from tracked source paths; a directory with unsafe tracked entries is omitted. Users may refine profile/project/channel/include/exclude or choose existing identities/peers, then request a new proposal. The preview lists selected and omitted files (up to 200 of each, with total counts). An empty selection or any selected unsafe tracked path is refused.

The private review record in `config.json.control` contains a 24-hex digest over the proposal, cwd/Git context, current configuration revision, and timestamp. The revision covers both raw config bytes and hashes of configured key files. Confirming rechecks the record, 15-minute expiry, workspace/index, revision, namespace/binding uniqueness and the full candidate schema. A per-config process lock prevents lost updates. Validated JSON is written by fsync + atomic rename against the final config filename; publication state is never copied. Concurrent workspace proposals based on a now-stale revision must be reviewed again.

`/sp status`, `/sp config`, and `/sp publish [token]` require a unique publisher profile matching that Git root. Explicit publisher names are also checked against the invoking workspace. The resolved profile hash is carried into the shared execution engine and rechecked under the project lock, preventing a concurrent reconfiguration from retargeting an already-resolved action. CLI explicit-profile commands and explicit receiver slash commands remain available.

Receiver add/clone uses trusted-terminal prompts, verifies nonoverlapping new target roots and distinct bindings/state namespaces, and saves a reviewed candidate. Clone copies configuration only; trust-floor input belongs to the new project and no highwater, staged, pending or source directory is copied. Remove retains all files and records the old name/binding as retired; it cannot be reused to reset counters.

CLI `init` now aliases device `bootstrap`. Original v1 configs remain readable; bootstrap can derive reusable device metadata from an existing profile without rewriting that profile. Once device metadata is saved, the older 0.1 parser will reject it. This is read compatibility with old files, not bidirectional binary compatibility. See README for upgrade/downgrade boundaries.

## Format v1

The relay contains only `packets/<project>/<channel>/<12-digit-sequence>.age` and `latest.age`. Immutable filenames do not make GitHub trustworthy: receivers verify all signed bindings. Relay commits have generic author/message metadata. The transport uses ordinary HTTPS Git credentials supplied by the host. It does not upload source commits or source repository history.

Age plaintext is UTF-8 JSON:

```json
{
  "format": "dsh-secure-publish/v1",
  "manifest": "BASE64 exact UTF-8 manifest bytes",
  "manifestSignature": "BASE64 minisign detached signature",
  "payload": "BASE64 gzip-compressed JSON array of BASE64 file contents",
  "payloadSignature": "BASE64 minisign detached signature"
}
```

The manifest contains `format`, `project`, `channel`, `repository` (lowercase owner/name), `branch`, `sequence`, `createdAt`, `sourceCommit`, `payloadSha256`, and `files`. Each file has `path`, `size`, `mode` (420 or 493, i.e. 0644 or 0755), `sha256`. File content array order equals manifest file order. Verification authenticates the original manifest bytes; it does not rely on JSON reserialization for signature verification. Strict portable-path, collision, hash, byte/count checks run before materialization.

Gzip + a bounded JSON container was chosen for this small-source MVP to avoid cross-platform tar traversal/links and an extra zstd dependency. It increases memory use and is capped at 32 MiB original source. It is not intended for large assets or build artifacts. A future format can introduce streaming without changing v1 interpretation.

Both signatures and all source metadata are inside age encryption, matching the sign-then-encrypt requirement. There is no outer public manifest. Authentication occurs after age decryption but before payload decompression; untrusted ciphertext/envelope lengths are capped.

## Publisher state

Preparing increments/reserves the local sequence before cryptographic work, captures one immutable source commit, signs and encrypts it, saves `pending.age` and a review record. No network upload happens during preparation. The review token binds the prepared metadata, including recipient list and ciphertext hash. The confirmation step checks the current config/public-key hash and the exact pending ciphertext before uploading. Failed pushes retain the pending pair for idempotent retries.

Each upload uses a fresh bare repository. It fetches the configured branch, retains its tree, writes the ciphertext through `hash-object`/`update-index`, creates a generic commit and uses a normal fast-forward push. Competing branch updates fail; an already existing immutable sequence must match byte-for-byte. The Git wrapper disables hooks/signing and file transport; the host's credential setup remains in use.

## Receiver state and transactions

Fetch checks signature, bindings, file integrity, trust floor, timestamp window and anti-replay state. The high-water sequence and ciphertext/envelope digests are persisted before staging; an identical fetch remains retryable if staging failed. Applying accepts only the currently staged highest verified snapshot. Rollback accepts only a signed, locally retained previous snapshot, without lowering the high-water state.

Every review re-verifies the stored envelope, checks every managed source file and fingerprints all current/candidate files, modes and directory entries. The confirmation digest also binds the operation, configuration and high-water mark. Extra build files in `current` are disclosed and remain in the backup. Modified managed source is refused. Candidate staging must contain no extra files.

The target root holds `root.json`, `staged/`, `current/`, backup directories and optionally `transaction.json`. A switch journals its candidate, original-presence flag and backup destination, renames current to a unique backup and candidate to current, saves the previous pointer, then removes the journal. Recovery recognizes a successfully installed candidate or restores the original directory. Backups are never automatically pruned in v1.

## Version and compatibility evidence

Authoring baseline inspected on 2026-09-23:

- DSH master tree: `46a7f68b0922371ce7144b668b90e377d8e799f4`.
- DSH old baseline: `dsh-v0.1.2-rc.1`, `CommandDefinition`/`CommandResult` from `packages/interaction/commands`.
- DSHA main tree: `2b4fa8912c8d87b68c2701704b7feed98d0bc95a`, standard prebuilt bundle import requirements.

The shared subset used is `name`, `description`, `input.hint`, `recordInput`, `handler({rawInput,signal,agent})` returning `{kind:'success'|'error',text}`. Both inspected command baselines expose `agent`. The workspace cwd property is also used by upstream [`sessionCwd`](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/fs/tool-fs/src/session-cwd.ts). No newer attachment fields, Cordis constructors, browser-only packages or native Node addons are needed. These are source-contract checks and handler integration tests, not a claim of launching DSH or DSHA on a physical device.
