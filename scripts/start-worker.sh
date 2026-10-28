#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "Usage: $(basename "$0")" >&2
  echo "Error: This script does not accept any arguments." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_SCRIPT="$PROJECT_ROOT/dist/worker.js"

if [ ! -f "$WORKER_SCRIPT" ]; then
  echo "Error: worker script not found at $WORKER_SCRIPT. Please run 'npm run build' first." >&2
  exit 1
fi

AGENT_BRIDGE_ROOT="${AGENT_BRIDGE_ROOT:-"$HOME/agent-bridge"}"
export AGENT_BRIDGE_ROOT

AGENTS_FILE="$AGENT_BRIDGE_ROOT/agents.json"
if [ ! -f "$AGENTS_FILE" ]; then
  echo "Error: Agent registry file not found at $AGENTS_FILE" >&2
  exit 1
fi

WORKDIR="$HOME/agent-bridge/workdir"
if [ ! -d "$WORKDIR" ]; then
  mkdir -p "$WORKDIR"
fi

cd "$WORKDIR" && exec node "$WORKER_SCRIPT"
