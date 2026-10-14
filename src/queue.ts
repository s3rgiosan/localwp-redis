import { getState } from './state';

/**
 * Runs `fn` after every operation already queued for the same site has
 * settled, so container lifecycle steps for one site never interleave.
 */
export function runExclusive<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
	const { queues } = getState();
	const previous = queues.get(siteId) ?? Promise.resolve();
	const result = previous.then(fn);
	const settled = result.then(
		() => undefined,
		() => undefined
	);

	queues.set(siteId, settled);
	settled.then(() => {
		const latest = queues.get(siteId);
		if (latest === settled) queues.delete(siteId);
	});

	return result;
}
