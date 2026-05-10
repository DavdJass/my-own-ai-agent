import * as vscode from 'vscode';
import { DeepSeekClient } from './client';

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private readonly client: DeepSeekClient;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Lines of context sent before and after the cursor. */
  private static readonly PREFIX_LINES = 60;
  private static readonly SUFFIX_LINES = 20;
  private static readonly DEBOUNCE_MS = 350;

  constructor(client: DeepSeekClient) {
    this.client = client;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | undefined> {
    const enabled = vscode.workspace
      .getConfiguration('deepseek')
      .get<boolean>('inlineEnabled', true);
    if (!enabled) return;

    // Only fire on explicit invocation or after the debounce settles.
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      await this.debounce();
      if (token.isCancellationRequested) return;
    }

    const prefix = this.getPrefix(document, position);
    const suffix = this.getSuffix(document, position);

    // Skip if cursor is in the middle of whitespace-only content.
    if (!prefix.trim() && !suffix.trim()) return;

    const lang = document.languageId;
    const prompt =
      `Complete the following ${lang} code. ` +
      `The cursor position is marked with <CURSOR>. ` +
      `Return ONLY the completion — no explanations, no markdown fences.\n\n` +
      `${prefix}<CURSOR>${suffix}`;

    try {
      const completion = await this.client.complete(prompt);
      if (!completion || token.isCancellationRequested) return;

      return {
        items: [
          new vscode.InlineCompletionItem(
            completion,
            new vscode.Range(position, position)
          ),
        ],
      };
    } catch {
      return;
    }
  }

  private getPrefix(doc: vscode.TextDocument, pos: vscode.Position): string {
    const startLine = Math.max(0, pos.line - InlineProvider.PREFIX_LINES);
    return doc.getText(
      new vscode.Range(new vscode.Position(startLine, 0), pos)
    );
  }

  private getSuffix(doc: vscode.TextDocument, pos: vscode.Position): string {
    const endLine = Math.min(
      doc.lineCount - 1,
      pos.line + InlineProvider.SUFFIX_LINES
    );
    const endChar = doc.lineAt(endLine).text.length;
    return doc.getText(
      new vscode.Range(pos, new vscode.Position(endLine, endChar))
    );
  }

  private debounce(): Promise<void> {
    return new Promise((resolve) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(resolve, InlineProvider.DEBOUNCE_MS);
    });
  }
}
