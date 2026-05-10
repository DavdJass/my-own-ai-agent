# DeepSeek Coder — VS Code Extension

A private AI coding assistant for VS Code powered by [DeepSeek](https://api.deepseek.com).

## Features

- **Chat panel** — talk to DeepSeek about your code; the current file is injected as context automatically.
- **Inline completions** — fill-in-the-middle suggestions as you type (toggleable).
- **Explain code** — select code, right-click → *DeepSeek: Explain Code*.
- **Refactor code** — select code, right-click → *DeepSeek: Refactor Code*, enter an instruction.
- **Generate code** — right-click anywhere → *DeepSeek: Generate Code*, describe what you want.
- **Model switcher** — toggle between `deepseek-v4-flash` (fast) and `deepseek-v4-pro` (powerful) from the status bar.

## Setup

### 1. Install the extension

```bash
npm install
npm run compile
npx vsce package
```

Then in VS Code: **Extensions** → `...` → **Install from VSIX** → select `deepseek-coder-0.1.0.vsix`.

### 2. Set your API key

Open the Command Palette (`Ctrl+Shift+P`) and run:

```
DeepSeek: Set API Key
```

Your key is stored securely in VS Code's secret storage — never written to `settings.json`.

### 3. (Optional) Configure in settings

```jsonc
{
  "deepseek.model": "deepseek-v4-flash",   // or "deepseek-v4-pro"
  "deepseek.inlineEnabled": true,
  "deepseek.maxTokens": 2048,
  "deepseek.temperature": 0.2
}
```

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open Chat | `Ctrl+Shift+D` |

## Development

```bash
npm install
npm run watch    # compile in watch mode
# Press F5 in VS Code to open the Extension Development Host
```
