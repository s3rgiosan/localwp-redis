import * as LocalMain from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	checkDockerAvailable,
	compareVersions,
	errorText,
	hostUriFor,
	inspectContainer,
	isRedisReady,
	stopContainer,
} from './docker';
import { registerHooks } from './hooks';
import {
	SITE_ID_PATTERN,
	cancelShutdown,
	clearLastError,
	getLastError,
	getSiteStatus,
	isSiteRunning,
	startRedisLocked,
	stopAllManagedContainers,
	sweepContainers,
	watchReadiness,
} from './lifecycle';
import { ensurePort } from './ports';
import { runExclusive } from './queue';
import { getState } from './state';
import {
	getCacheConstant,
	getRedisConstants,
	removeCacheConstant,
	removeRedisConstants,
	setCacheConstant,
	setRedisConstants,
	type RedisConstants,
	type WpConfigResult,
} from './wpconfig';
import {
	DEFAULT_VERSION,
	getDataVersion,
	getVersion,
	isEnabled,
	isSupportedVersion,
	setEnabled,
	setVersion,
	siteData,
	SUPPORTED_VERSIONS,
} from './storage';

type Result = { ok: boolean; error?: string };

type Status = {
	dockerAvailable: boolean;
	dockerError: string | null;
	containerRunning: boolean;
	containerExists: boolean;
	ready: boolean;
	version: string;
	deployedVersion: string | null;
	versionDowngrade: boolean;
	hostUri: string | null;
	hostPort: number | null;
	supportedVersions: readonly string[];
	defaultVersion: string;
	objectCacheCurrent: RedisConstants | null;
	cacheCurrent: boolean | null;
	siteStatus: string | null;
	lastError: string | null;
};

const QUIT_CLEANUP_TIMEOUT_MS = 15_000;

const CHANNELS = [
	'redis:isEnabled',
	'redis:setEnabled',
	'redis:setObjectCacheEnabled',
	'redis:setCacheEnabled',
	'redis:status',
	'redis:setVersion',
] as const;

export default function (context: LocalMain.AddonMainContext): void {
	const { electron } = context;
	const { app, ipcMain } = electron;

	registerHooks();
	void sweepContainers();

	const state = getState();
	if (state.quitListener) {
		app.removeListener('before-quit', state.quitListener);
	}
	state.quitListener = createQuitListener(app);
	app.on('before-quit', state.quitListener);

	for (const channel of CHANNELS) {
		ipcMain.removeHandler(channel);
	}

	ipcMain.handle('redis:isEnabled', (_e: unknown, siteId: unknown) => {
		const site = resolveSite(siteId);
		return site ? isEnabled(site.id) : false;
	});

	ipcMain.handle('redis:setEnabled', (_e: unknown, siteId: unknown, enabled: unknown) =>
		handleSetEnabled(siteId, enabled)
	);

	ipcMain.handle('redis:setObjectCacheEnabled', (_e: unknown, siteId: unknown, enabled: unknown) =>
		handleSetObjectCacheEnabled(siteId, enabled)
	);

	ipcMain.handle('redis:setCacheEnabled', (_e: unknown, siteId: unknown, enabled: unknown) =>
		handleSetCacheEnabled(siteId, enabled)
	);

	ipcMain.handle('redis:status', (_e: unknown, siteId: unknown) => buildStatus(siteId));

	ipcMain.handle('redis:setVersion', (_e: unknown, siteId: unknown, version: unknown) =>
		handleSetVersion(siteId, version)
	);
}

/**
 * Stops the add-on's containers before Local quits, giving up after a fixed
 * time so a hung Docker engine cannot block the quit. Each quit attempt that
 * reaches this listener without having been released runs the cleanup again,
 * so a quit cancelled elsewhere is cleaned up on the next try.
 */
function createQuitListener(app: Electron.App): (event: Electron.Event) => void {
	let cleaning = false;
	let released = false;

	return (event: Electron.Event) => {
		if (released) {
			released = false;
			return;
		}

		event.preventDefault();
		if (cleaning) return;
		cleaning = true;

		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				console.warn('[redis] shutdown cleanup timed out');
				resolve();
			}, QUIT_CLEANUP_TIMEOUT_MS);
		});
		const cleanup = stopAllManagedContainers().catch((err) => {
			console.error('[redis] shutdown stop failed:', err);
		});

		Promise.race([cleanup, timeout]).finally(() => {
			clearTimeout(timer);
			cleaning = false;
			released = true;
			app.quit();
		});
	};
}

function resolveSite(siteId: unknown): Local.Site | null {
	if (typeof siteId !== 'string' || !SITE_ID_PATTERN.test(siteId)) return null;
	try {
		return siteData().getSite(siteId);
	} catch {
		return null;
	}
}

function toResult(result: WpConfigResult): Result {
	return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function failure(err: unknown): Result {
	return { ok: false, error: errorText(err) || 'Unknown error.' };
}

async function handleSetEnabled(siteId: unknown, enabled: unknown): Promise<Result> {
	const site = resolveSite(siteId);
	if (!site) return { ok: false, error: 'Unknown site.' };
	if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid value.' };

	// The panel is in use, so any earlier quit was cancelled.
	cancelShutdown();
	let started = false;
	let result: Result;
	try {
		result = await runExclusive(site.id, async (): Promise<Result> => {
			const previous = isEnabled(site.id);
			setEnabled(site.id, enabled);
			if (!enabled) return disableRedis(site, previous);

			try {
				if (isSiteRunning(site)) {
					started = await startRedisLocked(site);
				}
				return { ok: true };
			} catch (err) {
				setEnabled(site.id, previous);
				console.error('[redis] setEnabled handler failed:', err);
				return failure(err);
			}
		});
	} catch (err) {
		console.error('[redis] setEnabled handler failed:', err);
		return failure(err);
	}

	if (started) {
		void watchReadiness(site.id);
	}
	return result;
}

/**
 * Stops the container when Docker is reachable, then strips the add-on's
 * blocks from wp-config.php so WordPress stops pointing at a stopped Redis.
 * The enabled flag is already off; it goes back to `previous` only when the
 * container could not be stopped.
 */
async function disableRedis(site: Local.Site, previous: boolean): Promise<Result> {
	clearLastError(site.id);

	const docker = await checkDockerAvailable();
	if (docker.available) {
		try {
			const info = await inspectContainer(site.id);
			if (info?.running) await stopContainer(site.id);
		} catch (err) {
			setEnabled(site.id, previous);
			console.error('[redis] stopping the container failed:', err);
			return failure(err);
		}
	}

	const redis = await removeRedisConstants(site);
	if (!redis.ok) return { ok: false, error: redis.error };

	const cache = await removeCacheConstant(site);
	if (!cache.ok) return { ok: false, error: cache.error };

	if (!docker.available) {
		return {
			ok: false,
			error: `Redis is turned off and wp-config.php was updated, but the container could not be stopped because Docker is not reachable. ${docker.error ?? ''}`.trim(),
		};
	}
	return { ok: true };
}

async function handleSetObjectCacheEnabled(siteId: unknown, enabled: unknown): Promise<Result> {
	const site = resolveSite(siteId);
	if (!site) return { ok: false, error: 'Unknown site.' };
	if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid value.' };

	try {
		return await runExclusive(site.id, async (): Promise<Result> => {
			if (!enabled) {
				return toResult(await removeRedisConstants(site));
			}
			if (!isEnabled(site.id)) {
				return { ok: false, error: 'Enable Redis for this site first.' };
			}
			const port = await ensurePort(site.id);
			return toResult(await setRedisConstants(site, '127.0.0.1', port));
		});
	} catch (err) {
		console.error('[redis] setObjectCacheEnabled handler failed:', err);
		return failure(err);
	}
}

async function handleSetCacheEnabled(siteId: unknown, enabled: unknown): Promise<Result> {
	const site = resolveSite(siteId);
	if (!site) return { ok: false, error: 'Unknown site.' };
	if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid value.' };

	try {
		return await runExclusive(site.id, async (): Promise<Result> => {
			const result = enabled ? await setCacheConstant(site) : await removeCacheConstant(site);
			return toResult(result);
		});
	} catch (err) {
		console.error('[redis] setCacheEnabled handler failed:', err);
		return failure(err);
	}
}

async function handleSetVersion(siteId: unknown, version: unknown): Promise<Result> {
	const site = resolveSite(siteId);
	if (!site) return { ok: false, error: 'Unknown site.' };
	if (!isSupportedVersion(version)) return { ok: false, error: 'Unsupported Redis version.' };

	try {
		await runExclusive(site.id, async () => setVersion(site.id, version));
		return { ok: true };
	} catch (err) {
		console.error('[redis] setVersion handler failed:', err);
		return failure(err);
	}
}

function emptyStatus(): Status {
	return {
		dockerAvailable: false,
		dockerError: null,
		containerRunning: false,
		containerExists: false,
		ready: false,
		version: DEFAULT_VERSION,
		deployedVersion: null,
		versionDowngrade: false,
		hostUri: null,
		hostPort: null,
		supportedVersions: SUPPORTED_VERSIONS,
		defaultVersion: DEFAULT_VERSION,
		objectCacheCurrent: null,
		cacheCurrent: null,
		siteStatus: null,
		lastError: null,
	};
}

async function buildStatus(siteId: unknown): Promise<Status> {
	const site = resolveSite(siteId);
	if (!site) return emptyStatus();

	try {
		const [docker, objectCacheCurrent, cacheCurrent] = await Promise.all([
			checkDockerAvailable(),
			getRedisConstants(site).catch(() => null),
			getCacheConstant(site).catch(() => null),
		]);

		const base: Status = {
			...emptyStatus(),
			version: getVersion(site.id),
			objectCacheCurrent,
			cacheCurrent,
			siteStatus: getSiteStatus(site),
			lastError: getLastError(site.id),
		};

		if (!docker.available) {
			return { ...base, dockerError: docker.error };
		}

		try {
			const info = await inspectContainer(site.id);
			const running = Boolean(info?.running);
			const ready = running ? await isRedisReady(site.id) : false;
			const deployedVersion = info?.version ?? null;
			const hostPort = running ? info?.hostPort ?? null : null;
			// Without a container, the version that last wrote the data volume applies.
			const dataVersion = deployedVersion ?? getDataVersion(site.id);
			const versionOrder = dataVersion ? compareVersions(base.version, dataVersion) : 0;
			const versionDowngrade = versionOrder < 0;

			return {
				...base,
				dockerAvailable: true,
				containerRunning: running,
				containerExists: info !== null,
				ready,
				deployedVersion,
				versionDowngrade,
				hostUri: hostPort ? hostUriFor(hostPort) : null,
				hostPort,
			};
		} catch (err) {
			return { ...base, dockerError: errorText(err) };
		}
	} catch (err) {
		console.error('[redis] status failed:', err);
		return emptyStatus();
	}
}
