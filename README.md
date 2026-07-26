# OpenCode JavaScript REPL

A project-local OpenCode plugin that ports the core of Codex's former `js_repl` tool. It runs JavaScript in a persistent, session-isolated Node.js kernel with top-level `await`.

## Requirements

- OpenCode 1.18.5 or newer
- Node.js 22.22.0 or newer on `PATH`

OpenCode discovers `.opencode/plugins/js-repl.ts` automatically and installs dependencies from `.opencode/package.json`. Fully quit and restart OpenCode after changing plugin files or configuration.

## Tools

### `js_repl`

Arguments:

- `code` (required): plain JavaScript source without markdown fences
- `timeout_ms` (optional): integer from 1 to 300000; defaults to 30000

```js
// First call
let counter = 1
const path = await import("node:path")
console.log(path.basename("/tmp/example"), counter)

// Later call in the same OpenCode session
counter += 1
console.log(counter)
```

Top-level `const`, `let`, `var`, function, and class bindings persist between calls. Use `console.log`, `console.info`, `console.warn`, `console.error`, or `console.debug` to return output.

Dynamic imports support Node builtins, installed packages, and local ESM `.js`/`.mjs` files. Top-level static imports are not supported; use `await import(...)`. Local modules are reloaded for each execution so edits are visible.

The kernel exposes:

- `opencode.cwd`
- `opencode.homeDir`
- `opencode.tmpDir`
- `opencode.emitImage(imageLike)`
- `tmpDir` as a compatibility shorthand

Use `opencode.emitImage` to attach an image directly to the tool result:

```js
const screenshot = await page.screenshot({ type: "jpeg", quality: 85, scale: "css" })
await opencode.emitImage({
  bytes: screenshot,
  mimeType: "image/jpeg",
  filename: "desktop-qa.jpg",
})
```

The helper also accepts a base64 image data URL. PNG, JPEG, WebP, and GIF are supported, with a 5 MiB limit per image and at most four images per execution. Await every call so validation failures are associated with the current cell.

### `js_repl_reset`

Clears bindings and terminates the current session's kernel. Timeouts, active-call cancellation, fatal asynchronous errors, and process crashes also reset the kernel automatically.

## Playwright Interactive Skill

The project-local `playwright-interactive` skill is available for persistent browser and Electron QA. It installs Playwright and browser binaries on demand in the application workspace, keeps browser/page handles in `js_repl`, and attaches screenshots with `opencode.emitImage`.

The skill lives at `.opencode/skills/playwright-interactive/SKILL.md`. Its upstream Apache-2.0 license and adaptation notice are included alongside it.

## Configuration

`opencode.json` defaults JavaScript execution to a permission prompt:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "js_repl": "ask"
  }
}
```

Change `js_repl` to `allow` for silent execution or `deny` to block it. An "always" approval lasts for the current OpenCode session.

Set `OPENCODE_JS_REPL_NODE_PATH` to use a specific Node binary. Set `OPENCODE_JS_REPL_NODE_MODULE_DIRS` to a platform path-delimited list of additional package resolution roots.

## Security

This plugin is **not an OS sandbox**. Direct imports of `process`, `child_process`, and `worker_threads` are blocked, but evaluated code can access the filesystem and network, and imported dependency code runs with the current user's privileges. Treat `permission.js_repl = "allow"` as permission to execute arbitrary local code.

Unlike the Codex implementation, this OpenCode port does not provide `codex.tool(...)`, Codex's OS sandbox integration, or raw freeform tool arguments. Image emission is available through `opencode.emitImage(...)`. OpenCode calls the tool with `{ "code": "..." }`.

## Development

From `.opencode`:

```sh
npm install
npm run typecheck
npm test
```

The kernel is adapted from OpenAI Codex revision `219c65dc2f7a2fdb2adef73d572189e80b7470e5`, the parent of the commit that removed `js_repl`.
