# Dovsky daemon

`dovskyd` is the only process that writes Dovsky state or owns provider
children. It stores transactional state in SQLite/WAL and accepts newline-delimited
JSON RPC on a mode-`0600` Unix socket.

Run the compiled entrypoint with `--config PATH`, `DOVSKY_CONFIG`, or the default
`~/.config/dovsky/config.json`. Runtime state defaults to `$DOVSKY_HOME`
(`~/.dovsky`): `run/dovsky.sock`, `state/dovsky.db`, and `artifacts/`.
`DOVSKY_SOCKET` supplies the omitted socket path; explicit config paths remain
relative to the config file's directory.

```json
{
  "maxActive": 3,
  "projects": [
    {
      "id": "project",
      "name": "Project",
      "path": "/srv/project",
      "workflows": [
        {
          "id": "review",
          "name": "Review",
          "readOnly": true,
          "providerTimeoutMs": 3600000,
          "gateTimeoutMs": 900000,
          "qualityCommands": [],
          "providers": {
            "claude": {
              "argv": ["claude", "-p", "--verbose", "--output-format", "stream-json"]
            },
            "codex": {
              "argv": ["codex", "exec", "--json", "--sandbox", "read-only", "-"]
            }
          }
        }
      ]
    }
  ]
}
```

Each provider attempt has a one-hour wall-clock deadline, and each verify, proof,
bench, or workflow quality command has a 15-minute deadline. Override them per
workflow with `providerTimeoutMs` and `gateTimeoutMs`; both must be integer
milliseconds from 1,000 through 86,400,000. A timed-out command is terminated and
recorded as the non-retryable `command_timeout` failure.

Provider prompts are written to stdin. Project paths, command arguments, gates,
and optional red-before proof settings come only from this local config and cannot
be overridden over RPC. A red-before block uses a temporary detached Git worktree;
`files` are config-approved proof files copied into that worktree, and `commands`
must fail there before the provider is allowed to run.

```json
{
  "redBefore": {
    "files": ["test/regression.test.ts"],
    "commands": [["npm", "test", "--", "test/regression.test.ts"]]
  }
}
```
