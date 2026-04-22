# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-22

### Added

- Support for [Colima](https://github.com/abiosoft/colima) as an alternative to Docker Desktop. The add-on now resolves the `docker` binary from common Homebrew locations (`/opt/homebrew/bin/docker`, `/usr/local/bin/docker`) in addition to `PATH`. Props [@theskinnyghost](https://github.com/theskinnyghost).

### Fixed

- Surface a clearer error when the `docker` CLI cannot be found, instead of a generic failure.

## [1.0.0] - Initial release

- Per-site Redis container lifecycle tied to Local's `siteStarted` / `siteStopped` hooks.
