import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DeepSeekClient, Message, ToolCall, TokenUsage } from './client';
import { ChatMode, executeTool, toolsForMode } from './tools';

const MAX_AGENT_ITERATIONS = 8;
const MODE_KEY = 'deepseek.mode';
const MODEL_KEY = 'deepseek.activeModel';
const HISTORY_KEY = 'deepseek.savedConversations';

const AVAILABLE_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
const AVAILABLE_MODES: ChatMode[] = ['ask', 'plan', 'debug', 'agent'];

/** Approximate USD pricing per 1M tokens (input / output). Update if DeepSeek changes them. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.07, output: 0.28 },
  'deepseek-v4-pro': { input: 0.27, output: 1.1 },
};

/** Slash commands expanded before sending. */
const SLASH_COMMANDS: Record<string, { label: string; expand: (rest: string) => string }> = {
  '/explain': {
    label: 'Explain selection / file',
    expand: (rest) =>
      `Explain ${rest || 'the active code'} in detail. Walk through what it does, why, and any pitfalls.`,
  },
  '/test': {
    label: 'Generate tests',
    expand: (rest) =>
      `Generate unit tests for ${rest || 'the active file'}. Use the testing framework already present in the project. Cover happy path and edge cases.`,
  },
  '/docs': {
    label: 'Add documentation',
    expand: (rest) =>
      `Add docstrings / JSDoc / GoDoc style documentation to ${rest || 'the active file'}. Do not change logic.`,
  },
  '/optimize': {
    label: 'Optimize code',
    expand: (rest) =>
      `Find performance and readability improvements in ${rest || 'the active file'}. Show the proposed change and explain why.`,
  },
  '/refactor': {
    label: 'Refactor code',
    expand: (rest) =>
      `Refactor ${rest || 'the active file'} to be cleaner and more idiomatic. Preserve behavior. Show diffs.`,
  },
  '/fix': {
    label: 'Fix problems',
    expand: (rest) =>
      `Read the diagnostics and fix the problems in ${rest || 'the active file'}. Use apply_edit for the changes.`,
  },
};

interface SavedConversation {
  id: string;
  name: string;
  savedAt: number;
  messages: Message[];
}

const MODE_PROMPTS: Record<ChatMode, string> = {
  ask:
    'You are DeepSeek Coder in Ask mode. Answer the user concisely. ' +
    'You have NO tools available — do not pretend to read files. ' +
    'Use markdown with fenced code blocks for any code you show.',
  plan:
    'You are DeepSeek Coder in Plan mode. ' +
    'Read the relevant files using your read-only tools (read_file, list_directory, search_workspace, get_open_files) ' +
    'and produce a clear, structured implementation plan in markdown. ' +
    'You CANNOT write or edit files in this mode — only propose changes. ' +
    'Format your final answer with clear section headers and bullet lists. ' +
    'End with a one-line summary of the next step the user should take.',
  debug:
    'You are DeepSeek Coder in Debug mode. ' +
    'Help the user investigate bugs, errors and unexpected behavior. ' +
    'Always start by calling get_diagnostics to see what VS Code has flagged. ' +
    'Then read the relevant files with read_file and search the workspace for related code. ' +
    'You CANNOT write changes — diagnose the root cause and recommend fixes in chat with code blocks. ' +
    'Be specific about line numbers and exact problem locations.',
  agent:
    'You are DeepSeek Coder in Agent mode — an autonomous coding agent embedded in VS Code. ' +
    'You can read files, search the workspace, read VS Code diagnostics, and propose edits using your tools. ' +
    'When the user asks about code, prefer reading the relevant files yourself instead of guessing. ' +
    'For any change to a file, use apply_edit (preferred for small targeted changes) or write_file. ' +
    'Both apply_edit and write_file ask the user for confirmation, so do not ask in chat — just call the tool. ' +
    'When you finish, give a concise summary of what you did. Use markdown with fenced code blocks.',
};

/**
 * Sidebar webview view that hosts the DeepSeek chat.
 * Lives in its own activity-bar container so the user always has 1-click access.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'deepseek.chatView';

  private view?: vscode.WebviewView;
  private readonly client: DeepSeekClient;
  private readonly context: vscode.ExtensionContext;

  private history: Message[] = [];
  private abortController?: AbortController;
  private pendingUserMessages: string[] = [];

  private mode: ChatMode;
  private model: string;

  /** Running total tokens & cost for the current chat session. */
  private sessionUsage = { prompt: 0, completion: 0, costUsd: 0 };

  constructor(client: DeepSeekClient, context: vscode.ExtensionContext) {
    this.client = client;
    this.context = context;

    const savedMode = context.globalState.get<string>(MODE_KEY) ?? 'agent';
    this.mode = (AVAILABLE_MODES as readonly string[]).includes(savedMode)
      ? (savedMode as ChatMode)
      : 'agent';

    const savedModel = context.globalState.get<string>(MODEL_KEY);
    const configModel = vscode.workspace
      .getConfiguration('deepseek')
      .get<string>('model', 'deepseek-v4-flash');
    this.model = (AVAILABLE_MODELS as readonly string[]).includes(savedModel ?? '')
      ? (savedModel as string)
      : configModel;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.buildHtml();
    view.webview.onDidReceiveMessage(this.onMessage.bind(this));

    // Send initial state to the webview (mode + model + lists + slash commands + saved chats).
    this.postWebview({
      type: 'init',
      mode: this.mode,
      model: this.model,
      modes: AVAILABLE_MODES,
      models: AVAILABLE_MODELS,
      slashCommands: Object.entries(SLASH_COMMANDS).map(([cmd, def]) => ({
        cmd,
        label: def.label,
      })),
      savedConversations: this.listSavedConversations().map((c) => ({
        id: c.id,
        name: c.name,
        savedAt: c.savedAt,
      })),
    });

    while (this.pendingUserMessages.length > 0) {
      const text = this.pendingUserMessages.shift()!;
      this.processChat(text);
    }

    this.broadcastUsage();
  }

  /** Reveal the sidebar (opens it if collapsed) and feed it a message. */
  async sendUserMessage(text: string): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    if (!this.view) {
      this.pendingUserMessages.push(text);
      return;
    }
    this.view.show?.(true);
    this.postWebview({ type: 'prefill', text });
    this.processChat(text);
  }

  /** Reset the conversation and clear the visible messages. */
  clear(): void {
    this.history = [];
    this.sessionUsage = { prompt: 0, completion: 0, costUsd: 0 };
    this.abortController?.abort();
    this.postWebview({ type: 'clearAll' });
    this.broadcastUsage();
  }

  private broadcastUsage(): void {
    this.postWebview({
      type: 'usage',
      prompt: this.sessionUsage.prompt,
      completion: this.sessionUsage.completion,
      costUsd: this.sessionUsage.costUsd,
    });
  }

  private accumulateUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const pricing = MODEL_PRICING[this.model] ?? MODEL_PRICING['deepseek-v4-flash'];
    const cost =
      (usage.prompt * pricing.input) / 1_000_000 +
      (usage.completion * pricing.output) / 1_000_000;
    this.sessionUsage.prompt += usage.prompt;
    this.sessionUsage.completion += usage.completion;
    this.sessionUsage.costUsd += cost;
    this.broadcastUsage();
  }

  // ─── Agent loop ────────────────────────────────────────────────────────────

  private async processChat(userText: string): Promise<void> {
    // Expand /slash commands first, then resolve @mentions.
    const expanded = this.expandSlashCommand(userText);
    const resolvedText = await this.resolveAtMentions(expanded);

    // Re-seed the system prompt every turn so mode switches mid-conversation
    // take effect (we keep only the latest system message). Project rules
    // (AGENTS.md / .cursorrules) are read freshly each turn.
    await this.refreshSystemPrompt();
    this.history = this.history.filter((m) => m.role !== 'system');
    this.history.unshift({ role: 'system', content: this.buildSystemPrompt() });
    this.history.push({ role: 'user', content: resolvedText });

    this.abortController = new AbortController();
    this.postWebview({ type: 'startResponse', model: this.model, mode: this.mode });

    const tools = toolsForMode(this.mode);
    const allowTools = tools.length > 0;

    try {
      for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
        let assistantText = '';
        let thinkingNotified = false;
        const result = await this.client.chat(this.history, {
          tools: allowTools ? tools : undefined,
          model: this.model,
          signal: this.abortController.signal,
          onToken: (t) => {
            assistantText += t;
            this.postWebview({ type: 'token', text: t });
          },
          onReasoningToken: () => {
            // Notify the webview only on the first reasoning chunk to switch
            // the placeholder from "Typing" to "Thinking".
            if (!thinkingNotified) {
              thinkingNotified = true;
              this.postWebview({ type: 'thinking' });
            }
          },
        });

        this.history.push({
          role: 'assistant',
          content: result.content,
          reasoning_content: result.reasoningContent || undefined,
          tool_calls:
            result.toolCalls.length > 0
              ? result.toolCalls.map((t) => ({
                  id: t.id,
                  type: 'function',
                  function: { name: t.name, arguments: t.arguments },
                }))
              : undefined,
        });

        this.accumulateUsage(result.usage);

        if (result.toolCalls.length === 0 || !allowTools) break;

        if (assistantText) this.postWebview({ type: 'endResponse' });

        for (const call of result.toolCalls) {
          await this.runTool(call);
        }

        if (iter === MAX_AGENT_ITERATIONS - 1) {
          this.postWebview({
            type: 'error',
            text: `Agent stopped: reached max iterations (${MAX_AGENT_ITERATIONS}).`,
          });
        } else {
          this.postWebview({ type: 'startResponse', model: this.model, mode: this.mode });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'aborted') this.postWebview({ type: 'error', text: msg });
    } finally {
      this.postWebview({ type: 'endResponse' });
    }
  }

  private async runTool(call: ToolCall): Promise<void> {
    const args = this.parseArgs(call.arguments);
    const summary = this.summariseToolCall(call.name, args);

    this.postWebview({
      type: 'toolStart',
      id: call.id,
      name: call.name,
      summary,
    });

    const output = await executeTool(call.name, args);
    const isError =
      output.startsWith('Error:') || output.startsWith('User rejected');

    this.postWebview({
      type: 'toolEnd',
      id: call.id,
      ok: !isError,
      preview: this.previewOutput(output),
    });

    this.history.push({
      role: 'tool',
      tool_call_id: call.id,
      content: output,
    });
  }

  private parseArgs(raw: string): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private summariseToolCall(
    name: string,
    args: Record<string, unknown>
  ): string {
    switch (name) {
      case 'read_file':
      case 'list_directory':
      case 'write_file':
      case 'apply_edit':
        return String(args.path ?? '');
      case 'search_workspace':
        return `"${args.query}"${args.glob ? ` in ${args.glob}` : ''}`;
      case 'get_diagnostics':
        return args.path
          ? `${args.path} (${args.severity ?? 'warning'}+)`
          : `workspace (${args.severity ?? 'warning'}+)`;
      case 'get_git_status':
        return args.include_diff ? 'with diff' : 'status + log';
      case 'run_command':
        return String(args.command ?? '');
      case 'find_workspace_symbols':
        return String(args.query ?? '');
      case 'get_document_outline':
        return String(args.path ?? '');
      default:
        return '';
    }
  }

  private previewOutput(output: string): string {
    const firstLine = output.split('\n')[0] ?? '';
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  private async resolveAtMentions(text: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const attachments: string[] = [];

    if (text.includes('@selection')) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const sel = editor.document.getText(editor.selection);
        const lang = editor.document.languageId;
        const rel = vscode.workspace.asRelativePath(editor.document.uri);
        const truncated =
          sel.length > 12000 ? sel.slice(0, 12000) + '\n// ... (truncated)' : sel;
        attachments.push(
          `**Editor selection** from \`${rel}\` (${lang}):\n\`\`\`${lang}\n${truncated}\n\`\`\``
        );
      } else {
        attachments.push(
          '*(User wrote @selection but no text is selected in the active editor.)*'
        );
      }
    }

    if (!root) {
      if (attachments.length === 0) return text;
      return text + '\n\n---\n' + attachments.join('\n\n');
    }

    const matches = [...text.matchAll(/@([\w./\\-]+)/g)];
    for (const match of matches) {
      const rel = match[1];
      if (rel === 'selection') continue;
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const data = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(data).toString('utf-8');
        const ext = rel.split('.').pop() ?? '';
        const truncated =
          content.length > 8000
            ? content.slice(0, 8000) + '\n// ... (truncated)'
            : content;
        attachments.push(`File \`${rel}\`:\n\`\`\`${ext}\n${truncated}\n\`\`\``);
      } catch {
        /* not a file — leave the @mention as-is */
      }
    }

    if (attachments.length === 0) return text;
    return text + '\n\n---\n*Attached context:*\n' + attachments.join('\n\n');
  }

  private expandSlashCommand(text: string): string {
    const trimmed = text.trimStart();
    const match = trimmed.match(/^(\/\w+)(\s+([\s\S]*))?$/);
    if (!match) return text;
    const cmd = match[1].toLowerCase();
    const rest = (match[3] ?? '').trim();
    const def = SLASH_COMMANDS[cmd];
    return def ? def.expand(rest) : text;
  }

  private async readProjectRules(): Promise<string | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return undefined;

    const configured = vscode.workspace
      .getConfiguration('deepseek')
      .get<string[]>('rulesFiles');
    const defaultList = [
      'DEEPSEEK.md',
      'AGENTS.md',
      '.deepseekrules.md',
      '.deepseekrules',
      '.cursorrules',
    ];
    const candidates =
      Array.isArray(configured) && configured.length > 0 ? configured : defaultList;

    for (const name of candidates) {
      if (!name || typeof name !== 'string') continue;
      try {
        const data = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(root, name.replace(/^[./\\]+/, ''))
        );
        const content = Buffer.from(data).toString('utf-8').trim();
        if (content) {
          const truncated =
            content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content;
          return `Project conventions from \`${name}\`:\n${truncated}`;
        }
      } catch {
        /* file does not exist, try next */
      }
    }
    return undefined;
  }

  private buildSystemPrompt(): string {
    // Note: this is a sync method but we cache project rules asynchronously.
    // We use a synchronous wrapper that returns the cached value.
    return this.cachedSystemPrompt ?? this.composeSystemPrompt();
  }

  private cachedSystemPrompt?: string;

  private composeSystemPrompt(rules?: string): string {
    const root =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(no workspace)';
    const parts = [MODE_PROMPTS[this.mode], `\nWorkspace root: ${root}`];

    if (rules) parts.push(`\n${rules}`);

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      parts.push(`Active file the user is looking at: ${rel}`);
    }

    return parts.join('\n');
  }

  private async refreshSystemPrompt(): Promise<void> {
    const rules = await this.readProjectRules();
    this.cachedSystemPrompt = this.composeSystemPrompt(rules);
  }

  // ─── Saved conversations ───────────────────────────────────────────────────

  private listSavedConversations(): SavedConversation[] {
    return this.context.globalState.get<SavedConversation[]>(HISTORY_KEY) ?? [];
  }

  private async saveCurrentConversation(name: string): Promise<void> {
    if (!this.history.some((m) => m.role === 'user')) {
      throw new Error('No user messages to save.');
    }
    const all = this.listSavedConversations();
    const conversation: SavedConversation = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name.trim() || `Chat ${new Date().toLocaleString()}`,
      savedAt: Date.now(),
      // Deep clone so globalState always gets plain JSON.
      messages: JSON.parse(JSON.stringify(this.history)) as Message[],
    };
    const updated = [conversation, ...all].slice(0, 50);
    try {
      await this.context.globalState.update(HISTORY_KEY, updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${msg} — If the chat is very long, use Export instead; VS Code storage has limits.`
      );
    }
    this.broadcastSavedList();
  }

  private async loadConversation(id: string): Promise<void> {
    const conv = this.listSavedConversations().find((c) => c.id === id);
    if (!conv) return;
    this.history = conv.messages;
    this.sessionUsage = { prompt: 0, completion: 0, costUsd: 0 };
    this.postWebview({ type: 'replayHistory', messages: this.serializeHistory() });
    this.broadcastUsage();
  }

  private async deleteConversation(id: string): Promise<void> {
    const remaining = this.listSavedConversations().filter((c) => c.id !== id);
    await this.context.globalState.update(HISTORY_KEY, remaining);
    this.broadcastSavedList();
  }

  private broadcastSavedList(): void {
    this.postWebview({
      type: 'savedConversations',
      list: this.listSavedConversations().map((c) => ({
        id: c.id,
        name: c.name,
        savedAt: c.savedAt,
      })),
    });
  }

  /** Serialize full history for Markdown export (includes tool turns). */
  private buildExportMarkdown(): string {
    const lines: string[] = [
      '# DeepSeek Coder — chat export',
      '',
      `Exported: ${new Date().toISOString()}`,
      '',
      '---',
      '',
    ];
    for (const m of this.history) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        lines.push('## User\n\n', m.content, '\n\n');
      } else if (m.role === 'assistant') {
        let body = m.content || '';
        if (m.tool_calls?.length) {
          const names = m.tool_calls
            .map((t) => t.function?.name)
            .filter(Boolean)
            .join(', ');
          body += `\n\n_(Tools: ${names})_\n`;
        }
        lines.push('## Assistant\n\n', body, '\n\n');
      } else if (m.role === 'tool') {
        const preview =
          m.content.length > 3000 ? m.content.slice(0, 3000) + '\n...' : m.content;
        lines.push(`### Tool result (${m.tool_call_id ?? '?'})\n\n`, '```\n', preview, '\n```\n\n');
      }
    }
    return lines.join('');
  }

  /** Copy the current conversation as Markdown to the system clipboard. */
  async exportToClipboard(): Promise<void> {
    if (this.history.filter((m) => m.role !== 'system').length === 0) {
      this.postWebview({ type: 'error', text: 'Nothing to export — start a chat first.' });
      return;
    }
    const md = this.buildExportMarkdown();
    await vscode.env.clipboard.writeText(md);
    vscode.window.showInformationMessage(
      'DeepSeek: conversation copied to clipboard as Markdown.'
    );
    this.postWebview({ type: 'info', text: 'Exported to clipboard (Markdown).' });
  }

  /** Pre-render the history into webview-friendly entries for replay. */
  private serializeHistory(): unknown[] {
    return this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));
  }

  private postWebview(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    code?: string;
    mode?: string;
    model?: string;
    name?: string;
    id?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'send':
        if (msg.text) this.processChat(msg.text);
        break;
      case 'stop':
        this.abortController?.abort();
        break;
      case 'clear':
        this.history = [];
        this.sessionUsage = { prompt: 0, completion: 0, costUsd: 0 };
        this.broadcastUsage();
        break;
      case 'insertCode': {
        const editor = vscode.window.activeTextEditor;
        if (editor && msg.code) {
          await editor.edit((edit) =>
            edit.insert(editor.selection.active, String(msg.code))
          );
          await vscode.window.showTextDocument(editor.document, { preview: false });
        }
        break;
      }
      case 'setMode':
        if (msg.mode && (AVAILABLE_MODES as readonly string[]).includes(msg.mode)) {
          this.mode = msg.mode as ChatMode;
          await this.context.globalState.update(MODE_KEY, this.mode);
        }
        break;
      case 'setModel':
        if (
          msg.model &&
          (AVAILABLE_MODELS as readonly string[]).includes(msg.model)
        ) {
          this.model = msg.model;
          await this.context.globalState.update(MODEL_KEY, this.model);
          // Also sync the global setting so the status bar reflects it.
          await vscode.workspace
            .getConfiguration('deepseek')
            .update('model', this.model, vscode.ConfigurationTarget.Global);
        }
        break;
      case 'saveConversation': {
        if (!this.history.some((m) => m.role === 'user')) {
          this.postWebview({
            type: 'error',
            text: 'Nothing to save — send at least one message first.',
          });
          break;
        }
        const defaultName = `Chat ${new Date().toLocaleString()}`;
        const name = await vscode.window.showInputBox({
          title: 'DeepSeek — Save conversation',
          prompt: 'Name for this saved chat',
          value: typeof msg.name === 'string' && msg.name.trim() ? msg.name : defaultName,
          ignoreFocusOut: true,
        });
        if (name === undefined) {
          this.postWebview({ type: 'info', text: 'Save cancelled.' });
          break;
        }
        if (!name.trim()) {
          this.postWebview({ type: 'error', text: 'Enter a name or cancel.' });
          break;
        }
        try {
          await this.saveCurrentConversation(name);
          this.postWebview({ type: 'info', text: 'Conversation saved.' });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`DeepSeek: ${text}`);
          this.postWebview({ type: 'error', text });
        }
        break;
      }
      case 'loadConversation':
        if (msg.id) await this.loadConversation(msg.id);
        break;
      case 'deleteConversation':
        if (msg.id) await this.deleteConversation(msg.id);
        break;
      case 'exportChat':
        await this.exportToClipboard();
        break;
    }
  }

  // ─── HTML / CSS / JS — fully inlined ───────────────────────────────────────

  private buildHtml(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>DeepSeek Chat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body { height: 100%; width: 100%; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Top bar with mode pills ─────────────────────────────────────── */
    #topbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .mode-pill {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 3px 9px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .mode-pill:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }
    .mode-pill.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .topbar-spacer { flex: 1; }

    .history-wrap { position: relative; }
    .topbar-icon {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 3px;
      opacity: 0.85;
    }
    .topbar-icon:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .dropdown {
      position: absolute;
      right: 0;
      top: 100%;
      margin-top: 4px;
      min-width: 200px;
      max-height: 240px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      z-index: 50;
    }
    .dropdown-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 6px 10px;
      font-size: 12px;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .dropdown-item:hover { background: var(--vscode-list-hoverBackground); }
    .dropdown-item.del { color: var(--vscode-errorForeground); }

    .usage {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #info-toast {
      display: none;
      background: var(--vscode-inputValidation-infoBackground);
      color: var(--vscode-inputValidation-infoForeground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 12px;
      margin: 0 10px 6px;
    }

    #btn-clear {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
    }
    #btn-clear:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* ── Mode hint ──────────────────────────────────────────────────── */
    #mode-hint {
      padding: 4px 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    /* ── Messages ────────────────────────────────────────────────────── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
    .msg-role {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .msg-user .msg-role { color: var(--vscode-textLink-foreground); }
    .msg-assistant .msg-role { color: var(--vscode-charts-green); }

    .msg-body {
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-foreground);
    }
    .msg-user .msg-body {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 8px 10px;
    }
    .msg-assistant .msg-body { padding: 0; }

    .msg-body pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      overflow-x: auto;
      padding: 10px 12px;
      margin: 6px 0;
    }
    .msg-body code {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      color: var(--vscode-textPreformat-foreground);
    }
    .msg-body p { margin: 4px 0; }
    .msg-body strong { font-weight: 700; }
    .msg-body em { font-style: italic; }

    /* ── Code block "Insert at cursor" button ────────────────────────── */
    .code-wrapper { position: relative; margin: 6px 0; }
    .code-wrapper pre { margin: 0; }
    .insert-btn {
      position: absolute;
      top: 6px;
      right: 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      letter-spacing: 0.04em;
    }
    .code-wrapper:hover .insert-btn { opacity: 1; }
    .insert-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .insert-btn:active { transform: scale(0.96); }

    .streaming-cursor::after {
      content: '\u258D';
      animation: blink 0.7s step-end infinite;
      margin-left: 1px;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Typing / thinking placeholder ──────────────────────────────── */
    .thinking-placeholder {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 2px 0;
    }
    .thinking-placeholder .label { font-size: 12px; }
    .thinking-placeholder .dots {
      display: inline-flex;
      gap: 2px;
      align-items: center;
    }
    .thinking-placeholder .dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.3;
      animation: dotPulse 1.2s infinite ease-in-out;
    }
    .thinking-placeholder .dot:nth-child(2) { animation-delay: 0.15s; }
    .thinking-placeholder .dot:nth-child(3) { animation-delay: 0.3s; }
    @keyframes dotPulse {
      0%, 60%, 100% { opacity: 0.3; transform: scale(0.85); }
      30%           { opacity: 1;   transform: scale(1); }
    }

    /* ── Tool cards ─────────────────────────────────────────────────────── */
    .tool-card {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-charts-blue);
      border-radius: 4px;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .tool-card.ok { border-left-color: var(--vscode-charts-green); }
    .tool-card.err { border-left-color: var(--vscode-charts-red); }
    .tool-icon { width: 14px; height: 14px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; }
    .tool-name { font-weight: 600; }
    .tool-summary {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-descriptionForeground);
    }
    .tool-status {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Input area ─────────────────────────────────────────────────────── */
    #inputarea {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #input {
      width: 100%;
      min-height: 60px;
      max-height: 200px;
      resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      padding: 7px 9px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
      line-height: 1.5;
    }
    #input::placeholder { color: var(--vscode-input-placeholderForeground); }
    #input:focus { border-color: var(--vscode-focusBorder); }

    /* ── Footer below input: model selector + send ────────────────────── */
    #footer {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #model-select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 3px;
      padding: 3px 6px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      outline: none;
    }
    #model-select:focus { border-color: var(--vscode-focusBorder); }

    .footer-spacer { flex: 1; }

    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 5px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.primary:disabled { opacity: 0.5; cursor: default; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* ── Error toast ─────────────────────────────────────────────────── */
    #error-toast {
      display: none;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 12px;
      margin: 0 10px 6px;
    }

    /* ── Empty state ─────────────────────────────────────────────────── */
    #empty-state {
      text-align: center;
      padding: 30px 16px;
      user-select: none;
      color: var(--vscode-foreground);
    }
    #empty-state .logo { font-size: 32px; margin-bottom: 10px; }
    #empty-state .title {
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
    }
    #empty-state .subtitle {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
    #empty-state .examples {
      margin-top: 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #empty-state .example {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 7px 9px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      line-height: 1.4;
    }
    #empty-state .example:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
  </style>
</head>
<body>
  <div id="topbar">
    <button class="mode-pill" data-mode="ask">Ask</button>
    <button class="mode-pill" data-mode="plan">Plan</button>
    <button class="mode-pill" data-mode="debug">Debug</button>
    <button class="mode-pill" data-mode="agent">Agent</button>
    <span class="topbar-spacer"></span>
    <div class="history-wrap">
      <button id="btn-history" class="topbar-icon" title="Saved conversations">\u{1F4DA}</button>
      <div id="history-menu" class="dropdown" style="display:none"></div>
    </div>
    <button id="btn-save" class="topbar-icon" title="Save current conversation">\u{1F4BE}</button>
    <button id="btn-export" class="topbar-icon" title="Export chat to clipboard (Markdown)">\u{1F4CB}</button>
    <button id="btn-clear" title="Clear conversation">Clear</button>
  </div>
  <div id="mode-hint"></div>

  <div id="messages">
    <div id="empty-state">
      <div class="logo">\u26A1</div>
      <div class="title">DeepSeek Coder</div>
      <div class="subtitle">Ask, plan, debug or run as an autonomous agent.</div>
      <div class="examples">
        <button class="example" data-q="/explain ">/explain — explain code</button>
        <button class="example" data-q="/test ">/test — generate tests</button>
        <button class="example" data-q="/docs ">/docs — add documentation</button>
        <button class="example" data-q="What does this project do? Read the README and explain.">What does this project do?</button>
      </div>
    </div>
  </div>

  <div id="error-toast"></div>
  <div id="info-toast"></div>

  <div id="inputarea">
    <div id="slash-hint" style="display:none"></div>
    <textarea id="input" placeholder="Ask anything\u2026 @path/to/file, @selection, or /command shortcuts."></textarea>
    <div id="footer">
      <select id="model-select" title="DeepSeek model"></select>
      <span id="usage-display" class="usage" title="Tokens & cost this session"></span>
      <span class="footer-spacer"></span>
      <span class="hint">Enter to send</span>
      <button class="secondary" id="btn-stop" style="display:none">Stop</button>
      <button class="primary" id="btn-send">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const messagesEl   = document.getElementById('messages');
    const inputEl      = document.getElementById('input');
    const btnSend      = document.getElementById('btn-send');
    const btnStop      = document.getElementById('btn-stop');
    const btnClear     = document.getElementById('btn-clear');
    const btnSave      = document.getElementById('btn-save');
    const btnExport    = document.getElementById('btn-export');
    const btnHistory   = document.getElementById('btn-history');
    const historyMenu  = document.getElementById('history-menu');
    const emptyState   = document.getElementById('empty-state');
    const errorToast   = document.getElementById('error-toast');
    const infoToast    = document.getElementById('info-toast');
    const usageDisplay = document.getElementById('usage-display');
    const modePills    = document.querySelectorAll('.mode-pill');
    const modelSelect  = document.getElementById('model-select');
    const modeHintEl   = document.getElementById('mode-hint');

    let streaming = false;
    let currentAssistantBody = null;
    let rawBuffer = '';
    let currentMode = 'agent';
    let placeholderEl = null;
    let firstContentToken = true;
    const toolCards = new Map();

    function placeholderHtml(label) {
      return (
        '<span class="thinking-placeholder">' +
          '<span class="label">' + label + '</span>' +
          '<span class="dots">' +
            '<span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
          '</span>' +
        '</span>'
      );
    }

    function showPlaceholder(label) {
      if (!currentAssistantBody) return;
      currentAssistantBody.classList.remove('streaming-cursor');
      currentAssistantBody.innerHTML = placeholderHtml(label);
      placeholderEl = currentAssistantBody.querySelector('.thinking-placeholder');
      scrollBottom();
    }

    function clearPlaceholder() {
      if (placeholderEl && currentAssistantBody) {
        currentAssistantBody.innerHTML = '';
      }
      placeholderEl = null;
    }

    const MODE_HINTS = {
      ask:   'Ask: chat only, no tools, no file access.',
      plan:  'Plan: reads files, returns a plan in markdown. Cannot edit.',
      debug: 'Debug: reads diagnostics + files. Cannot edit \u2014 suggests fixes.',
      agent: 'Agent: full autonomy \u2014 reads, searches, edits files (with confirmation).',
    };

    function updateModePills(mode) {
      currentMode = mode;
      modePills.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      modeHintEl.textContent = MODE_HINTS[mode] || '';
    }

    function populateModels(models, current) {
      modelSelect.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === current) opt.selected = true;
        modelSelect.appendChild(opt);
      }
    }

    modePills.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        updateModePills(mode);
        vscode.postMessage({ type: 'setMode', mode });
      });
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'setModel', model: modelSelect.value });
    });

    // ── Markdown rendering ────────────────────────────────────────────────
    function renderMarkdown(text) {
      let out = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      out = out.replace(/\`\`\`([\\w+-]*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) =>
        '<pre><code class="lang-' + lang + '">' + code + '</code></pre>'
      );
      out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      out = out.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      out = out.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      out = out.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');

      const lines = out.split('\\n');
      const wrapped = [];
      let inPre = false;
      for (const line of lines) {
        if (line.startsWith('<pre>')) inPre = true;
        if (line.endsWith('</pre>')) inPre = false;
        wrapped.push(inPre ? line : '<p>' + (line || '&nbsp;') + '</p>');
      }
      return wrapped.join('');
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

    function showInfo(text) {
      infoToast.textContent = text;
      infoToast.style.display = 'block';
      setTimeout(() => { infoToast.style.display = 'none'; }, 4000);
    }

    function updateUsageDisplay(p, c, cost) {
      if (!usageDisplay) return;
      const costStr = typeof cost === 'number' ? cost.toFixed(4) : '0';
      usageDisplay.textContent =
        p > 0 ? String.fromCodePoint(0x1f4ca) + ' ' + p + '+' + c + ' tok ~$' + costStr : '';
    }

    function renderReplayMessages(messages) {
      Array.from(messagesEl.children).forEach((ch) => {
        if (ch !== emptyState) ch.remove();
      });
      if (!messages || messages.length === 0) {
        emptyState.style.display = '';
        return;
      }
      emptyState.style.display = 'none';
      for (const m of messages) {
        if (m.role === 'user') appendUserMessage(m.content);
        else if (m.role === 'assistant') {
          rawBuffer = m.content || '';
          const div = document.createElement('div');
          div.className = 'msg msg-assistant';
          div.innerHTML =
            '<div class="msg-role">ASSISTANT</div>' +
            '<div class="msg-body">' + renderMarkdown(rawBuffer) + '</div>';
          messagesEl.appendChild(div);
          const body = div.querySelector('.msg-body');
          if (body) addInsertButtons(body);
        }
      }
      scrollBottom();
    }

    function rebuildHistoryMenu(list) {
      historyMenu.innerHTML = '';
      if (!list || list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dropdown-item';
        empty.style.opacity = '0.6';
        empty.textContent = '(no saved chats)';
        historyMenu.appendChild(empty);
        return;
      }
      for (const c of list) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'stretch';
        const loadBtn = document.createElement('button');
        loadBtn.className = 'dropdown-item';
        loadBtn.style.flex = '1';
        loadBtn.textContent = c.name;
        loadBtn.title = new Date(c.savedAt).toLocaleString();
        loadBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'loadConversation', id: c.id });
          historyMenu.style.display = 'none';
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'dropdown-item del';
        delBtn.textContent = '\u2715';
        delBtn.title = 'Delete';
        delBtn.style.flex = '0 0 32px';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteConversation', id: c.id });
        });
        row.appendChild(loadBtn);
        row.appendChild(delBtn);
        historyMenu.appendChild(row);
      }
    }

    btnHistory.addEventListener('click', (e) => {
      e.stopPropagation();
      historyMenu.style.display = historyMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { historyMenu.style.display = 'none'; });

    btnSave.addEventListener('click', () => {
      vscode.postMessage({ type: 'saveConversation' });
    });

    btnExport.addEventListener('click', () => {
      vscode.postMessage({ type: 'exportChat' });
    });

    function setStreaming(val) {
      streaming = val;
      btnSend.disabled = val;
      btnStop.style.display = val ? 'inline-block' : 'none';
    }

    function appendUserMessage(text) {
      emptyState.style.display = 'none';
      const div = document.createElement('div');
      div.className = 'msg msg-user';
      div.innerHTML =
        '<div class="msg-role">You</div>' +
        '<div class="msg-body">' + escapeHtml(text) + '</div>';
      messagesEl.appendChild(div);
      scrollBottom();
    }

    function startAssistantBubble(model, mode) {
      emptyState.style.display = 'none';
      rawBuffer = '';
      placeholderEl = null;
      firstContentToken = true;
      const label = (mode || 'agent').toUpperCase() + ' \u00b7 ' + (model || 'DeepSeek');
      const div = document.createElement('div');
      div.className = 'msg msg-assistant';
      div.innerHTML =
        '<div class="msg-role">' + escapeHtml(label) + '</div>' +
        '<div class="msg-body"></div>';
      messagesEl.appendChild(div);
      currentAssistantBody = div.querySelector('.msg-body');
      // Show an initial placeholder immediately so the bubble is never empty.
      // Pro models start with reasoning, so show "Thinking" right away;
      // Flash and others start producing content so show "Typing".
      const isPro = (model || '').toLowerCase().includes('pro') ||
                    (model || '').toLowerCase().includes('reasoner');
      showPlaceholder(isPro ? 'Thinking' : 'Typing');
    }

    function appendToken(token) {
      if (!currentAssistantBody) return;
      if (firstContentToken) {
        clearPlaceholder();
        firstContentToken = false;
      }
      rawBuffer += token;
      currentAssistantBody.innerHTML = renderMarkdown(rawBuffer);
      currentAssistantBody.classList.add('streaming-cursor');
      scrollBottom();
    }

    function showThinking() {
      // Switch the placeholder to "Thinking" if no content has streamed yet.
      if (firstContentToken && currentAssistantBody) {
        showPlaceholder('Thinking');
      }
    }

    function addInsertButtons(body) {
      body.querySelectorAll('pre').forEach((pre) => {
        if (pre.closest('.code-wrapper')) return; // already wrapped
        const codeEl = pre.querySelector('code');
        if (!codeEl) return;
        const rawCode = codeEl.textContent || '';
        const wrapper = document.createElement('div');
        wrapper.className = 'code-wrapper';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
        const btn = document.createElement('button');
        btn.className = 'insert-btn';
        btn.title = 'Insert at cursor';
        btn.textContent = 'Insert \u2191';
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'insertCode', code: rawCode });
          btn.textContent = 'Inserted \u2713';
          setTimeout(() => { btn.textContent = 'Insert \u2191'; }, 1500);
        });
        wrapper.appendChild(btn);
      });
    }

    function finaliseAssistant() {
      if (currentAssistantBody) {
        currentAssistantBody.classList.remove('streaming-cursor');
        if (!rawBuffer.trim()) {
          // Remove empty bubbles (only tool calls, no text).
          const bubble = currentAssistantBody.parentElement;
          bubble && bubble.remove();
        } else {
          addInsertButtons(currentAssistantBody);
        }
        currentAssistantBody = null;
        placeholderEl = null;
      }
    }

    function toolIcon(name) {
      switch (name) {
        case 'read_file':       return '\u{1F4C4}';
        case 'list_directory':  return '\u{1F4C1}';
        case 'search_workspace':return '\u{1F50D}';
        case 'get_open_files':  return '\u{1F441}\uFE0F';
        case 'write_file':      return '\u{270F}\uFE0F';
        case 'apply_edit':      return '\u{1F4DD}';
        case 'get_diagnostics': return '\u{1F41E}';
        case 'get_git_status':  return '\u{1F500}';
        case 'run_command':     return '\u{1F4BB}';
        case 'find_workspace_symbols': return '\u{1F3AF}';
        case 'get_document_outline': return '\u{1F4D1}';
        default:                return '\u{1F527}';
      }
    }
    function prettyToolName(name) {
      return ({
        read_file: 'Read',
        list_directory: 'List',
        search_workspace: 'Search',
        get_open_files: 'Open files',
        write_file: 'Write',
        apply_edit: 'Edit',
        get_diagnostics: 'Diagnostics',
        get_git_status: 'Git status',
        run_command: 'Run',
        find_workspace_symbols: 'Symbols',
        get_document_outline: 'Outline',
      })[name] || name;
    }

    function startTool(id, name, summary) {
      emptyState.style.display = 'none';
      const div = document.createElement('div');
      div.className = 'tool-card';
      div.dataset.id = id;
      div.innerHTML =
        '<span class="tool-icon">' + toolIcon(name) + '</span>' +
        '<span class="tool-name">' + escapeHtml(prettyToolName(name)) + '</span>' +
        '<span class="tool-summary">' + escapeHtml(summary || '') + '</span>' +
        '<span class="tool-status"><span class="spinner"></span></span>';
      messagesEl.appendChild(div);
      toolCards.set(id, div);
      scrollBottom();
    }

    function endTool(id, ok, preview) {
      const card = toolCards.get(id);
      if (!card) return;
      card.classList.add(ok ? 'ok' : 'err');
      const status = card.querySelector('.tool-status');
      if (status) status.textContent = ok ? 'done' : 'failed';
      if (preview) {
        const summary = card.querySelector('.tool-summary');
        if (summary) summary.title = preview;
      }
      toolCards.delete(id);
    }

    function send(text) {
      const msg = (text ?? inputEl.value).trim();
      if (!msg || streaming) return;
      inputEl.value = '';
      appendUserMessage(msg);
      vscode.postMessage({ type: 'send', text: msg });
    }

    btnSend.addEventListener('click', () => send());
    btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    btnClear.addEventListener('click', () => {
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyState);
      emptyState.style.display = '';
      vscode.postMessage({ type: 'clear' });
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    document.querySelectorAll('#empty-state .example').forEach((btn) => {
      btn.addEventListener('click', () => send(btn.dataset.q));
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          updateModePills(msg.mode);
          populateModels(msg.models, msg.model);
          if (msg.savedConversations) rebuildHistoryMenu(msg.savedConversations);
          break;
        case 'prefill':
          inputEl.value = msg.text;
          inputEl.focus();
          break;
        case 'startResponse':
          setStreaming(true);
          startAssistantBubble(msg.model, msg.mode);
          break;
        case 'token':
          appendToken(msg.text);
          break;
        case 'thinking':
          showThinking();
          break;
        case 'endResponse':
          finaliseAssistant();
          setStreaming(false);
          break;
        case 'toolStart':
          startTool(msg.id, msg.name, msg.summary);
          break;
        case 'toolEnd':
          endTool(msg.id, msg.ok, msg.preview);
          break;
        case 'clearAll':
          messagesEl.innerHTML = '';
          messagesEl.appendChild(emptyState);
          emptyState.style.display = '';
          toolCards.clear();
          finaliseAssistant();
          setStreaming(false);
          break;
        case 'error':
          finaliseAssistant();
          setStreaming(false);
          showError(msg.text);
          break;
        case 'info':
          showInfo(msg.text);
          break;
        case 'usage':
          updateUsageDisplay(msg.prompt, msg.completion, msg.costUsd);
          break;
        case 'replayHistory':
          renderReplayMessages(msg.messages);
          break;
        case 'savedConversations':
          rebuildHistoryMenu(msg.list);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
