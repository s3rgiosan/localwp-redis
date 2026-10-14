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

// Layout uses flex and gap only; colors and type come from the Text component.
// With `labelsControl`, the row is a <label>, so its text names the switch inside it.
function Field({
	label,
	children,
	labelsControl = false,
}: {
	label: string;
	children: React.ReactNode;
	labelsControl?: boolean;
}) {
	const Row = labelsControl ? 'label' : 'div';
	return (
		<Row style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
			<Text style={{ fontWeight: 500 }}>{label}
				<span aria-hidden="true">:</span>
			</Text>
			{children}
		</Row>
	);
}

const VISUALLY_HIDDEN: React.CSSProperties = {
	position: 'absolute',
	width: 1,
	height: 1,
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap',
};

function Hint({ children }: { children: React.ReactNode }) {
	return <Text size="caption">{children}</Text>;
}

function RedisPanel({ site, electron }: { site: SiteProps; electron: any }) {
	const ipc = electron.ipcRenderer;
	const [enabled, setEnabled] = useState(false);
	const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const requestId = useRef(0);
	const pollMsRef = useRef(POLL_IDLE_MS);

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
			if (current !== requestId.current) return false;
			const waiting = e && !s.ready;
			pollMsRef.current = waiting ? POLL_STARTING_MS : POLL_IDLE_MS;
			setEnabled(e);
			setStatus(s);
			setRefreshError(null);
			return true;
		} catch (err) {
			if (current === requestId.current) setRefreshError(errorMessage(err));
			return false;
		}
	}, [site.id, ipc]);

	useEffect(
		() => () => {
			requestId.current += 1;
		},
		[]
	);

	useEffect(() => {
		refresh();
	}, [refresh]);

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

	// The next poll is scheduled only after the previous refresh settles.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			timer = setTimeout(async () => {
				await refresh();
				if (!cancelled) schedule();
			}, pollMsRef.current);
		};
		schedule();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [refresh]);

	const run = async (channel: string, ...args: unknown[]) => {
		setBusy(true);
		try {
			const result = (await ipc.invoke(channel, site.id, ...args)) as ActionResult;
			if (result && result.ok) {
				setError(null);
			} else {
				setError((result && result.error) || 'The action failed');
			}
		} catch (err) {
			setError(errorMessage(err));
		}
		await refresh();
		setBusy(false);
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

	const versionChangePending =
		!!status.deployedVersion && status.deployedVersion !== status.version;

	const dockerMessage = status.dockerError || 'Docker not running';
	const stateLabel = !status.dockerAvailable
		? dockerMessage
		: !enabled
			? 'Disabled'
			: siteHalted || !status.containerRunning
				? 'Stopped'
				: !status.ready
					? 'Starting…'
					: 'Running';

	const ocCurrent = status.objectCacheCurrent;
	const ocMismatch =
		!!ocCurrent && status.hostPort !== null &&
		(ocCurrent.host !== '127.0.0.1' || ocCurrent.port !== status.hostPort);

	const cacheOn = status.cacheCurrent === true;
	const objectCacheOn = !!ocCurrent;

	const mainDisabled = busy || (!enabled && !status.dockerAvailable);
	const cacheDisabled = busy || (cacheOn ? false : !enabled);
	const objectCacheDisabled = busy || (objectCacheOn ? false : !enabled || !status.dockerAvailable);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 14 }}>
			{(error || refreshError) && <Banner variant="error">{error || refreshError}</Banner>}
			{status.lastError && <Banner variant="warning">{status.lastError}</Banner>}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<label>
					<span style={VISUALLY_HIDDEN}>Redis</span>
					<Switch tiny flat checked={enabled} disabled={mainDisabled} onChange={onToggle} />
				</label>
				{enabled && status.dockerAvailable && siteHalted && <Hint>Starts with the site</Hint>}
			</div>
			<Field label="State">
				<Text>{stateLabel}</Text>
			</Field>
			<Field label="Host">
				{enabled && status.ready && status.hostUri ? (
					<Text style={{ userSelect: 'text', cursor: 'text' }}>{status.hostUri}</Text>
				) : (
					<Text size="caption">—</Text>
				)}
			</Field>
			<Field label="Version">
				<div role="group" aria-label="Redis version" style={{ display: 'contents' }}>
					<FlySelect
						value={status.version || status.defaultVersion}
						options={versionOptions}
						disabled={!enabled || busy || !status.dockerAvailable || !status.supportedVersions.length}
						onChange={onVersionChange}
					/>
				</div>
				{enabled && status.dockerAvailable && versionChangePending && (
					<Hint>
						{status.versionDowngrade
							? 'Restart site to apply. Downgrading clears Redis data.'
							: 'Restart site to apply'}
					</Hint>
				)}
			</Field>
			<Field label="Cache" labelsControl>
				<Switch tiny flat checked={cacheOn} disabled={cacheDisabled} onChange={onCacheToggle} />
			</Field>
			<Field label="Object Cache" labelsControl>
				<Switch
					tiny
					flat
					checked={objectCacheOn}
					disabled={objectCacheDisabled}
					onChange={onObjectCacheToggle}
				/>
			</Field>
			{ocMismatch && (
				<Banner variant="warning">
					WP_REDIS_* in wp-config.php ({ocCurrent!.host}:{ocCurrent!.port}) doesn't match (127.0.0.1:{status.hostPort})
				</Banner>
			)}
		</div>
	);
}

export default function (context: any): void {
	const { hooks, electron } = context;
	if (!hooks?.addContent) return;
	hooks.addContent('siteInfoUtilities', (site: SiteProps) => (
		<TableListRow alignMiddle key="redis" label="Redis">
			<RedisPanel key={site.id} site={site} electron={electron} />
		</TableListRow>
	));
}
