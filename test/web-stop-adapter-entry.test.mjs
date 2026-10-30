import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const rootSource = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
function compile(source, output, references = [], target = "exe") {
  execFileSync(compiler, ["/nologo", `/target:${target}`, "/platform:x64", "/optimize+", "/debug-", ...references, `/out:${output}`, source],
    { windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const official = path.join(root, "node_repl.exe"), officialSource = path.join(root, "official.cs");
  writeFileSync(officialSource, `using System;
using System.Diagnostics;
using System.Threading;
class OfficialFixture {
  static int Main(string[] args) {
    if (args.Length != 0) { Thread.Sleep(Timeout.Infinite); return 0; }
    Process descendant = Process.Start(new ProcessStartInfo {
      FileName = System.Reflection.Assembly.GetExecutingAssembly().Location, Arguments = "--descendant",
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
      RedirectStandardOutput = true, RedirectStandardError = true });
    Console.WriteLine("{\\"pid\\":" + Process.GetCurrentProcess().Id + ",\\"startedTicks\\":\\"" + Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks
      + "\\",\\"descendantPid\\":" + descendant.Id + ",\\"bridgePid\\":" + (Environment.GetEnvironmentVariable("ROUTER_FIXTURE_BRIDGE_PID") ?? "0") + "}");
    string line; while ((line = Console.ReadLine()) != null) Console.WriteLine(line);
    return 17;
  }
}
`, "utf8");
  compile(officialSource, official);
  const bridge = path.join(root, "bridge.mjs"), config = path.join(root, "config.json"), events = path.join(root, "events.jsonl");
  writeFileSync(config, JSON.stringify({ server: official })); writeFileSync(events, "");
  writeFileSync(bridge, `import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--generation" || !/^[a-f0-9-]{36}$/.test(args[3])) process.exit(64);
const child = spawn(JSON.parse(readFileSync(args[1], "utf8")).server, [], { stdio: "inherit", windowsHide: true,
  env: { ...process.env, ROUTER_FIXTURE_BRIDGE_PID: String(process.pid) } });
child.on("exit", code => { process.exitCode = code; });
`, "utf8");
  const cua = path.join(root, "node_modules", "@oai", "cua-repl", "bin", "cua-repl.mjs"), guard = path.join(root, "require-browser-access.mjs");
  mkdirSync(path.dirname(cua), { recursive: true }); writeFileSync(guard, "// fixture import guard\n");
  const cuaSource = `import { spawn } from "node:child_process";
const child = spawn(process.env.ROUTER_FIXTURE_ENTRY, [], { stdio: "inherit", windowsHide: true });
child.on("exit", code => { process.exitCode = code; });
`;
  writeFileSync(cua, cuaSource); const unknown = path.join(root, "unknown.mjs"); writeFileSync(unknown, cuaSource);
  const entry = path.join(root, "entry.exe"), source = path.join(root, "entry.cs");
  function render({ nodeHash = hash(readFileSync(process.execPath)), officialHash = hash(readFileSync(official)) } = {}) {
    let template = readFileSync(path.join(rootSource, "src", "web-stop-adapter-entry.cs"), "utf8");
    for (const [token, value] of [["NODE", process.execPath], ["ADAPTER", bridge], ["CONFIG", config], ["EVENTS", events],
      ["OFFICIAL_REPL", official], ["OFFICIAL_REPL_SHA256", officialHash], ["NODE_SHA256", nodeHash],
      ["CUA_ENTRY", cua], ["CUA_ENTRY_SHA256", hash(readFileSync(cua))], ["CUA_GUARD", guard], ["CUA_GUARD_SHA256", hash(readFileSync(guard))]]) {
      assert.equal(template.split(`@@${token}@@`).length, 2); template = template.replace(`@@${token}@@`, value.replaceAll('"', '""'));
    }
    writeFileSync(source, template); compile(source, entry, ["/reference:System.Management.dll"], "winexe");
  }
  render();
  return { root, entry, official, bridge, cua, guard, unknown, events, render };
}
function line(reader) { return once(reader, "line", { signal: AbortSignal.timeout(15_000) }).then(([value]) => value); }
function launch(f, { module = f.cua, guarded = false, banner = 'await import("@oai/cua/tinyskyAlt");\n', surfaces = "browser,computer", selected = f.entry } = {}) {
  const args = guarded ? ["--import", pathToFileURL(f.guard).href, module] : [module];
  const parent = spawn(process.execPath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
    ROUTER_FIXTURE_ENTRY: f.entry, CUA_REPL_NODE_REPL_PATH: selected, NODE_REPL_JS_BANNER: banner, CUA_REPL_ENABLED_SURFACES: surfaces } });
  const reader = createInterface({ input: parent.stdout }); let stderr = "";
  parent.stderr.setEncoding("utf8"); parent.stderr.on("data", chunk => { stderr += chunk; });
  return { parent, reader, ready: line(reader).then(JSON.parse), stderr: () => stderr };
}
function receipts(f) { return readFileSync(f.events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
async function exited(pid) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    assert.ok(performance.now() < deadline, `owned descendant ${pid} exited with its job`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function closeFixture(running, terminal, started) {
  running.parent.stdin.end();
  if (running.parent.exitCode === null && running.parent.signalCode === null) {
    const ended = await Promise.race([terminal.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2000))]);
    if (!ended && started) process.kill(started.entryPid);
    if (!ended) await terminal;
  }
  running.reader.close();
}

test("compiled launcher conservatively selects the CUA path and preserves stdio, native identity, exit and descendant cleanup", {
  skip: process.platform !== "win32", timeout: 90_000,
}, async t => {
  const f = fixture(t);
  async function exercise(options, mode) {
    const running = launch(f, options), terminal = once(running.parent, "exit");
    let started;
    try {
      const ready = await running.ready; started = receipts(f).at(-1);
      assert.equal(started.code, "adapter_process_started"); assert.equal(started.mode, mode);
      assert.equal(started.schemaVersion, 1); assert.match(started.generation, /^[a-f0-9-]{36}$/);
      if (mode === "cua-direct") assert.equal(started.startedTicks, ready.startedTicks);
      assert.equal(started.pid, mode === "cua-direct" ? ready.pid : ready.bridgePid);
      assert.match(started.entryStartedTicks, /^\d{18}$/); assert.match(started.startedTicks, /^\d{18}$/);
      assert.equal(started.entryImageSha256, hash(path.resolve(f.entry).toLowerCase()));
      assert.equal(started.imageSha256, hash(path.resolve(mode === "cua-direct" ? f.official : process.execPath).toLowerCase()));
      const echoed = line(running.reader), message = '{"jsonrpc":"2.0","id":7,"method":"tools/list"}';
      running.parent.stdin.write(`${message}\n`); assert.equal(await echoed, message);
      running.parent.stdin.end(); assert.deepEqual(await terminal, [17, null], running.stderr());
      const ended = receipts(f).at(-1); assert.equal(ended.code, "adapter_process_exited");
      assert.equal(ended.generation, started.generation); assert.equal(ended.startedTicks, started.startedTicks); assert.equal(ended.exitCode, 17);
      await exited(ready.pid); await exited(ready.descendantPid);
    } finally { await closeFixture(running, terminal, started); }
  }
  for (const [name, options, mode] of [
    ["ordinary Node module", { module: f.unknown }, "bridge"],
    ["known CUA bootstrap", {}, "cua-direct"],
    ["known guarded CUA bootstrap", { guarded: true }, "cua-direct"],
    ["custom banner", { banner: "await import('other');" }, "bridge"],
    ["unknown surfaces", { surfaces: "browser,unknown" }, "bridge"],
    ["different selected entry", { selected: f.official }, "bridge"],
  ]) await t.test(name, () => exercise(options, mode));
  await t.test("changed parent Node identity retains the bridge", async () => {
    f.render({ nodeHash: "0".repeat(64) });
    await exercise({}, "bridge"); f.render();
  });
  await t.test("changed CUA entry bytes retain the bridge", async () => {
    writeFileSync(f.cua, readFileSync(f.cua, "utf8") + "// replaced bootstrap\n");
    await exercise({}, "bridge"); f.render();
  });
  await t.test("changed import guard bytes retain the bridge", async () => {
    writeFileSync(f.guard, "// replaced guard\n");
    await exercise({ guarded: true }, "bridge"); f.render();
  });
  await t.test("terminating the job entry cleans a direct child and its descendants", async () => {
    const running = launch(f), terminal = once(running.parent, "exit"), ready = await running.ready, started = receipts(f).at(-1);
    try {
      assert.equal(started.mode, "cua-direct"); process.kill(started.entryPid);
      await terminal; await exited(ready.pid); await exited(ready.descendantPid);
    } finally { await closeFixture(running, terminal, started); }
  });
  await t.test("a changed official child is refused before direct execution", async () => {
    f.render({ officialHash: "0".repeat(64) });
    const running = launch(f), terminal = once(running.parent, "exit");
    // No protocol line is expected when native executable verification fails.
    running.ready.catch(() => {}); running.parent.stdin.end();
    assert.deepEqual(await terminal, [70, null]); assert.match(running.stderr(), /Web Stop adapter entry failed/);
    running.reader.close();
  });
});
