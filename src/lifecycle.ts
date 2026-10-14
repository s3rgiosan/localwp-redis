import * as LocalMain from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	checkDockerAvailable,
	errorText,
	inspectContainer,
	isPortConflict,
	listManagedContainers,
	listManagedVolumeSiteIds,
	removeContainer,
	removeContainerByName,
	removeVolume,
	startContainer,
	stopContainer,
	stopContainerByName,
	waitForRedisReady,
} from './docker';
import { ensurePort, reassignPort } from './ports';
import { runExclusive } from './queue';
import { getState } from './state';
import {
	getDataVersion,
	getVersion,
	isEnabled,
	setDataVersion,
	siteData,
} from './storage';

export const SITE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const MAX_PORT_REASSIGNMENTS = 3;

export function getLastError(siteId: string): string | null {
	return getState().lastErrors.get(siteId) ?? null;
}

export function setLastError(siteId: string, message: string): void {
	getState().lastErrors.set(siteId, message);
}

export function clearLastError(siteId: string): void {
	getState().lastErrors.delete(siteId);
}

export function getSiteStatus(site: Local.Site): Local.SiteStatus | null {
	try {
		return LocalMain.getServiceContainer().cradle.siteProcessManager.getSiteStatus(site);
	} catch (err) {
		console.error('[redis] unable to read site status:', err);
		return null;
	}
}

export function isSiteRunning(site: Local.Site): boolean {
	const status = getSiteStatus(site);
	return status === 'running';
}

/**
 * Starts the site's container on its stored version and port. Runs inside the
 * site's queue. Returns false when the site stopped while Redis was starting,
 * in which case the container is stopped again.
 */
export async function startRedisLocked(site: Local.Site): Promise<boolean> {
	// The setting can change while this start waits in the queue.
	if (getState().shuttingDown || !isEnabled(site.id)) return false;

	const version = getVersion(site.id);
	const dataVersion = getDataVersion(site.id);
	let port = await ensurePort(site.id);

	for (let reassignments = 0; ; reassignments++) {
		try {
			await startContainer(site.id, version, port, dataVersion);
			break;
		} catch (err) {
			if (!isPortConflict(err) || reassignments >= MAX_PORT_REASSIGNMENTS) throw err;
			console.warn(`[redis] port ${port} is taken for site ${site.id}, reassigning`);
			port = await reassignPort(site.id);
		}
	}
	setDataVersion(site.id, version);

	if (getState().shuttingDown || !isSiteActive(site)) {
		await stopContainer(site.id);
		return false;
	}
	return true;
}

/**
 * Stops the site's container when it is running. Runs inside the site's queue.
 */
export async function stopRedisLocked(siteId: string): Promise<void> {
	const info = await inspectContainer(siteId);
	if (info?.running) {
		await stopContainer(siteId);
	}
}

/**
 * Starts the site's container in the background and then watches readiness.
 * Never throws; failures are logged and recorded as the site's last error.
 */
export function startRedisInBackground(site: Local.Site): void {
	void runExclusive(site.id, () => startRedisLocked(site))
		.then((started) => (started ? watchReadiness(site.id) : undefined))
		.catch((err) => {
			console.error(`[redis] start for site ${site.id} failed:`, err);
			setLastError(site.id, `Redis could not be started: ${errorText(err) || 'Unknown error.'}`);
		});
}

/**
 * Waits for Redis to answer, logs why it did not and records the reason as
 * the site's last error. Never throws.
 */
export async function watchReadiness(siteId: string): Promise<void> {
	try {
		const result = await waitForRedisReady(siteId);
		switch (result.state) {
			case 'ready':
				clearLastError(siteId);
				break;
			case 'exited': {
				console.error(`[redis] container for site ${siteId} exited during startup. Last log lines:\n${result.logs}`);
				const lastLine = lastNonEmptyLine(result.logs);
				setLastError(siteId, lastLine ? `Redis exited during startup: ${lastLine}` : 'Redis exited during startup.');
				break;
			}
			case 'missing':
				console.error(`[redis] container for site ${siteId} disappeared during startup`);
				setLastError(siteId, 'The Redis container disappeared during startup.');
				break;
			default:
				console.error(`[redis] Redis for site ${siteId} did not become ready in time`);
				setLastError(siteId, 'Redis did not become ready in time.');
				break;
		}
	} catch (err) {
		console.error(`[redis] readiness check for site ${siteId} failed:`, err);
		setLastError(siteId, `Redis readiness check failed: ${errorText(err) || 'Unknown error.'}`);
	}
}

export async function deleteSiteRedis(siteId: string): Promise<void> {
	await runExclusive(siteId, async () => {
		await removeContainer(siteId);
		await removeVolume(siteId);
	});
}

/**
 * Removes containers and volumes of deleted sites and stops containers whose
 * site is not running. Marks the sweep as done only when Docker answered.
 */
export function sweepContainers(): Promise<void> {
	const state = getState();
	if (state.sweepInFlight) return state.sweepInFlight;

	state.sweepInFlight = (async () => {
		try {
			const docker = await checkDockerAvailable();
			if (!docker.available) {
				console.warn('[redis] Docker unavailable, container sweep postponed:', docker.error);
				return;
			}
			await sweep();
			state.sweepPending = false;
		} catch (err) {
			console.error('[redis] container sweep failed:', err);
		} finally {
			state.sweepInFlight = null;
		}
	})();

	return state.sweepInFlight;
}

export function isSweepPending(): boolean {
	return getState().sweepPending;
}

/**
 * Lets containers start again after a quit was cancelled and restores Redis
 * for every enabled site that is running. Does nothing when no quit was
 * in progress.
 */
export function cancelShutdown(): void {
	const state = getState();
	if (!state.shuttingDown) return;
	state.shuttingDown = false;

	let sites: Local.Site[];
	try {
		sites = Object.values(siteData().getSites() ?? {});
	} catch (err) {
		console.error('[redis] unable to restore Redis after a cancelled quit:', err);
		return;
	}

	for (const site of sites) {
		if (isEnabled(site.id) && getSiteStatus(site) === 'running') {
			startRedisInBackground(site);
		}
	}
}

/**
 * Stops every running add-on container. Used when Local quits. Starts that
 * finish after this point stop their own container.
 */
export async function stopAllManagedContainers(): Promise<void> {
	getState().shuttingDown = true;
	const containers = await listManagedContainers();
	const running = containers.filter((c) => c.running);
	const results = await Promise.allSettled(running.map((c) => stopContainerByName(c.name)));
	results.forEach((result, index) => {
		if (result.status === 'rejected') {
			console.error(`[redis] failed to stop container ${running[index].name} on quit:`, result.reason);
		}
	});
}

function lastNonEmptyLine(text: string): string {
	const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
	return lines.length > 0 ? lines[lines.length - 1] : '';
}

function isSiteActive(site: Local.Site): boolean {
	const status = getSiteStatus(site);
	switch (status) {
		case 'running':
		case 'starting':
		case 'restarting':
			return true;
		default:
			return false;
	}
}

async function sweep(): Promise<void> {
	const containers = await listManagedContainers();
	const volumeSiteIds = await listManagedVolumeSiteIds();
	const handled = new Set<string>();

	// An empty site list while add-on data exists means the site data could not
	// be read, so nothing is removed.
	const knownSites = Object.keys(siteData().getSites() ?? {});
	const removalAllowed = knownSites.length > 0 || (containers.length === 0 && volumeSiteIds.length === 0);
	if (!removalAllowed) {
		console.warn('[redis] Local reported no sites while add-on containers or volumes exist, skipping removals');
	}

	for (const container of containers) {
		if (!SITE_ID_PATTERN.test(container.siteId)) {
			console.warn(`[redis] skipping container ${container.name} with unexpected site ID`);
			continue;
		}
		handled.add(container.siteId);

		try {
			await runExclusive(container.siteId, async () => {
				const site = siteData().getSite(container.siteId);
				if (!site) {
					if (!removalAllowed) return;
					await removeContainerByName(container.name);
					await removeVolume(container.siteId);
					return;
				}
				if (container.running && !isSiteActive(site)) {
					await stopContainerByName(container.name);
				}
			});
		} catch (err) {
			console.error(`[redis] sweep of container ${container.name} failed:`, err);
		}
	}

	for (const siteId of volumeSiteIds) {
		if (!removalAllowed) break;
		if (handled.has(siteId)) continue;
		try {
			await runExclusive(siteId, async () => {
				const site = siteData().getSite(siteId);
				if (!site) await removeVolume(siteId);
			});
		} catch (err) {
			console.error(`[redis] sweep of volume for site ${siteId} failed:`, err);
		}
	}
}
