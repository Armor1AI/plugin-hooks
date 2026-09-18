import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { candidates, currentBuildDir, loadConfig, parseConfig, parseDecision, runHook, spawnSpec } from "../src/hook.ts"
import type { HookPayload } from "../src/types.ts"

const hasPwsh = () => spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0

// Reading policies.json

const policy = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    telemetry_engine: "interpreter",
    policies: {
      "opencode-policy": { spec_uname: "opencode-policy", remediation_mode: true, telemetry_mode: true },
    },
    ...over,
  })

const candidate = (home = "/opt/armor1", layout: "script" | "sensor" = "script") => ({
  home,
  build: `${home}/1.4.0+abc`,
  layout,
  file: layout === "sensor" ? `${home}/policies/policies.json` : `${home}/1.4.0+abc/policies/policies.json`,
})

const ok = (raw: string, home = "/opt/armor1", layout: "script" | "sensor" = "script") => {
  const parsed = parseConfig(raw, candidate(home, layout))
  assert.ok(!("kind" in parsed), `expected a config, got ${JSON.stringify(parsed)}`)
  return parsed
}

// "current" is a symlink on unix and a text file holding the build id on Windows and on
// filesystems without symlink support. Both forms must resolve.
const withHome = (make: (home: string) => void): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armor1-test-"))
  make(home)
  return home
}

test("resolves a symlink pointer", () => {
  const home = withHome((h) => {
    fs.mkdirSync(path.join(h, "1.4.0+abc", "policies"), { recursive: true })
    fs.symlinkSync("1.4.0+abc", path.join(h, "current"))
  })
  assert.equal(currentBuildDir(home), path.join(home, "1.4.0+abc"))
})

test("resolves a pointer file, which is what Windows writes", () => {
  const home = withHome((h) => {
    fs.mkdirSync(path.join(h, "1.4.0+abc", "policies"), { recursive: true })
    fs.writeFileSync(path.join(h, "current"), "1.4.0+abc\n")
  })
  assert.equal(currentBuildDir(home), path.join(home, "1.4.0+abc"))
})

test("tolerates stray whitespace in a pointer file", () => {
  const home = withHome((h) => fs.writeFileSync(path.join(h, "current"), "  1.4.0+abc  \r\nignored\n"))
  assert.equal(currentBuildDir(home), path.join(home, "1.4.0+abc"))
})

test("an empty or missing pointer resolves to nothing", () => {
  assert.equal(currentBuildDir("/nonexistent/armor1"), undefined)
  const empty = withHome((h) => fs.writeFileSync(path.join(h, "current"), "\n"))
  assert.equal(currentBuildDir(empty), undefined)
})

test("candidates uses the resolved build, not a literal current directory", () => {
  const home = withHome((h) => {
    fs.mkdirSync(path.join(h, "1.4.0+abc", "policies"), { recursive: true })
    fs.writeFileSync(path.join(h, "current"), "1.4.0+abc\n")
  })
  const found = candidates({ ARMOR1_HOME: home })
  assert.equal(found[0]?.file, path.join(home, "1.4.0+abc", "policies", "policies.json"))
  assert.equal(found[0]?.home, home)
  assert.equal(found[0]?.layout, "script")
})

test("a home with no pointer contributes no candidate", () => {
  const home = withHome(() => {})
  assert.deepEqual(candidates({ ARMOR1_HOME: home }).filter((c) => c.home === home), [])
})

test("derives every path from the build the pointer resolved to", () => {
  const config = ok(policy())
  assert.equal(config.hooksPath, "/opt/armor1/1.4.0+abc/policies/hooks.sh")
  assert.equal(config.settingsFile, "/opt/armor1/config/settings.json")
  assert.equal(config.armorHome, "/opt/armor1")
  assert.equal(config.specUname, "opencode-policy")
  assert.deepEqual(config.hookEnv, {})
})

test("takes the modes from the policy entry, not from us", () => {
  assert.equal(ok(policy()).policyEnabled, true)
  assert.equal(ok(policy()).telemetryEnabled, true)

  const monitor = JSON.stringify({
    policies: { "opencode-policy": { remediation_mode: false, telemetry_mode: true } },
  })
  assert.equal(ok(monitor).policyEnabled, false)
  assert.equal(ok(monitor).telemetryEnabled, true)
})

test("takes the telemetry engine from the top level, defaulting to the interpreter", () => {
  assert.equal(ok(policy({ telemetry_engine: "compiled" })).telemetryEngine, "compiled")
  assert.equal(ok(policy({ telemetry_engine: "" })).telemetryEngine, "interpreter")
})

test("a policy file with no opencode entry means unassigned, not broken", () => {
  const other = JSON.stringify({ policies: { "claude-code-policy": { remediation_mode: true } } })
  assert.deepEqual(parseConfig(other, candidate()), { kind: "unassigned" })
})

test("malformed input is reported as invalid", () => {
  assert.equal((parseConfig("nope", candidate()) as { kind: string }).kind, "invalid")
  assert.equal((parseConfig("[]", candidate()) as { kind: string }).kind, "invalid")
  assert.equal((parseConfig("{}", candidate()) as { kind: string }).kind, "invalid")
})

// Reading the hook's answer

test("parses the primary deny shape", () => {
  const d = parseDecision('{"decision":"deny","reason":"nope"}', 0)
  assert.deepEqual(d, { kind: "deny", reason: "nope" })
})

test("parses the Claude-shaped deny", () => {
  const d = parseDecision(
    '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
    0,
  )
  assert.deepEqual(d, { kind: "deny", reason: "blocked" })
})

test("allows on empty stdout", () => {
  assert.deepEqual(parseDecision("   ", 0), { kind: "allow" })
})

test("allows on the not-applicable exit code", () => {
  assert.deepEqual(parseDecision('{"decision":"deny","reason":"x"}', 42), { kind: "allow" })
})

test("degrades rather than denying on malformed stdout", () => {
  assert.equal(parseDecision("not json", 0).kind, "degraded")
  assert.equal(parseDecision("[1,2]", 0).kind, "degraded")
  assert.equal(parseDecision('{"nothing":true}', 0).kind, "degraded")
})

test("downgrades ask, which OpenCode cannot express", () => {
  assert.equal(parseDecision('{"decision":"ask","reason":"?"}', 0).kind, "degraded")
})

test("supplies a default deny reason", () => {
  const d = parseDecision('{"decision":"deny"}', 0)
  assert.deepEqual(d, { kind: "deny", reason: "blocked by Armor1 policy" })
})

test("an allow carries context for the model when the rule supplies one", () => {
  assert.deepEqual(parseDecision('{"decision":"allow","reason":"on the allowlist"}', 0), {
    kind: "allow",
    context: "on the allowlist",
  })
})

test("allow context is also read from the Claude-shaped field", () => {
  assert.deepEqual(
    parseDecision('{"hookSpecificOutput":{"permissionDecision":"allow","additionalContext":"fyi"}}', 0),
    { kind: "allow", context: "fyi" },
  )
})

test("an allow with no context stays bare", () => {
  assert.deepEqual(parseDecision('{"decision":"allow"}', 0), { kind: "allow" })
  assert.deepEqual(parseDecision('{"decision":"allow","reason":""}', 0), { kind: "allow" })
})

test("a deny still defaults its reason and ignores additionalContext", () => {
  assert.deepEqual(
    parseDecision('{"hookSpecificOutput":{"permissionDecision":"deny","additionalContext":"ignored"}}', 0),
    { kind: "deny", reason: "blocked by Armor1 policy" },
  )
})

test("a degraded result names its own signal instead of leaving it to be guessed", () => {
  const cases: [string, string][] = [
    ["not json", "hook_unparseable"],
    ["[1,2]", "hook_unparseable"],
    ['{"nothing":true}', "hook_unparseable"],
    ['{"decision":"maybe"}', "hook_unparseable"],
    ['{"decision":"ask","reason":"?"}', "hook_ask_downgraded"],
  ]
  for (const [stdout, signal] of cases) {
    const d = parseDecision(stdout, 0)
    assert.equal(d.kind, "degraded", stdout)
    if (d.kind !== "degraded") continue
    assert.equal(d.signal, signal, stdout)
  }
})

// Windows: the runner is hooks.ps1 and it needs a PowerShell host.

test("picks hooks.ps1 on win32 and hooks.sh elsewhere", () => {
  const win = parseConfig(policy(), candidate(), "win32")
  assert.ok(!("kind" in win))
  assert.equal(win.hooksPath, "/opt/armor1/1.4.0+abc/policies/hooks.ps1")
  assert.equal(ok(policy()).hooksPath, "/opt/armor1/1.4.0+abc/policies/hooks.sh")
})

test("spawnSpec wraps the runner in a hidden non-interactive PowerShell on win32 only", () => {
  const args = ["--policy", "opencode-policy", "--hook", "command_execution", "--policy-enabled"]
  assert.deepEqual(spawnSpec("/p/hooks.sh", args, "darwin"), { file: "/p/hooks.sh", argv: args, detached: true })
  // Not detached on Windows: DETACHED_PROCESS gives powershell.exe no console and it exits
  // 0 without running the script, which reads as a silent allow.
  assert.deepEqual(spawnSpec("C:\\p\\hooks.ps1", args, "win32"), {
    file: "powershell.exe",
    argv: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\p\\hooks.ps1", ...args],
    detached: false,
  })
})

// armor1-sensor: the document moves out of the build, the runner moves into bin/ and is
// renamed, and two more variables are required or it refuses to start.

test("offers both agent layouts, 1.x first", () => {
  const home = withHome((h) => {
    fs.mkdirSync(path.join(h, "1.4.0+abc"), { recursive: true })
    fs.writeFileSync(path.join(h, "current"), "1.4.0+abc\n")
  })
  assert.deepEqual(
    candidates({ ARMOR1_HOME: home })
      .filter((c) => c.home === home)
      .map((c) => [c.layout, c.file]),
    [
      ["script", path.join(home, "1.4.0+abc", "policies", "policies.json")],
      ["sensor", path.join(home, "policies", "policies.json")],
    ],
  )
})

test("the sensor runner is bin/hooks.bash and is told where the payload and libs are", () => {
  const config = ok(policy(), "/opt/armor1", "sensor")
  assert.equal(config.hooksPath, "/opt/armor1/1.4.0+abc/bin/hooks.bash")
  assert.deepEqual(config.hookEnv, {
    ARMOR1_PAYLOAD_DIR: "/opt/armor1/1.4.0+abc",
    ARMOR1_LIB_DIR: "/opt/armor1/1.4.0+abc/lib",
  })

  const win = parseConfig(policy(), candidate("/opt/armor1", "sensor"), "win32")
  assert.ok(!("kind" in win))
  assert.equal(win.hooksPath, "/opt/armor1/1.4.0+abc/bin/hooks.ps1")
})

test("a sensor device is read from state, since its build holds no document", () => {
  const home = withHome((h) => {
    fs.mkdirSync(path.join(h, "1.4.0+abc", "bin"), { recursive: true })
    fs.mkdirSync(path.join(h, "policies"), { recursive: true })
    fs.writeFileSync(path.join(h, "current"), "1.4.0+abc\n")
    fs.writeFileSync(path.join(h, "policies", "policies.json"), policy())
  })
  const load = loadConfig({ ARMOR1_HOME: home })
  assert.equal(load.kind, "ok")
  if (load.kind !== "ok") return
  assert.equal(load.config.hooksPath, path.join(home, "1.4.0+abc", "bin", "hooks.bash"))
  assert.equal(load.config.hookEnv["ARMOR1_PAYLOAD_DIR"], path.join(home, "1.4.0+abc"))
})

// The variables the sensor fails by name without have to actually reach the process.
test("a sensor hook is spawned with the payload and lib directories set", async () => {
  const home = withHome((h) => {
    const bin = path.join(h, "1.4.0+abc", "bin")
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(path.join(h, "policies"), { recursive: true })
    fs.writeFileSync(path.join(h, "current"), "1.4.0+abc\n")
    fs.writeFileSync(path.join(h, "policies", "policies.json"), policy())
    fs.writeFileSync(
      path.join(bin, "hooks.bash"),
      [
        "#!/usr/bin/env bash",
        'echo "$ARMOR1_PAYLOAD_DIR" > "$(dirname "$0")/seen.txt"',
        'echo "$ARMOR1_LIB_DIR" >> "$(dirname "$0")/seen.txt"',
        "echo '{\"decision\":\"deny\",\"reason\":\"sensor says no\"}'",
      ].join("\n"),
      { mode: 0o755 },
    )
  })
  const load = loadConfig({ ARMOR1_HOME: home })
  assert.equal(load.kind, "ok")
  if (load.kind !== "ok") return

  const payload = { armor1: { section: "command_execution" } } as unknown as HookPayload
  const decision = await runHook(load.config, "command_execution", payload)
  assert.deepEqual(decision, { kind: "deny", reason: "sensor says no" })

  const seen = fs.readFileSync(path.join(home, "1.4.0+abc", "bin", "seen.txt"), "utf8").trim().split("\n")
  assert.deepEqual(seen, [path.join(home, "1.4.0+abc"), path.join(home, "1.4.0+abc", "lib")])
})

// Live round trip through a real PowerShell: the Windows argv shape reaches a recording
// hooks.ps1, the payload arrives on stdin, and its stdout decision is parsed. Skipped when
// pwsh is not installed.
test("runs hooks.ps1 through PowerShell and parses its decision", { skip: !hasPwsh() }, async () => {
  const home = withHome((h) => {
    const policies = path.join(h, "1.4.0+abc", "policies")
    fs.mkdirSync(policies, { recursive: true })
    fs.writeFileSync(path.join(h, "current"), "1.4.0+abc\n")
    fs.writeFileSync(path.join(policies, "policies.json"), policy())
    fs.writeFileSync(
      path.join(policies, "hooks.ps1"),
      [
        "$payload = [Console]::In.ReadToEnd()",
        "$rec = @{ args = @($args); payload = $payload; home = $env:ARMOR1_HOME }",
        "$rec | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'seen.json')",
        '@{ decision = "deny"; reason = "ps1 says no" } | ConvertTo-Json -Compress',
        "exit 0",
      ].join("\n"),
    )
  })
  const load = loadConfig({ ARMOR1_HOME: home }, "win32")
  assert.equal(load.kind, "ok")
  if (load.kind !== "ok") return
  assert.equal(load.config.hooksPath, path.join(home, "1.4.0+abc", "policies", "hooks.ps1"))

  const payload = { armor1: { section: "command_execution" }, command: "rm -rf /" } as unknown as HookPayload
  const decision = await runHook(load.config, "command_execution", payload, (p, a) => spawnSpec(p, a, "win32", "pwsh"))
  assert.deepEqual(decision, { kind: "deny", reason: "ps1 says no" })

  const seen = JSON.parse(fs.readFileSync(path.join(home, "1.4.0+abc", "policies", "seen.json"), "utf8"))
  assert.deepEqual(seen.args, ["--policy", "opencode-policy", "--hook", "command_execution", "--policy-enabled", "--telemetry-enabled"])
  assert.deepEqual(JSON.parse(seen.payload), payload)
  assert.equal(seen.home, home)
})
