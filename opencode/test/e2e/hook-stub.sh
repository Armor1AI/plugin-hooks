#!/bin/bash
# Stands in for $ARMOR1_HOME/current/policies/hooks.sh during e2e.
# Same contract: event JSON on stdin, decision JSON on stdout, exit 0.
hook=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hook) hook="$2"; shift 2 ;;
    *) shift ;;
  esac
done
payload=$(cat)
[[ -n "$ARMOR1_E2E_HOOK_LOG" ]] && echo "$hook|$payload" >> "$ARMOR1_E2E_HOOK_LOG"
[[ -n "$ARMOR1_E2E_HOOK_SLEEP" ]] && sleep "$ARMOR1_E2E_HOOK_SLEEP"

deny() { printf '{"decision":"deny","reason":"%s"}\n' "$1"; exit 0; }
allow() { printf '{"decision":"allow"}\n'; exit 0; }
allow_with_context() { printf '{"decision":"allow","reason":"%s"}\n' "$1"; exit 0; }

value=$(printf '%s' "$payload" | jq -r 'if (.armor1.section // "") | test("mcp") then .tool_name else (.tool_input.command // .tool_input.file_path // .tool_input.url // "") end')

case "$hook" in
  command_execution)
    [[ "$value" == *"rm -rf"* ]] && deny "Armor1 policy: destructive command blocked"
    [[ "$value" == *"hello-allowed"* ]] && allow_with_context "Armor1 note: echo is on the allowlist"
    allow ;;
  file_access_read)
    [[ "$value" == *.env ]] && deny "Armor1 policy: reading secrets is blocked"
    allow_with_context "Armor1 note: read was permitted" ;;
  file_access_write) [[ "$value" == *.env ]] && deny "Armor1 policy: writing secrets is blocked"; allow ;;
  network_access)    [[ "$value" == *"evil.example"* ]] && deny "Armor1 policy: domain blocked"; allow ;;
  mcp)
    [[ "$value" == *"delete"* ]] && deny "Armor1 policy: destructive MCP tool blocked"
    allow_with_context "Armor1 note: MCP call permitted" ;;
  *) allow ;;
esac
