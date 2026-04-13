import { HooksMain } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import {
	ensureNetworkConnected,
	findFreePort,
	isContainerRunning,
	startContainer,
	stopContainer,
	waitForRedisReady,
} from './docker';
import { getPort, getVersion, isEnabled, setPort } from './storage';

export function registerHooks(): void {
	HooksMain.addAction('siteStarted', async (site: Local.Site) => {
		if (!isEnabled(site.id)) return;
		try {
			let port = getPort(site.id);
			if (!port) {
				port = await findFreePort();
				setPort(site.id, port);
			}
			await startContainer(site.id, getVersion(site.id), port);
			await ensureNetworkConnected(site.id);
			await waitForRedisReady(site.id);
		} catch (err) {
			console.error('[redis] siteStarted handler failed:', err);
		}
	});

	HooksMain.addAction('siteStopped', async (site: Local.Site) => {
		try {
			if (await isContainerRunning(site.id)) {
				await stopContainer(site.id);
			}
		} catch (err) {
			console.error('[redis] siteStopped handler failed:', err);
		}
	});
}
