import * as https from 'https';
import * as vscode from 'vscode';

const DEEPSEEK_HOST = 'api.deepseek.com';
const CHAT_PATH = '/v1/chat/completions';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Required by DeepSeek thinking models — must be echoed back on next turn. */
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ChatResult {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

export interface ChatOptions {
  /** Tool definitions to expose to the model. */
  tools?: readonly unknown[];
  /** Override the model for this call (defaults to the global setting). */
  model?: string;
  /** Streaming token callback (assistant text only — tool args are buffered). */
  onToken?: (token: string) => void;
  /** Called whenever a reasoning_content fragment arrives (thinking models). */
  onReasoningToken?: (token: string) => void;
  /** Cancellation. */
  signal?: AbortSignal;
}

export class DeepSeekClient {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  get model(): string {
    return vscode.workspace
      .getConfiguration('deepseek')
      .get<string>('model', 'deepseek-v4-flash');
  }

  private get maxTokens(): number {
    return vscode.workspace
      .getConfiguration('deepseek')
      .get<number>('maxTokens', 2048);
  }

  private get temperature(): number {
    return vscode.workspace
      .getConfiguration('deepseek')
      .get<number>('temperature', 0.2);
  }

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get('deepseek.apiKey');
  }

  async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store('deepseek.apiKey', key);
  }

  /**
   * Streaming chat completion that supports tool calling.
   * Returns the full assistant text plus any tool calls the model wants to invoke.
   */
  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('API key not set. Run "DeepSeek: Set API Key" first.');
    }

    const payload: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = 'auto';
    }
    const body = JSON.stringify(payload);

    return new Promise<ChatResult>((resolve, reject) => {
      const req = https.request(
        {
          hostname: DEEPSEEK_HOST,
          path: CHAT_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errBody = '';
            res.on('data', (c: Buffer) => (errBody += c.toString()));
            res.on('end', () =>
              reject(new Error(`DeepSeek ${res.statusCode}: ${errBody}`))
            );
            return;
          }

          let buffer = '';
          let content = '';
          let reasoningContent = '';
          let usage: TokenUsage | undefined;
          // Tool calls arrive incrementally; index → accumulator.
          const toolAccum: Record<number, ToolCall> = {};

          const finalResult = (): ChatResult => ({
            content,
            reasoningContent,
            toolCalls: Object.values(toolAccum).filter((t) => t.name),
            usage,
          });

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              const data = trimmed.slice(6);
              if (data === '[DONE]') {
                resolve(finalResult());
                return;
              }
              try {
                const parsed = JSON.parse(data);

                // The final chunk before [DONE] carries usage stats.
                if (parsed.usage) {
                  usage = {
                    prompt: parsed.usage.prompt_tokens ?? 0,
                    completion: parsed.usage.completion_tokens ?? 0,
                    total: parsed.usage.total_tokens ?? 0,
                  };
                }

                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                if (typeof delta.content === 'string' && delta.content) {
                  content += delta.content;
                  options.onToken?.(delta.content);
                }

                if (
                  typeof delta.reasoning_content === 'string' &&
                  delta.reasoning_content
                ) {
                  reasoningContent += delta.reasoning_content;
                  options.onReasoningToken?.(delta.reasoning_content);
                }

                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolAccum[idx]) {
                      toolAccum[idx] = { id: '', name: '', arguments: '' };
                    }
                    if (tc.id) toolAccum[idx].id = tc.id;
                    if (tc.function?.name) toolAccum[idx].name = tc.function.name;
                    if (tc.function?.arguments) {
                      toolAccum[idx].arguments += tc.function.arguments;
                    }
                  }
                }
              } catch {
                /* skip malformed SSE chunk */
              }
            }
          });

          res.on('end', () => resolve(finalResult()));
          res.on('error', reject);
        }
      );

      req.on('error', reject);

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('aborted'));
        });
      }

      req.write(body);
      req.end();
    });
  }

  /**
   * Single-shot (non-streaming) completion used by the inline provider.
   * Returns an empty string on any error so the editor is never blocked.
   */
  async complete(prompt: string): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) return '';

    const body = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You are a code completion assistant. ' +
            'The user will give you code with a <CURSOR> marker. ' +
            'Return ONLY the text that should be inserted at the cursor — no explanations, no markdown fences.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 256,
      temperature: 0.1,
      stream: false,
    });

    return new Promise<string>((resolve) => {
      const req = https.request(
        {
          hostname: DEEPSEEK_HOST,
          path: CHAT_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let responseBody = '';
          res.on('data', (c: Buffer) => (responseBody += c.toString()));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseBody);
              resolve(parsed.choices?.[0]?.message?.content ?? '');
            } catch {
              resolve('');
            }
          });
          res.on('error', () => resolve(''));
        }
      );

      req.on('error', () => resolve(''));
      req.write(body);
      req.end();
    });
  }
}
