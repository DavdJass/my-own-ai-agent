import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DeepSeekClient, Message, ToolCall } from './client';
import { TOOL_DEFINITIONS, executeTool } from './tools';

const MAX_AGENT_ITERATIONS = 8;

/**
 * Sidebar webview view that hosts the DeepSeek chat.
 * Lives in its own activity-bar container so the user always has 1-click access.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'deepseek.chatView';

  private view?: vscode.WebviewView;
  private readonly client: DeepSeekClient;
  private history: Message[] = [];
  private abortController?: AbortController;
  /** Messages queued before the webview is ready. */
  private pendingUserMessages: string[] = [];

  constructor(client: DeepSeekClient) {
    this.client = client;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.buildHtml();
    view.webview.onDidReceiveMessage(this.onMessage.bind(this));

    // Flush any messages requested before the view existed.
    while (this.pendingUserMessages.length > 0) {
      const text = this.pendingUserMessages.shift()!;
      this.processChat(text);
    }
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
    this.abortController?.abort();
    this.postWebview({ type: 'clearAll' });
  }

  // ─── Agent loop ────────────────────────────────────────────────────────────

  private async processChat(userText: string): Promise<void> {
    if (this.history.length === 0) {
      this.history.push({ role: 'system', content: this.buildSystemPrompt() });
    }
    this.history.push({ role: 'user', content: userText });

    this.abortController = new AbortController();
    this.postWebview({ type: 'startResponse', model: this.client.model });

    try {
      for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
        let assistantText = '';
        const result = await this.client.chat(this.history, {
          tools: TOOL_DEFINITIONS,
          signal: this.abortController.signal,
          onToken: (t) => {
            assistantText += t;
            this.postWebview({ type: 'token', text: t });
          },
        });

        // reasoning_content is required by DeepSeek thinking models.
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

        if (result.toolCalls.length === 0) break;

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
          this.postWebview({ type: 'startResponse', model: this.client.model });
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
      default:
        return '';
    }
  }

  private previewOutput(output: string): string {
    const firstLine = output.split('\n')[0] ?? '';
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  private buildSystemPrompt(): string {
    const root =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(no workspace)';
    const parts = [
      'You are DeepSeek Coder, an autonomous coding agent embedded in VS Code.',
      'You can read files, search the workspace, and propose edits using the available tools.',
      'When the user asks about code, prefer reading the relevant files yourself instead of guessing.',
      'For any change to a file, use apply_edit (preferred for small targeted changes) or write_file.',
      'Both apply_edit and write_file ask the user for confirmation, so do not ask in chat — just call the tool.',
      'When you finish, give a concise summary of what you did. Use markdown with fenced code blocks.',
      `\nWorkspace root: ${root}`,
    ];

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      parts.push(`Active file the user is looking at: ${rel}`);
    }

    return parts.join('\n');
  }

  private postWebview(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private onMessage(msg: { type: string; text?: string }): void {
    switch (msg.type) {
      case 'send':
        if (msg.text) this.processChat(msg.text);
        break;
      case 'stop':
        this.abortController?.abort();
        break;
      case 'clear':
        this.history = [];
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

    html, body {
      height: 100%;
      width: 100%;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Top bar ─────────────────────────────────────────────────────── */
    #topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #model-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
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

    .streaming-cursor::after {
      content: '\u258D';
      animation: blink 0.7s step-end infinite;
      margin-left: 1px;
    }
    @keyframes blink { 50% { opacity: 0; } }

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
    .tool-icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }
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

    #btn-row {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      align-items: center;
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex: 1;
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
    <span id="model-label">DeepSeek Agent</span>
    <button id="btn-clear" title="Clear conversation">Clear</button>
  </div>

  <div id="messages">
    <div id="empty-state">
      <div class="logo">\u26A1</div>
      <div class="title">DeepSeek Coder Agent</div>
      <div class="subtitle">I can read your files, search the workspace, and edit code.</div>
      <div class="examples">
        <button class="example" data-q="What does this project do? Read the README and explain.">What does this project do?</button>
        <button class="example" data-q="Find all TODO comments in the codebase.">Find all TODO comments</button>
        <button class="example" data-q="Add a docstring to the main function in the active file.">Document my main function</button>
      </div>
    </div>
  </div>

  <div id="error-toast"></div>

  <div id="inputarea">
    <textarea id="input" placeholder="Ask anything\u2026 the agent will read files as needed."></textarea>
    <div id="btn-row">
      <span class="hint">Enter to send</span>
      <button class="secondary" id="btn-stop" style="display:none">Stop</button>
      <button class="primary" id="btn-send">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const messagesEl = document.getElementById('messages');
    const inputEl    = document.getElementById('input');
    const btnSend    = document.getElementById('btn-send');
    const btnStop    = document.getElementById('btn-stop');
    const btnClear   = document.getElementById('btn-clear');
    const emptyState = document.getElementById('empty-state');
    const errorToast = document.getElementById('error-toast');

    let streaming = false;
    let currentAssistantBody = null;
    let rawBuffer = '';
    const toolCards = new Map();

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

    function showError(text) {
      errorToast.textContent = text;
      errorToast.style.display = 'block';
      setTimeout(() => { errorToast.style.display = 'none'; }, 8000);
    }

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

    function startAssistantBubble(model) {
      emptyState.style.display = 'none';
      rawBuffer = '';
      const div = document.createElement('div');
      div.className = 'msg msg-assistant';
      div.innerHTML =
        '<div class="msg-role">' + escapeHtml(model || 'DeepSeek') + '</div>' +
        '<div class="msg-body streaming-cursor"></div>';
      messagesEl.appendChild(div);
      currentAssistantBody = div.querySelector('.msg-body');
      scrollBottom();
    }

    function appendToken(token) {
      if (!currentAssistantBody) return;
      rawBuffer += token;
      currentAssistantBody.innerHTML = renderMarkdown(rawBuffer);
      currentAssistantBody.classList.add('streaming-cursor');
      scrollBottom();
    }

    function finaliseAssistant() {
      if (currentAssistantBody) {
        currentAssistantBody.classList.remove('streaming-cursor');
        if (!rawBuffer.trim()) {
          const bubble = currentAssistantBody.parentElement;
          bubble && bubble.remove();
        }
        currentAssistantBody = null;
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
        case 'prefill':
          inputEl.value = msg.text;
          inputEl.focus();
          break;
        case 'startResponse':
          setStreaming(true);
          startAssistantBubble(msg.model);
          break;
        case 'token':
          appendToken(msg.text);
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
      }
    });
  </script>
</body>
</html>`;
  }
}
