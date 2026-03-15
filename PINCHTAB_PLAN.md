# PinchTab Extension Proposal

Adding web browsing capabilities to `pi` using `pinchtab`.

## Overview

`pinchtab` is a high-performance browser automation bridge designed for AI agents. It provides a token-efficient way to interact with the web by extracting structured data (snapshots) instead of raw HTML or screenshots.

## Refined Plan

1. **CLI Focused**: The extension will act as a thin wrapper around the `pinchtab` CLI.
2. **Browser: Microsoft Edge**: We will configure `pinchtab` to use the Edge binary.
3. **Installation**: We'll use the `npm` version for easy integration, or assume the binary is available in `PATH`.

## Updated Toolset (CLI-based)

| Tool | CLI Command | Description |
|------|-------------|-------------|
| `browser_open` | `pinchtab nav <url>` | Navigates the current instance to a URL. |
| `browser_snapshot` | `pinchtab snap -i` | Gets an interactive snapshot of the page. |
| `browser_click` | `pinchtab click <ref>` | Clicks an element by its reference. |
| `browser_type` | `pinchtab fill <ref> <text>` | Fills an input field. |
| `browser_press` | `pinchtab press <ref> <key>` | Presses a key (e.g., Enter). |
| `browser_text` | `pinchtab text` | Extracts the page text (very token efficient). |

## Edge Configuration

To use Microsoft Edge, we will likely need to set the browser path in `pinchtab`'s config or via an environment variable. 

On macOS:
`export PINCHTAB_BROWSER_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"`

## Implementation Strategy

1. **`pinchtab` detection**: The extension will check if `pinchtab` is available.
2. **Automatic Daemon Management**: (Optional) The extension could try to start the `pinchtab daemon` if it's not running.
3. **Simplified Actions**: Map `pi` tool calls directly to `execSync('pinchtab ...')`.

## Draft Implementation (POC)

```typescript
import { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_open",
    description: "Open a URL in a headless browser",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    },
    execute: async ({ url }) => {
      // Logic to call pinchtab nav
      return { result: `Opened ${url}` };
    }
  });
}
```
