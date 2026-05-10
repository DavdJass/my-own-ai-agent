import * as vscode from 'vscode';
import { DeepSeekClient } from './client';
import { ChatViewProvider } from './chatView';
import { InlineProvider } from './inlineProvider';

export function activate(context: vscode.ExtensionContext): void {
  const client = new DeepSeekClient(context);
  const chatProvider = new ChatViewProvider(client);

  // ── Sidebar webview view ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Status bar — shows active model, click to switch ──────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'deepseek.selectModel';
  context.subscriptions.push(statusBar);

  const refreshStatusBar = (): void => {
    const model = vscode.workspace
      .getConfiguration('deepseek')
      .get<string>('model', 'deepseek-v4-flash');
    const label = model === 'deepseek-v4-pro' ? 'DS Pro' : 'DS Flash';
    statusBar.text = `$(comment-discussion) ${label}`;
    statusBar.tooltip = `DeepSeek model: ${model}\nClick to switch`;
    statusBar.show();
  };
  refreshStatusBar();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deepseek.model')) refreshStatusBar();
    })
  );

  // ── Commands ───────────────────────────────────────────────────────────

  // Open / focus the sidebar chat view
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.openChat', async () => {
      await vscode.commands.executeCommand(
        `${ChatViewProvider.viewType}.focus`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.clearChat', () => {
      chatProvider.clear();
    })
  );

  // Store API key in SecretStorage
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.setApiKey', async () => {
      const existing = await client.getApiKey();
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your DeepSeek API key',
        password: true,
        value: existing ?? '',
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
      });
      if (key !== undefined && key.trim()) {
        await client.setApiKey(key.trim());
        vscode.window.showInformationMessage(
          'DeepSeek: API key saved securely.'
        );
      }
    })
  );

  // Quick-pick model selector
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.selectModel', async () => {
      const current = vscode.workspace
        .getConfiguration('deepseek')
        .get<string>('model', 'deepseek-v4-flash');

      const items: vscode.QuickPickItem[] = [
        {
          label: 'deepseek-v4-flash',
          description: 'Faster, cheaper',
          detail: current === 'deepseek-v4-flash' ? 'Currently active' : '',
        },
        {
          label: 'deepseek-v4-pro',
          description: 'More powerful (thinking mode)',
          detail: current === 'deepseek-v4-pro' ? 'Currently active' : '',
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select DeepSeek model',
        title: 'DeepSeek Coder — Model',
      });
      if (!picked) return;

      await vscode.workspace
        .getConfiguration('deepseek')
        .update('model', picked.label, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        `DeepSeek: model set to ${picked.label}`
      );
    })
  );

  // ── Code actions (context menu) ────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.explainCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const code = editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('Select code to explain first.');
        return;
      }

      const lang = editor.document.languageId;
      chatProvider.sendUserMessage(
        `Explain what this ${lang} code does:\n\`\`\`${lang}\n${code}\n\`\`\``
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.refactorCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const code = editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('Select code to refactor first.');
        return;
      }

      const instruction = await vscode.window.showInputBox({
        prompt: 'How should this code be refactored?',
        placeHolder:
          'e.g. make it more readable, extract functions, add error handling…',
        ignoreFocusOut: true,
      });
      if (!instruction) return;

      const lang = editor.document.languageId;
      chatProvider.sendUserMessage(
        `Refactor this ${lang} code — ${instruction}:\n\`\`\`${lang}\n${code}\n\`\`\``
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek.generateCode', async () => {
      const description = await vscode.window.showInputBox({
        prompt: 'Describe the code you want to generate',
        placeHolder: 'e.g. a function that sorts a list of users by name…',
        ignoreFocusOut: true,
      });
      if (!description) return;

      const lang =
        vscode.window.activeTextEditor?.document.languageId ?? 'code';
      chatProvider.sendUserMessage(`Generate ${lang} code: ${description}`);
    })
  );

  // ── Inline completions ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new InlineProvider(client)
    )
  );
}

export function deactivate(): void {
  /* nothing to clean up — subscriptions handle disposal */
}
