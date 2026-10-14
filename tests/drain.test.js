/**
 * The exit flush, `drained()`, must not set off Node's listener-leak warning.
 *
 * `muhkoo login` printed `MaxListenersExceededWarning: … 15 error listeners
 * added to [WriteStream]. MaxListeners is 10.` twice after signing in. The ZK
 * prover starts a worker thread per core, and Node pipes each worker's stdout
 * and stderr into the process's own, one `error` listener each (raising the
 * limit only around the pipe, so that adds no warning). On a 14-core Mac the
 * flush's own `error` listener was then the 15th, on stdout and on stderr.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { drained } from "../src/lib/drain.js";

const drainUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "drain.js")).href;

/** A stream that already has `n` error listeners, added the way Node adds a worker's: without a warning. */
function crowded(n, write = (_chunk, _enc, cb) => cb()) {
    const stream = new Writable({ write });
    stream.setMaxListeners(Infinity);
    for (let i = 0; i < n; i++) stream.on("error", () => {});
    stream.setMaxListeners(10);
    return stream;
}

const leakWarnings = (spy) => spy.mock.calls.filter(([w]) => /MaxListenersExceeded/.test(String(w?.name ?? w)));

afterEach(() => vi.restoreAllMocks());

describe("drained() and the listener-leak warning", () => {
    it("adds no warning to a stream that already has 14 error listeners, and leaves 14 behind", async () => {
        const warn = vi.spyOn(process, "emitWarning");
        const streams = [crowded(14), crowded(14)];
        await drained(streams);
        expect(leakWarnings(warn)).toEqual([]);
        for (const stream of streams) {
            expect(stream.listenerCount("error")).toBe(14);
            expect(stream.getMaxListeners()).toBe(10);
        }
    });

    it("leaves an unlimited stream unlimited", async () => {
        const stream = crowded(14);
        stream.setMaxListeners(0);
        await drained([stream]);
        expect(stream.getMaxListeners()).toBe(0);
        expect(stream.listenerCount("error")).toBe(14);
    });

    it("leaves a stream with no limit of its own following the default", async () => {
        // As process.stdout is: a raise must not pin it at what the default was.
        const dflt = EventEmitter.defaultMaxListeners;
        try {
            EventEmitter.defaultMaxListeners = 20;
            const stream = new Writable({ write: (_chunk, _enc, cb) => cb() });
            for (let i = 0; i < 14; i++) stream.on("error", () => {});
            EventEmitter.defaultMaxListeners = 10;   // 14 is now past it: drained() has to raise
            await drained([stream]);
            EventEmitter.defaultMaxListeners = 30;
            expect(stream.getMaxListeners()).toBe(30);
            expect(stream.listenerCount("error")).toBe(14);
        } finally {
            EventEmitter.defaultMaxListeners = dflt;
        }
    });

    it("a process with 14 worker threads exits without the warning", async () => {
        // As the prover leaves it: a worker per core, each piped into stdout and stderr.
        const script = `
            import { Worker } from "node:worker_threads";
            import { drained } from ${JSON.stringify(drainUrl)};
            for (let i = 0; i < 14; i++) new Worker("setInterval(() => {}, 1000)", { eval: true });
            const count = () => [process.stdout, process.stderr].map((s) => s.listenerCount("error")).join(" ");
            process.stdout.write("before " + count() + "\\n");
            await drained();
            process.stdout.write("after " + count() + "\\n");
            // Long enough for a warning, which is printed on a later tick, to reach stderr.
            setTimeout(() => process.exit(0), 300);
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const code = await new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
        });
        expect(code, stderr).toBe(0);
        expect(stdout).toMatch(/^before 14 14$/m);   // the setup holds: 14 listeners already
        expect(stderr).not.toMatch(/MaxListenersExceededWarning/);
        expect(stdout).toMatch(/^after 14 14$/m);
    }, 30_000);
});

describe("drained() still flushes", () => {
    it("waits for writes already queued", async () => {
        const written = [];
        const slow = crowded(0, (chunk, _enc, cb) => setTimeout(() => {
            if (chunk.length) written.push(chunk.toString());   // not the flush's own empty write
            cb();
        }, 20));
        slow.write("a");
        slow.write("b");
        slow.write("c");
        await drained([slow]);
        expect(written).toEqual(["a", "b", "c"]);
        expect(slow.listenerCount("error")).toBe(0);
    });

    it("settles on a stream whose writes fail, as a closed pipe's do, and leaves its error handled", async () => {
        const closed = crowded(0, (_chunk, _enc, cb) => cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
        // Unhandled, the stream's `error` would throw on a later tick and fail this file.
        await drained([closed]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(closed.destroyed).toBe(true);
    });

    it("settles on a stream already destroyed, and leaves no listener on it", async () => {
        // Its write fails, but no `error` follows: a destroyed stream emits nothing more.
        const gone = crowded(0);
        gone.destroy();
        await drained([gone]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(gone.listenerCount("error")).toBe(0);
    });

    it("on a stream already ended, takes the error that follows its write, and then its listener goes", async () => {
        // Here the stream is destroyed only after the write's callback, and its
        // `error` comes later still: the listener must outlast the callback.
        const ended = crowded(0);
        ended.end();
        await drained([ended]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(ended.destroyed).toBe(true);
        expect(ended.listenerCount("error")).toBe(0);
    });
});
