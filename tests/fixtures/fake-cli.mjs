// Stand-in for bin/muhkoo.js in the runner's tests. The first argument picks
// the behaviour; the runner appends --json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [mode, extra] = process.argv.slice(2);
switch (mode) {
  case "json":
    process.stdout.write(JSON.stringify({ ok: 1, argv: process.argv.slice(2), cwd: process.cwd(), ni: process.env.MUHKOO_NONINTERACTIVE, nc: process.env.NO_COLOR }));
    break;
  case "text":
    process.stdout.write("plain words\n");
    break;
  case "error":
    process.stdout.write(JSON.stringify({ error: "App not found" }));
    process.exit(1);
  case "unauthorized":
    process.stdout.write(JSON.stringify({ error: "Request failed (401): session expired" }));
    process.exit(1);
  case "stderr-only":
    process.stderr.write("boom on stderr\n");
    process.exit(2);
  case "progress":
    process.stderr.write("step one\nstep two\n");
    process.stdout.write(JSON.stringify({ done: true }));
    break;
  case "quiet-ok":
    process.stderr.write("available  todo\n");
    break;
  case "big":
    process.stdout.write("x".repeat(3 * 1024 * 1024));
    break;
  case "binary":
    process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    break;
  case "hang": {
    // A grandchild that also hangs; its pid goes to the file named by `extra`.
    const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    writeFileSync(extra, String(kid.pid));
    setInterval(() => {}, 1000);
    break;
  }
}
