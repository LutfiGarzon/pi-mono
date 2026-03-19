# Objective: add-shift-enter-keybinding

## Tasks
- [x] Research current keybinding implementation in packages/tui or packages/coding-agent (Focusing on low-level TUI events)
- [x] Identify the specific editor component handling keyboard input and how it receives Shift+Enter events from TUI
- [x] Update `packages/tui/src/keys.ts` to ensure `ctrl+enter` is recognized correctly across terminal protocols
- [x] Update `packages/tui/src/keybindings.ts` to add `ctrl+enter` and `ctrl+j` as a default for the `newLine` action
- [x] Verify the fix via unit tests and build the project
