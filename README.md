# @cpzombie/pi-tool-limit-bumper

[pi](https://pi.dev) coding agent extension that raises pi's hardcoded tool
output limits and keeps them raised.

pi hardcodes a **50KB / 2000-line** output limit in its `read`/`bash`/
`grep`/`find`/`ls` tools. This extension patches the installed pi package
(constants only — no tool logic) to larger limits, and re-checks on every
session start, so a pi update never silently regresses the limits.

Defaults: **100KB / 4000 lines**.

## Install

```bash
pi install npm:@cpzombie/pi-tool-limit-bumper
# or pinned to a version:
pi install npm:@cpzombie/pi-tool-limit-bumper@1.0.0
```

Uninstall:

```bash
pi remove npm:@cpzombie/pi-tool-limit-bumper
```

## Configuration

Limits are chosen with the following precedence (highest first):

1. **Env vars** — `PI_TOOL_LIMIT_KB=150 PI_TOOL_MAX_LINES=6000 pi`
   (non-interactive runs, per-session overrides, CI)
2. **Saved choice** — the value you picked via the first-boot prompt or
   the `/tool-limit` command, stored in
   `~/.pi/agent/pi-tool-limit-bumper.json`
3. **First-boot prompt** — on the first TUI/RPC session where nothing is
   configured yet, pi asks once: *Tool output limit (KB)* and *Max output
   lines* (Esc keeps the default). The answer is saved for future sessions.
4. **Default** — 100KB / 4000 lines

Change the limits at any time with the **`/tool-limit`** command:
*Set new limits*, *Show current*, or *Reset to defaults*.

Note: the patch is applied from pi's **stock** limits (50KB / 2000 lines).
If pi is currently patched to a different value than your setting, the
extension leaves the package alone and tells you to update or reinstall pi
(e.g. `pi update`) — once the files are back to stock, your saved limits
are applied automatically on the next start.

Also available:

```bash
PI_TOOL_LIMIT_PKG_DIR=/path/to/pi-package pi   # pin a specific install
```

## Behavior

On every session start:

- **already patched** → silent no-op
- **unpatched + writable** → patches, notifies "restart pi to activate"
  (the running process already has the old code in memory)
- **unpatched + not writable** (typical after a root `npm i -g`) → notifies
  with the exact `chmod -R a+w <pi package dir>` command needed
- **constants unrecognized** (upstream refactor) → notifies an error and
  never touches files it doesn't understand

If a future pi release refactors the constants, the extension surfaces a
clear error instead of half-patching.

## Notes

- Why patch files instead of overriding the tools? The public tool
  factories (`createReadTool`, `createBashTool`, …) have no truncation
  options, and the `tool_result` hook fires after truncation — the
  built-in limits are only reachable by patching the installed package.
- Extension is TypeScript, loaded by pi via jiti — no build step.
- `@earendil-works/pi-coding-agent` is a peer dependency provided by your
  pi installation; it is not bundled here.
