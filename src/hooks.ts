import { HooksMain } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	SITE_ID_PATTERN,
	cancelShutdown,
	deleteSiteRedis,
	isSweepPending,
	startRedisInBackground,
	stopRedisLocked,
	sweepContainers,
} from './lifecycle';
import { runExclusive } from './queue';
import { getState } from './state';
import { getPort, isEnabled } from './storage';

// HooksMain offers no way to remove an action, so registration happens once
// per process.
export function registerHooks(): void {
	const state = getState();
	if (state.hooksRegistered) return;
	state.hooksRegistered = true;

	HooksMain.addAction('siteStarted', async (site: Local.Site) => {
		// A site starting means Local is still running, so any earlier quit was cancelled.
		cancelShutdown();
		if (isSweepPending()) {
			void sweepContainers();
		}

		// The start runs in the background so Local's site start is not held up.
		if (!isEnabled(site.id)) return;
		startRedisInBackground(site);
	});

	HooksMain.addAction('siteStopped', async (site: Local.Site) => {
		if (!isEnabled(site.id) && getPort(site.id) === null) return;
		try {
			await runExclusive(site.id, () => stopRedisLocked(site.id));
		} catch (err) {
			console.error('[redis] siteStopped handler failed:', err);
		}
	});

	// Local passes the deleted site's ID, after its site data is gone.
	HooksMain.addAction('siteDeleted', async (siteId: string) => {
		if (typeof siteId !== 'string' || !SITE_ID_PATTERN.test(siteId)) return;
		try {
			await deleteSiteRedis(siteId);
		} catch (err) {
			console.error('[redis] siteDeleted handler failed:', err);
		}
	});
}
