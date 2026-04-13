import { promises as fs } from 'fs';
import * as path from 'path';
import type { Site } from '@getflywheel/local';

const REDIS_BEGIN = '// BEGIN Local Redis';
const REDIS_END = '// END Local Redis';
const CACHE_BEGIN = '// BEGIN Local Cache';
const CACHE_END = '// END Local Cache';

const REDIS_RE = new RegExp(`\\n?${REDIS_BEGIN}[\\s\\S]*?${REDIS_END}\\n?`, 'g');
const CACHE_RE = new RegExp(`\\n?${CACHE_BEGIN}[\\s\\S]*?${CACHE_END}\\n?`, 'g');

function wpConfigPath(site: Site): string | null {
	const webRoot = (site as any).paths?.webRoot;
	if (!webRoot) return null;
	return path.join(webRoot, 'wp-config.php');
}

function stripAll(contents: string, re: RegExp): string {
	return contents.replace(re, '\n');
}

function insertBlock(contents: string, block: string): string {
	const marker = /\/\*\s*That's all, stop editing!/i;
	if (marker.test(contents)) {
		return contents.replace(marker, `${block}\n\n$&`);
	}
	const phpOpen = contents.indexOf('<?php');
	if (phpOpen !== -1) {
		const after = phpOpen + '<?php'.length;
		return `${contents.slice(0, after)}\n${block}\n${contents.slice(after)}`;
	}
	return `${block}\n${contents}`;
}

function defineLineRegex(name: string): RegExp {
	return new RegExp(`define\\s*\\(\\s*(['"])${name}\\1\\s*,\\s*[^)]*\\)\\s*;?`, 'i');
}

// ────────── Redis (host/port) ──────────

function redisLines(host: string, port: number): string[] {
	return [
		`define( 'WP_REDIS_HOST', '${host}' );`,
		`define( 'WP_REDIS_PORT', ${port} );`,
	];
}

function buildRedisBlock(host: string, port: number): string {
	return [REDIS_BEGIN, ...redisLines(host, port), REDIS_END].join('\n');
}

export async function setRedisConstants(site: Site, host: string, port: number): Promise<boolean> {
	const file = wpConfigPath(site);
	if (!file) return false;
	try {
		let contents = await fs.readFile(file, 'utf8');
		const original = contents;

		// If our block exists, ensure it's current.
		if (contents.includes(REDIS_BEGIN)) {
			contents = contents.replace(REDIS_RE, `\n${buildRedisBlock(host, port)}\n`);
			if (contents !== original) await fs.writeFile(file, contents, 'utf8');
			return true;
		}

		// Update any existing outside defines in place; track which still need insertion.
		const missing: string[] = [];

		const hostRe = defineLineRegex('WP_REDIS_HOST');
		if (hostRe.test(contents)) {
			contents = contents.replace(hostRe, `define( 'WP_REDIS_HOST', '${host}' );`);
		} else {
			missing.push(`define( 'WP_REDIS_HOST', '${host}' );`);
		}

		const portRe = defineLineRegex('WP_REDIS_PORT');
		if (portRe.test(contents)) {
			contents = contents.replace(portRe, `define( 'WP_REDIS_PORT', ${port} );`);
		} else {
			missing.push(`define( 'WP_REDIS_PORT', ${port} );`);
		}

		if (missing.length > 0) {
			const block = [REDIS_BEGIN, ...missing, REDIS_END].join('\n');
			contents = insertBlock(contents, block);
		}

		if (contents === original) return true;
		await fs.writeFile(file, contents, 'utf8');
		return true;
	} catch (err) {
		console.warn(`[redis] Failed to write WP_REDIS_* for ${site.name}:`, err);
		return false;
	}
}

export type RedisConstants = { host: string; port: number };

export async function getRedisConstants(site: Site): Promise<RedisConstants | null> {
	const file = wpConfigPath(site);
	if (!file) return null;
	try {
		const contents = await fs.readFile(file, 'utf8');
		const hostMatch = contents.match(/define\s*\(\s*['"]WP_REDIS_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/);
		const portMatch = contents.match(/define\s*\(\s*['"]WP_REDIS_PORT['"]\s*,\s*(\d+)\s*\)/);
		if (!hostMatch || !portMatch) return null;
		return { host: hostMatch[1], port: parseInt(portMatch[1], 10) };
	} catch {
		return null;
	}
}

export async function removeRedisConstants(site: Site): Promise<boolean> {
	const file = wpConfigPath(site);
	if (!file) return false;
	try {
		const contents = await fs.readFile(file, 'utf8');
		if (!contents.includes(REDIS_BEGIN)) return true;
		const next = stripAll(contents, REDIS_RE);
		if (next === contents) return true;
		await fs.writeFile(file, next, 'utf8');
		return true;
	} catch (err) {
		console.warn(`[redis] Failed to remove WP_REDIS_* for ${site.name}:`, err);
		return false;
	}
}

// ────────── Cache (WP_CACHE) ──────────

function buildCacheBlock(value: boolean = true): string {
	return [CACHE_BEGIN, `define( 'WP_CACHE', ${value ? 'true' : 'false'} );`, CACHE_END].join('\n');
}

export async function setCacheConstant(site: Site): Promise<boolean> {
	const file = wpConfigPath(site);
	if (!file) return false;
	try {
		const contents = await fs.readFile(file, 'utf8');

		if (contents.includes(CACHE_BEGIN)) {
			const next = contents.replace(CACHE_RE, `\n${buildCacheBlock(true)}\n`);
			if (next === contents) return true;
			await fs.writeFile(file, next, 'utf8');
			return true;
		}

		const defRe = defineLineRegex('WP_CACHE');
		if (defRe.test(contents)) {
			const next = contents.replace(defRe, `define( 'WP_CACHE', true );`);
			if (next === contents) return true;
			await fs.writeFile(file, next, 'utf8');
			return true;
		}

		const next = insertBlock(contents, buildCacheBlock(true));
		if (next === contents) return true;
		await fs.writeFile(file, next, 'utf8');
		return true;
	} catch (err) {
		console.warn(`[redis] Failed to write WP_CACHE for ${site.name}:`, err);
		return false;
	}
}

export async function getCacheConstant(site: Site): Promise<boolean | null> {
	const file = wpConfigPath(site);
	if (!file) return null;
	try {
		const contents = await fs.readFile(file, 'utf8');
		const m = contents.match(/define\s*\(\s*['"]WP_CACHE['"]\s*,\s*(true|false|1|0)\s*\)/i);
		if (!m) return null;
		const v = m[1].toLowerCase();
		return v === 'true' || v === '1';
	} catch {
		return null;
	}
}

export async function removeCacheConstant(site: Site): Promise<boolean> {
	const file = wpConfigPath(site);
	if (!file) return false;
	try {
		const contents = await fs.readFile(file, 'utf8');

		if (contents.includes(CACHE_BEGIN)) {
			const next = stripAll(contents, CACHE_RE);
			if (next === contents) return true;
			await fs.writeFile(file, next, 'utf8');
			return true;
		}

		const defRe = defineLineRegex('WP_CACHE');
		if (defRe.test(contents)) {
			const next = contents.replace(defRe, `define( 'WP_CACHE', false );`);
			if (next === contents) return true;
			await fs.writeFile(file, next, 'utf8');
			return true;
		}

		return true;
	} catch (err) {
		console.warn(`[redis] Failed to remove WP_CACHE for ${site.name}:`, err);
		return false;
	}
}
