import * as React from 'react';
import { Banner, FlySelect, Switch, TableListRow, Text } from '@getflywheel/local-components';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

type RedisConstants = { host: string; port: number };

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

type ActionResult = { ok: boolean; error?: string };

const DEFAULT_STATUS: Status = {
	dockerAvailable: true,
	dockerError: null,
	containerRunning: false,
	containerExists: false,
	ready: false,
	version: '',
	deployedVersion: null,
	versionDowngrade: false,
	hostUri: null,
	hostPort: null,
	supportedVersions: [],
	defaultVersion: '',
	objectCacheCurrent: null,
	cacheCurrent: null,
	siteStatus: null,
	lastError: null,
};

const POLL_STARTING_MS = 2000;
const POLL_IDLE_MS = 5000;

type SiteProps = { id: string; name: string; [key: string]: any };

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const VISUALLY_HIDDEN: React.CSSProperties = {
	position: 'absolute',
	width: 1,
	height: 1,
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap',
};

const COLUMN: React.CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'flex-start',
	gap: 8,
};

const INLINE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };

// Row cells align on the text baseline, so the switch is centered on the line of text.
const SWITCH_LABEL: React.CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	verticalAlign: 'middle',
};

// TableListRow renders its label as plain text, so each switch carries its own hidden label.
function LabelledSwitch({
	label,
	checked,
	disabled,
	epoch,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled: boolean;
	epoch: number;
	onChange: (name: string, next: boolean) => void;
}) {
	return (
		<label style={SWITCH_LABEL}>
			<span style={VISUALLY_HIDDEN}>{label}</span>
			{/* Switch keeps its own toggled state; remounting re-syncs it with the real value. */}
			<Switch key={`${checked}-${epoch}`} tiny flat checked={checked} disabled={disabled} onChange={onChange} />
		</label>
	);
}

function Hint({ children }: { children: React.ReactNode }) {
	return <Text size="caption">{children}</Text>;
}

/** `label` names the Tools tab entry; Local reads it from the element's props. */
function RedisPanel({ site, electron }: { site: SiteProps; electron: any; label: string }) {
	const ipc = electron.ipcRenderer;
	const [enabled, setEnabled] = useState(false);
	const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [switchEpoch, setSwitchEpoch] = useState(0);
	const mountedRef = useRef(true);
	const requestId = useRef(0);
	const pollMsRef = useRef(POLL_IDLE_MS);
	const kickRef = useRef<() => void>(() => undefined);
	const lastSiteStatusRef = useRef(site.status);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Resolves true when the refresh was applied. Later refreshes and unmounting
	// invalidate earlier in-flight ones.
	const refresh = useCallback(async (): Promise<boolean> => {
		requestId.current += 1;
		const current = requestId.current;
		try {
			const [e, s] = await Promise.all([
				ipc.invoke('redis:isEnabled', site.id) as Promise<boolean>,
				ipc.invoke('redis:status', site.id) as Promise<Status>,
			]);
			if (!mountedRef.current || current !== requestId.current) return false;
			const waiting = e && !s.ready;
			pollMsRef.current = waiting ? POLL_STARTING_MS : POLL_IDLE_MS;
			setEnabled(e);
			setStatus(s);
			setLoaded(true);
			setRefreshError(null);
			return true;
		} catch (err) {
			if (mountedRef.current && current === requestId.current) setRefreshError(errorMessage(err));
			return false;
		}
	}, [site.id, ipc]);

	// The next poll starts only after the previous refresh settles. A kick runs one right away.
	useEffect(() => {
		let cancelled = false;
		let inFlight = false;
		let rerun = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const poll = async () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			if (inFlight) {
				rerun = true;
				return;
			}
			inFlight = true;
			await refresh();
			inFlight = false;
			if (cancelled) return;
			if (rerun) {
				rerun = false;
				poll();
				return;
			}
			timer = setTimeout(poll, pollMsRef.current);
		};

		kickRef.current = poll;
		poll();

		return () => {
			cancelled = true;
			kickRef.current = () => undefined;
			if (timer) clearTimeout(timer);
		};
	}, [refresh]);

	// Re-read status right away when Local reports a site status change.
	useEffect(() => {
		if (lastSiteStatusRef.current !== site.status) kickRef.current();
		lastSiteStatusRef.current = site.status;
	}, [site.status]);

	let siteHalted = false;
	switch (status.siteStatus) {
		case 'running':
			break;
		case null:
		case 'halted':
		case 'stopped':
			siteHalted = true;
			break;
		default:
			break;
	}

	const run = async (channel: string, ...args: unknown[]) => {
		setBusy(true);
		try {
			const result = (await ipc.invoke(channel, site.id, ...args)) as ActionResult;
			if (!mountedRef.current) return;
			if (result && result.ok) {
				setError(null);
			} else {
				setError((result && result.error) || 'The action failed');
			}
		} catch (err) {
			if (mountedRef.current) setError(errorMessage(err));
		} finally {
			await refresh();
			if (mountedRef.current) {
				setSwitchEpoch((n) => n + 1);
				setBusy(false);
			}
		}
	};

	const onToggle = (_name: string, next: boolean) => run('redis:setEnabled', next);
	const onObjectCacheToggle = (_name: string, next: boolean) => run('redis:setObjectCacheEnabled', next);
	const onCacheToggle = (_name: string, next: boolean) => run('redis:setCacheEnabled', next);
	const onVersionChange = (next: string) => run('redis:setVersion', next);

	const versionOptions = useMemo(() => {
		const out: Record<string, string> = {};
		for (const v of status.supportedVersions) {
			out[v] = v === status.defaultVersion ? `${v} (default)` : v;
		}
		return out;
	}, [status.supportedVersions, status.defaultVersion]);

	const dockerDown = !status.dockerAvailable;
	const locked = !loaded;
	const versionChangePending =
		!!status.deployedVersion && status.deployedVersion !== status.version;
	const dockerMessage = status.dockerError || 'Docker not running';
	const shownError = error || refreshError;

	let stateLabel: string;
	if (locked) {
		stateLabel = '…';
	} else if (dockerDown) {
		stateLabel = dockerMessage;
	} else if (!enabled) {
		stateLabel = 'Disabled';
	} else if (siteHalted || !status.containerRunning) {
		stateLabel = 'Stopped';
	} else if (!status.ready) {
		stateLabel = 'Starting…';
	} else {
		stateLabel = 'Running';
	}

	let startHint: string | null = null;
	if (enabled && !dockerDown && siteHalted) {
		startHint = status.containerExists
			? 'Starts on next site start.'
			: 'Container is created on next site start.';
	}

	const ocCurrent = status.objectCacheCurrent;
	const ocMismatch =
		!!ocCurrent && status.hostPort !== null &&
		(ocCurrent.host !== '127.0.0.1' || ocCurrent.port !== status.hostPort);

	const cacheOn = status.cacheCurrent === true;
	const objectCacheOn = !!ocCurrent;

	const mainDisabled = locked || busy || (!enabled && dockerDown);
	const cacheDisabled = locked || busy || (cacheOn ? false : !enabled);
	const objectCacheDisabled = locked || busy || (objectCacheOn ? false : !enabled || dockerDown);

	return (
		<>
			<TableListRow alignMiddle key="redis" label="Redis">
				<div style={COLUMN}>
					<div>
						<LabelledSwitch
							label="Redis"
							checked={enabled}
							disabled={mainDisabled}
							epoch={switchEpoch}
							onChange={onToggle}
						/>
						{startHint && (
							<span style={{ marginLeft: 8 }}>
								<Hint>{startHint}</Hint>
							</span>
						)}
					</div>
					{dockerDown && <Banner variant="warning">{dockerMessage}</Banner>}
					{shownError && <Banner variant="error">{shownError}</Banner>}
					{status.lastError && <Banner variant="warning">{status.lastError}</Banner>}
				</div>
			</TableListRow>
			<TableListRow key="redis-state" label="State">
				<Text>{stateLabel}</Text>
			</TableListRow>
			<TableListRow key="redis-host" label="Host">
				{enabled && status.ready && status.hostUri ? (
					<Text style={{ userSelect: 'text', cursor: 'text' }}>{status.hostUri}</Text>
				) : (
					<Text>—</Text>
				)}
			</TableListRow>
			<TableListRow key="redis-version" label="Version">
				<div style={INLINE}>
					<div role="group" aria-label="Redis version" style={{ display: 'contents' }}>
						<FlySelect
							value={status.version || status.defaultVersion}
							options={versionOptions}
							disabled={locked || dockerDown || !enabled || busy || !status.supportedVersions.length}
							onChange={onVersionChange}
						/>
					</div>
					{enabled && !dockerDown && versionChangePending && (
						<Hint>
							{status.versionDowngrade
								? 'Applies on next site start. Downgrading clears Redis data.'
								: 'Applies on next site start'}
						</Hint>
					)}
				</div>
			</TableListRow>
			<TableListRow key="redis-cache" label="Cache">
				<LabelledSwitch
					label="Cache"
					checked={cacheOn}
					disabled={cacheDisabled}
					epoch={switchEpoch}
					onChange={onCacheToggle}
				/>
			</TableListRow>
			<TableListRow key="redis-object-cache" label="Object Cache">
				<div style={COLUMN}>
					<div>
						<LabelledSwitch
							label="Object Cache"
							checked={objectCacheOn}
							disabled={objectCacheDisabled}
							epoch={switchEpoch}
							onChange={onObjectCacheToggle}
						/>
					</div>
					{ocMismatch && (
						<Banner variant="warning">
							WP_REDIS_* in wp-config.php ({ocCurrent!.host}:{ocCurrent!.port}) doesn't match
							(127.0.0.1:{status.hostPort})
						</Banner>
					)}
				</div>
			</TableListRow>
		</>
	);
}

export default function (context: any): void {
	const { hooks, electron } = context;
	if (!hooks?.addContent) return;
	hooks.addContent('siteInfoUtilities', (site: SiteProps) => (
		<RedisPanel key={site.id} label="Redis" site={site} electron={electron} />
	));
}
