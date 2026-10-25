#!/usr/bin/env bash
# Verification helper script for the Subagent Orchestration Layer

set -euo pipefail

echo "=== Subagent Orchestration Environment Check ==="

# 1. Node.js check
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  echo "✔ Node.js installed: $NODE_VER"
else
  echo "✖ Node.js is not installed!"
  exit 1
fi

# 2. Git check & base branch
if command -v git >/dev/null 2>&1; then
  GIT_VER=$(git --version)
  echo "✔ Git installed: $GIT_VER"
  
  CURRENT_BRANCH=$(git branch --show-current || echo "none")
  echo "  Current branch: $CURRENT_BRANCH"
  
  if git rev-parse --verify integration >/dev/null 2>&1; then
    echo "✔ 'integration' branch exists"
  else
    echo "ℹ 'integration' branch does not exist yet. Creating from HEAD..."
    git branch integration HEAD
    echo "✔ 'integration' branch initialized"
  fi
else
  echo "✖ Git is not installed!"
  exit 1
fi

# 3. Worktree support check
echo "ℹ Verifying git worktree capability..."
TEMP_WT="wt/.check_wt_test"
mkdir -p wt
if git worktree add --detach "$TEMP_WT" HEAD >/dev/null 2>&1; then
  git worktree remove --force "$TEMP_WT" >/dev/null 2>&1
  echo "✔ Git worktrees functional"
else
  echo "✖ Git worktree command failed"
  exit 1
fi

# 4. Check directories
for dir in "agents/prompts" "scripts/lib" "scripts/gates" "runs/orchestrator" "docs"; do
  if [ -d "$dir" ]; then
    echo "✔ Directory exists: $dir"
  else
    echo "ℹ Directory to be created: $dir"
  fi
done

echo "=== All prerequisite checks passed ==="
