import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as net from 'net';

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

const execAsync = promisify(exec);

const CONTAINER_PREFIX = 'localwp-redis-';
const IMAGE_LABEL = 'com.localwp.redisImage';

function hostPlatform(): string {
	return os.arch() === 'arm64' ? 'linux/arm64' : 'linux/amd64';
}

const manifestCache = new Map<string, Set<string>>();

async function imagePlatforms(image: string): Promise<Set<string>> {
	const cached = manifestCache.get(image);
	if (cached) return cached;
	const platforms = new Set<string>();
	try {
		const { stdout } = await execAsync(`docker manifest inspect ${image}`);
		const parsed = JSON.parse(stdout) as {
			manifests?: { platform?: { os?: string; architecture?: string } }[];
		};
		for (const m of parsed.manifests ?? []) {
			const p = m.platform;
			if (p?.os && p.architecture) platforms.add(`${p.os}/${p.architecture}`);
		}
	} catch {
		/* ignore; cache empty set */
	}
	manifestCache.set(image, platforms);
	return platforms;
}

async function platformFor(image: string): Promise<string | null> {
	const host = hostPlatform();
	const available = await imagePlatforms(image);
	if (available.size === 0) return null;
	if (available.has(host)) return host;
	return 'linux/amd64';
}

function imageFor(version: string): string {
	return `redis:${version}`;
}

export const CONTAINER_LABEL = 'com.localwp.addon=redis';

export class DockerError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = 'DockerError';
	}
}

export function containerNameFor(siteId: string): string {
	return `${CONTAINER_PREFIX}${siteId}`;
}

export function volumeNameFor(siteId: string): string {
	return `${CONTAINER_PREFIX}${siteId}-data`;
}

export async function isDockerAvailable(): Promise<boolean> {
	try {
		await execAsync('docker info');
		return true;
	} catch {
		return false;
	}
}

export async function isContainerRunning(siteId: string): Promise<boolean> {
	const name = containerNameFor(siteId);
	try {
		const { stdout } = await execAsync(
			`docker ps --filter "name=^/${name}$" --format "{{.Names}}"`
		);
		return stdout.trim() === name;
	} catch {
		return false;
	}
}

export async function getHostPort(siteId: string): Promise<number | null> {
	const name = containerNameFor(siteId);
	try {
		const { stdout } = await execAsync(`docker port ${name} 6379/tcp`);
		const line = stdout.split('\n').map((s) => s.trim()).find(Boolean);
		if (!line) return null;
		const port = line.split(':').pop();
		if (!port || !/^\d+$/.test(port)) return null;
		return parseInt(port, 10);
	} catch {
		return null;
	}
}

export async function getHostUri(siteId: string): Promise<string | null> {
	const port = await getHostPort(siteId);
	return port ? `redis://127.0.0.1:${port}` : null;
}

export async function getDeployedVersion(siteId: string): Promise<string | null> {
	const image = await inspectContainerImage(containerNameFor(siteId));
	if (!image) return null;
	const tag = image.split(':').pop();
	return tag ?? null;
}

async function inspectContainerImage(name: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(
			`docker inspect --format "{{ index .Config.Labels \\"${IMAGE_LABEL}\\" }}" ${name}`
		);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function containerExists(siteId: string): Promise<boolean> {
	const name = containerNameFor(siteId);
	try {
		const { stdout } = await execAsync(
			`docker ps -a --filter "name=^/${name}$" --format "{{.Names}}"`
		);
		return stdout.trim() === name;
	} catch {
		return false;
	}
}

export async function removeContainer(siteId: string): Promise<void> {
	const name = containerNameFor(siteId);
	try {
		await execAsync(`docker rm -f ${name}`);
	} catch {
		/* ignore — already gone */
	}
}

export async function startContainer(siteId: string, version: string, hostPort: number): Promise<void> {
	if (!(await isDockerAvailable())) {
		throw new DockerError('Docker is not running. Start Docker Desktop and try again.');
	}

	const name = containerNameFor(siteId);
	const volume = volumeNameFor(siteId);
	const image = imageFor(version);

	if (await isContainerRunning(siteId)) {
		const current = await inspectContainerImage(name);
		if (current === image) return;
		await removeContainer(siteId);
	} else if (await containerExists(siteId)) {
		const current = await inspectContainerImage(name);
		if (current === image) {
			await execAsync(`docker start ${name}`);
			return;
		}
		await removeContainer(siteId);
	}

	const platform = await platformFor(image);

	try {
		await execAsync(
			[
				'docker run -d',
				...(platform ? [`--platform ${platform}`] : []),
				`--name ${name}`,
				`--label ${CONTAINER_LABEL}`,
				`--label com.localwp.siteId=${siteId}`,
				`--label ${IMAGE_LABEL}=${image}`,
				`-v ${volume}:/data`,
				`-p 127.0.0.1:${hostPort}:6379`,
				image,
				'redis-server --appendonly yes',
			].join(' ')
		);
	} catch (err) {
		throw new DockerError(`Failed to start Redis ${version} for site ${siteId}.`, err);
	}
}

export async function stopContainer(siteId: string): Promise<void> {
	return stopContainerByName(containerNameFor(siteId));
}

export async function stopContainerByName(name: string): Promise<void> {
	try {
		await execAsync(`docker stop ${name}`);
	} catch (err) {
		throw new DockerError(`Failed to stop Redis container ${name}.`, err);
	}
}

export async function isRedisReady(siteId: string): Promise<boolean> {
	const name = containerNameFor(siteId);
	try {
		const { stdout } = await execAsync(`docker exec ${name} redis-cli ping`);
		return stdout.trim() === 'PONG';
	} catch {
		return false;
	}
}

export async function waitForRedisReady(siteId: string, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isRedisReady(siteId)) return true;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

export async function listRunningContainers(): Promise<string[]> {
	try {
		const { stdout } = await execAsync(
			`docker ps --filter "label=${CONTAINER_LABEL}" --format "{{.Names}}"`
		);
		return stdout.split('\n').map((n) => n.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

export async function findSiteNetwork(siteId: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync('docker network ls --format "{{.Name}}"');
		const networks = stdout.split('\n').map((n) => n.trim()).filter(Boolean);
		const match = networks.find((n) => n.includes(siteId)) ??
			networks.find((n) => /local(by_?flywheel)?|localwp/i.test(n));
		return match ?? null;
	} catch {
		return null;
	}
}

export async function connectToNetwork(siteId: string, network: string): Promise<void> {
	const name = containerNameFor(siteId);
	try {
		await execAsync(`docker network connect ${network} ${name}`);
	} catch (err: any) {
		const msg = String(err?.stderr ?? err?.message ?? '');
		if (/already exists in network/i.test(msg)) return;
		throw new DockerError(`Failed to connect ${name} to network ${network}.`, err);
	}
}

export async function ensureNetworkConnected(siteId: string): Promise<string | null> {
	const network = await findSiteNetwork(siteId);
	if (!network) return null;
	await connectToNetwork(siteId, network);
	return network;
}
