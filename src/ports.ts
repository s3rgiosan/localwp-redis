import { findFreePort, inspectContainer, isPortFree } from './docker';
import {
	getOtherSitePorts,
	getPort,
	setPort,
	siteData,
} from './storage';
import { getState } from './state';
import { checkRedisBlock, getRedisConstants, setRedisConstants } from './wpconfig';

const MAX_ALLOCATION_ATTEMPTS = 20;

/**
 * Returns the host port for the site's Redis container, allocating a new one
 * when the stored port is shared with another site or bound by something
 * other than this site's container. Call it inside the site's queue.
 */
export async function ensurePort(siteId: string): Promise<number> {
	const stored = getPort(siteId);
	if (stored !== null && (await isStoredPortUsable(siteId, stored))) {
		return stored;
	}
	return assignNewPort(siteId);
}

/**
 * Allocates and stores a new port for the site, regardless of the stored
 * one. Call it inside the site's queue.
 */
export async function reassignPort(siteId: string): Promise<number> {
	return assignNewPort(siteId);
}

async function isStoredPortUsable(siteId: string, port: number): Promise<boolean> {
	// A port this site's container already publishes stays with this site, even
	// when a cloned site stored the same number.
	const info = await inspectContainer(siteId).catch(() => null);
	if (info?.running && info.hostPort === port) return true;

	const otherPorts = getOtherSitePorts(siteId);
	if (otherPorts.has(port) || isReservedByOther(siteId, port)) return false;
	return isPortFree(port);
}

function isReservedByOther(siteId: string, port: number): boolean {
	const owner = getState().reservedPorts.get(port);
	return owner !== undefined && owner !== siteId;
}

async function assignNewPort(siteId: string): Promise<number> {
	const { reservedPorts } = getState();
	const previous = getPort(siteId);
	const otherPorts = getOtherSitePorts(siteId);

	let port: number | null = null;
	for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
		const candidate = await findFreePort();
		const taken = candidate === previous || otherPorts.has(candidate) || reservedPorts.has(candidate);
		if (!taken) {
			port = candidate;
			break;
		}
	}
	if (port === null) {
		throw new Error('Unable to find a free port for Redis.');
	}

	// The reservation covers the window before the port is stored, so
	// concurrent allocations for other sites cannot pick the same number.
	reservedPorts.set(port, siteId);
	try {
		// wp-config.php is updated first so a failed write leaves the old port stored.
		await syncWpConfigPort(siteId, port);
		setPort(siteId, port);
	} finally {
		reservedPorts.delete(port);
	}
	return port;
}

/**
 * Points an existing WP_REDIS_* block in wp-config.php at the new port.
 */
async function syncWpConfigPort(siteId: string, port: number): Promise<void> {
	const site = siteData().getSite(siteId);
	if (!site) return;

	const failed = (reason: string): Error =>
		new Error(`Redis could not switch to port ${port} because wp-config.php could not be updated: ${reason}`);

	const check = await checkRedisBlock(site);
	if (!check.ok) throw failed(check.error);

	const current = await getRedisConstants(site);
	if (!current) return;

	const result = await setRedisConstants(site, '127.0.0.1', port);
	if (!result.ok) throw failed(result.error);
}
