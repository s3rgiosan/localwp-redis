import * as LocalMain from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';

const ENABLED = 'redisEnabled';
const VERSION = 'redisVersion';
const PORT = 'redisPort';
const DATA_VERSION = 'redisDataVersion';

export const SUPPORTED_VERSIONS = ['6.2', '7.2', '7.4'] as const;
export type RedisVersion = typeof SUPPORTED_VERSIONS[number];
export const DEFAULT_VERSION: RedisVersion = '7.4';

/**
 * Returns Local's site data service.
 */
export function siteData(): LocalMain.Services.SiteDataService {
	return LocalMain.getServiceContainer().cradle.siteData;
}

export function isSupportedVersion(value: unknown): value is RedisVersion {
	return (SUPPORTED_VERSIONS as readonly unknown[]).includes(value);
}

export function isEnabled(siteId: string): boolean {
	return Boolean(readField(siteId, ENABLED));
}

export function setEnabled(siteId: string, enabled: boolean): void {
	writeField(siteId, ENABLED, enabled);
}

export function getVersion(siteId: string): RedisVersion {
	const value = readField(siteId, VERSION);
	return isSupportedVersion(value) ? value : DEFAULT_VERSION;
}

export function setVersion(siteId: string, version: RedisVersion): void {
	writeField(siteId, VERSION, version);
}

export function getPort(siteId: string): number | null {
	const value = readField(siteId, PORT);
	return typeof value === 'number' ? value : null;
}

export function setPort(siteId: string, port: number): void {
	writeField(siteId, PORT, port);
}

/**
 * Returns the Redis version that last wrote the site's data volume.
 */
export function getDataVersion(siteId: string): string | null {
	const value = readField(siteId, DATA_VERSION);
	return typeof value === 'string' ? value : null;
}

export function setDataVersion(siteId: string, version: string): void {
	writeField(siteId, DATA_VERSION, version);
}

/**
 * Returns the stored ports of every site except the given one.
 */
export function getOtherSitePorts(siteId: string): Set<number> {
	const ports = new Set<number>();
	const sites = siteData().getSites();
	for (const id of Object.keys(sites)) {
		if (id === siteId) continue;
		const port = getPort(id);
		if (port !== null) ports.add(port);
	}
	return ports;
}

function readField(siteId: string, key: string): unknown {
	const site = siteData().getSite(siteId) as (Local.Site & Record<string, unknown>) | null;
	return site?.[key];
}

function writeField(siteId: string, key: string, value: unknown): void {
	siteData().updateSite(siteId, { [key]: value } as unknown as Partial<Local.SiteJSON>);
}
