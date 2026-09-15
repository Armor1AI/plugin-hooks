import path from "node:path"
import os from "node:os"
import type { PatchOp } from "./types.ts"

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------
// Values the plugin does not control: hook stdout, policies.json, and OpenCode's own
// event payloads.

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function toAbsolute(value: string, cwd: string): string {
  const expanded = expandHome(value)
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)
}

// ---------------------------------------------------------------------------
// MCP tool ids
// ---------------------------------------------------------------------------

// A tool id is server + "_" + tool, both with odd characters replaced by "_", so splitting
// on "_" cannot tell them apart. Match against the servers actually configured.

export type McpResolution =
  | { readonly kind: "none" }
  | { readonly kind: "match"; readonly server: string; readonly tool: string }
  | { readonly kind: "ambiguous"; readonly servers: readonly string[] }

export function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function resolveMcpTool(toolId: string, servers: readonly string[]): McpResolution {
  const matches: { server: string; tool: string }[] = []

  for (const server of servers) {
    const prefix = sanitize(server) + "_"
    if (toolId.length > prefix.length && toolId.startsWith(prefix)) {
      matches.push({ server, tool: toolId.slice(prefix.length) })
    }
  }

  if (matches.length === 0) return { kind: "none" }

  // Prefer the longest server prefix; only genuinely equal-length prefixes are ambiguous.
  let longest = matches[0]!
  for (const candidate of matches) {
    if (sanitize(candidate.server).length > sanitize(longest.server).length) longest = candidate
  }
  const tied = matches.filter(
    (m) => sanitize(m.server).length === sanitize(longest.server).length,
  )
  if (tied.length > 1) return { kind: "ambiguous", servers: tied.map((m) => m.server) }

  return { kind: "match", server: longest.server, tool: longest.tool }
}

// ---------------------------------------------------------------------------
// Patch bodies
// ---------------------------------------------------------------------------

export interface PatchTarget {
  readonly op: PatchOp
  readonly path: string
  readonly movePath?: string
}

export interface PatchScan {
  readonly targets: readonly PatchTarget[]
  readonly wellFormed: boolean
}

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"
const ADD = "*** Add File:"
const DELETE = "*** Delete File:"
const UPDATE = "*** Update File:"
const MOVE = "*** Move to:"

// Scans every line for a header rather than skipping hunk bodies. Finding one path too
// many costs an extra check; missing one lets a write through unchecked.
export function scanPatch(patchText: string): PatchScan {
  const lines = patchText.split(/\r?\n/)
  const begin = lines.findIndex((line) => line.trim() === BEGIN)
  const end = lines.findIndex((line) => line.trim() === END)

  if (begin === -1 || end === -1 || begin >= end) {
    return { targets: [], wellFormed: false }
  }

  const targets: PatchTarget[] = []

  for (let i = begin + 1; i < end; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (line.startsWith(ADD)) {
      const target = line.slice(ADD.length).trim()
      if (target) targets.push({ op: "add", path: target })
      continue
    }

    if (line.startsWith(DELETE)) {
      const target = line.slice(DELETE.length).trim()
      if (target) targets.push({ op: "delete", path: target })
      continue
    }

    if (line.startsWith(UPDATE)) {
      const target = line.slice(UPDATE.length).trim()
      if (!target) continue

      const next = lines[i + 1]
      if (next !== undefined && next.startsWith(MOVE)) {
        const movePath = next.slice(MOVE.length).trim()
        i++
        if (movePath) {
          targets.push({ op: "move", path: target, movePath })
          continue
        }
      }
      targets.push({ op: "update", path: target })
    }
  }

  return { targets, wellFormed: true }
}
