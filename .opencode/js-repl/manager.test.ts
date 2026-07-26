import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ReplController, validateTimeout } from "./manager.ts"

async function fixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "js-repl-test-"))
  const controller = new ReplController({ sessionID: name, directory })
  return {
    controller,
    directory,
    async dispose() {
      await controller.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("validates execution timeouts", () => {
  assert.equal(validateTimeout(undefined), 30_000)
  assert.equal(validateTimeout(1), 1)
  assert.throws(() => validateTimeout(0), /between 1 and 300000/)
  assert.throws(() => validateTimeout(1.5), /between 1 and 300000/)
  assert.throws(() => validateTimeout(300_001), /between 1 and 300000/)
})

test("persists declarations, functions, classes, and top-level await", async () => {
  const current = await fixture("persistence")
  try {
    assert.equal(
      await current.controller.execute(`
        let counter = 1;
        function add(a, b) { return a + b; }
        class Box { constructor(value) { this.value = value; } }
        const waited = await Promise.resolve(2);
        console.log(counter, waited);
      `),
      "1 2",
    )
    assert.equal(
      await current.controller.execute(
        "counter += 2; console.log(counter, add(counter, new Box(4).value));",
      ),
      "3 7",
    )
  } finally {
    await current.dispose()
  }
})

test("keeps initialized bindings from a failed cell", async () => {
  const current = await fixture("partial-failure")
  try {
    await assert.rejects(
      current.controller.execute('const kept = 41; throw new Error("boom");'),
      /boom/,
    )
    assert.equal(await current.controller.execute("console.log(kept + 1);"), "42")
  } finally {
    await current.dispose()
  }
})

test("isolates kernels by controller", async () => {
  const first = await fixture("isolation-a")
  const second = new ReplController({ sessionID: "isolation-b", directory: first.directory })
  try {
    await first.controller.execute("const privateValue = 7;")
    await assert.rejects(second.execute("console.log(privateValue);"), /privateValue is not defined/)
  } finally {
    await Promise.all([first.dispose(), second.dispose()])
  }
})

test("supports dynamic builtins and reloads local ESM files", async () => {
  const current = await fixture("imports")
  const modulePath = join(current.directory, "fixture.mjs")
  try {
    await writeFile(modulePath, "export const value = 1;\n")
    assert.equal(
      await current.controller.execute(
        `console.log((await import("node:path")).basename("/a/b"), (await import("./fixture.mjs")).value);`,
      ),
      "b 1",
    )
    await writeFile(modulePath, "export const value = 2;\n")
    assert.equal(
      await current.controller.execute(`console.log((await import("./fixture.mjs")).value);`),
      "2",
    )
    await assert.rejects(
      current.controller.execute(`await import("node:child_process");`),
      /not allowed/,
    )
  } finally {
    await current.dispose()
  }
})

test("timeout kills the kernel and clears its state", async () => {
  const current = await fixture("timeout")
  try {
    await current.controller.execute("const beforeTimeout = 1;")
    await assert.rejects(current.controller.execute("while (true) {}", 50), /timed out; kernel reset/)
    await assert.rejects(
      current.controller.execute("console.log(beforeTimeout);"),
      /beforeTimeout is not defined/,
    )
    assert.equal(await current.controller.execute(`console.log("recovered");`), "recovered")
  } finally {
    await current.dispose()
  }
})

test("abort kills the active kernel and allows recovery", async () => {
  const current = await fixture("abort")
  const abort = new AbortController()
  try {
    const execution = current.controller.execute(
      "await new Promise((resolve) => setTimeout(resolve, 60_000));",
      120_000,
      abort.signal,
    )
    setTimeout(() => abort.abort(), 50)
    await assert.rejects(execution, /aborted; kernel reset/)
    assert.equal(await current.controller.execute(`console.log("after abort");`), "after abort")
  } finally {
    await current.dispose()
  }
})

test("explicit reset clears state", async () => {
  const current = await fixture("reset")
  try {
    await current.controller.execute("const resetValue = 1;")
    await current.controller.reset()
    await assert.rejects(
      current.controller.execute("console.log(resetValue);"),
      /resetValue is not defined/,
    )
  } finally {
    await current.dispose()
  }
})

test("bounds console output inside the kernel", async () => {
  const current = await fixture("output-limit")
  try {
    const output = await current.controller.execute(`console.log("x".repeat(2 * 1024 * 1024));`)
    assert.match(output, /output truncated at 1048576 bytes/)
    assert.ok(Buffer.byteLength(output) < 2048)
  } finally {
    await current.dispose()
  }
})

test("returns validated image attachments from byte data", async () => {
  const current = await fixture("image-bytes")
  try {
    const result = await current.controller.executeResult(`
      await opencode.emitImage({
        bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"),
        mimeType: "image/png",
        filename: "../QA screenshot 1.png",
      });
      console.log("attached");
    `)
    assert.equal(result.output, "attached")
    assert.equal(result.attachments.length, 1)
    assert.deepEqual(
      {
        type: result.attachments[0]?.type,
        mime: result.attachments[0]?.mime,
        filename: result.attachments[0]?.filename,
      },
      { type: "file", mime: "image/png", filename: "QA_screenshot_1.png" },
    )
    assert.match(result.attachments[0]?.url ?? "", /^data:image\/png;base64,/)
  } finally {
    await current.dispose()
  }
})

test("supports data URLs, multiple images, and persisted emitter references", async () => {
  const current = await fixture("image-multiple")
  try {
    await current.controller.execute("var savedEmitImage = opencode.emitImage;")
    const result = await current.controller.executeResult(`
      await savedEmitImage("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
      await opencode.emitImage({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" });
    `)
    assert.deepEqual(
      result.attachments.map((attachment) => attachment.mime),
      ["image/gif", "image/jpeg"],
    )
  } finally {
    await current.dispose()
  }
})

test("validates image MIME, size, and unawaited failures", async () => {
  const current = await fixture("image-validation")
  try {
    await assert.rejects(
      current.controller.executeResult(
        `await opencode.emitImage({ bytes: Buffer.from("x"), mimeType: "text/plain" });`,
      ),
      /supports PNG, JPEG, WebP, and GIF/,
    )
    await assert.rejects(
      current.controller.executeResult(
        `await opencode.emitImage({ bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: "image/png" });`,
      ),
      /exceeds the 5242880-byte limit/,
    )
    await assert.rejects(
      current.controller.executeResult(
        `void opencode.emitImage({ bytes: Buffer.from("x"), mimeType: "text/plain" });`,
      ),
      /supports PNG, JPEG, WebP, and GIF/,
    )
    assert.equal(
      await current.controller.execute(`
        try {
          await opencode.emitImage({ bytes: Buffer.from("x"), mimeType: "text/plain" });
        } catch (error) {
          console.log("caught", error.message.includes("supports PNG"));
        }
      `),
      "caught true",
    )
  } finally {
    await current.dispose()
  }
})

test("does not return images from failed cells", async () => {
  const current = await fixture("image-failed-cell")
  try {
    await assert.rejects(
      current.controller.executeResult(`
        await opencode.emitImage({ bytes: Buffer.from([1]), mimeType: "image/png" });
        throw new Error("after image");
      `),
      /after image/,
    )
    const result = await current.controller.executeResult(`console.log("next");`)
    assert.equal(result.output, "next")
    assert.deepEqual(result.attachments, [])
  } finally {
    await current.dispose()
  }
})

test("recovers after an uncaught asynchronous error", async () => {
  const current = await fixture("fatal-error")
  try {
    await assert.rejects(
      current.controller.execute(
        `setTimeout(() => { throw new Error("async boom"); }, 0); await new Promise(() => {});`,
        10_000,
      ),
      /uncaught exception: async boom.*kernel reset/,
    )
    assert.equal(await current.controller.execute(`console.log("after crash");`), "after crash")
  } finally {
    await current.dispose()
  }
})
