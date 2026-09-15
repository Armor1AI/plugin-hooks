import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { candidates, currentBuildDir, parseConfig, parseDecision } from "../src/hook.ts"

// ---------------------------------------------------------------------------
// Reading policies.json
// ---------------------------------------------------------------------------

const policy = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    telemetry_engine: "interpreter",
    policies: {
      "opencode-policy": { spec_uname: "opencode-policy", remediation_mode: true, telemetry_mode: true },
    },
    ...over,
  })

const candidate = (home = "/opt/armor1") => ({
  home,
  policiesDir: `${home}/1.4.0+abc/policies`,
  file: `${home}/1.4.0+abc/policies/policies.json`,
})

const ok = (raw: string, home = "/opt/armor1") => {
  const parsed = parseConfig(raw, candidate(home))
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

// ---------------------------------------------------------------------------
// Reading the hook's answer
// ---------------------------------------------------------------------------

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
