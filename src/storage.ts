import { getServiceContainer } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';

const ENABLED = 'redisEnabled';
const VERSION = 'redisVersion';
const PORT = 'redisPort';

export const SUPPORTED_VERSIONS = ['6.2', '7.2', '7.4'] as const;
export type RedisVersion = typeof SUPPORTED_VERSIONS[number];
export const DEFAULT_VERSION: RedisVersion = '7.4';

type SiteData = {
	getSite: (id: string) => Local.Site & Record<string, any>;
	updateSite: (id: string, partial: Record<string, any>) => void;
	getSites: () => Record<string, Local.Site & Record<string, any>>;
};

let siteData: SiteData | null = null;

export function initStorage(): void {
	try {
		siteData = (getServiceContainer() as any).cradle.siteData;
	} catch (err) {
		console.error('[redis] failed to resolve siteData service:', err);
	}
}

function requireSiteData(): SiteData {
	if (!siteData) throw new Error('Storage not initialized');
	return siteData;
}

export function isEnabled(siteId: string): boolean {
	return Boolean(requireSiteData().getSite(siteId)?.[ENABLED]);
}

export function setEnabled(siteId: string, enabled: boolean): void {
	requireSiteData().updateSite(siteId, { [ENABLED]: enabled });
}

export function getVersion(siteId: string): RedisVersion {
	const v = requireSiteData().getSite(siteId)?.[VERSION];
	return (SUPPORTED_VERSIONS as readonly string[]).includes(v) ? v : DEFAULT_VERSION;
}

export function setVersion(siteId: string, version: RedisVersion): void {
	requireSiteData().updateSite(siteId, { [VERSION]: version });
}

export function getPort(siteId: string): number | null {
	const p = requireSiteData().getSite(siteId)?.[PORT];
	return typeof p === 'number' ? p : null;
}

export function setPort(siteId: string, port: number): void {
	requireSiteData().updateSite(siteId, { [PORT]: port });
}
