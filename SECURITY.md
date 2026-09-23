# Security boundary

This is a new third-party implementation, not a cryptographic audit or a sandbox. Report reproducible issues privately to the repository owner before publishing sensitive details. Never attach real keys, credentials, plaintext private projects, or decrypted production artifacts to an issue.

## Trust model

Trusted: local OS/account, Node, Git, official age/minisign binaries, pinned public key, recipient configuration, config/state directories, DSH host and installed plugins. GitHub is a transport: it can delete, truncate, replace or replay data; it must not learn source content or choose a trusted signer. Git's locally configured credential helpers and URL rewrite rules are trusted host configuration.

The human-command-only interface reduces accidental agent invocation. It does **not** isolate keys from an LLM with unrestricted same-user Bash/filesystem access, from a malicious plugin, from a compromised endpoint, or from a model that can drive the human UI. For that boundary use an OS-isolated publisher/signing service. Signing confirms origin and integrity, not source-code safety. Applying never runs code; a later human build can run build scripts.

## Enforced invariants

- Source is read from committed Git blobs after a clean-worktree check; explicit path allowlist, no working-tree filters or hooks, no symlink/submodule/LFS export.
- Snapshot manifest and compressed payload have separate minisign signatures. The signed manifest binds their SHA-256, per-file hashes/modes, project, channel, logical repository, branch, timestamp and sequence.
- Entire signed envelope is encrypted with age. Native X25519 recipients only. No home-grown cryptography; Node only supplies hashes/compression/format handling.
- Verification keys are pinned in a private configuration directory outside source and target roots. No trust-on-first-use from relay content, no artifact-driven key rotation.
- Fetch is size-bounded and verifies before decompressing/materializing file contents. Native age decryption precedes signature verification; encrypted input is untrusted and byte-capped. Decompression and file counts are bounded.
- Portable paths reject traversal, absolute paths, control characters, Windows reserved devices/ADS, non-NFC spellings, case collisions, Git metadata and reserved internal paths. No archive extraction command is used.
- Accepted sequence/digest state is saved before staging. Same ciphertext can be fetched again; lower sequence or different ciphertext at an accepted sequence is refused. Local rollback does not lower this state.
- Publish confirms prepared ciphertext and pinned config; Apply/Rollback confirm a freshly reverified candidate and full filesystem inventory. Subprocesses use argv arrays, never a shell.
- Managed roots require ownership markers. Full directory switches retain backups and use a journal. Ambiguous recovery fails closed. No force push, no automatic deletion of old backups, no automatic execution.

## Limits requiring operator judgment

- A fresh target has no history. Set `minSequence` using an out-of-band current value. A malicious relay can freeze a client at an old but still valid version, especially within the configured age window. This is not a transparency log or consensus protocol.
- Restoring old local state, resetting counters, restoring an entire old device backup or compromising the local account can defeat anti-replay guarantees. Back up and restore state deliberately; use a new channel and re-pin the sequence when recovering a publisher whose state was lost.
- POSIX mode checks do not establish Windows ACL security or prevent same-UID races. Do not let another process modify config, stage, current, backups, or keys during an operation. Tokens catch changes between preview and confirmation, not a hostile concurrent filesystem actor.
- Locks are local to one configured state path. Use one publisher per project/channel. Different state paths/machines are not a distributed lock; concurrent Git pushes are rejected without force. Do not configure the same targetRoot under independent config files/state roots.
- Crash recovery handles tested rename boundaries and uses fsync on POSIX. Filesystem, power-loss and cross-platform durability semantics still vary. Windows open files may prevent a directory rename; stop builds before Apply/Rollback/Recover.
- Names, project/channel, sequence, timing, object size and number of publications remain visible in the Git relay. Filenames and source contents are inside age encryption. Git history retains old encrypted snapshots.
- Pattern-based secret rejection is incomplete. Do not include tokens/passwords in tracked source, even if encrypted. It is possible to encrypt a secret to the wrong recipient if the human config is wrong.
- Plaintext exists locally in private temporary files while signing/verifying and in staging/current/backups. Process death can leave temp directories; deletion is not secure erasure. Use full-disk encryption where needed.
- Password-protected signing keys work in an interactive trusted terminal. The Web plugin refuses to prompt for key passwords. Unencrypted signing keys permit Web Publish but increase exposure to same-user agents.
- Cancellation before workspace mutation is honored; once a directory transaction begins, it completes or leaves a recovery journal. A network timeout may have occurred after the server accepted a push: inspect/retry the same prepared ciphertext, do not blindly generate a replacement.

## Dependency and installation policy

No runtime npm dependencies, lifecycle scripts, bundled crypto executables, OAuth or provider configuration. Use trusted OS package sources for external binaries and verify plugin release hashes/commit before installation. A checksum shipped beside an unsigned plugin is corruption detection, not publisher authentication. This release does not claim signed plugin distribution.
