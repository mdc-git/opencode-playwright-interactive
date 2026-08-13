# OpenCode V2 JavaScript REPL and Playwright

A persistent JavaScript runtime and Playwright workflow for browser and Electron
QA in OpenCode V2.

This project targets OpenCode V2 and its V2 plugin, tool, skill, permission,
and Code Mode APIs. It is not a V1 plugin.

<!-- markdownlint-disable-next-line MD033 -->
<video controls src="https://github.com/user-attachments/assets/b015fe51-692f-475b-a8ac-a772695db35e"></video>

## Why use it

Normal browser scripts start from a blank state on every run. This plugin keeps
JavaScript bindings, loaded modules, browser pages, and Electron windows alive
for the current OpenCode session. An agent can inspect an application, modify
the code, and check the same live page again without reopening the browser or
reconstructing the test state.

The bundled Playwright skill gives OpenCode a consistent workflow for local web
applications, Electron applications, responsive layouts, and remote websites.
Playwright and Chromium use a shared user cache instead of being installed in
every application under test.

## Example workflows

### Verify a staging signup flow

A request such as "test the staging signup flow on desktop and mobile" can
produce this sequence:

1. Open the staging site.
2. Complete the form with test data.
3. Follow the visible confirmation flow.
4. Check the resulting dashboard or error state.
5. Repeat the relevant checks in a responsive touch layout.
6. Report interaction and layout problems with screenshots.

### Debug a local application

OpenCode can start or connect to a local application, inspect its rendered UI,
change the source, and query the same browser page after the application
updates. Persistent browser state is useful for problems that only appear after
several navigation or form steps.

### Inspect an Electron application

The workflow can launch an Electron application, inspect its windows, interact
with visible controls, and verify the result after code changes. Electron uses
its native Playwright launcher rather than the remote-browser runtime.

### Research a live website

For an authorized remote site, OpenCode can read JavaScript-rendered content,
follow visible navigation, inspect controls in frames and open shadow roots,
and summarize what it observed. Remote access remains subject to the site's
access policy and rate limits.

## Requirements

- OpenCode V2
- Node.js 22.22.0 or newer on `PATH` (used by the persistent REPL kernel)
- npm and npx on `PATH`, unless custom executable paths are configured

## Install

Add the plugin to your `opencode.json(c)` and let OpenCode install it
automatically from git. No manual cloning or dependency management is needed.

For global use, edit `~/.config/opencode/opencode.json(c)`. For a single
project, edit `<project>/.opencode/opencode.json(c)` or
`<project>/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "js_repl", "resource": "*", "effect": "ask" }
  ],
  "plugins": [
    {
      "package": "opencode-playwright-interactive@git+https://github.com/mdc-git/opencode-playwright-interactive.git",
      "options": {
        "nodePath": "node",
        "nodeModuleDirs": [],
        "replCacheDir": "/home/user/.cache/opencode",
        "playwrightCacheDir": "/home/user/.cache/opencode/playwright",
        "npmPath": "npm",
        "playwrightNpmPath": "npm",
        "playwrightNpxPath": "npx"
      }
    }
  ]
}
```

Paths are used as provided; shell expansion such as `~` is not performed. Use
`allow` to run the browser tools without prompting or `deny` to block them.

The plugin registers the `playwright-interactive` skill automatically; no
separate skill directory or entry is required.

Restart the service after adding the entry:

```sh
opencode2 service restart
```

OpenCode fetches the repository, resolves `@opencode-ai/plugin`, `effect`, and
other declared dependencies into an isolated cache, and loads the plugin. See
[Verify](#verify) below to confirm it loaded.

> [!NOTE]
> If the plugin fails to load with an `NpmInstallFailedError` about a missing
> `package.json`, a stale npm or OpenCode package cache may be referencing a
> prior failed clone. Clear both caches and restart:
>
> ```sh
> rm -rf ~/.cache/opencode/packages/opencode-playwright-interactive@git+https:*
> npm cache clean --force
> opencode2 service restart
> ```

## Commands

The plugin registers a `/playwright` slash command. Use it to start a browser
QA session with a single prompt:

```text
/playwright test the staging signup flow on desktop and mobile
/playwright open http://localhost:3000 and check the dashboard layout
/playwright launch the Electron app and verify the settings dialog
```

The command activates the `playwright-interactive` skill, runs setup, and
instructs the agent to select the correct startup mode before carrying out the
task. The skill can also be activated directly without the command.

## Verify

Restart the V2 service:

```sh
opencode2 service restart
```

From a project where the plugin should be active, check the loaded plugins:

```sh
opencode2 api get "/api/plugin?location[directory]=$(pwd)"
```

The response should contain `local.js-repl`. Start OpenCode in that project and
confirm that the `playwright-interactive` skill is available.

The first browser request installs the supported Playwright package and matching
Chromium under `~/.cache/opencode/playwright` by default. Later sessions reuse
that installation.

## Components

| Component | Purpose |
| --- | --- |
| Persistent JavaScript runtime | Keeps state, imports, and browser objects alive across turns. |
| Session cleanup | Stops and clears one session's persistent runtime. |
| Shared browser installation | Installs the supported Playwright package and matching Chromium in a shared cache. |
| Playwright skill | Selects the browser mode and guides inspection, interaction, screenshots, and cleanup. |
| `/playwright` command | Shortcut that activates the skill and runs setup before the task. |

## Browser modes

| Target | Mode | Behavior |
| --- | --- | --- |
| Local web application | Standard Chromium | Uses normal Playwright behavior without the managed remote runtime. |
| Electron application | Electron launcher | Opens the desktop application directly without a separate Chromium profile. |
| Remote website | Managed Chromium | Uses a session profile, managed input, responsive layouts, and guarded identity settings. |

Local targets include `file:` URLs, `localhost`, `*.localhost`, the
`127.0.0.0/8` range, and `[::1]`. Responsive remote mode models a Chromium touch
layout; it does not impersonate Safari or a physical mobile device.

Managed remote sessions support visible controls in the main page, attached
frames, and open shadow roots. They track popups and navigation, provide
screenshots, and keep one coherent profile for the OpenCode session. Desktop
and responsive touch layouts share that profile and run sequentially.

The maintained Playwright package avoids the `Runtime.enable` CDP automation
signal and includes a guarded child-frame navigation fix. Chromium keeps a
version-coherent user agent. Identity-bearing overrides such as custom user
agents, locale, timezone, screen, and browser arguments are blocked when they
would create an inconsistent profile.

## Runtime behavior

| Property | Behavior |
| --- | --- |
| Session isolation | Each OpenCode session has its own Node.js kernel and scratch directory. |
| Persistence | JavaScript state, loaded modules, browser pages, and Electron windows survive between turns. |
| Package resolution | Node.js built-ins, workspace packages, local ESM files, and configured module roots are available. |
| Browser cache | Playwright and Chromium are shared under `~/.cache/opencode/playwright` by default. |
| Text output | Limited to 1 MiB per execution. |
| Images | Up to four PNG, JPEG, WebP, or GIF images, limited to 5 MiB each. |
| Operation timeout | Configurable from 1 ms to 300000 ms; the default is 30000 ms. |
| Rejected promises | A rejected final expression or detached rejection fails the relevant call without resetting the kernel. A late background rejection is reported before the next cell executes. |
| Timed-out work | May continue in the session kernel until that kernel is reset. |
| TUI lifecycle | Closing the TUI does not necessarily stop the background service, kernel, or browser. |
| Plugin cleanup | Reloading, disabling, or stopping the plugin closes its kernels and browser resources. |
| Forced-exit cleanup | Orphaned scratch directories are removed during a later service start. |

Interactive browser sessions remain open after a task so the visible result can
be inspected and later turns can continue from the same state. Different
OpenCode sessions do not share kernels, browser bindings, or temporary remote
profiles.

## Privacy and access boundaries

Remote telemetry stays in memory and records action, failure, navigation, and
popup counts plus the latest main-document status. It does not record tokens,
input contents, page fingerprints, or a browsing history. Diagnostics may
include frame URLs and links needed to identify a control.

## Security

The persistent JavaScript runtime is trusted local code, not a sandbox. Code
runs with the current user's Node.js permissions and can access the filesystem,
network, child processes, and worker threads. An `allow` permission for
`js_repl` permits arbitrary local code execution.

## Remove

Remove the plugin entry and `js_repl` permission rule from your
`opencode.json(c)`, then restart:

```sh
opencode2 service restart
```

The shared caches under `~/.cache/opencode` remain available to other OpenCode
sessions and installations.

The runtime is adapted from OpenAI Codex revision
`219c65dc2f7a2fdb2adef73d572189e80b7470e5`.
