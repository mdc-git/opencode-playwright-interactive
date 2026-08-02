# OpenCode JavaScript REPL

A copyable OpenCode payload containing a persistent JavaScript REPL tool and the Playwright interactive QA skill.

## Install

Copy both directories into an OpenCode project's `.opencode/` directory:

```text
.opencode/
  tools/
    js_repl.ts
    LICENSE.txt
    NOTICE.txt
  skills/
    playwright-interactive/
      SKILL.md
      LICENSE.txt
      NOTICE.txt
```

No project package manifest or workspace install step is required. On first use, `js_repl` installs its pinned Meriyah parser in `~/.cache/opencode/js-repl`; later sessions reuse it. Fully quit and restart OpenCode after copying or changing a tool or skill.

## Requirements

- OpenCode with native custom-tool support
- Node.js 22.22.0 or newer on `PATH`

## Tools

`tools/js_repl.ts` exports three native tools:

- `js_repl`: execute plain JavaScript in a persistent, session-isolated Node.js kernel.
- `js_repl_reset`: clear the current session's bindings and terminate its kernel.
- `js_repl_playwright_setup`: install the shared Playwright runtime and Chromium once for every local workspace.

`js_repl` accepts `code` and optional `timeout_ms` (1 to 300000 milliseconds; default 30000). Send JavaScript directly, without Markdown fences.

```js
// First call
let counter = 1
const path = await import("node:path")
console.log(path.basename("/tmp/example"), counter)

// Later call in the same OpenCode session
counter += 1
console.log(counter)
```

Top-level `const`, `let`, `var`, function, and class bindings persist between calls. Dynamic imports support Node builtins, installed workspace packages, and local ESM `.js`/`.mjs` files. Static imports are not supported; use `await import(...)`.

The kernel exposes `opencode.cwd`, `opencode.homeDir`, `opencode.tmpDir`, `tmpDir`, and `opencode.emitImage(imageLike)`. Image attachments support PNG, JPEG, WebP, and GIF, with a 5 MiB limit per image and at most four images per execution.

Call `js_repl_reset` after explicit browser cleanup. Timeouts, cancellation, fatal asynchronous errors, and process crashes also reset the kernel. Native custom tools do not receive the plugin session-deletion lifecycle hook, so reset explicitly when a long-lived session no longer needs the REPL.

## Playwright Skill

`skills/playwright-interactive/` provides persistent browser and Electron QA instructions. Before first use, call `js_repl_playwright_setup`; it installs Playwright 1.62.0 and Chromium under `~/.cache/opencode/playwright` by default, rather than modifying each application workspace. The REPL automatically resolves the shared library and browser path thereafter. Set `OPENCODE_PLAYWRIGHT_CACHE_DIR` to relocate the managed cache, `OPENCODE_PLAYWRIGHT_NPM_PATH` or `OPENCODE_PLAYWRIGHT_NPX_PATH` to select package executables, and `PLAYWRIGHT_BROWSERS_PATH` to reuse an existing browser cache.

## Advantages

Compared with one-shot shell commands, ad hoc Node scripts, or a fresh browser launch for every check, `js_repl` keeps JavaScript bindings, imports, and browser objects alive for the current OpenCode session. This makes iterative debugging faster: inspect a page, change the application, query the same page again, and retain the variables and helpers built along the way.

The Playwright skill turns that persistent runtime into an interactive QA loop for browser and Electron applications. It supports targeted inspection, repeatable interactions, screenshots, and follow-up assertions without adding Playwright dependencies or browser binaries to each application workspace. The shared, managed runtime also avoids setup drift between projects while leaving each REPL session isolated.

## Configuration

OpenCode prompts before running JavaScript by default. A consumer project may configure the permission explicitly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "js_repl": "ask"
  }
}
```

Set `OPENCODE_JS_REPL_NODE_PATH` to choose a Node binary. Set `OPENCODE_JS_REPL_NODE_MODULE_DIRS` to a platform path-delimited list of additional package resolution roots.

Set `OPENCODE_JS_REPL_CACHE_DIR` to relocate the shared Meriyah cache and `OPENCODE_JS_REPL_NPM_PATH` to select the npm executable used for its one-time install.

## Security

This tool is not an OS sandbox. It blocks direct `process`, `child_process`, and `worker_threads` imports, but evaluated code can access the filesystem and network, and imported dependency code runs with the current user's privileges. Treat `permission.js_repl = "allow"` as permission to run arbitrary local code.

The bundled runtime is adapted from OpenAI Codex revision `219c65dc2f7a2fdb2adef73d572189e80b7470e5`. See `tools/NOTICE.txt` and `tools/LICENSE.txt`.
