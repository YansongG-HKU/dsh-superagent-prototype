# dsh-superagent

[![check](https://github.com/YansongG-HKU/dsh-superagent-windows/actions/workflows/ci.yml/badge.svg?branch=windows-port)](https://github.com/YansongG-HKU/dsh-superagent-windows/actions/workflows/ci.yml)

> **Windows port.** This fork runs the prototype on **Windows**, including inside the DeepSeek Harness **Desktop app**:
> host environment, `gh` identity isolation, git credential helper, PowerShell ticket preparation, Session presets,
> tests and an optional in-app deployment are adapted. It also ships **cluster mode** for watching **several
> repositories**: one isolated instance per repository from a declarative config (`tools/cluster.mjs`, see
> [WINDOWS.md](WINDOWS.md#multiple-repositories-cluster-mode)), managed from the Superagent panel's
> **Repositories (cluster)** page as well: list the instances, add a repository, start and stop them.
> Start at [WINDOWS.md](WINDOWS.md) for the Windows
> installation, the exact upstream changes and the known limitations; `tools/` contains the installer and
> configuration helpers. Everything below is the upstream documentation and still applies.
> 中文说明（安装、多仓库 cluster 模式与面板集群页、限制）：[WINDOWS.zh.md](WINDOWS.zh.md)。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
