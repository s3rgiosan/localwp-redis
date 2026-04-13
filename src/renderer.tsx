import * as React from 'react';
// Provided by Local at runtime (not bundled).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TableListRow, Switch, FlySelect } = require('@getflywheel/local-components') as {
	TableListRow: React.ComponentType<{
		label: string;
		children?: React.ReactNode;
		key?: string;
		alignMiddle?: boolean;
	}>;
	Switch: React.ComponentType<{
		checked?: boolean;
		disabled?: boolean;
		tiny?: boolean;
		flat?: boolean;
		name?: string;
		onChange?: (name: string, checked: boolean) => void;
	}>;
	FlySelect: React.ComponentType<{
		value: string;
		options: Record<string, string>;
		disabled?: boolean;
		onChange?: (value: string) => void;
	}>;
};

const { useCallback, useEffect, useState } = React;

type RedisConstants = { host: string; port: number };

type Status = {
	dockerAvailable: boolean;
	containerRunning: boolean;
	containerExists: boolean;
	version: string;
	deployedVersion: string | null;
	hostUri: string | null;
	hostPort: number | null;
	ready: boolean;
	supportedVersions: readonly string[];
	defaultVersion: string;
	objectCacheCurrent: RedisConstants | null;
	cacheCurrent: boolean | null;
};

const DEFAULT_STATUS: Status = {
	dockerAvailable: true,
	containerRunning: false,
	containerExists: false,
	version: '',
	deployedVersion: null,
	hostUri: null,
	hostPort: null,
	ready: false,
	supportedVersions: [],
	defaultVersion: '',
	objectCacheCurrent: null,
	cacheCurrent: null,
};

type SiteProps = { id: string; name: string; [key: string]: any };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#5d5e5e' }}>
			<div style={{ fontWeight: 500, fontSize: 14, lineHeight: '30px', alignSelf: 'flex-start' }}>{label}:</div>
			<div style={{ fontSize: 14 }}>{children}</div>
		</div>
	);
}

function RedisPanel({ site, electron }: { site: SiteProps; electron: any }) {
	const ipc = electron.ipcRenderer;
	const [enabled, setEnabled] = useState(false);
	const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const [e, s] = await Promise.all([
			ipc.invoke('redis:isEnabled', site.id) as Promise<boolean>,
			ipc.invoke('redis:status', site.id) as Promise<Status>,
		]);
		setEnabled(e);
		setStatus(s);
	}, [site.id, ipc]);

	useEffect(() => {
		refresh();
	}, [refresh, site.status]);

	useEffect(() => {
		const siteHalted = site.status === 'halted' || site.status === 'stopped';
		if (!enabled || siteHalted) return;
		const id = setInterval(refresh, status.ready ? 5000 : 2000);
		return () => clearInterval(id);
	}, [enabled, site.status, status.ready, refresh]);

	const onToggle = async (_name: string, next: boolean) => {
		setBusy(true);
		try {
			await ipc.invoke('redis:setEnabled', site.id, next);
			setEnabled(next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const onObjectCacheToggle = async (_name: string, next: boolean) => {
		setBusy(true);
		try {
			await ipc.invoke('redis:setObjectCacheEnabled', site.id, next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const onCacheToggle = async (_name: string, next: boolean) => {
		setBusy(true);
		try {
			await ipc.invoke('redis:setCacheEnabled', site.id, next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const onVersionChange = async (next: string) => {
		setBusy(true);
		try {
			await ipc.invoke('redis:setVersion', site.id, next);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const versionOptions = React.useMemo(() => {
		const out: Record<string, string> = {};
		for (const v of status.supportedVersions) {
			out[v] = v === status.defaultVersion ? `${v} (default)` : v;
		}
		return out;
	}, [status.supportedVersions, status.defaultVersion]);

	const versionChangePending =
		!!status.deployedVersion && status.deployedVersion !== status.version;

	const siteHalted = site.status === 'halted' || site.status === 'stopped';
	const siteRunning = site.status === 'running';
	const stateLabel = !status.dockerAvailable
		? 'Docker not running'
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

	return (
		<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 14 }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<Switch tiny flat checked={enabled} disabled={busy} onChange={onToggle} />
				{enabled && status.dockerAvailable && !status.deployedVersion && (
					<span style={{ color: '#5d5e5e', fontSize: 14 }}>
						{siteRunning ? 'Restart site to create the container' : 'Start site to create the container'}
					</span>
				)}
			</div>
			<Field label="State">{stateLabel}</Field>
			<Field label="Host">
				{enabled && status.ready && status.hostUri ? (
					<span style={{ userSelect: 'text', cursor: 'text' }}>{status.hostUri}</span>
				) : (
					<span style={{ color: '#5d5e5e' }}>—</span>
				)}
			</Field>
			<Field label="Version">
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<FlySelect
						value={status.version || status.defaultVersion}
						options={versionOptions}
						disabled={!enabled || busy || !status.supportedVersions.length}
						onChange={onVersionChange}
					/>
					{enabled && status.dockerAvailable && versionChangePending && (
						<span style={{ color: '#5d5e5e', fontSize: 14 }}>Restart site to apply</span>
					)}
				</div>
			</Field>
			<Field label="Cache">
				<Switch
					tiny
					flat
					checked={status.cacheCurrent === true}
					disabled={!enabled || busy}
					onChange={onCacheToggle}
				/>
			</Field>
			<Field label="Object Cache">
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<Switch
						tiny
						flat
						checked={!!ocCurrent}
						disabled={!enabled || busy || !status.ready}
						onChange={onObjectCacheToggle}
					/>
					{ocMismatch && (
						<span style={{ color: '#f5c16c', fontSize: 14 }}>
							WP_REDIS_* in wp-config.php ({ocCurrent!.host}:{ocCurrent!.port}) doesn't match (127.0.0.1:{status.hostPort})
						</span>
					)}
				</div>
			</Field>
		</div>
	);
}

export default function (context: any): void {
	const { hooks, electron } = context;
	if (!hooks?.addContent) return;
	hooks.addContent('siteInfoUtilities', (site: SiteProps) => (
		<TableListRow alignMiddle key="redis" label="Redis">
			<RedisPanel site={site} electron={electron} />
		</TableListRow>
	));
}
