import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import type { AdapterConfig, Decision, HookPayload, Section, Signal } from "./types.ts"
import { ENFORCE_SECTIONS } from "./types.ts"
import { asRecord, asString, describe, isRecord } from "./normalize.ts"

// ---------------------------------------------------------------------------
// Reading policies.json
// ---------------------------------------------------------------------------

const SPEC_UNAME = "opencode-policy"
const HOOK_TIMEOUT_MS = 30_000

export type ConfigLoad =
  | { readonly kind: "ok"; readonly config: AdapterConfig }
  | { readonly kind: "unassigned" }
  | { readonly kind: "missing"; readonly searched: readonly string[] }
  | { readonly kind: "invalid"; readonly path: string; readonly reason: string }

// The two agent layouts a device can be running. 1.x keeps the policy document inside
// the build and runs policies/hooks.sh; armor1-sensor keeps it in state beside the build
// and runs bin/hooks.bash, which refuses to start without ARMOR1_PAYLOAD_DIR and
// ARMOR1_LIB_DIR.
type Layout = "script" | "sensor"

interface Candidate {
  readonly home: string
  readonly build: string
  readonly layout: Layout
  readonly file: string
}

// "current" points at the active build: a symlink on unix, or a text file holding the
// build id on Windows. The agent reads both forms, so this does too.
export function currentBuildDir(home: string): string | undefined {
  const pointer = path.join(home, "current")

  let info
  try {
    info = fs.lstatSync(pointer)
  } catch {
    return undefined
  }

  try {
    if (info.isSymbolicLink()) return path.join(home, path.basename(fs.readlinkSync(pointer)))
    if (info.isDirectory()) return pointer
    if (info.isFile()) {
      const id = fs.readFileSync(pointer, "utf8").split("\n")[0]?.trim()
      return id ? path.join(home, id) : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

// Read directly so enforcement and telemetry modes are never stale; the agent rewrites
// this file whenever the server changes a policy.
export function candidates(env: NodeJS.ProcessEnv = process.env): Candidate[] {
  const homes = [env["ARMOR1_HOME"], path.join(os.homedir(), ".armor1")].filter(
    (home): home is string => typeof home === "string" && home !== "",
  )
  return homes.flatMap((home) => {
    const build = currentBuildDir(home)
    if (build === undefined) return []
    // 1.x first: on a device running it nothing here changes, and the sensor keeps no
    // document inside the build, so the two can never answer for each other.
    return [
      { home, build, layout: "script" as const, file: path.join(build, "policies", "policies.json") },
      { home, build, layout: "sensor" as const, file: path.join(home, "policies", "policies.json") },
    ]
  })
}

// Programs are state in the sensor, so its runner sits in the build's bin/ rather than
// beside the document, and keeps the extension its source has.
function runnerFor(candidate: Candidate, platform: NodeJS.Platform): string {
  const dir = candidate.layout === "sensor" ? "bin" : "policies"
  const name = platform === "win32" ? "hooks.ps1" : candidate.layout === "sensor" ? "hooks.bash" : "hooks.sh"
  return path.join(candidate.build, dir, name)
}

// Nothing extra for 1.x. Its runner works out its own payload directory and falls back to
// one derived from its location, so handing it ours would point it at the wrong tree.
function hookEnvFor(candidate: Candidate): Record<string, string> {
  if (candidate.layout !== "sensor") return {}
  return { ARMOR1_PAYLOAD_DIR: candidate.build, ARMOR1_LIB_DIR: path.join(candidate.build, "lib") }
}

export function parseConfig(
  raw: string,
  candidate: Candidate,
  platform: NodeJS.Platform = process.platform,
): AdapterConfig | ConfigLoad {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: "invalid", path: candidate.file, reason: `not valid JSON: ${describe(error)}` }
  }

  if (!isRecord(parsed)) return { kind: "invalid", path: candidate.file, reason: "top level is not an object" }

  const policies = parsed["policies"]
  if (!isRecord(policies)) return { kind: "invalid", path: candidate.file, reason: "no policies object" }

  const entry = policies[SPEC_UNAME]
  if (!isRecord(entry)) return { kind: "unassigned" }

  const engine = parsed["telemetry_engine"]

  return {
    hooksPath: runnerFor(candidate, platform),
    hookEnv: hookEnvFor(candidate),
    armorHome: candidate.home,
    settingsFile: path.join(candidate.home, "config", "settings.json"),
    telemetryEngine: typeof engine === "string" && engine !== "" ? engine : "interpreter",
    specUname: SPEC_UNAME,
    policyEnabled: entry["remediation_mode"] === true,
    telemetryEnabled: entry["telemetry_mode"] === true,
    timeoutMs: HOOK_TIMEOUT_MS,
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ConfigLoad {
  const searched = candidates(env)

  for (const candidate of searched) {
    let raw: string
    try {
      raw = fs.readFileSync(candidate.file, "utf8")
    } catch {
      continue
    }
    const parsed = parseConfig(raw, candidate, platform)
    return "kind" in parsed ? parsed : { kind: "ok", config: parsed }
  }

  return { kind: "missing", searched: searched.map((candidate) => candidate.file) }
}

// ---------------------------------------------------------------------------
// Running the hook
// ---------------------------------------------------------------------------
// A .ps1 cannot be executed directly; on Windows the runner is hooks.ps1 under the same
// host the agent uses for every other client (policy.ps1). `host` is only overridden by
// tests, which drive the Windows argv through pwsh on a unix box.
// Detached only on unix: it keeps a hook alive when V2 `run` tears down the process group
// at the end of a turn. On Windows it means DETACHED_PROCESS, no console, and powershell.exe
// exits 0 without running the script.
export function spawnSpec(
  hooksPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  host = "powershell.exe",
): { readonly file: string; readonly argv: readonly string[]; readonly detached: boolean } {
  if (platform !== "win32") return { file: hooksPath, argv: args, detached: true }
  return {
    file: host,
    argv: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hooksPath, ...args],
    detached: false,
  }
}

// Async: spawnSync would block the server event loop and stall every other session.
export function runHook(
  config: AdapterConfig,
  section: Section,
  payload: HookPayload,
  spec: (hooksPath: string, args: readonly string[]) => ReturnType<typeof spawnSpec> = spawnSpec,
): Promise<Decision> {
  return new Promise((resolve) => {
    const args = ["--policy", config.specUname, "--hook", section]
    // Telemetry-only sections never carry --policy-enabled, as for every other client.
    const enforcing = (ENFORCE_SECTIONS as readonly string[]).includes(section)
    if (enforcing && config.policyEnabled) args.push("--policy-enabled")
    if (config.telemetryEnabled) args.push("--telemetry-enabled")
    const { file, argv, detached } = spec(config.hooksPath, args)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ARMOR1_TELEMETRY_ENGINE: config.telemetryEngine,
      ARMOR1_HOME: config.armorHome,
      ARMOR1_SETTINGS_FILE: config.settingsFile,
      ...config.hookEnv,
    }

    let child
    try {
      // windowsHide: never let a hook flash a console window on the user's screen.
      child = spawn(file, [...argv], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ kind: "degraded", signal: "hook_spawn_failed", reason: describe(error) })
      return
    }

    let stdout = ""
    let settled = false
    const finish = (decision: Decision): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(decision)
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ kind: "degraded", signal: "hook_timeout", reason: `hook exceeded ${config.timeoutMs}ms` })
    }, config.timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stdout.on("error", () => {})
    child.stderr.on("data", () => {})
    child.stderr.on("error", () => {})
    child.on("error", (error) => finish({ kind: "degraded", signal: "hook_spawn_failed", reason: describe(error) }))
    child.on("close", (code) => finish(parseDecision(stdout, code)))

    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

// ---------------------------------------------------------------------------
// Reading its answer
// ---------------------------------------------------------------------------

const degraded = (signal: Signal, reason: string): Decision => ({ kind: "degraded", signal, reason })

const NOT_APPLICABLE_EXIT = 42

export function parseDecision(stdout: string, exitCode: number | null): Decision {
  if (exitCode === NOT_APPLICABLE_EXIT) return { kind: "allow" }

  const text = stdout.trim()
  if (text === "") return { kind: "allow" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return degraded("hook_unparseable", "hook stdout was not JSON")
  }

  const root = asRecord(parsed)
  if (root === undefined) return degraded("hook_unparseable", "hook stdout was not an object")

  const nested = asRecord(root["hookSpecificOutput"])
  const verdict = asString(root["decision"]) ?? asString(nested?.["permissionDecision"])

  if (verdict === undefined) return degraded("hook_unparseable", "hook stdout carried no decision")

  if (verdict === "deny") {
    const reason =
      asString(root["reason"]) ??
      asString(nested?.["permissionDecisionReason"]) ??
      "blocked by Armor1 policy"
    return { kind: "deny", reason }
  }

  if (verdict === "allow") {
    const context = asString(root["reason"]) ?? asString(nested?.["additionalContext"])
    return context === undefined ? { kind: "allow" } : { kind: "allow", context }
  }
  if (verdict === "ask") return degraded("hook_ask_downgraded", "hook returned ask, unsupported by OpenCode")

  return degraded("hook_unparseable", `unrecognised decision "${verdict}"`)
}
