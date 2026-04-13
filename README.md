# LocalWP Redis

A [LocalWP](https://localwp.com/) add-on that runs a per-site Redis container on demand.

## What it does

- Adds a **Redis** row to each site's "Utilities" panel with:
  - A master toggle to enable Redis for the site.
  - State, Host URI, Version selector, and an optional **Object Cache** sub-toggle.
- On the **first site start** after enabling, creates a dedicated Docker container for the site (`localwp-redis-<siteId>`) using the selected Redis version. The container is reused across site restarts.
- Publishes the container on a stable per-site `localhost` port (persisted in site data).
- Automatically selects a native image when available (`linux/arm64` on Apple Silicon, `linux/amd64` elsewhere) and falls back gracefully.
- When Object Cache is toggled on, writes a marked block to `wp-config.php` compatible with the [Redis Object Cache](https://wordpress.org/plugins/redis-cache/) plugin:

  ```php
  // BEGIN Local Redis
  define( 'WP_REDIS_HOST', '127.0.0.1' );
  define( 'WP_REDIS_PORT', <port> );
  // END Local Redis
  ```

  Toggling off removes that block.
- Stops the container on site stop or when the Redis toggle is turned off. The container and its data volume (AOF-persisted) are preserved.
- Stops any still-running managed containers when LocalWP itself quits.

## Requirements

- [LocalWP](https://localwp.com/) 9+
- **Docker Desktop running on your host machine.** The add-on talks to your host's Docker daemon via the `docker` CLI — it does **not** spin up a Docker instance inside LocalWP. If Docker Desktop isn't running, the panel shows "Docker not running" and does nothing.
- Developed and tested on **macOS**.

## First-run macOS permission prompt

The first time the add-on writes `WP_REDIS_*` to your site's `wp-config.php`, macOS shows a TCC dialog:

> "Local" would like to access data from other apps.

Click **Allow**. Without it, the constants can't be written. The prompt only appears once per macOS user.

## Installation

```bash
git clone <repo> localwp-redis
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
3. If the site isn't running, the panel hints "Start site to create the container". If running, "Restart site to create the container". Start/restart to create the container on first enablement.
4. Once the container is running, State flips from `Starting…` to `Running` and Host shows `redis://127.0.0.1:<port>`.
5. To wire up the Redis Object Cache plugin, flip the **Object Cache** sub-toggle. It writes `WP_REDIS_HOST` and `WP_REDIS_PORT` to `wp-config.php`. Toggle off to remove.

### Client compatibility (Predis vs. PhpRedis)

LocalWP's bundled PHP does **not** ship the `phpredis` C extension. This addon works out of the box only with plugins that can talk to Redis via the **Predis** pure-PHP client — for example [Redis Object Cache](https://wordpress.org/plugins/redis-cache/) by Till Krüss, with:

```php
define( 'WP_REDIS_CLIENT', 'predis' );
```

Plugins that require the `phpredis` extension — including **Object Cache Pro**, **Relay**, and Pantheon's **WP Redis** — will not connect until you install the extension into LocalWP's PHP. That means building `redis.so` against LocalWP's exact PHP build and loading it via the site's `php.ini.hbs` template. It's possible, but it's manual and has to be redone whenever LocalWP ships a new PHP version.

### Lifecycle

| Action | Effect |
|---|---|
| Redis toggle **on** (container exists) | Starts the container. |
| Redis toggle **on** (container missing) | Stores the intent; container is created on next site start. |
| Redis toggle **off** | Stops the container (does not remove it). |
| Site **start** | Starts/creates the container if intent is on. |
| Site **stop** | Stops the container if running. |
| LocalWP **quit** | Stops any still-running managed containers. |

### Version changes

Pick a new version and restart the site. The existing data volume is reused (Redis RDB/AOF formats are forward-compatible across the supported majors).

### Data persistence

Per-site data is stored in a Docker volume named `localwp-redis-<siteId>-data` with AOF enabled. Survives site restarts, toggle off/on, and container recreation on version bump.

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

If desired, remove the `// BEGIN Local Redis` … `// END Local Redis` block from each site's `wp-config.php` by hand (or toggle Object Cache off before uninstalling).

## Caveats

- LocalWP has no public API to gate a site's "ready" state on an external dependency. The site will show as running before Redis is reachable; we surface this in the addon UI as `Starting…`.

## License

MIT
