# tools

Helpers for running this Windows port. All paths and accounts are parameters; nothing here
contains credentials. See [../WINDOWS.md](../WINDOWS.md) for the full installation story.

| File | Purpose |
| --- | --- |
| `install.ps1` | Build `lib/` and append the `dsh-superagent` machine configuration (`stateDir`) to a DSH profile's `cordis.patch.yml`; prints the remaining install steps. |
| `setup-agent-gh.ps1` | Create the agent account's isolated `gh` configuration under `<stateDir>\gh-agent` (GH_CONFIG_DIR), restricted to the current Windows user. |
| `configure.mjs` | Idempotent settings setup through the management API: GitHub Source, Policy allow-list, PowerShell prepare command, Delivery requirements prompt. |
| `status.ps1` | Print setup, accounts, health, last day's flow and the tickets waiting for a person (exit codes 0/1/2/3). |
| `smoke-test.mjs` | Open an Issue that mentions the agent, then follow the ticket to a person stage or its end, printing pull requests. |
| `dev-profile.ps1` | Start/stop a dedicated-profile deployment (upstream's recommended layout) instead of the Desktop profile. |
