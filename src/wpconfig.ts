import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Site } from '@getflywheel/local';

export type WpConfigResult = { ok: true } | { ok: false; error: string };
export type RedisConstants = { host: string; port: number };

type BlockSpec = {
	begin: string;
	end: string;
	disabledPrefix: string;
	names: string[];
};

type Edit = { ok: true; contents: string } | { ok: false; error: string };

const REDIS_SPEC: BlockSpec = {
	begin: '// BEGIN Local Redis',
	end: '// END Local Redis',
	disabledPrefix: '// Disabled by Local Redis: ',
	names: [
		'WP_REDIS_HOST',
		'WP_REDIS_PORT',
		'WP_REDIS_GRACEFUL',
		'WP_REDIS_PASSWORD',
		'WP_REDIS_SCHEME',
		'WP_REDIS_PATH',
		'WP_REDIS_SERVERS',
		'WP_REDIS_CLUSTER',
		'WP_REDIS_SHARDS',
		'WP_REDIS_SENTINEL',
	],
};

const CACHE_SPEC: BlockSpec = {
	begin: '// BEGIN Local Cache',
	end: '// END Local Cache',
	disabledPrefix: '// Disabled by Local Cache: ',
	names: ['WP_CACHE'],
};

const STOP_EDITING_RE = /\/\*\s*That's all, stop editing!/i;

function wpConfigPath(site: Site): string | null {
	const webRoot = (site as any).paths?.webRoot;
	if (!webRoot) return null;
	return path.join(webRoot, 'wp-config.php');
}

function describeError(err: unknown, file: string): string {
	const code = (err as NodeJS.ErrnoException)?.code;
	switch (code) {
		case 'ENOENT':
			return `wp-config.php was not found at ${file}.`;
		case 'EACCES':
		case 'EPERM':
			return `Permission denied for ${file}. On macOS, Local may need file access (System Settings > Privacy & Security > Files and Folders or Full Disk Access).`;
		default:
			return `Could not update ${file}: ${err instanceof Error ? err.message : String(err)}`;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectEol(contents: string): string {
	return contents.includes('\r\n') ? '\r\n' : '\n';
}

// Block-matching regexes. `core` matches the marker lines and everything between them;
// `full` also consumes the trailing line break and one following blank line.
function blockRegex(spec: BlockSpec, full: boolean): RegExp {
	const begin = escapeRegExp(spec.begin);
	const end = escapeRegExp(spec.end);
	const core = `^[ \\t]*${begin}[ \\t]*\\r?\\n[\\s\\S]*?^[ \\t]*${end}[ \\t]*$`;
	const tail = full ? '(?:\\r?\\n|(?![\\s\\S]))(?:[ \\t]*\\r?\\n)?' : '';
	return new RegExp(core + tail, 'gm');
}

// Reports markers that do not pair up as BEGIN followed by END, in order.
// Repeated well-formed blocks are accepted.
function markerError(contents: string, spec: BlockSpec): string | null {
	const markers: Array<{ at: number; isBegin: boolean }> = [];
	const collect = (marker: string, isBegin: boolean): void => {
		const re = new RegExp(`^[ \\t]*${escapeRegExp(marker)}[ \\t]*$`, 'gm');
		let match = re.exec(contents);
		while (match) {
			markers.push({ at: match.index, isBegin });
			match = re.exec(contents);
		}
	};
	collect(spec.begin, true);
	collect(spec.end, false);
	markers.sort((a, b) => a.at - b.at);

	let open = false;
	let balanced = true;
	for (const marker of markers) {
		if (marker.isBegin === open) {
			balanced = false;
			break;
		}
		open = marker.isBegin;
	}
	if (balanced && !open) return null;
	return `The ${spec.begin} / ${spec.end} markers in wp-config.php are unbalanced. Fix them by hand and try again.`;
}

function findBlock(contents: string, spec: BlockSpec): RegExpExecArray | null {
	return blockRegex(spec, false).exec(contents);
}

// Returns a same-length copy of the source with comment bodies replaced by spaces
// (line breaks kept), so offsets map one-to-one onto the original text.
function maskComments(source: string): string {
	const out = source.split('');
	const length = source.length;
	const blank = (from: number, to: number): void => {
		for (let k = from; k < to; k++) {
			const ch = source[k];
			if (ch !== '\n' && ch !== '\r') out[k] = ' ';
		}
	};

	let i = 0;
	while (i < length) {
		const ch = source[i];
		const next = source[i + 1];

		if (ch === "'" || ch === '"') {
			i++;
			while (i < length && source[i] !== ch) {
				if (source[i] === '\\') i++;
				i++;
			}
			i++;
		} else if ((ch === '/' && next === '/') || ch === '#') {
			let eol = i;
			while (eol < length && source[eol] !== '\n' && source[eol] !== '\r') eol++;
			blank(i, eol);
			i = eol;
		} else if (ch === '/' && next === '*') {
			const close = source.indexOf('*/', i + 2);
			const stop = close === -1 ? length : close + 2;
			blank(i, stop);
			i = stop;
		} else {
			i++;
		}
	}

	return out.join('');
}

function stripStrings(text: string): string {
	return text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
}

function isSingleStatement(text: string): boolean {
	const code = stripStrings(text);
	const semicolons = code.split(';').length - 1;
	const opens = code.split('(').length - 1;
	const closes = code.split(')').length - 1;
	return semicolons === 1 && opens === closes;
}

function strictDefineRegex(names: string[]): RegExp {
	const alternatives = names.map(escapeRegExp).join('|');
	return new RegExp(
		`^[ \\t]*define[ \\t]*\\([ \\t]*(['"])(?:${alternatives})\\1[ \\t]*,.*\\)[ \\t]*;[ \\t]*(?:(?://|#).*)?$`,
		'gm',
	);
}

function looseDefineRegex(names: string[]): RegExp {
	const alternatives = names.map(escapeRegExp).join('|');
	return new RegExp(`\\bdefine\\s*\\(\\s*(['"])(${alternatives})\\1`, 'g');
}

// Comments out single-line defines of the spec's constants that live outside the add-on block.
function disableForeignDefines(contents: string, spec: BlockSpec, file: string): Edit {
	const mask = maskComments(contents).split('');
	const blockRe = blockRegex(spec, false);
	let blockMatch = blockRe.exec(contents);
	while (blockMatch) {
		for (let k = blockMatch.index; k < blockMatch.index + blockMatch[0].length; k++) {
			if (mask[k] !== '\n' && mask[k] !== '\r') mask[k] = ' ';
		}
		blockMatch = blockRe.exec(contents);
	}
	const masked = mask.join('');

	const strictStarts: number[] = [];
	const strictRanges: Array<[number, number]> = [];
	const strictRe = strictDefineRegex(spec.names);
	let strict = strictRe.exec(masked);
	while (strict) {
		if (isSingleStatement(strict[0])) {
			strictStarts.push(strict.index);
			strictRanges.push([strict.index, strict.index + strict[0].length]);
		}
		strict = strictRe.exec(masked);
	}

	// Every define of the constants must be a complete single-line statement, one per line.
	const looseRe = looseDefineRegex(spec.names);
	let looseCount = 0;
	let loose = looseRe.exec(masked);
	while (loose) {
		const at = loose.index;
		const covered = strictRanges.some(([from, to]) => at >= from && at < to);
		looseCount++;
		if (!covered) {
			return {
				ok: false,
				error: `${loose[2]} is defined in ${file} in a form the add-on cannot safely change. Remove that define manually and try again.`,
			};
		}
		loose = looseRe.exec(masked);
	}

	if (looseCount !== strictStarts.length) {
		return {
			ok: false,
			error: `${spec.names.join(' / ')} is defined in ${file} in a form the add-on cannot safely change. Remove that define manually and try again.`,
		};
	}

	let result = contents;
	for (let k = strictStarts.length - 1; k >= 0; k--) {
		const at = strictStarts[k];
		result = result.slice(0, at) + spec.disabledPrefix + result.slice(at);
	}
	return { ok: true, contents: result };
}

// Uncomments lines the add-on previously disabled for this block's constants.
function restoreForeignDefines(contents: string, spec: BlockSpec): string {
	const lineRe = new RegExp(`^${escapeRegExp(spec.disabledPrefix)}(.*)$`, 'gm');
	const original = strictDefineRegex(spec.names);
	return contents.replace(lineRe, (whole: string, rest: string) => {
		original.lastIndex = 0;
		const matches = original.exec(rest);
		const valid = matches !== null && matches[0] === rest;
		return valid ? rest : whole;
	});
}

function insertBlock(contents: string, block: string, eol: string): string {
	const stop = STOP_EDITING_RE.exec(contents);
	if (stop) {
		return `${contents.slice(0, stop.index)}${block}${eol}${eol}${contents.slice(stop.index)}`;
	}
	const phpOpen = contents.indexOf('<?php');
	if (phpOpen !== -1) {
		const after = phpOpen + '<?php'.length;
		return `${contents.slice(0, after)}${eol}${block}${eol}${contents.slice(after)}`;
	}
	return `${block}${eol}${contents}`;
}

function applyBlock(contents: string, spec: BlockSpec, lines: string[], file: string): Edit {
	const unbalanced = markerError(contents, spec);
	if (unbalanced) return { ok: false, error: unbalanced };

	const disabled = disableForeignDefines(contents, spec, file);
	if (!disabled.ok) return disabled;

	const eol = detectEol(contents);
	const next = disabled.contents;
	const block = [spec.begin, ...lines, spec.end].join(eol);

	const first = findBlock(next, spec);
	if (!first) {
		return { ok: true, contents: insertBlock(next, block, eol) };
	}

	const head = next.slice(0, first.index);
	const tail = next.slice(first.index + first[0].length).replace(blockRegex(spec, true), '');
	return { ok: true, contents: `${head}${block}${tail}` };
}

function removeBlock(contents: string, spec: BlockSpec): Edit {
	const unbalanced = markerError(contents, spec);
	if (unbalanced) return { ok: false, error: unbalanced };

	const stripped = contents.replace(blockRegex(spec, true), '');
	return { ok: true, contents: restoreForeignDefines(stripped, spec) };
}

// Removes the Redis block. When the Redis Object Cache drop-in is installed, a block holding
// only WP_REDIS_GRACEFUL stays so the drop-in tolerates the missing server. A restored or
// otherwise active WP_REDIS_GRACEFUL define makes the residual block unnecessary.
function removeRedisBlock(contents: string, dropIn: boolean): Edit {
	const unbalanced = markerError(contents, REDIS_SPEC);
	if (unbalanced) return { ok: false, error: unbalanced };

	const first = findBlock(contents, REDIS_SPEC);
	const stripped = removeBlock(contents, REDIS_SPEC);
	if (!stripped.ok || !first || !dropIn) return stripped;

	const active = maskComments(stripped.contents);
	if (looseDefineRegex(['WP_REDIS_GRACEFUL']).test(active)) return stripped;

	const eol = detectEol(contents);
	const residual = [REDIS_SPEC.begin, "define( 'WP_REDIS_GRACEFUL', true );", REDIS_SPEC.end].join(eol);
	const head = contents.slice(0, first.index);
	const tail = contents.slice(first.index + first[0].length).replace(blockRegex(REDIS_SPEC, true), '');
	return { ok: true, contents: restoreForeignDefines(`${head}${residual}${tail}`, REDIS_SPEC) };
}

async function writeAtomic(file: string, contents: string): Promise<void> {
	const target = await fs.realpath(file);
	const stat = await fs.stat(target);
	const suffix = crypto.randomBytes(4).toString('hex');
	const temp = path.join(path.dirname(target), `${path.basename(target)}.tmp-${process.pid}-${suffix}`);

	try {
		await fs.writeFile(temp, contents, { encoding: 'latin1', mode: stat.mode & 0o7777 });
		await fs.chmod(temp, stat.mode & 0o7777);
		await fs.rename(temp, target);
	} catch (err) {
		await fs.unlink(temp).catch(() => undefined);
		throw err;
	}
}

async function editConfig(site: Site, edit: (contents: string, file: string) => Edit): Promise<WpConfigResult> {
	const file = wpConfigPath(site);
	if (!file) return { ok: false, error: 'The site has no web root, so wp-config.php cannot be located.' };

	try {
		const contents = await fs.readFile(file, 'latin1');
		const result = edit(contents, file);
		if (!result.ok) return result;
		if (result.contents !== contents) await writeAtomic(file, result.contents);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: describeError(err, file) };
	}
}

async function readBlock(site: Site, spec: BlockSpec): Promise<string | null> {
	const file = wpConfigPath(site);
	if (!file) return null;
	try {
		const contents = await fs.readFile(file, 'latin1');
		if (markerError(contents, spec)) return null;
		const match = findBlock(contents, spec);
		return match ? match[0] : null;
	} catch {
		return null;
	}
}

// ────────── Redis (host/port) ──────────

export async function setRedisConstants(site: Site, host: string, port: number): Promise<WpConfigResult> {
	if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]+$/.test(host)) {
		return { ok: false, error: `Invalid Redis host: ${String(host)}.` };
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, error: `Invalid Redis port: ${String(port)}.` };
	}

	const lines = [
		`define( 'WP_REDIS_HOST', '${host}' );`,
		`define( 'WP_REDIS_PORT', ${port} );`,
		"define( 'WP_REDIS_GRACEFUL', true );",
	];
	return editConfig(site, (contents, file) => applyBlock(contents, REDIS_SPEC, lines, file));
}

export async function removeRedisConstants(site: Site): Promise<WpConfigResult> {
	const file = wpConfigPath(site);
	let dropIn = false;
	if (file) {
		const dropInFile = path.join(path.dirname(file), 'wp-content', 'object-cache.php');
		dropIn = await fs.access(dropInFile).then(
			() => true,
			() => false,
		);
	}
	return editConfig(site, (contents) => removeRedisBlock(contents, dropIn));
}

// Reports whether the Redis block markers in wp-config.php are balanced and the file is readable.
export async function checkRedisBlock(site: Site): Promise<WpConfigResult> {
	const file = wpConfigPath(site);
	if (!file) return { ok: false, error: 'The site has no web root, so wp-config.php cannot be located.' };
	try {
		const contents = await fs.readFile(file, 'latin1');
		const unbalanced = markerError(contents, REDIS_SPEC);
		if (unbalanced) return { ok: false, error: unbalanced };
		return { ok: true };
	} catch (err) {
		return { ok: false, error: describeError(err, file) };
	}
}

export async function getRedisConstants(site: Site): Promise<RedisConstants | null> {
	const block = await readBlock(site, REDIS_SPEC);
	if (!block) return null;
	const hostMatch = block.match(/define\s*\(\s*(['"])WP_REDIS_HOST\1\s*,\s*(['"])([^'"]*)\2\s*\)\s*;/);
	const portMatch = block.match(/define\s*\(\s*(['"])WP_REDIS_PORT\1\s*,\s*(\d+)\s*\)\s*;/);
	if (!hostMatch || !portMatch) return null;
	return { host: hostMatch[3], port: parseInt(portMatch[2], 10) };
}

// ────────── Cache (WP_CACHE) ──────────

export async function setCacheConstant(site: Site): Promise<WpConfigResult> {
	const lines = ["define( 'WP_CACHE', true );"];
	return editConfig(site, (contents, file) => applyBlock(contents, CACHE_SPEC, lines, file));
}

export async function removeCacheConstant(site: Site): Promise<WpConfigResult> {
	return editConfig(site, (contents) => removeBlock(contents, CACHE_SPEC));
}

export async function getCacheConstant(site: Site): Promise<boolean | null> {
	const block = await readBlock(site, CACHE_SPEC);
	if (!block) return null;
	const match = block.match(/define\s*\(\s*(['"])WP_CACHE\1\s*,\s*(true|false|1|0)\s*\)\s*;/i);
	if (!match) return null;
	const value = match[2].toLowerCase();
	return value === 'true' || value === '1';
}
