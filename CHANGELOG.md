# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-10-14

### Changed

- Each Redis setting has its own row in the site's Tools tab, with switches that re-sync with the saved state after every change. The panel reads status again as soon as the site starts or stops.
- Hints in the panel say when a change applies: on the next site start.

## [1.2.0] - 2026-10-14

### Added

- Write `WP_REDIS_GRACEFUL` with the Object Cache constants so WordPress keeps serving pages when Redis is stopped or still starting.
- The panel reports when Docker creates the Redis container but does not start it, and asks for a Docker restart. Images are pulled as a separate step, so starting a container times out after 60 seconds.
- Remove a site's Redis container and data volume when the site is deleted.
- Stop leftover containers of stopped sites, and remove containers and volumes of deleted sites, when Local starts.
- Show Docker errors, action errors, start failures and containers that exit during startup in the panel.
- Look up the `docker` CLI in the Docker Desktop and Rancher Desktop install locations.

### Changed

- While Object Cache is on, `WP_REDIS_PASSWORD`, `WP_REDIS_SCHEME`, `WP_REDIS_PATH`, `WP_REDIS_SERVERS`, `WP_REDIS_CLUSTER`, `WP_REDIS_SHARDS` and `WP_REDIS_SENTINEL` defines outside the add-on's block are commented out and restored when it is turned off.
- Enabling Redis on a running site creates and starts the container immediately. On a stopped site, the container starts with the site.
- Turning Redis off removes the add-on's `WP_REDIS_*` and `WP_CACHE` blocks from `wp-config.php`.
- Defines that already exist outside the add-on's blocks are commented out while a toggle is on and restored when it is turned off.
- Downgrading the Redis version deletes the data volume, and the panel warns about it.
- The Cache and Object Cache toggles can always be turned off.
- The panel uses Local's components and theme.

### Fixed

- Keep `WP_REDIS_GRACEFUL` in the add-on's block when Object Cache or Redis is turned off while the Redis Object Cache drop-in is installed, so WordPress keeps serving pages without the cache.
- Refuse to edit `wp-config.php` when the add-on's `BEGIN` and `END` markers do not pair up, and ask for the markers to be fixed by hand.
- Preserve bytes that are not valid UTF-8 when editing `wp-config.php`.
- Prevent `wp-config.php` corruption when an existing define's value contains parentheses.
- Write `wp-config.php` atomically and ignore commented-out defines.
- Serialize container operations per site, so a site stopped during startup no longer leaves Redis running.
- Add timeouts to Docker commands, so a hung Docker engine no longer blocks Local from quitting.
- Run Docker commands with an argument list and validate all values received from the panel.
- Reassign the port when it is taken by another site or process, including cloned sites.
- Keep the selected version across Local restarts.
- Stop reporting success when starting Redis or editing `wp-config.php` fails.
- Show the current site's state after switching sites in the panel.
- Report Docker daemon errors that contain "not found" accurately.
- Stop attaching the Redis container to unrelated Docker networks.
- Detect the image platform from the Docker engine, so an Intel build of Local on Apple Silicon pulls native images.

## [1.1.0] - 2026-04-22

### Added

- Support for [Colima](https://github.com/abiosoft/colima) as an alternative to Docker Desktop. The add-on resolves the `docker` binary from common Homebrew locations (`/opt/homebrew/bin/docker`, `/usr/local/bin/docker`) and from `PATH`. Props [@theskinnyghost](https://github.com/theskinnyghost).

### Fixed

- Log a specific error when the `docker` CLI cannot be found.

## [1.0.0] - 2026-04-13

### Added

- Per-site Redis container lifecycle tied to Local's `siteStarted` / `siteStopped` hooks.

[Unreleased]: https://github.com/s3rgiosan/localwp-redis/compare/1.2.1...HEAD
[1.2.1]: https://github.com/s3rgiosan/localwp-redis/compare/1.2.0...1.2.1
[1.2.0]: https://github.com/s3rgiosan/localwp-redis/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/s3rgiosan/localwp-redis/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/s3rgiosan/localwp-redis/releases/tag/1.0.0
