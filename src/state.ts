type AddonState = {
	hooksRegistered: boolean;
	quitListener: ((event: Electron.Event) => void) | null;
	queues: Map<string, Promise<void>>;
	shuttingDown: boolean;
	sweepPending: boolean;
	sweepInFlight: Promise<void> | null;
	lastErrors: Map<string, string>;
	reservedPorts: Map<number, string>;
};

const STATE_KEY = Symbol.for('localwp-redis.state');

/**
 * Returns the add-on's mutable state. It lives on `globalThis` so that a
 * second evaluation of the modules (for example after a reload) shares the
 * queues, flags and registrations of the first.
 */
export function getState(): AddonState {
	const holder = globalThis as unknown as Record<symbol, AddonState | undefined>;
	let state = holder[STATE_KEY];
	if (!state) {
		state = {
			hooksRegistered: false,
			quitListener: null,
			queues: new Map(),
			shuttingDown: false,
			sweepPending: true,
			sweepInFlight: null,
			lastErrors: new Map(),
			reservedPorts: new Map(),
		};
		holder[STATE_KEY] = state;
	}
	return state;
}
