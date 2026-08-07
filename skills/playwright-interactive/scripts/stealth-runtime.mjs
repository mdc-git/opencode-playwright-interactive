const fs = await import("node:fs/promises");
const path = await import("node:path");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let installedRuntime;

function runtimeSource(markdown) {
  const heading = "\n## Default Stealth Web Session\n";
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) throw new Error("Stealth runtime source heading is missing");

  const fenceStart = markdown.indexOf("```js\n", headingIndex);
  const fenceEnd = fenceStart < 0 ? -1 : markdown.indexOf("\n```", fenceStart + 6);
  if (fenceStart < 0 || fenceEnd < 0) throw new Error("Stealth runtime source code block is missing");
  return markdown.slice(fenceStart + 6, fenceEnd);
}

export async function installStealthRuntime({
  chromium,
  opencode,
  headless = false,
  webProfileDir,
  mobileProfileDir,
} = {}) {
  if (installedRuntime) return installedRuntime;
  if (!chromium?.launchPersistentContext) throw new TypeError("The shared Playwright chromium object is required");
  if (!opencode?.homeDir && !opencode?.tmpDir) throw new TypeError("The js_repl opencode runtime object is required");

  installedRuntime = (async () => {
    const markdown = await fs.readFile(new URL("../references/stealth-runtime-source.txt", import.meta.url), "utf8");
    const source = runtimeSource(markdown);
    const install = new AsyncFunction(
      "chromium",
      "path",
      "opencode",
      "HEADLESS",
      "webProfileDir",
      "mobileProfileDir",
      `
var browser;
var context;
var page;
var mobileContext;
var mobilePage;
var stealth;
var mobileStealth;
var resetWebHandles = function () {
  browser = undefined;
  context = undefined;
  page = undefined;
  mobileContext = undefined;
  mobilePage = undefined;
  stealth = undefined;
  mobileStealth = undefined;
};
${source}
return {
  ensureWebBrowser,
  ensureMobileBrowser,
  createStealthController,
  launchStealthChromium,
  resetStealthProfile,
  stealthControllerRegistry,
};
`,
    );

    const runtime = await install(chromium, path, opencode, headless, webProfileDir, mobileProfileDir);
    const required = [
      ["ensureWebBrowser", typeof runtime.ensureWebBrowser === "function"],
      ["ensureMobileBrowser", typeof runtime.ensureMobileBrowser === "function"],
      ["createStealthController", typeof runtime.createStealthController === "function"],
      ["launchStealthChromium", typeof runtime.launchStealthChromium === "function"],
      ["resetStealthProfile", typeof runtime.resetStealthProfile === "function"],
      ["stealthControllerRegistry", runtime.stealthControllerRegistry instanceof Map],
    ];
    const missing = required.filter((entry) => !entry[1]).map((entry) => entry[0]);
    if (missing.length) throw new Error(`Stealth runtime is incomplete: ${missing.join(", ")}`);
    return Object.freeze(runtime);
  })();

  try {
    return await installedRuntime;
  } catch (error) {
    installedRuntime = undefined;
    throw error;
  }
}
