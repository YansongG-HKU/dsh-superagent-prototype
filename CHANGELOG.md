# Changelog

All notable changes to `dsh-superagent` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.3.2] — 2026-11-06

### Fixed

- **DSH 0.2.2 compatibility.** `SessionController.inspect()` was removed upstream; the transcript resource route now reads a passive event page through `sessionController.events({address, maxMessages})` and maps `records[].event`.

### Changed

- `peerDependencies`: dropped the removed `@deepseek-ai/dsh-client-ui-slots` package, moved `@deepseek-ai/cordis` to `~4.1.0`, `@deepseek-ai/schemastery` to `3.19.0` and every `@deepseek-ai/dsh-*` peer to `^0.2.2-rc.1`.
- `engines.dsh` is now `>=0.2.2-rc.1`.

### Verified

- `vitest`: 1188 passed, 2 known Windows-only environment-restore failures (they fail on the untouched baseline too).
