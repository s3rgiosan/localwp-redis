import * as LocalMain from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	containerExists,
	ensureNetworkConnected,
	findFreePort,
	getDeployedVersion,
	getHostPort,
	getHostUri,
	isContainerRunning,
	isDockerAvailable,
	isRedisReady,
	listRunningContainers,
	startContainer,
	stopContainer,
	stopContainerByName,
} from './docker';
import { registerHooks } from './hooks';
import {
	getCacheConstant,
	getRedisConstants,
	removeCacheConstant,
	removeRedisConstants,
	setCacheConstant,
	setRedisConstants,
} from './wpcli';
import {
	DEFAULT_VERSION,
	SUPPORTED_VERSIONS,
	getPort,
	getVersion,
	initStorage,
	isEnabled,
	setEnabled,
	setPort,
	setVersion,
	type RedisVersion,
} from './storage';

async function ensurePort(siteId: string): Promise<number> {
	let p = getPort(siteId);
	if (p) return p;
	p = await findFreePort();
	setPort(siteId, p);
	return p;
}

async function reconcileVersions(): Promise<void> {
	try {
		const sites = LocalMain.SiteData.getSites();
		for (const siteId of Object.keys(sites)) {
			const deployed = await getDeployedVersion(siteId);
			if (!deployed) continue;
			if ((SUPPORTED_VERSIONS as readonly string[]).includes(deployed)) {
				setVersion(siteId, deployed as RedisVersion);
			}
		}
	} catch (err) {
		console.error('[redis] version reconcile failed:', err);
	}
}

export default function (context: LocalMain.AddonMainContext): void {
	const { electron } = context;

	initStorage();
	registerHooks();
	reconcileVersions().catch((err) =>
		console.error('[redis] version reconcile failed:', err)
	);

	let shuttingDown = false;
	electron.app.on('before-quit', (event: any) => {
		if (shuttingDown) return;
		event.preventDefault();
		shuttingDown = true;
		(async () => {
			try {
				const names = await listRunningContainers();
				await Promise.allSettled(names.map((n) => stopContainerByName(n)));
			} catch (err) {
				console.error('[redis] shutdown stop failed:', err);
			} finally {
				electron.app.quit();
			}
		})();
	});

	electron.ipcMain.handle('redis:isEnabled', (_e: any, siteId: string) =>
		isEnabled(siteId)
	);

	electron.ipcMain.handle(
		'redis:setEnabled',
		async (_e: any, siteId: string, enabled: boolean) => {
			setEnabled(siteId, enabled);
			try {
				const running = await isContainerRunning(siteId);
				if (enabled && !running && (await containerExists(siteId))) {
					const port = await ensurePort(siteId);
					await startContainer(siteId, getVersion(siteId), port);
					await ensureNetworkConnected(siteId);
				} else if (!enabled && running) {
					await stopContainer(siteId);
				}
			} catch (err) {
				console.error('[redis] setEnabled handler failed:', err);
			}
			return enabled;
		}
	);

	electron.ipcMain.handle(
		'redis:setObjectCacheEnabled',
		async (_e: any, siteId: string, enabled: boolean) => {
			const site = LocalMain.SiteData.getSite(siteId);
			if (!site) return false;
			try {
				if (enabled) {
					const port = await getHostPort(siteId);
					if (!port) return false;
					await setRedisConstants(site, '127.0.0.1', port);
					return true;
				}
				await removeRedisConstants(site);
				return false;
			} catch (err) {
				console.error('[redis] setObjectCacheEnabled handler failed:', err);
				return enabled;
			}
		}
	);

	electron.ipcMain.handle(
		'redis:setCacheEnabled',
		async (_e: any, siteId: string, enabled: boolean) => {
			const site = LocalMain.SiteData.getSite(siteId);
			if (!site) return false;
			try {
				if (enabled) {
					await setCacheConstant(site);
					return true;
				}
				await removeCacheConstant(site);
				return false;
			} catch (err) {
				console.error('[redis] setCacheEnabled handler failed:', err);
				return enabled;
			}
		}
	);

	electron.ipcMain.handle('redis:status', async (_e: any, siteId: string) => {
		const site = LocalMain.SiteData.getSite(siteId);
		const [dockerAvailable, running, hostUri, hostPort, exists, deployedVersion, objectCacheCurrent, cacheCurrent] = await Promise.all([
			isDockerAvailable(),
			listRunningContainers(),
			getHostUri(siteId),
			getHostPort(siteId),
			containerExists(siteId),
			getDeployedVersion(siteId),
			site ? getRedisConstants(site) : Promise.resolve(null),
			site ? getCacheConstant(site) : Promise.resolve(null),
		]);
		const containerRunning = running.some((n) => n === `localwp-redis-${siteId}`);
		const ready = containerRunning ? await isRedisReady(siteId) : false;
		return {
			dockerAvailable,
			containerRunning,
			containerExists: exists,
			ready,
			version: getVersion(siteId),
			deployedVersion,
			hostUri,
			hostPort,
			supportedVersions: SUPPORTED_VERSIONS,
			defaultVersion: DEFAULT_VERSION,
			objectCacheCurrent,
			cacheCurrent,
		};
	});

	electron.ipcMain.handle(
		'redis:setVersion',
		(_e: any, siteId: string, version: RedisVersion) => {
			setVersion(siteId, version);
			return version;
		}
	);
}

export type { Local };
