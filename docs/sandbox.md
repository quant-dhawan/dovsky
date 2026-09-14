# Sandbox and host verification

Dovsky runs provider and evaluation commands in a private bubblewrap
(`bwrap`) environment. The launcher creates a private repository view, run
directory, temporary directory, and provider home; it mounts only the command's
required runtime files and explicitly allowed readonly paths. The network is
disabled when the resolved sandbox policy says so. A job's command is launched
inside a dedicated per-job systemd user scope, which supplies resource limits
and gives the daemon an authoritative cgroup identity for observation,
signalling, and cleanup.

The daemon fails closed. Startup probes bubblewrap and a disposable scoped
diagnostic before it listens or announces readiness. A job cannot proceed when
the sandbox is unavailable, the scope cannot be enrolled, limits are invalid,
or scope absence cannot be verified. Cleanup and extraction likewise retain the
private state while a scope is alive or unverifiable. These are application
invariants; a fixture that mocks the ports is not proof of kernel isolation.

The repository's ordinary CI is a fixture-oriented gate. It runs on Node 24
after `npm ci`, building, typechecking, and running the test suite. Tests whose
purpose is a native bubblewrap or systemd-user-scope probe may skip only when
the host lacks those facilities. The skip path is explicit and becomes a
failure when `DOVSKY_REQUIRE_SANDBOX=1` is set. CI therefore does not claim
that every runner is a production-ready sandbox host, and it performs no live
provider calls.

For a host gate, use a Linux machine where bubblewrap, user namespaces, and a
usable systemd user manager are available. Install dependencies and build first:

```sh
npm ci
npm run build
DOVSKY_REQUIRE_SANDBOX=1 npm test -w @dovsky/daemon
```

This is the mandatory native check for host readiness. The native tests use
disposable local repositories, homes, sockets, and scopes; they do not contact
providers. Record the host, command, exit status, and output tail for a release
candidate. That native evidence does not establish live-provider compatibility, public
publication, production migration, or cutover.
