import { execFile, type ExecFileException } from 'child_process';
import * as os from 'os';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const CONTAINER_PREFIX = 'localwp-redis-';
const IMAGE_LABEL = 'com.localwp.redisImage';
const SITE_LABEL = 'com.localwp.siteId';
const REDIS_PORT = '6379/tcp';

const QUERY_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 10 * 60_000;

const FALLBACK_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export const CONTAINER_LABEL = 'com.localwp.addon=redis';

export type DockerErrorKind = 'not-found' | 'timeout' | 'failed';

export class DockerError extends Error {
	public readonly cause?: unknown;
	public readonly stderr: string;
	public readonly kind: DockerErrorKind;

	constructor(
		message: string,
		options: { cause?: unknown; stderr?: string; kind?: DockerErrorKind } = {}
	) {
		super(message);
		this.name = 'DockerError';
		this.cause = options.cause;
		this.stderr = options.stderr ?? '';
		this.kind = options.kind ?? 'failed';
	}
}

export type DockerAvailability = { available: boolean; error: string | null };

export type ContainerInfo = {
	name: string;
	running: boolean;
	image: string | null;
	version: string | null;
	hostPort: number | null;
};

export type ManagedContainer = { name: string; siteId: string; running: boolean };

export type ReadyResult =
	| { state: 'ready' }
	| { state: 'timeout' }
	| { state: 'exited'; logs: string }
	| { state: 'missing' };

let dockerBin: string | null = null;
let hostPlatformCache: string | null = null;
const manifestCache = new Map<string, Set<string>>();
const manifestFailures = new Set<string>();

export function containerNameFor(siteId: string): string {
	return `${CONTAINER_PREFIX}${siteId}`;
}

export function volumeNameFor(siteId: string): string {
	return `${CONTAINER_PREFIX}${siteId}-data`;
}

export function hostUriFor(port: number): string {
	return `redis://127.0.0.1:${port}`;
}

/**
 * Compares dotted version strings numerically. Returns a negative number when
 * `a` is lower than `b`, zero when equal and a positive number when higher.
 */
export function compareVersions(a: string, b: string): number {
	const left = a.split('.').map((part) => parseInt(part, 10) || 0);
	const right = b.split('.').map((part) => parseInt(part, 10) || 0);
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Returns the combined text of an error and every error in its cause chain,
 * including captured Docker stderr.
 */
export function errorText(err: unknown): string {
	const parts: string[] = [];
	let current: unknown = err;
	for (let depth = 0; current && depth < 5; depth++) {
		if (current instanceof DockerError) {
			parts.push(current.message, current.stderr);
			current = current.cause;
		} else if (current instanceof Error) {
			parts.push(current.message);
			current = (current as { cause?: unknown }).cause;
		} else {
			parts.push(String(current));
			current = null;
		}
	}
	return parts.filter(Boolean).join('\n');
}

export function isPortConflict(err: unknown): boolean {
	return /port is already allocated|address already in use/i.test(errorText(err));
}

export async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

export async function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.unref();
		srv.once('error', () => resolve(false));
		srv.listen(port, '127.0.0.1', () => {
			srv.close(() => resolve(true));
		});
	});
}

export async function checkDockerAvailable(): Promise<DockerAvailability> {
	try {
		await runDocker(['info', '--format', '{{.ServerVersion}}']);
		return { available: true, error: null };
	} catch (err) {
		return { available: false, error: describeUnavailable(err) };
	}
}

/**
 * Inspects the site's container. Returns null when it does not exist and
 * throws a DockerError for any other failure.
 */
export async function inspectContainer(siteId: string): Promise<ContainerInfo | null> {
	const name = containerNameFor(siteId);
	let stdout: string;
	try {
		({ stdout } = await runDocker(['container', 'inspect', name]));
	} catch (err) {
		if (isNoSuchObject(err)) return null;
		throw err;
	}

	const [data] = JSON.parse(stdout) as {
		State?: { Running?: boolean };
		Config?: { Labels?: Record<string, string> | null };
		HostConfig?: { PortBindings?: Record<string, { HostPort?: string }[] | null> | null };
	}[];
	if (!data) return null;

	const image = data.Config?.Labels?.[IMAGE_LABEL] || null;
	const binding = data.HostConfig?.PortBindings?.[REDIS_PORT]?.[0]?.HostPort ?? '';
	const hostPort = /^\d+$/.test(binding) ? parseInt(binding, 10) : null;

	return {
		name,
		running: Boolean(data.State?.Running),
		image,
		version: image ? image.split(':').pop() ?? null : null,
		hostPort,
	};
}

export async function removeContainer(siteId: string): Promise<void> {
	await removeContainerByName(containerNameFor(siteId));
}

export async function removeContainerByName(name: string): Promise<void> {
	try {
		await runDocker(['rm', '-f', name], ACTION_TIMEOUT_MS);
	} catch (err) {
		if (isNoSuchObject(err)) return;
		throw new DockerError(`Failed to remove Redis container ${name}.`, { cause: err });
	}
}

export async function removeVolume(siteId: string): Promise<void> {
	const volume = volumeNameFor(siteId);
	try {
		await runDocker(['volume', 'rm', '-f', volume], ACTION_TIMEOUT_MS);
	} catch (err) {
		if (isNoSuchObject(err)) return;
		throw new DockerError(`Failed to remove Redis volume ${volume}.`, { cause: err });
	}
}

/**
 * Creates or starts the site's container on the given version and host port.
 *
 * An existing container is reused only when its image and published port both
 * match. Otherwise it is recreated. Moving to a lower version also removes the
 * data volume, because older Redis releases cannot read newer data files.
 */
export async function startContainer(
	siteId: string,
	version: string,
	hostPort: number,
	dataVersion: string | null
): Promise<void> {
	const name = containerNameFor(siteId);
	const volume = volumeNameFor(siteId);
	const image = imageFor(version);
	const info = await inspectContainer(siteId);

	if (info) {
		if (info.image === image && info.hostPort === hostPort) {
			if (info.running) return;
			try {
				await runDocker(['start', name], ACTION_TIMEOUT_MS);
				return;
			} catch (err) {
				throw await startFailure(name, `Failed to start Redis container ${name}.`, err);
			}
		}

		await removeContainer(siteId);
	}

	// The container's image is the best record of the data format. Without a
	// container, fall back to the version that last started on this volume.
	const volumeVersion = info?.version ?? dataVersion;
	const versionOrder = volumeVersion ? compareVersions(version, volumeVersion) : 0;
	if (versionOrder < 0) {
		await removeVolume(siteId);
	}

	const platform = await prepareImage(image);
	const args = [
		'run',
		'-d',
		...(platform ? ['--platform', platform] : []),
		'--name', name,
		'--label', CONTAINER_LABEL,
		'--label', `${SITE_LABEL}=${siteId}`,
		'--label', `${IMAGE_LABEL}=${image}`,
		'-v', `${volume}:/data`,
		'-p', `127.0.0.1:${hostPort}:6379`,
		image,
		'redis-server',
		'--appendonly',
		'yes',
	];

	try {
		await runDocker(args, ACTION_TIMEOUT_MS);
	} catch (err) {
		throw await startFailure(name, `Failed to start Redis ${version} for site ${siteId}.`, err);
	}
}

/**
 * Makes the image available locally for the platform the container will run
 * on and returns that platform, or null when it cannot be determined. The
 * pull runs under the long pull timeout so `docker run` never has to pull
 * inside the shorter action timeout.
 */
async function prepareImage(image: string): Promise<string | null> {
	const local = await localImagePlatform(image);
	const host = await hostPlatform();
	if (local === host) return host;

	const target = await platformFor(image, host);
	if (target !== null && local === target) return target;
	if (target === null && local !== null) return null;

	try {
		await runDocker(['pull', ...(target ? ['--platform', target] : []), image], PULL_TIMEOUT_MS);
	} catch (err) {
		throw new DockerError(`Failed to pull ${image}.`, { cause: err });
	}
	return target;
}

/**
 * Returns the `os/architecture` of the local image, or null when the image is
 * not present.
 */
async function localImagePlatform(image: string): Promise<string | null> {
	try {
		const { stdout } = await runDocker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]);
		const platform = stdout.trim();
		return platform || null;
	} catch (err) {
		if (isNoSuchObject(err)) return null;
		throw err;
	}
}

/**
 * Error for a failed `docker run` or `docker start`. A container left in the
 * `created` state after a timeout means the Docker daemon is not starting
 * containers, which a Docker restart fixes.
 */
async function startFailure(name: string, message: string, err: unknown): Promise<DockerError> {
	if (err instanceof DockerError && err.kind === 'timeout') {
		const state = await containerState(name).catch(() => null);
		if (state === 'created') {
			return new DockerError(
				'Docker created the Redis container but did not start it. Restart Docker, then start the site again.',
				{ cause: err }
			);
		}
	}
	return new DockerError(message, { cause: err });
}

async function containerState(name: string): Promise<string> {
	const { stdout } = await runDocker(['inspect', '--type', 'container', '--format', '{{.State.Status}}', name]);
	return stdout.trim();
}

export async function stopContainer(siteId: string): Promise<void> {
	return stopContainerByName(containerNameFor(siteId));
}

export async function stopContainerByName(name: string): Promise<void> {
	try {
		await runDocker(['stop', name], ACTION_TIMEOUT_MS);
	} catch (err) {
		if (isNoSuchObject(err)) return;
		throw new DockerError(`Failed to stop Redis container ${name}.`, { cause: err });
	}
}

/**
 * Pings Redis inside the container. A missing or stopped container, or a
 * server that does not answer yet, is a normal false. Failures to reach
 * Docker itself are thrown.
 */
export async function isRedisReady(siteId: string): Promise<boolean> {
	try {
		const { stdout } = await runDocker(['exec', containerNameFor(siteId), 'redis-cli', 'ping']);
		const reply = stdout.trim();
		return reply === 'PONG';
	} catch (err) {
		if (isDockerUnreachable(err)) throw err;
		return false;
	}
}

export async function containerLogs(siteId: string, lines = 20): Promise<string> {
	try {
		const { stdout, stderr } = await runDocker(['logs', '--tail', String(lines), containerNameFor(siteId)]);
		return [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n');
	} catch (err) {
		return `Unable to read container logs: ${errorText(err)}`;
	}
}

/**
 * Polls until Redis answers, the container stops, or the timeout passes.
 */
export async function waitForRedisReady(siteId: string, timeoutMs = 30_000): Promise<ReadyResult> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const info = await inspectContainer(siteId);
		if (!info) return { state: 'missing' };
		if (!info.running) {
			const logs = await containerLogs(siteId);
			return { state: 'exited', logs };
		}
		if (await isRedisReady(siteId)) return { state: 'ready' };
		await new Promise((r) => setTimeout(r, 1000));
	}
	return { state: 'timeout' };
}

/**
 * Lists every container carrying the add-on label, running or not.
 */
export async function listManagedContainers(): Promise<ManagedContainer[]> {
	const { stdout } = await runDocker([
		'ps',
		'-a',
		'--filter', `label=${CONTAINER_LABEL}`,
		'--format', `{{.Names}}\t{{.Label "${SITE_LABEL}"}}\t{{.State}}`,
	]);

	const containers: ManagedContainer[] = [];
	for (const line of stdout.split('\n')) {
		const [name, label, state] = line.trim().split('\t');
		if (!name) continue;
		const siteId = label || (name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : '');
		containers.push({ name, siteId, running: state === 'running' });
	}
	return containers;
}

/**
 * Lists the site IDs that own a data volume created by the add-on.
 */
export async function listManagedVolumeSiteIds(): Promise<string[]> {
	const { stdout } = await runDocker([
		'volume',
		'ls',
		'--filter', `name=${CONTAINER_PREFIX}`,
		'--format', '{{.Name}}',
	]);

	const pattern = new RegExp(`^${CONTAINER_PREFIX}([A-Za-z0-9_-]+)-data$`);
	const siteIds: string[] = [];
	for (const line of stdout.split('\n')) {
		const match = pattern.exec(line.trim());
		if (match) siteIds.push(match[1]);
	}
	return siteIds;
}

function imageFor(version: string): string {
	return `redis:${version}`;
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves the Docker CLI on every call until one of the known install
 * locations exists, so installing Docker while Local runs needs no restart.
 */
function resolveDockerBin(): string {
	if (dockerBin) return dockerBin;

	const home = os.homedir();
	const candidates = [
		'/opt/homebrew/bin/docker',
		'/usr/local/bin/docker',
		'/Applications/Docker.app/Contents/Resources/bin/docker',
		path.join(home, '.docker/bin/docker'),
		path.join(home, '.rd/bin/docker'),
		path.join(home, '.rancher-desktop/bin/docker'),
		'/usr/bin/docker',
	];

	for (const candidate of candidates) {
		if (isExecutable(candidate)) {
			dockerBin = candidate;
			return candidate;
		}
	}

	return 'docker';
}

/**
 * Electron apps launched from Finder get a minimal PATH. Docker needs its own
 * directory and the Homebrew paths on PATH to find credential helpers and
 * CLI plugins.
 */
function dockerEnv(bin: string): NodeJS.ProcessEnv {
	const binDirs = path.isAbsolute(bin) ? [path.dirname(bin)] : [];
	const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	const dirs = Array.from(new Set([...binDirs, ...FALLBACK_PATH_DIRS, ...current]));
	return { ...process.env, PATH: dirs.join(path.delimiter) };
}

function runDocker(args: string[], timeout = QUERY_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
	const bin = resolveDockerBin();
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			{ timeout, env: dockerEnv(bin), maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (!err) {
					resolve({ stdout: String(stdout), stderr: String(stderr) });
					return;
				}
				reject(toDockerError(bin, args, err, String(stderr ?? '')));
			}
		);
	});
}

function toDockerError(
	bin: string,
	args: string[],
	err: ExecFileException,
	stderr: string
): DockerError {
	const code = err.code;
	if (code === 'ENOENT' || code === 127) {
		return new DockerError(
			`Docker executable not found (tried ${bin}). Install Docker Desktop, Colima or Rancher Desktop.`,
			{ cause: err, stderr, kind: 'not-found' }
		);
	}

	if (err.killed) {
		return new DockerError(
			`Docker did not respond in time (docker ${args[0]}).`,
			{ cause: err, stderr, kind: 'timeout' }
		);
	}

	const detail = stderr.trim() || err.message;
	return new DockerError(`docker ${args[0]} failed: ${detail}`, { cause: err, stderr });
}

function isNoSuchObject(err: unknown): boolean {
	return err instanceof DockerError &&
		err.kind === 'failed' &&
		/No such (container|object|volume|image)/i.test(err.stderr);
}

function isDockerUnreachable(err: unknown): boolean {
	if (!(err instanceof DockerError)) return true;
	if (err.kind !== 'failed') return true;
	return /Cannot connect to the Docker daemon|error during connect|Is the docker daemon running/i.test(err.stderr);
}

function describeUnavailable(err: unknown): string {
	if (err instanceof DockerError && err.kind === 'not-found') {
		return err.message;
	}

	const detail = err instanceof DockerError ? (err.stderr.trim() || err.message) : errorText(err);
	return `Docker is not reachable: ${detail}. Start Docker Desktop. With Colima or Rancher Desktop, make sure the engine is running and the active \`docker context\` points at it.`;
}

function mapArchitecture(arch: string): string | null {
	switch (arch) {
		case 'aarch64':
		case 'arm64':
			return 'linux/arm64';
		case 'x86_64':
		case 'amd64':
		case 'x64':
			return 'linux/amd64';
		default:
			return null;
	}
}

/**
 * Uses the Docker engine's architecture, since os.arch() reports Local's own
 * architecture, which differs when Local runs under Rosetta.
 */
async function hostPlatform(): Promise<string> {
	if (hostPlatformCache) return hostPlatformCache;
	try {
		const { stdout } = await runDocker(['info', '--format', '{{.Architecture}}']);
		const platform = mapArchitecture(stdout.trim());
		if (platform) {
			hostPlatformCache = platform;
			return platform;
		}
	} catch {
		/* fall back to the local architecture */
	}
	return mapArchitecture(os.arch()) ?? 'linux/amd64';
}

async function imagePlatforms(image: string): Promise<Set<string> | null> {
	const cached = manifestCache.get(image);
	if (cached) return cached;
	if (manifestFailures.has(image)) return null;
	try {
		const { stdout } = await runDocker(['manifest', 'inspect', image], MANIFEST_TIMEOUT_MS);
		const parsed = JSON.parse(stdout) as {
			manifests?: { platform?: { os?: string; architecture?: string } }[];
		};
		const platforms = new Set<string>();
		for (const m of parsed.manifests ?? []) {
			const p = m.platform;
			if (p?.os && p.architecture) platforms.add(`${p.os}/${p.architecture}`);
		}
		manifestCache.set(image, platforms);
		return platforms;
	} catch {
		manifestFailures.add(image);
		return null;
	}
}

async function platformFor(image: string, host: string): Promise<string | null> {
	const available = await imagePlatforms(image);
	if (!available || available.size === 0) return null;
	if (available.has(host)) return host;
	return 'linux/amd64';
}
