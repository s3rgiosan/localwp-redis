# LocalWP Redis

A [LocalWP](https://localwp.com/) add-on that runs a per-site Redis container on demand.

## What it does

- Adds a **Redis** row to each site's "Utilities" panel with:
  - A master toggle to enable Redis for the site.
  - State, Host URI, Version selector, and optional **Cache** and **Object Cache** sub-toggles.
- Creates a dedicated Docker container for the site (`localwp-redis-<siteId>`) using the selected Redis version, as soon as Redis is enabled on a running site or on the next site start. The container is reused across site restarts.
- Publishes the container on a per-site `127.0.0.1` port persisted in site data. If that port is taken by another site or process, a new one is assigned and the `WP_REDIS_PORT` define is updated.
- Selects a native image when available, based on the Docker engine's architecture (`linux/arm64` on Apple Silicon, `linux/amd64` elsewhere).
- When Object Cache is toggled on, writes a marked block to `wp-config.php` compatible with the [Redis Object Cache](https://wordpress.org/plugins/redis-cache/) plugin:

  ```php
  // BEGIN Local Redis
  define( 'WP_REDIS_HOST', '127.0.0.1' );
  define( 'WP_REDIS_PORT', <port> );
  define( 'WP_REDIS_GRACEFUL', true );
  // END Local Redis
  ```

  `WP_REDIS_GRACEFUL` lets WordPress keep serving pages when Redis is stopped or still starting. Toggling off removes that block. When the Redis Object Cache drop-in (`wp-content/object-cache.php`) is installed, turning Object Cache or Redis off keeps `WP_REDIS_GRACEFUL` in the add-on's block so WordPress keeps serving pages without the cache.
- When Cache is toggled on, writes `define( 'WP_CACHE', true );` in a `// BEGIN Local Cache` … `// END Local Cache` block. Toggling off removes it.
- If `wp-config.php` already defines one of these constants outside the add-on's block, the add-on comments that line out with a `// Disabled by Local Redis:` or `// Disabled by Local Cache:` prefix and restores it when the toggle is turned off. While Object Cache is on, the same applies to `WP_REDIS_PASSWORD`, `WP_REDIS_SCHEME`, `WP_REDIS_PATH`, `WP_REDIS_SERVERS`, `WP_REDIS_CLUSTER`, `WP_REDIS_SHARDS` and `WP_REDIS_SENTINEL`, which would otherwise override the add-on's host and port. `WP_REDIS_CLIENT` is never touched. A define spread over several lines is left alone, and the toggle reports that it must be removed by hand. If the `// BEGIN` / `// END` markers of a block do not pair up, `wp-config.php` is left unchanged and the toggle reports that the markers must be fixed by hand.
- Stops the container on site stop or when the Redis toggle is turned off. If Docker is not reachable at that moment, the panel shows an error and the container stops on the next quit or startup cleanup. Turning Redis off also removes both blocks from `wp-config.php`. The container and its data volume (AOF-persisted) are preserved.
- Shows start failures, and containers that exit during startup, in the panel.
- Removes the container and its data volume when the site is deleted.
- Stops any still-running managed containers when LocalWP itself quits, giving up after 15 seconds if Docker does not respond. On the next launch, containers left running for stopped sites are stopped, and containers and volumes of deleted sites are removed.

## Requirements

- [LocalWP](https://localwp.com/) 9+
- **Docker running on your host machine.** Supported runtimes:
  - [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - [Colima](https://github.com/abiosoft/colima#docker)
  - [Rancher Desktop](https://rancherdesktop.io/)

  The add-on talks to your host's Docker daemon through the `docker` CLI. It does **not** run Docker inside LocalWP or use a container runtime bundled with LocalWP. The CLI is looked up in the Homebrew, Docker Desktop and Rancher Desktop install locations, then on `PATH`. If Docker isn't reachable, the panel shows the reason and the add-on does nothing.

  If you have more than one runtime installed, make sure the active context points at the one you want before starting sites (e.g. `docker context use colima`).
- Developed and tested on **macOS**. Linux/Windows paths and permission prompts are not covered here.

## First-run macOS permission prompt

The first time the add-on writes `WP_REDIS_*` to your site's `wp-config.php`, macOS shows a TCC dialog:

> "Local" would like to access data from other apps.

Click **Allow**. Without it, the constants can't be written. The prompt only appears once per macOS user.

## Installation

```bash
git clone https://github.com/s3rgiosan/localwp-redis.git localwp-redis
cd localwp-redis
npm install
npm run build
```

Symlink into LocalWP's add-on directory and restart LocalWP:

```bash
ln -s "$PWD" "$HOME/Library/Application Support/Local/addons/localwp-redis"
```

## Usage

1. Open a site and expand **Utilities**.
2. Flip the **Redis** toggle on. Supported versions: **6.2**, **7.2**, **7.4** (default).
3. If the site is running, the container is created and started right away. If not, the panel shows "Starts with the site".
4. Once the container is running, State flips from `Starting…` to `Running` and Host shows `redis://127.0.0.1:<port>`.
5. To wire up the Redis Object Cache plugin, flip the **Object Cache** sub-toggle. It writes `WP_REDIS_HOST`, `WP_REDIS_PORT` and `WP_REDIS_GRACEFUL` to `wp-config.php`. Add `define( 'WP_REDIS_CLIENT', 'predis' );` yourself, as described in [Client compatibility](#client-compatibility-predis-vs-phpredis). Toggle off to remove.
6. To set `WP_CACHE`, flip the **Cache** sub-toggle. Toggle off to remove.

Both sub-toggles can always be turned off, even when Redis or Docker is down. Errors from any action appear in the panel.

### Client compatibility (Predis vs. PhpRedis)

LocalWP's bundled PHP does **not** ship the `phpredis` C extension. This addon works out of the box only with plugins that can talk to Redis via the **Predis** pure-PHP client — for example [Redis Object Cache](https://wordpress.org/plugins/redis-cache/) by Till Krüss, with:

```php
define( 'WP_REDIS_CLIENT', 'predis' );
```

Plugins that require the `phpredis` extension — including **Object Cache Pro**, **Relay**, and Pantheon's **WP Redis** — will not connect until you install the extension into LocalWP's PHP. That means building `redis.so` against LocalWP's exact PHP build and loading it via the site's `php.ini.hbs` template. It's possible, but it's manual and has to be redone whenever LocalWP ships a new PHP version.

### Lifecycle

| Action | Effect |
|---|---|
| Redis toggle **on** (site running) | Creates or starts the container. |
| Redis toggle **on** (site stopped) | Stores the setting. The container starts with the site. |
| Redis toggle **off** | Stops the container (does not remove it) and removes the add-on's blocks from `wp-config.php`. If Docker is not reachable, the panel shows an error and the container stops on the next quit or startup cleanup. |
| Site **start** | Creates or starts the container if Redis is on. |
| Site **stop** | Stops the container if running. |
| Site **delete** | Removes the container and its data volume. |
| LocalWP **quit** | Stops any still-running managed containers. |

### Version changes

Pick a new version and restart the site.

- **Upgrade:** the existing data volume is reused.
- **Downgrade:** the data volume is deleted and Redis starts empty, because older Redis releases cannot read data files written by newer ones. The panel warns about this before you restart.

### Data persistence

Per-site data is stored in a Docker volume named `localwp-redis-<siteId>-data` with AOF enabled. It survives site restarts, toggle off/on, and container recreation on a version upgrade or port change. It is deleted on a version downgrade and when the site is deleted.

## Development

```bash
npm install
npm run watch   # tsc --watch, emits to lib/
```

## Uninstall

Remove the add-on from `~/Library/Application Support/Local/addons/`, then clean up leftover Docker resources:

```bash
docker ps -a --filter "label=com.localwp.addon=redis" --format "{{.Names}}" | xargs -r docker rm -f
docker volume ls --filter "name=localwp-redis-" --format "{{.Name}}" | xargs -r docker volume rm
```

Before uninstalling, turn Redis off for each site so the add-on removes its blocks from `wp-config.php` and restores any defines it disabled. Otherwise, remove the `// BEGIN Local Redis` … `// END Local Redis` and `// BEGIN Local Cache` … `// END Local Cache` blocks by hand, and remove the `// Disabled by Local Redis: ` and `// Disabled by Local Cache: ` prefixes from any disabled lines.

## Caveats

- LocalWP has no public API to gate a site's "ready" state on an external dependency. The site will show as running before Redis is reachable; we surface this in the addon UI as `Starting…`.

## License

MIT
