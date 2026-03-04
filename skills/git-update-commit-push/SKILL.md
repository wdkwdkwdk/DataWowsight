---
name: git-update-commit-push
description: Automate repository update handoff by summarizing changes, staging files, committing, and pushing to remote. Use when the user asks to "总结更新并提交", "git add commit push", "自动提交代码", or any request that combines change summary + Git commit/push in one flow.
---

# Git Update Commit Push

Summarize current repo changes and execute a safe one-command Git handoff.

## Workflow

1. Verify repository and branch state with `git status --short --branch`.
2. Summarize staged/unstaged changes using:
   - `git diff --stat`
   - `git diff --cached --stat`
   - `git diff -- <file>` for key files when needed
3. Run the automation script:
   - `scripts/auto_git_update.sh`
4. Report:
   - Summary of changes
   - Commit hash and message
   - Push target (`remote/branch`)

## Command

Run from repository root:

```bash
skills/git-update-commit-push/scripts/auto_git_update.sh
```

Common options:

```bash
# custom commit title
skills/git-update-commit-push/scripts/auto_git_update.sh --message "feat(api): add retry logic"

# commit but do not push
skills/git-update-commit-push/scripts/auto_git_update.sh --no-push

# preview only
skills/git-update-commit-push/scripts/auto_git_update.sh --dry-run
```

## Guardrails

- Stop if not inside a Git repository.
- Stop if no changes exist.
- Detect current branch automatically unless `--branch` is provided.
- Default remote is `origin` unless `--remote` is provided.
- Keep commit message concise and action-oriented. Use `references/commit-style.md` if unsure.

## Resources

- Script: `scripts/auto_git_update.sh`
- Reference: `references/commit-style.md`
