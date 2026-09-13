/**
 * pi-tool-limit-bumper.ts — pi extension: raises the built-in tool result limits
 * and re-applies the patch automatically after pi updates.
 *
 * pi hardcodes a 50KB / 2000-line output limit in its read/bash/grep/find/ls
 * tools. This extension patches the installed pi package (constants only —
 * no tool logic) to use larger limits, and re-checks on every session start
 * so an update never silently regresses the limits.
 *
 * Choosing limits (highest precedence first):
 *   1. env:    PI_TOOL_LIMIT_KB=150 PI_TOOL_MAX_LINES=6000 pi
 *   2. saved:  the choice made via the first-boot prompt or the /tool-limit
 *              command, stored in ~/.pi/agent/pi-tool-limit-bumper.json
 *   3. prompt: one-time interactive question at startup (TUI only;
 *              Esc keeps the default)
 *   4. default: 100KB / 4000 lines
 *   Plus: PI_TOOL_LIMIT_PKG_DIR=/path/to/pi-package (pin a specific install)
 *
 * Changing limits later: /tool-limit (set new limits, show current, reset
 * to defaults). Note: the patch only applies from pi's STOCK limits. If pi
 * is currently patched to a different value, the extension leaves it alone
 * and tells you to update/reinstall pi (e.g. `pi update`) — on the next
 * start, after the files are back to stock, your saved limits are applied.
 *
 * What it patches (constants only):
 *   1. dist/bundle (all .js files, incl. chunks/ in newer pi versions —
 *      the code the pi CLI actually runs):
 *      - every `51200` (the 50KB limit baked into the minified bundle) ->
 *        limitKB*1024. Covers truncation defaults, the 2x rolling output
 *        buffer, temp-file spill thresholds, truncation notices, tool
 *        descriptions.
 *      - the 2000-line limit, minified as `2e3`, but ONLY in its known
 *        limit-specific contexts. The minifier writes `2e3` for many
 *        unrelated values (timeouts, model context windows, image resize),
 *        so a blanket replace would be dangerous.
 *   2. dist/core/tools/truncate.js: DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES
 *      (the unbundled tree that extension imports resolve to).
 *
 * Behavior on session_start:
 *   - already patched        -> silent no-op (a few ms of file reads)
 *   - unpatched + writable   -> patches, notifies "restart pi to activate"
 *     (the running process already has the old code in memory)
 *   - unpatched + not
 *     writable (root-owned,  -> notifies with the exact chmod command
 *     typical after `npm i -g` as root)
 *   - constants differ from  -> notifies an error; never touches files it
 *     51200 / 2e3 (upstream   doesn't recognize
 *     refactor or new value)
 *   - patched to a different -> notifies that updating/reinstalling pi is
 *     value than configured    needed to apply the configured limits
 *
 * Verified against pi v0.84.3 and v0.85.1 (bundle split into chunks/;
 * the totalLines>2e3 site disappeared in 0.85.1 — harmless). If a future
 * pi release refactors the constants, the extension will surface a clear
 * error instead of half-patching.
 *
 * Install: `pi install npm:@cpzombie/pi-tool-limit-bumper` (or place in
 * ~/.pi/agent/extensions/ / .pi/extensions/ for a manual install).
 * Note: after a root npm update the package files are root-owned again, so
 * re-patching needs one of:
 *   - you re-run `chmod -R a+w <pi package dir>` (extension patches on next start)
 *   - or patch as root:  sudo node -e "..."  / manual edit
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	getPackageDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_LIMITS = { kb: 100, lines: 4000 };

const ORIGIN_BYTES = "51200"; // original 50KB literal in the minified bundle
const ORIGIN_KB = 50;
const ORIGIN_LINES = 2000;

const STATE_FILE_NAME = "pi-tool-limit-bumper.json";

export interface ToolLimits {
	/** Byte limit in KB (user-facing unit). */
	kb: number;
	/** Maximum output lines. */
	lines: number;
}

/** Limits as they physically exist in the installed pi package. */
interface CurrentLimits {
	bytes: number;
	lines: number;
}

export type PatchStatus = "patched" | "already" | "upstream-changed" | "write-error";

export interface PatchResult {
	status: PatchStatus;
	packageDir: string;
	/** Human-readable detail for notifications/logs. */
	detail?: string;
}

// ---------------------------------------------------------------------------
// Choice resolution (env / saved state)
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const n = Number(trimmed);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Limits from env vars; only entries that are valid positive integers. */
export function parseEnvLimits(): Partial<ToolLimits> {
	const out: Partial<ToolLimits> = {};
	const kb = parsePositiveInt(process.env.PI_TOOL_LIMIT_KB);
	const lines = parsePositiveInt(process.env.PI_TOOL_MAX_LINES);
	if (kb !== undefined) out.kb = kb;
	if (lines !== undefined) out.lines = lines;
	return out;
}

/** True when an env var is set but not a valid positive integer. */
export function hasInvalidEnvLimits(): boolean {
	return (
		(process.env.PI_TOOL_LIMIT_KB !== undefined && parsePositiveInt(process.env.PI_TOOL_LIMIT_KB) === undefined) ||
		(process.env.PI_TOOL_MAX_LINES !== undefined && parsePositiveInt(process.env.PI_TOOL_MAX_LINES) === undefined)
	);
}

function statePath(agentDir: string): string {
	return join(agentDir, STATE_FILE_NAME);
}

/** The user's saved choice (from the first-boot prompt or /tool-limit). */
export function readState(agentDir: string): ToolLimits | undefined {
	try {
		const data: unknown = JSON.parse(readFileSync(statePath(agentDir), "utf8"));
		if (
			typeof data === "object" &&
			data !== null &&
			Number.isInteger((data as ToolLimits).kb) &&
			(data as ToolLimits).kb > 0 &&
			Number.isInteger((data as ToolLimits).lines) &&
			(data as ToolLimits).lines > 0
		) {
			return { kb: (data as ToolLimits).kb, lines: (data as ToolLimits).lines };
		}
	} catch {
		// missing/corrupt -> no saved choice
	}
	return undefined;
}

export function writeState(agentDir: string, limits: ToolLimits): void {
	writeFileSync(statePath(agentDir), JSON.stringify(limits, null, "\t") + "\n");
}

export function clearState(agentDir: string): void {
	try {
		rmSync(statePath(agentDir));
	} catch {
		// not there
	}
}

// ---------------------------------------------------------------------------
// Core patch logic (pure file operations on the given package dir)
// ---------------------------------------------------------------------------

function count(haystack: string, needle: string): number {
	let n = 0;
	let idx = 0;
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		n++;
		idx += needle.length;
	}
	return n;
}

function* walkJs(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJs(full);
		else if (entry.name.endsWith(".js")) yield full;
	}
}

/**
 * Read the limits currently in place in the pi package from
 * dist/core/tools/truncate.js (readable source, stable form):
 *   DEFAULT_MAX_BYTES = 50 * 1024   (or a raw byte literal)
 *   DEFAULT_MAX_LINES = 2000
 * Undefined when the file or form is not recognizable.
 */
export function readCurrentLimits(packageDir: string): CurrentLimits | undefined {
	try {
		const src = readFileSync(join(packageDir, "dist", "core", "tools", "truncate.js"), "utf8");
		const b = src.match(/DEFAULT_MAX_BYTES\s*=\s*(\d+)(\s*\*\s*1024)?/);
		const l = src.match(/DEFAULT_MAX_LINES\s*=\s*(\d+)/);
		if (!b || !l) return undefined;
		return { bytes: Number(b[1]) * (b[2] ? 1024 : 1), lines: Number(l[1]) };
	} catch {
		return undefined;
	}
}

/**
 * True when the patch can be applied: the package is at pi's stock limits,
 * already at the target, or in an unrecognized state (the engine then
 * reports the error itself). When pi is currently patched to a *different*
 * known value, re-patching from scratch is not possible — the files must be
 * reset to stock (pi update / reinstall) first.
 */
export function isPatchingPossible(packageDir: string, target: ToolLimits): boolean {
	const current = readCurrentLimits(packageDir);
	if (!current) return true;
	const atOrigin = current.bytes === ORIGIN_KB * 1024 && current.lines === ORIGIN_LINES;
	const atTarget = current.bytes === target.kb * 1024 && current.lines === target.lines;
	return atOrigin || atTarget;
}

/**
 * Patch the pi package at `packageDir` to the target limits (from pi's
 * stock limits). Idempotent. Never throws: all outcomes are reported via
 * PatchResult.
 */
export function applyToolLimitPatch(packageDir: string, target: ToolLimits): PatchResult {
	const bundleDir = join(packageDir, "dist", "bundle");
	const truncatePath = join(packageDir, "dist", "core", "tools", "truncate.js");
	const problems: string[] = [];

	const TARGET_BYTES = String(target.kb * 1024);

	// Limit-specific contexts for the 2000-line limit in the minified bundle.
	// (Verified against v0.84.3: 1/1/6/2/1/4 sites; v0.85.1: the totalLines>
	// site is gone, the rest unchanged.)
	const LINE_PATTERNS: { origin: string; target: string }[] = [
		"DEFAULT_MAX_LINES=2e3",
		"DEFAULT_MAX_LINES2=2e3",
		"maxLines??2e3",
		"totalLines>2e3",
		"{maxLines:2e3,",
		"${2e3} lines",
	].map((origin) => ({ origin, target: origin.replace("2e3", String(target.lines)) }));

	// --- 1. Minified runtime bundle ---
	let byteReplaced = 0;
	let byteAlready = 0;
	let lineReplaced = 0;
	let lineAlready = 0;
	let writeFailed = false;

	try {
		for (const file of walkJs(bundleDir)) {
			let src = readFileSync(file, "utf8");
			let changed = false;

			const bOrig = count(src, ORIGIN_BYTES);
			if (bOrig > 0) {
				src = src.split(ORIGIN_BYTES).join(TARGET_BYTES);
				byteReplaced += bOrig;
				changed = true;
			} else {
				byteAlready += count(src, TARGET_BYTES);
			}

			for (const p of LINE_PATTERNS) {
				const n = count(src, p.origin);
				if (n > 0) {
					src = src.split(p.origin).join(p.target);
					lineReplaced += n;
					changed = true;
				} else {
					lineAlready += count(src, p.target);
				}
			}

			if (changed) {
				writeFileSync(file, src);
			}
		}
	} catch (err: any) {
		writeFailed = true;
		problems.push(`bundle: ${err?.message ?? err}`);
	}

	// --- 2. Unbundled tree (what extension imports resolve to) ---
	try {
		if (existsSync(truncatePath)) {
			let src = readFileSync(truncatePath, "utf8");
			const bytesOrigin = /DEFAULT_MAX_BYTES\s*=\s*50\s*\*\s*1024/;
			const linesOrigin = /DEFAULT_MAX_LINES\s*=\s*2000/;
			const bytesTarget = new RegExp(`DEFAULT_MAX_BYTES\\s*=\\s*${target.kb}\\s*\\*\\s*1024`);
			const linesTarget = new RegExp(`DEFAULT_MAX_LINES\\s*=\\s*${target.lines}\\b`);
			const hadOrigin = bytesOrigin.test(src) || linesOrigin.test(src);
			if (hadOrigin) {
				if (bytesOrigin.test(src)) src = src.replace(bytesOrigin, `DEFAULT_MAX_BYTES = ${target.kb} * 1024`);
				if (linesOrigin.test(src)) src = src.replace(linesOrigin, `DEFAULT_MAX_LINES = ${target.lines}`);
				// Cosmetic: keep nearby comments accurate
				src = src.replace(/\/\/\s*\d+KB\b/g, `// ${target.kb}KB (patched by pi-tool-limit-bumper extension)`);
				src = src.replace(/\(default:\s*\d+ lines\)/, `(default: ${target.lines} lines)`);
				writeFileSync(truncatePath, src);
			} else if (!bytesTarget.test(src) || !linesTarget.test(src)) {
				problems.push("truncate.js: DEFAULT_MAX_BYTES/DEFAULT_MAX_LINES not in recognized form");
			}
		} else {
			problems.push("truncate.js not found (package layout changed?)");
		}
	} catch (err: any) {
		writeFailed = true;
		problems.push(`truncate.js: ${err?.message ?? err}`);
	}

	// --- 3. Classify the outcome ---
	if (writeFailed) {
		return { status: "write-error", packageDir, detail: problems.join("; ") };
	}

	// Unrecognized constant values (upstream refactor, or a limit someone set
	// by hand) — never touch files we don't understand.
	if (byteReplaced === 0 && byteAlready === 0) {
		problems.push(`bundle: neither ${ORIGIN_BYTES} nor ${TARGET_BYTES} found — pi's byte-limit constant changed?`);
	}
	if (lineReplaced === 0 && lineAlready === 0) {
		problems.push("bundle: no line-limit patterns (2e3 or target) found — pi's line-limit constant changed?");
	}

	if (problems.length > 0) {
		return { status: "upstream-changed", packageDir, detail: problems.join("; ") };
	}
	if (byteReplaced > 0 || lineReplaced > 0) {
		return {
			status: "patched",
			packageDir,
			detail: `bytes ${byteReplaced}x, lines ${lineReplaced}x -> ${target.kb}KB / ${target.lines} lines`,
		};
	}
	return { status: "already", packageDir };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notifyPatchResult(ctx: Pick<ExtensionContext, "hasUI" | "ui">, result: PatchResult): void {
	if (!ctx.hasUI) return; // silent in print/json modes
	switch (result.status) {
		case "patched":
			ctx.ui.notify(
				`pi was updated — re-applied tool-limit patch (${result.detail}). Restart pi to activate it in a new process.`,
				"info",
			);
			break;
		case "write-error":
			ctx.ui.notify(
				`pi was updated and the tool-limit patch needs permissions (${result.detail}). As root: chmod -R a+w ${result.packageDir}`,
				"error",
			);
			break;
		case "upstream-changed":
			ctx.ui.notify(
				`tool-limit auto-patch no longer recognizes pi's constants (${result.detail}). Review the pi-tool-limit-bumper extension.`,
				"error",
			);
			break;
		case "already":
			break; // silent no-op
	}
}

/**
 * Apply the target limits if the package is in a patchable state; otherwise
 * explain what is needed. Returns true when the package now matches (or
 * already matched) the target.
 */
function applyOrExplain(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	packageDir: string,
	agentDir: string,
	target: ToolLimits,
): void {
	if (isPatchingPossible(packageDir, target)) {
		notifyPatchResult(ctx, applyToolLimitPatch(packageDir, target));
		return;
	}
	const current = readCurrentLimits(packageDir);
	if (ctx.hasUI && current) {
		ctx.ui.notify(
			`tool limits: pi is currently patched to ${Math.round(current.bytes / 1024)}KB / ${current.lines} lines, but your setting is ${target.kb}KB / ${target.lines} lines. Updating or reinstalling pi (e.g. \`pi update\`) resets it to stock limits — your setting will be applied automatically on the next start.`,
			"info",
		);
	}
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const packageDir = process.env.PI_TOOL_LIMIT_PKG_DIR || getPackageDir();
			const agentDir = getAgentDir();

			if (hasInvalidEnvLimits()) {
				ctx.ui.notify(
					"PI_TOOL_LIMIT_KB / PI_TOOL_MAX_LINES must be positive integers — ignoring invalid value(s).",
					"warning",
				);
			}

			const env = parseEnvLimits();
			const envActive = env.kb !== undefined || env.lines !== undefined;
			const state = envActive ? undefined : readState(agentDir);

			// One-time interactive choice when nothing was configured yet.
			let prompted: ToolLimits | undefined;
			if (!envActive && !state && ctx.hasUI) {
				const kbAnswer = await ctx.ui.input("Tool output limit (KB):", String(DEFAULT_LIMITS.kb));
				const linesAnswer = await ctx.ui.input("Max output lines:", String(DEFAULT_LIMITS.lines));
				prompted = {
					kb: parsePositiveInt(kbAnswer) ?? DEFAULT_LIMITS.kb,
					lines: parsePositiveInt(linesAnswer) ?? DEFAULT_LIMITS.lines,
				};
				writeState(agentDir, prompted);
				ctx.ui.notify("tool limits saved for future sessions.", "info");
			}

			const target: ToolLimits = {
				kb: env.kb ?? prompted?.kb ?? state?.kb ?? DEFAULT_LIMITS.kb,
				lines: env.lines ?? prompted?.lines ?? state?.lines ?? DEFAULT_LIMITS.lines,
			};
			applyOrExplain(ctx, packageDir, agentDir, target);
		} catch (err: any) {
			// Never break pi startup because of this extension.
			if (ctx.hasUI) {
				ctx.ui.notify(`tool-limit patch check failed: ${err?.message ?? err}`, "error");
			}
		}
	});

	pi.registerCommand("tool-limit", {
		description: "Configure pi's tool output limits (KB / max lines)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const packageDir = process.env.PI_TOOL_LIMIT_PKG_DIR || getPackageDir();
			const agentDir = getAgentDir();
			const current = readCurrentLimits(packageDir);
			const state = readState(agentDir);
			const env = parseEnvLimits();
			const envActive = env.kb !== undefined || env.lines !== undefined;

			const choice = await ctx.ui.select("Tool output limits", [
				"Set new limits",
				"Show current",
				`Reset to defaults (${DEFAULT_LIMITS.kb}KB / ${DEFAULT_LIMITS.lines} lines)`,
				"Cancel",
			]);

			if (choice === "Show current") {
				const inPackage = current
					? `${Math.round(current.bytes / 1024)}KB / ${current.lines} lines`
					: "unrecognized (not patched?)";
				const desired = `${env.kb ?? state?.kb ?? DEFAULT_LIMITS.kb}KB / ${env.lines ?? state?.lines ?? DEFAULT_LIMITS.lines} lines`;
				const source = envActive ? "env" : state ? `saved (${STATE_FILE_NAME})` : "default";
				ctx.ui.notify(`pi package: ${inPackage}; your setting: ${desired} (${source}).`, "info");
				return;
			}

			if (choice?.startsWith("Reset to defaults")) {
				clearState(agentDir);
				ctx.ui.notify(`tool limits reset to defaults (${DEFAULT_LIMITS.kb}KB / ${DEFAULT_LIMITS.lines} lines; saved choice cleared).`, "info");
				applyOrExplain(ctx, packageDir, agentDir, DEFAULT_LIMITS);
				return;
			}

			if (choice !== "Set new limits") return;

			const kbAnswer = await ctx.ui.input("Tool output limit (KB):", String(state?.kb ?? DEFAULT_LIMITS.kb));
			if (kbAnswer === undefined) return; // cancelled
			const linesAnswer = await ctx.ui.input("Max output lines:", String(state?.lines ?? DEFAULT_LIMITS.lines));
			if (linesAnswer === undefined) return; // cancelled
			const kb = parsePositiveInt(kbAnswer);
			const lines = parsePositiveInt(linesAnswer);
			if (kb === undefined || lines === undefined) {
				ctx.ui.notify("Limits must be positive integers.", "error");
				return;
			}
			writeState(agentDir, { kb, lines });
			applyOrExplain(ctx, packageDir, agentDir, { kb, lines });
		},
	});
}
