# Command release adapters

Local `releaseAdapters` configuration selects trusted commands through `createCommandReleaseAdapter` in `apps/daemon/src/releases.ts`. RPC clients provide candidate and operation identities, never shell commands. Building or testing does not install an adapter or alter a live deployment.

Register an accepted source candidate with its frozen artifact, configuration, migration and evidence identities. An explicit authorization limits allowed actions and targets. A `verify` adapter must establish provenance for that same candidate before a mutating operation can run. Preflight checks the expected predecessor; readback determines whether the effect actually occurred.

Commands receive fixed argument templates for the source/artifact paths, commit and content identities, operation ID, expected predecessor and target. Review the exact executable, arguments, working directory and timeout before installation. A successful command exit alone does not establish human acceptance or remote publication.

A timeout can leave an operation uncertain. Retain its target reservation and reconcile against observable execution and target state; never infer absence or blindly retry from a missing receipt. See [task coordination](task-coordination.md) for the candidate, authorization and operation contracts.

This repository includes no publishing adapter. Host installation and database upgrades remain separate operator-approved actions, with backups and rollback prepared before cutover.
