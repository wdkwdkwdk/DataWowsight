#!/usr/bin/env bash
set -euo pipefail

REMOTE="origin"
BRANCH=""
COMMIT_MESSAGE=""
NO_PUSH=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: auto_git_update.sh [options]

Options:
  -m, --message <msg>   Set commit title directly
  -r, --remote <name>   Push remote (default: origin)
  -b, --branch <name>   Push branch (default: current branch)
      --no-push         Commit only, skip push
      --dry-run         Show summary and planned actions without changing git state
  -h, --help            Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    -r|--remote)
      REMOTE="${2:-}"
      shift 2
      ;;
    -b|--branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: current directory is not a Git repository." >&2
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
fi

if [[ -z "$BRANCH" ]]; then
  echo "Error: could not determine current branch; pass --branch explicitly." >&2
  exit 1
fi

if [[ -z "$(git status --porcelain)" ]]; then
  echo "No changes detected. Nothing to commit."
  exit 0
fi

echo "=== Git change summary ==="
git status --short --branch
echo
git diff --stat || true
echo

if [[ -z "$COMMIT_MESSAGE" ]]; then
  changed_files="$(git status --porcelain --untracked-files=all | wc -l | tr -d ' ')"
  noun="files"
  if [[ "$changed_files" -eq 1 ]]; then
    noun="file"
  fi
  COMMIT_MESSAGE="chore: update ${changed_files} ${noun}"
fi

echo "Planned commit message: $COMMIT_MESSAGE"
echo "Planned push target: ${REMOTE}/${BRANCH}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run enabled. No git changes were made."
  exit 0
fi

git add -A
git commit -m "$COMMIT_MESSAGE"

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "Commit created; push skipped due to --no-push."
  exit 0
fi

git push "$REMOTE" "$BRANCH"
echo "Push completed: ${REMOTE}/${BRANCH}"
