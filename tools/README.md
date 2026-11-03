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
| `cluster.mjs` | **Multiple repositories:** one independent instance per repository from a declarative JSON config — `init`, `add` (`--provision` brings a repository all the way up), `setup`, `start`, `stop`, `status`, `configure`, `provision`, `upgrade`, `doctor`, `logs`. The panel's **Repositories (cluster)** page reads the same config and runs this tool. |
| `profile-template.yml` | Profile patch template the cluster tool renders for every instance (port, state dir, model route). |

## Multiple repositories (cluster mode)

The prototype serves one repository per instance, so several repositories are several isolated
instances: one DSH profile, process, port, state directory, `gh` configuration and panel each.
`cluster.mjs` keeps that fleet in one file (`~/.dsh/superagent-cluster.json`).

```powershell
# one time: describe the machine and the shared agent account
node tools/cluster.mjs init --bundle <this checkout> --dsh-bin <dsh/lib/bin.js> --node <node.exe> `
  --pnpm <pnpm.mjs> --agent-login <agent> --operator-login <you> --agent-cli <gh.exe> `
  --state-root <dir> --clone-root <dir> [--external desktop=http://127.0.0.1:54746]

# per repository
node tools/cluster.mjs add --repo owner/name --provision # allocates name/profile/port/state/clone and brings it up
node tools/cluster.mjs setup                           # profiles, patches, bundle, gh config, clones
node tools/cluster.mjs start                           # detached DSH processes, prints panel URLs
node tools/cluster.mjs configure                       # Source/Policy/Executor/Prompts per instance
node tools/cluster.mjs status                          # setup, health, executor load per instance
```

`--name <instance>` limits setup/start/stop/configure to one instance; `upgrade` rebuilds the
bundle once and restarts the running instances; `doctor` checks paths, identity, push access and
free ports. A hosted DSH Desktop instance can be listed as `--external` so `status` covers it too.

