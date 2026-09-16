#!/bin/bash
# End-to-end harness: real opencode binary + bundled adapter + fake model.
set -uo pipefail
set +m  # suppress job-control notices when killing background helpers
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
RIG="$HERE/.rig"
BUILD="1.4.0+test"
PORT=18473
PASS=0
FAIL=0
ONLY="${1:-}"

# Run one scenario with ./e2e/run.sh <name>. The full suite takes ~100s, a single
# scenario ~11s, which matters when iterating on one section.
want() { [[ -z "$ONLY" || "$1" == *"$ONLY"* ]]; }

check() {
  if [[ "$2" == "$3" ]]; then echo "    ok: $1"; PASS=$((PASS+1))
  else echo "    FAIL: $1 (expected '$3', got '$2')"; FAIL=$((FAIL+1)); fi
}

setup() {
  pkill -f "e2e/fake-llm.mjs" 2>/dev/null; sleep 0.3
  rm -rf "$RIG"; mkdir -p "$RIG/home/.config/opencode/plugins" "$RIG/work" "$RIG/armor1/$BUILD/policies"
  # the Windows form of the pointer: a text file holding the build id, not a symlink
  printf '%s\n' "$BUILD" > "$RIG/armor1/current"
  echo "SECRET=supersecret" > "$RIG/work/secret.env"
  echo "plain readable file" > "$RIG/work/notes.txt"
  rm -rf /tmp/armor1-e2e-victim; mkdir -p /tmp/armor1-e2e-victim
  echo canary > /tmp/armor1-e2e-victim/canary.txt
  cp "$ROOT/dist/armor1-opencode.js" "$RIG/home/.config/opencode/plugins/armor1.js"
}

# Stands in for the consolidated policy the device maintains. The adapter derives the hook
# path from ARMOR1_HOME, so the stub is symlinked into place rather than named here.
write_config() {
  ln -sf "$1" "$RIG/armor1/$BUILD/policies/hooks.sh"
  cat > "$RIG/armor1/$BUILD/policies/policies.json" <<EOF
{ "telemetry_engine": "interpreter",
  "policies": { "opencode-policy": { "spec_uname": "opencode-policy",
                                     "remediation_mode": true, "telemetry_mode": true } } }
EOF
}

run_opencode() {
  local scenario="$1" model="$2"
  sed -e "s|\$WORK|$RIG/work|g" -e "s|\$VICTIM|/tmp/armor1-e2e-victim|g" \
    "$HERE/scenarios/$scenario.json" > "$RIG/scenario.json"

  SCENARIO="$RIG/scenario.json" PORT=$PORT MESSAGES_FILE="$RIG/messages.log" \
    nohup node "$HERE/${LLM_SERVER:-fake-llm.mjs}" \
    > "$RIG/llm.log" 2>&1 < /dev/null &
  local llm=$!
  disown $llm 2>/dev/null
  sleep 1

  local cfg
  cfg=$(cat <<EOF
{"\$schema":"https://opencode.ai/config.json","permission":"allow","formatter":false,"lsp":false,
 ${MCP_BLOCK:-}
 "provider":{"test":{"name":"Test","id":"test","env":[],"npm":"${PROVIDER_NPM:-@ai-sdk/openai-compatible}",
 "models":{"$model":{"id":"$model","name":"T","attachment":false,"reasoning":false,"temperature":false,
 "tool_call":true,"release_date":"2025-01-01","limit":{"context":100000,"output":10000},
 "cost":{"input":0,"output":0},"options":{}}},
 "options":{"apiKey":"k","baseURL":"http://127.0.0.1:$PORT/v1"}}}}
EOF
)
  ( cd "$RIG/work" && env -i PATH="$PATH" \
      HOME="$RIG/home" OPENCODE_TEST_HOME="$RIG/home" \
      XDG_CONFIG_HOME="$RIG/home/.config" XDG_DATA_HOME="$RIG/home/.local/share" \
      XDG_STATE_HOME="$RIG/home/.local/state" XDG_CACHE_HOME="$RIG/home/.cache" \
      OPENCODE_CONFIG_CONTENT="$cfg" \
      OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
      OPENCODE_DISABLE_AUTOCOMPACT=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_AUTH_CONTENT='{}' \
      ARMOR1_HOME="$RIG/armor1" \
      ARMOR1_E2E_HOOK_LOG="$RIG/hook.log" ${HOOK_SLEEP:+ARMOR1_E2E_HOOK_SLEEP=$HOOK_SLEEP} \
      opencode run --model "test/$model" "do the tasks" ) > "$RIG/out.log" 2>&1 < /dev/null &
  local oc=$!
  # stdout is redirected so an orphaned watchdog cannot hold the script's pipe open and
  # inflate the measured wall time
  ( sleep 120; kill -9 $oc 2>/dev/null ) >/dev/null 2>&1 & local watch=$!
  disown $watch 2>/dev/null
  wait $oc; local code=$?
  kill $watch $llm 2>/dev/null
  cp "$RIG/hook.log" "$HERE/.last-$scenario.log" 2>/dev/null
  return $code
}

if want "enforce"; then
  echo "=== scenario: enforce (Claude-style model) ==="
  setup; write_config "$HERE/hook-stub.sh"
  run_opencode enforce test-model
  check "session completed" "$?" "0"
  check "rm -rf blocked, canary survives" "$([ -f /tmp/armor1-e2e-victim/canary.txt ] && echo yes || echo no)" "yes"
  # assert on what the model received, not on how the CLI rendered it
  check "allowed echo ran and its output reached the model" "$([ "$(grep -c '"content":"hello-allowed' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "secret.env read blocked" "$(grep -c 'reading secrets is blocked' "$RIG/out.log")" "1"
  check "allowed write landed" "$([ -f "$RIG/work/allowed.txt" ] && echo yes || echo no)" "yes"
  check "network deny enforced" "$(grep -c 'domain blocked' "$RIG/out.log")" "1"
  check "prompt telemetry fired once" "$(grep -c '^before_submit_prompt|' "$RIG/hook.log")" "1"
  check "post_shell_execution only for the allowed command" "$(grep -c '^post_shell_execution|' "$RIG/hook.log")" "1"
  check "post_write_file fired" "$(grep -c '^post_write_file|' "$RIG/hook.log")" "1"
  check "post_network_access fired for the allowed fetch" "$(grep -c '^post_network_access|' "$RIG/hook.log")" "1"
  check "no post hook after a denial" "$(grep -c '^post_' "$RIG/hook.log")" "3"
  check "turn id stamped on tool payloads" "$(grep '^command_execution|' "$RIG/hook.log" | grep -c '"turn_id":"[^"]')" "2"
  check "session_start fired once" "$(grep -c '^session_start|' "$RIG/hook.log")" "1"
  check "session_start precedes the prompt" "$(head -1 "$RIG/hook.log" | cut -d'|' -f1)" "session_start"
  check "session_start carries a real model" "$(grep '^session_start|' "$RIG/hook.log" | grep -c '"model":"test/test-model"')" "1"
  check "session_start carries an agent" "$(grep '^session_start|' "$RIG/hook.log" | grep -c '"agent":"[a-z]')" "1"
  check "stop fired once at idle" "$(grep -c '^stop|' "$RIG/hook.log")" "1"
  check "stop status is completed" "$(grep '^stop|' "$RIG/hook.log" | grep -c '"status":"completed"')" "1"
  # the model is resent the full history each turn, so a result appears more than once
  check "command deny reason reaches the model verbatim" "$([ "$(grep -c '"role":"tool","tool_call_id":"[^"]*","content":"Armor1 policy: destructive command blocked"' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "allow context works for read, which has no post section" "$([ "$(grep -c 'Armor1 note: read was permitted' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "read deny reason reaches the model verbatim" "$([ "$(grep -c '"role":"tool","tool_call_id":"[^"]*","content":"Armor1 policy: reading secrets is blocked"' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "allow context appended to the tool result the model sees" "$([ "$(grep -c 'Armor1 note: echo is on the allowlist' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "original tool output is preserved alongside the context" "$([ "$(grep -c 'hello-allowed' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "denied result carries the reason and nothing appended" "$([ "$(grep -c '"content":"Armor1 policy: destructive command blocked"' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "no adapter internals leak into the model" "$(grep -c 'armor1-opencode\|at Object\|undefined is not' "$RIG/messages.log")" "0"
fi
if want "patch"; then
  echo "=== scenario: patch (GPT-class model, apply_patch is the only write tool) ==="
  setup; write_config "$HERE/hook-stub.sh"
  run_opencode patch gpt-5-fake
  check "session completed" "$?" "0"
  check "secret.env NOT modified" "$(cat "$RIG/work/secret.env")" "SECRET=supersecret"
  check "patch on secret blocked" "$(grep -c 'writing secrets is blocked' "$RIG/out.log")" "1"
  check "harmless patch applied" "$([ -f "$RIG/work/harmless.txt" ] && echo yes || echo no)" "yes"
fi
if want "degraded_missing"; then
  echo "=== scenario: degraded, hook script missing ==="
  setup; write_config "$HERE/hook-stub-that-does-not-exist.sh"
  run_opencode degraded test-model
  check "session completed" "$?" "0"
  check "failed open, rm ran" "$([ -f /tmp/armor1-e2e-victim/canary.txt ] && echo yes || echo no)" "no"
fi
if want "degraded_hang"; then
  # The adapter's timeout is a constant 10s. This turn makes six hook calls, so a hook
  # sleeping 25s costs ~60s when cut short and ~150s when not.
  echo "=== scenario: degraded, hook hangs past the 10s timeout ==="
  setup; write_config "$HERE/hook-stub.sh"
  start=$(date +%s)
  HOOK_SLEEP=25 run_opencode degraded test-model
  elapsed=$(( $(date +%s) - start ))
  check "session completed" "$?" "0"
  check "each hook cut short rather than running its full 25s" "$([ $elapsed -lt 90 ] && echo yes || echo no)" "yes"
fi
if want "mcp_tools"; then
  echo "=== scenario: mcp tool calls against a real stdio MCP server ==="
  setup; write_config "$HERE/hook-stub.sh"
  MCP_BLOCK="\"mcp\":{\"armor1.test\":{\"type\":\"local\",\"command\":[\"node\",\"$HERE/mcp-server.mjs\"],\"enabled\":true}}," \
    run_opencode mcp_tools test-model
  check "session completed" "$?" "0"
  check "mcp enforcement ran for both calls" "$(grep -c '^mcp|' "$RIG/hook.log")" "2"
  check "destructive mcp tool denied" "$(grep -c 'destructive MCP tool blocked' "$RIG/out.log")" "1"
  check "allowed mcp tool executed" "$(grep -c 'hello from mcp' "$RIG/out.log")" "1"
  check "post_mcp fired only for the allowed call" "$(grep -c '^post_mcp|' "$RIG/hook.log")" "1"
  check "server name resolved through sanitize" "$(grep '^mcp|' "$RIG/hook.log" | grep -c '"server":"armor1.test"')" "2"
  check "tool name resolved" "$(grep '^mcp|' "$RIG/hook.log" | grep -c '"tool":"echo_text"')" "1"
  check "post_mcp carries the real tool response" "$(grep '^post_mcp|' "$RIG/hook.log" | grep -c 'echoed: hello from mcp')" "1"
  check "mcp args land in tool_input" "$(grep '^mcp|' "$RIG/hook.log" | grep -c '"tool_input":{"text":"hello from mcp"}')" "1"
fi
if want "failure"; then
  echo "=== scenario: stop_failure from a provider error ==="
  setup; write_config "$HERE/hook-stub.sh"
  run_opencode failure test-model
  check "stop_failure telemetry fired" "$(grep -c '^stop_failure|' "$RIG/hook.log")" "1"
  check "error name captured" "$(grep '^stop_failure|' "$RIG/hook.log" | grep -c '"error":"[A-Za-z]')" "1"
fi
if want "tokens"; then
  echo "=== scenario: model_token_usage flushed at session.idle ==="
  setup; write_config "$HERE/hook-stub.sh"
  run_opencode tokens test-model
  check "session completed" "$?" "0"
  check "model_token_usage fired" "$([ "$(grep -c '^model_token_usage|' "$RIG/hook.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "not attributed to a subagent" "$(grep -c '^model_token_usage_subagent|' "$RIG/hook.log")" "0"
  check "input tokens are non-zero" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"input_tokens":[1-9]')" "1"
  check "output tokens are non-zero" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"output_tokens":[1-9]')" "1"
  check "cache read carried through" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"cache_read_input_tokens":[1-9]')" "1"
  check "model name recorded" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"model":"test/')" "1"
fi
if want "anthropic"; then
  echo "=== scenario: cache_creation tokens via the Anthropic wire protocol ==="
  setup; write_config "$HERE/hook-stub.sh"
  LLM_SERVER=fake-anthropic.mjs PROVIDER_NPM=@ai-sdk/anthropic run_opencode tokens claude-fake
  check "session completed" "$?" "0"
  check "model_token_usage fired" "$([ "$(grep -c '^model_token_usage|' "$RIG/hook.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "cache_creation tokens are non-zero" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"cache_creation_input_tokens":[1-9]')" "1"
fi
if want "subagent"; then
  echo "=== scenario: subagent token usage attributed separately ==="
  setup; write_config "$HERE/hook-stub.sh"
  run_opencode subagent test-model
  check "session completed" "$?" "0"
  check "subagent usage fired" "$([ "$(grep -c '^model_token_usage_subagent|' "$RIG/hook.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "parent usage fired too" "$([ "$(grep -c '^model_token_usage|' "$RIG/hook.log")" -ge 1 ] && echo yes || echo no)" "yes"
  check "subagent payload carries agent_id" "$(grep '^model_token_usage_subagent|' "$RIG/hook.log" | grep -c '"agent_id":"ses_')" "1"
  check "subagent scope tagged" "$(grep '^model_token_usage_subagent|' "$RIG/hook.log" | grep -c '"scope":"subagent"')" "1"
fi


# --- V2 ------------------------------------------------------------------------
# opencode 2.x (`@opencode/cli`) is a different binary with an incompatible plugin
# API. Three things differ from the V1 runner, all learned the hard way:
#   * `--standalone` is mandatory. Otherwise V2 uses a machine-global background
#     service which answers for whatever config it started with, ignoring ours.
#   * config goes in a real opencode.json. OPENCODE_CONFIG_CONTENT does not
#     register MCP servers on V2, and a stale service made that look intermittent.
#   * never delete the state dir mid-run: V2 keeps opencode.db there.
# Set OPENCODE_V2_BIN to the 2.x binary; the pass is skipped when it is unset.
run_opencode_v2() {
  local scenario="$1" model="$2"
  sed -e "s|\$WORK|$RIG/work|g" -e "s|\$VICTIM|/tmp/armor1-e2e-victim|g" \
    "$HERE/scenarios/$scenario.json" > "$RIG/scenario.json"

  SCENARIO="$RIG/scenario.json" PORT=$PORT MESSAGES_FILE="$RIG/messages.log" \
    nohup node "$HERE/${LLM_SERVER:-fake-llm.mjs}" > "$RIG/llm.log" 2>&1 < /dev/null &
  local llm=$!
  disown $llm 2>/dev/null
  sleep 1

  mkdir -p "$RIG/home/.config/opencode"
  cat > "$RIG/home/.config/opencode/opencode.json" <<EOF
{"\$schema":"https://opencode.ai/config.json","model":"test/$model",
 "provider":{"test":{"name":"Test","id":"test","env":[],"npm":"@ai-sdk/openai-compatible",
 "models":{"$model":{"id":"$model","name":"T","attachment":false,"reasoning":false,
 "temperature":false,"tool_call":true}},
 "options":{"apiKey":"k","baseURL":"http://127.0.0.1:$PORT/v1"}}}}
EOF

  ( cd "$RIG/work" && env -i PATH="$PATH" \
      HOME="$RIG/home" \
      XDG_CONFIG_HOME="$RIG/home/.config" XDG_DATA_HOME="$RIG/home/.local/share" \
      XDG_STATE_HOME="$RIG/home/.local/state" XDG_CACHE_HOME="$RIG/home/.cache" \
      ARMOR1_HOME="$RIG/armor1" ARMOR1_E2E_HOOK_LOG="$RIG/hook.log" \
      ${HOOK_SLEEP:+ARMOR1_E2E_HOOK_SLEEP=$HOOK_SLEEP} \
      "$OPENCODE_V2_BIN" run --standalone --auto "do the tasks" ) > "$RIG/out.log" 2>&1 < /dev/null &
  local oc=$!
  ( sleep 120; kill -9 $oc 2>/dev/null ) >/dev/null 2>&1 & local watch=$!
  disown $watch 2>/dev/null
  wait $oc; local code=$?
  kill $watch $llm 2>/dev/null
  cp "$RIG/hook.log" "$HERE/.last-$scenario.log" 2>/dev/null
  return $code
}

if [[ -n "${OPENCODE_V2_BIN:-}" ]]; then
  if want "v2_enforce"; then
    echo "=== V2 scenario: enforcement across every section ==="
    setup; write_config "$HERE/hook-stub.sh"
    run_opencode_v2 v2_enforce test-model
    check "session completed" "$?" "0"
    check "rm -rf blocked, canary survives" "$([ -f /tmp/armor1-e2e-victim/canary.txt ] && echo yes || echo no)" "yes"
    check "shell routes to command_execution (not bash)" "$(grep -c '^command_execution|' "$RIG/hook.log")" "2"
    check "allowed echo reached the model" "$([ "$(grep -c 'hello-allowed' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
    check "allow-side context reached the model" "$([ "$(grep -c 'Armor1 note' "$RIG/messages.log")" -ge 1 ] && echo yes || echo no)" "yes"
    check "secret.env read blocked" "$(grep -c 'reading secrets is blocked' "$RIG/out.log")" "1"
    check "network deny enforced" "$(grep -c 'domain blocked' "$RIG/out.log")" "1"
    check "session_start fired once" "$(grep -c '^session_start|' "$RIG/hook.log")" "1"
    check "prompt telemetry fired once" "$(grep -c '^before_submit_prompt|' "$RIG/hook.log")" "1"
    check "post_shell_execution only for the allowed command" "$(grep -c '^post_shell_execution|' "$RIG/hook.log")" "1"
  fi
  if want "v2_codemode"; then
    echo "=== V2 scenario: code mode is a command-execution surface ==="
    setup; write_config "$HERE/hook-stub.sh"
    run_opencode_v2 v2_codemode test-model
    check "session completed" "$?" "0"
    check "execute routes to command_execution" "$(grep -c '^command_execution|' "$RIG/hook.log")" "1"
    # the silent hole: execute names its argument `code`, so reading only
    # command/cmd handed the policy an empty string while the section looked fine
    check "the code itself reached the policy" "$(grep '^command_execution|' "$RIG/hook.log" | grep -c '"command":"1 + 1"')" "1"
    check "post_shell_execution fired" "$(grep -c '^post_shell_execution|' "$RIG/hook.log")" "1"
  fi
  if want "v2_tokens"; then
    echo "=== V2 scenario: per-turn token usage ==="
    setup; write_config "${SPY:-$HERE/hook-stub.sh}"
    run_opencode_v2 v2_tokens test-model
    check "session completed" "$?" "0"
    check "model_token_usage fired" "$([ "$(grep -c '^model_token_usage|' "$RIG/hook.log")" -ge 1 ] && echo yes || echo no)" "yes"
    check "not attributed to a subagent" "$(grep -c '^model_token_usage_subagent|' "$RIG/hook.log")" "0"
    check "input tokens are non-zero" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"input_tokens":[1-9]')" "1"
    check "cache read carried through" "$(grep '^model_token_usage|' "$RIG/hook.log" | grep -c '"cache_read_input_tokens":[1-9]')" "1"
    check "stop fired" "$(grep -c '^stop|' "$RIG/hook.log")" "1"
  fi
  if want "v2_failure"; then
    echo "=== V2 scenario: stop_failure from a provider error ==="
    setup; write_config "$HERE/hook-stub.sh"
    run_opencode_v2 v2_failure test-model
    check "stop_failure telemetry fired" "$(grep -c '^stop_failure|' "$RIG/hook.log")" "1"
  fi
fi

pkill -f "e2e/fake-llm.mjs" 2>/dev/null
rm -rf /tmp/armor1-e2e-victim
echo
echo "=== $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
