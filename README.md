# DeepSeek Coder — VS Code Extension

A private AI coding **agent** for VS Code powered by [DeepSeek](https://api.deepseek.com).
Lives in its own sidebar tab, can read your files, search the workspace and edit code with confirmation diffs.

## Features

- **Sidebar chat** with persistent conversation history
- **Agent loop** — DeepSeek can autonomously read files, list folders, search the workspace, and propose edits
- **Diff confirmation** — every file write or edit shows a side-by-side diff before applying
- **Inline completions** — fill-in-the-middle suggestions as you type (toggleable)
- **Right-click menu** — Explain / Refactor / Generate code on the current selection
- **Model switcher** — toggle between `deepseek-v4-flash` (fast) and `deepseek-v4-pro` (thinking mode)
- **Secure API key** — stored in VS Code's `SecretStorage`, never in `settings.json`
- **Workspace symbols** — `find_workspace_symbols` tool (language-server index, faster than grep for known names)
- **File outline** — `get_document_outline` tool (classes, functions, hierarchy per file)
- **`@selection`** — attach the current editor selection to a message (with `@path/to/file`)
- **Export chat** — clipboard Markdown of the full thread (toolbar, view title, or command `DeepSeek: Export Chat to Clipboard`)
- **Configurable rules** — `deepseek.rulesFiles` (default starts with `DEEPSEEK.md`, then `AGENTS.md`, etc.); first existing file is injected into the system prompt

## Install

```bash
npm install
npm run compile
npx vsce package --allow-missing-repository
```

In VS Code: **Extensions** → `...` → **Install from VSIX...** → select `deepseek-coder-0.6.0.vsix`.

## Setting your API key

You need a DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com).

1. Open the Command Palette: `Ctrl+Shift+P`
2. Run: **`DeepSeek: Set API Key`**
3. Paste your key (it's masked while typing) and press Enter

The key is stored in VS Code's secret vault — never written to disk in plain text.

To update or replace it later, just run the same command again.

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P`).

| Command | Description |
|---|---|
| `DeepSeek: Open Chat` | Open / focus the chat sidebar (also `Ctrl+Shift+D`) |
| `DeepSeek: Set API Key` | Save or update your API key in SecretStorage |
| `DeepSeek: Select Model` | Switch between `deepseek-v4-flash` and `deepseek-v4-pro` |
| `DeepSeek: Explain Code` | Explain the currently selected code (also in right-click menu) |
| `DeepSeek: Refactor Code` | Refactor the selection given an instruction |
| `DeepSeek: Generate Code` | Generate code from a description |
| `DeepSeek: Clear Chat` | Reset the conversation |
| `DeepSeek: Export Chat to Clipboard` | Copy the full chat as Markdown |

### Right-click menu (when text is selected)

- **DeepSeek: Explain Code**
- **DeepSeek: Refactor Code**
- **DeepSeek: Generate Code**

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open / focus chat | `Ctrl+Shift+D` (`Cmd+Shift+D` on macOS) |

## Settings

Configure under **File → Preferences → Settings → Extensions → DeepSeek Coder**, or directly in `settings.json`:

```jsonc
{
  // Model — flash is fast & cheap, pro uses thinking mode
  "deepseek.model": "deepseek-v4-flash",
  // Inline completions while typing
  "deepseek.inlineEnabled": true,
  // Max tokens for chat responses (256-8192)
  "deepseek.maxTokens": 2048,
  // Sampling temperature (0-1, lower = more deterministic)
  "deepseek.temperature": 0.2,
  // Project rule files (first existing file wins)
  "deepseek.rulesFiles": ["DEEPSEEK.md", "AGENTS.md", ".deepseekrules.md", ".deepseekrules", ".cursorrules"]
}
```

## Agent tools

When you chat, DeepSeek can autonomously call these tools:

| Tool | What it does |
|---|---|
| `read_file` | Read any file in the workspace |
| `list_directory` | List contents of a folder |
| `search_workspace` | Regex/text search across the project |
| `get_open_files` | See which tabs you have open |
| `write_file` | Create/overwrite a file *(asks for confirmation + diff)* |
| `apply_edit` | Replace exact text in a file *(asks for confirmation + diff)* |
| `get_diagnostics` | Problems panel (errors / warnings from language servers) |
| `get_git_status` | `git status`, diff stat, recent commits |
| `run_command` | Run a shell command *(modal confirmation)* |
| `find_workspace_symbols` | Workspace-wide symbol search (LSP index) |
| `get_document_outline` | Hierarchical outline for one file (LSP) |

The agent loop runs up to **8 iterations** per message. Each tool call appears as a card in the chat with a live status indicator.

## Project rules (`deepseek.rulesFiles`)

The first file that exists in the workspace root (from your configured list) is appended to the system prompt. Default order: `DEEPSEEK.md`, `AGENTS.md`, `.deepseekrules.md`, `.deepseekrules`, `.cursorrules`.

Override in `settings.json`:

```jsonc
"deepseek.rulesFiles": ["docs/AI_RULES.md", "DEEPSEEK.md"]
```

## Models

| Model | Speed | Cost | Thinking mode |
|---|---|---|---|
| `deepseek-v4-flash` | Fast | ~$0.07 / $0.28 per 1M tokens | No |
| `deepseek-v4-pro` | Slower | ~$0.27 / $1.10 per 1M tokens | Yes |

Switch instantly by clicking the **DS Flash / DS Pro** indicator in the status bar.

## Status bar

The bottom-right status bar shows the active model:
```
$(comment-discussion) DS Flash
```
Click it to switch models.

## Development

```bash
npm install
npm run watch       # compile in watch mode
# Press F5 in VS Code to launch the Extension Development Host
```

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `401 Unauthorized` | Invalid API key | Run **DeepSeek: Set API Key** again |
| `402 Payment Required` | Insufficient balance on your account | Top up at [platform.deepseek.com](https://platform.deepseek.com) |
| `400 reasoning_content...` | Old version, fixed in 0.2.1+ | Update the extension |
