# Local Project Update Guidelines

This folder contains configuration and local documentation for agents working on this repository.

## How to update the project and sync with upstream

If you are notified that there is a pending update (or if the version in `package.json` is behind the version reported by npm), follow these steps:

1. **Sync with Upstream**: Run `./update-pi.sh` from the repository root.
   - This script fetches from `upstream` (https://github.com/badlogic/pi-mono.git).
   - It rebases your local `main` onto `upstream/main`.
   - It performs a fresh build.
   - It re-installs the global `pi` package from your local build.

2. **Manual Conflicts**: If `git rebase` fails due to conflicts:
   - Identify which files have conflicts (`git status`).
   - Resolve them carefully, ensuring you don't remove custom features (like `plan` or `ask` tools).
   - `git add <resolved-files>`
   - `git rebase --continue`

3. **Verify**: Run `pi --version` to ensure it reflects the latest version (e.g., `0.64.0`).
