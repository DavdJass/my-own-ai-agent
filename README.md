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

## Screenshots (what each image shows)

Below is a short tour of the UI. Click any image on GitHub to open it full size.

### 1. Full workspace — where the extension lives

<p align="center">
  <img src="https://github.com/user-attachments/assets/e89bcbc4-4e0c-4022-a645-6b41e85bd8fa" alt="VS Code with DeepSeek Coder sidebar open: activity bar icon, chat panel, and editor" width="920" />
</p>

**What you see:** VS Code with the **DeepSeek Coder** view open in the **secondary sidebar** (right). The **activity bar** on the far left includes the extension icon so you can open the chat in one click. The main editor stays on the left so you can keep coding while the agent answers.

**Tip:** Use `Ctrl+Shift+D` (`Cmd+Shift+D` on macOS) to focus the chat from anywhere.

---

### 2. Modes — Ask, Plan, Debug, Agent

<p align="center">
  <img src="https://github.com/user-attachments/assets/5d01da50-50ac-4206-9b04-f3274144c899" alt="Mode pills: Ask, Plan, Debug, Agent" width="560" />
</p>

**What you see:** The **mode selector** at the top of the chat. Each mode changes what the model is allowed to do:

| Mode | Purpose |
|------|--------|
| **Ask** | Chat only — no tools, no file access. Good for concepts and quick questions. |
| **Plan** | Read-only tools — explores the repo and returns a **written plan**; it cannot edit files. |
| **Debug** | Read-only + diagnostics + git — investigates errors; suggests fixes in chat but does not apply edits. |
| **Agent** | Full tools — can read, search, run commands (with approval), and **edit files** after you confirm the diff. |

---

### 3. Mode hint strip (context for the current mode)

<p align="center">
  <img src="https://github.com/user-attachments/assets/798211de-095c-4357-81e7-a76a8c137fd3" alt="Hint text under mode pills describing the active mode" width="560" />
</p>

**What you see:** A **one-line hint** under the mode pills so you always know what the active mode can and cannot do (for example, that Plan mode will not write to disk).

---

### 4. Chat toolbar — history, save, export, clear

<p align="center">
  <img src="https://github.com/user-attachments/assets/f18ae88a-9bb2-4788-adb1-1c9d75d11f50" alt="Toolbar icons: saved conversations, save, export, clear" width="560" />
</p>

**What you see:** Icons next to **Clear** for **saved conversations** (open the dropdown to load or delete a saved chat), **save current thread** (opens VS Code’s native name prompt — not the browser `prompt`), and related actions. **Export** copies the whole conversation as Markdown to the clipboard.

---

### 5. Composer — input, slash hints, typing / thinking

<p align="center">
  <img src="https://github.com/user-attachments/assets/347b45dd-2946-4c49-ad4e-f987c13e9713" alt="Chat textarea with placeholder for @files, @selection, and slash commands" width="560" />
</p>

**What you see:** The **message box** and shortcuts: type **`@path/to/file`** to attach a file, **`@selection`** to attach the current editor selection, or **`/explain`**, **`/test`**, etc. While the model streams, **Flash** shows a *Typing* indicator and **Pro** can show *Thinking* during reasoning before the visible answer appears.

---

### 6. Model picker and session cost (tokens + ~USD)

<p align="center">
  <img src="https://github.com/user-attachments/assets/8502ce81-30b2-41b5-993d-5ba2852dcfb8" alt="Footer: model dropdown deepseek-v4-flash or pro, token count and approximate dollar cost" width="600" />
</p>

**What you see:** The **footer** of the chat: a dropdown to switch between **`deepseek-v4-flash`** and **`deepseek-v4-pro`**, and a **session usage** line (emoji + prompt/completion token counts and an **approximate USD cost** for the current chat session, using published list prices — useful to see how much each long agent run is spending).

**Note:** Figures are **estimates** (API usage × list price); your DeepSeek invoice is the source of truth.

---

## Install

```bash
npm install
npm run compile
npx vsce package --allow-missing-repository
```

In VS Code: **Extensions** → `...` → **Install from VSIX...** → select `deepseek-coder-0.6.1.vsix`.

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
