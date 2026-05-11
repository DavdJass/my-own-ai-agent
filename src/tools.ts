import * as childProcess from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Tool definitions sent to DeepSeek so it knows what functions it can call.
 * Format follows the OpenAI function-calling spec, which DeepSeek implements.
 */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file in the user workspace. Use this when you need to see code in a file the user mentions or that is relevant to their question.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Workspace-relative path to the file (e.g. "src/main.ts").',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and subdirectories inside a folder of the workspace. Use this to discover the structure of the project.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Workspace-relative directory path. Use "." for the workspace root.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_workspace',
      description:
        'Search for a text pattern across all files in the workspace. Returns matching file paths and line numbers. Useful when looking for where a function/variable is defined or used.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Plain-text or regex pattern to look for.',
          },
          glob: {
            type: 'string',
            description:
              'Optional glob to limit which files are searched (e.g. "**/*.ts").',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_open_files',
      description:
        'Return the list of files the user currently has open in editor tabs, including which one is active.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file or completely overwrite an existing one. Always asks the user for confirmation first via a diff preview.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path to the file to write.',
          },
          content: {
            type: 'string',
            description: 'Full new contents of the file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_edit',
      description:
        'Replace an exact substring inside an existing file with a new substring. Use this for targeted edits instead of rewriting the whole file. Asks the user for confirmation via a diff preview.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path to the file to edit.',
          },
          old_text: {
            type: 'string',
            description:
              'Exact text to find. Must be unique in the file. Include enough surrounding context to disambiguate.',
          },
          new_text: {
            type: 'string',
            description: 'Text that will replace old_text.',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_git_status',
      description:
        'Read the current git state of the workspace: status (staged/unstaged files), diff summary and recent commits. ' +
        'Use this to understand what has changed before planning or debugging.',
      parameters: {
        type: 'object',
        properties: {
          include_diff: {
            type: 'boolean',
            description:
              'If true, also include the full `git diff` for unstaged changes (can be large). Default false.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a shell command in the workspace root. ' +
        'The user MUST approve before the command runs. ' +
        'Use for build/test/lint steps, not for destructive operations. ' +
        'Prefer specific tools (read_file, apply_edit) when they cover the need.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run, e.g. "npm test" or "go build ./...".',
          },
          working_directory: {
            type: 'string',
            description:
              'Optional workspace-relative directory to run the command in. Defaults to workspace root.',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        'Read the current Problems panel of VS Code (errors, warnings, hints from linters and language servers). Use this in Debug mode to find what is broken before reading code.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional workspace-relative file to scope diagnostics to. Omit to get diagnostics for the whole workspace.',
          },
          severity: {
            type: 'string',
            enum: ['error', 'warning', 'info', 'hint', 'all'],
            description:
              'Minimum severity to include. Defaults to "warning" (errors + warnings).',
          },
        },
      },
    },
  },
] as const;

/** Available chat modes. Each mode exposes a different subset of tools. */
export type ChatMode = 'ask' | 'plan' | 'debug' | 'agent';

const MODE_TOOLS: Record<ChatMode, readonly string[]> = {
  ask: [],
  plan: ['read_file', 'list_directory', 'search_workspace', 'get_open_files', 'get_git_status'],
  debug: [
    'read_file',
    'list_directory',
    'search_workspace',
    'get_open_files',
    'get_diagnostics',
    'get_git_status',
  ],
  agent: [
    'read_file',
    'list_directory',
    'search_workspace',
    'get_open_files',
    'write_file',
    'apply_edit',
    'get_diagnostics',
    'get_git_status',
    'run_command',
  ],
};

/** Returns the tool definitions allowed for a given mode. */
export function toolsForMode(mode: ChatMode): readonly unknown[] {
  const allowed = new Set(MODE_TOOLS[mode]);
  return TOOL_DEFINITIONS.filter((t) => allowed.has(t.function.name));
}

const MAX_FILE_BYTES = 100_000;
const MAX_SEARCH_RESULTS = 50;

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function resolveWorkspacePath(rel: string): vscode.Uri {
  const root = workspaceRoot();
  if (!root) throw new Error('No workspace folder is open.');
  const normalized = rel.replace(/^[./\\]+/, '');
  return vscode.Uri.joinPath(root, normalized);
}

function describeChange(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n').length;
  const newLines = newText.split('\n').length;
  return `${oldLines} line(s) → ${newLines} line(s)`;
}

/**
 * Execute a single tool call requested by the model.
 * Returns the string content that will be sent back as the tool result message.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':
        return await readFile(String(args.path ?? ''));
      case 'list_directory':
        return await listDirectory(String(args.path ?? '.'));
      case 'search_workspace':
        return await searchWorkspace(
          String(args.query ?? ''),
          args.glob ? String(args.glob) : undefined
        );
      case 'get_open_files':
        return getOpenFiles();
      case 'write_file':
        return await writeFile(
          String(args.path ?? ''),
          String(args.content ?? '')
        );
      case 'apply_edit':
        return await applyEdit(
          String(args.path ?? ''),
          String(args.old_text ?? ''),
          String(args.new_text ?? '')
        );
      case 'get_diagnostics':
        return getDiagnostics(
          args.path ? String(args.path) : undefined,
          args.severity ? String(args.severity) : 'warning'
        );
      case 'get_git_status':
        return await getGitStatus(args.include_diff === true);
      case 'run_command':
        return await runCommand(
          String(args.command ?? ''),
          args.working_directory ? String(args.working_directory) : undefined
        );
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

// ─── Read tools ──────────────────────────────────────────────────────────────

async function readFile(rel: string): Promise<string> {
  if (!rel) return 'Error: path is required';
  const uri = resolveWorkspacePath(rel);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    const truncated = bytes.slice(0, MAX_FILE_BYTES);
    return (
      Buffer.from(truncated).toString('utf-8') +
      `\n\n[truncated — file is ${bytes.byteLength} bytes, only first ${MAX_FILE_BYTES} shown]`
    );
  }
  return Buffer.from(bytes).toString('utf-8');
}

async function listDirectory(rel: string): Promise<string> {
  const uri = resolveWorkspacePath(rel === '.' ? '' : rel);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  if (entries.length === 0) return '(empty directory)';
  return entries
    .map(([name, type]) => {
      const tag =
        type === vscode.FileType.Directory
          ? 'dir '
          : type === vscode.FileType.SymbolicLink
            ? 'link'
            : 'file';
      return `${tag}  ${name}`;
    })
    .join('\n');
}

async function searchWorkspace(
  query: string,
  glob?: string
): Promise<string> {
  if (!query.trim()) return 'Error: query is required';

  const includePattern = glob ?? '**/*';
  const excludePattern =
    '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}';

  const files = await vscode.workspace.findFiles(
    includePattern,
    excludePattern,
    500
  );

  const results: string[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    regex = new RegExp(escapeRegex(query), 'i');
  }

  for (const file of files) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    try {
      const data = await vscode.workspace.fs.readFile(file);
      if (data.byteLength > MAX_FILE_BYTES) continue;
      const text = Buffer.from(data).toString('utf-8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const rel = vscode.workspace.asRelativePath(file);
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    } catch {
      /* skip unreadable file */
    }
  }

  if (results.length === 0) return `No matches for "${query}".`;
  return results.join('\n');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Git ─────────────────────────────────────────────────────────────────────

async function getGitStatus(includeDiff: boolean): Promise<string> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return 'Error: no workspace folder open.';

  const run = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      childProcess.exec(cmd, { cwd, timeout: 15_000 }, (err, stdout, stderr) => {
        resolve(err ? `(error: ${stderr.trim() || err.message})` : stdout.trim());
      });
    });

  const [status, diffStat, log] = await Promise.all([
    run('git status --short'),
    run('git diff --stat'),
    run('git log --oneline -10'),
  ]);

  const diff = includeDiff ? '\n\n### Diff\n' + (await run('git diff')) : '';

  const parts: string[] = [
    '### Git Status',
    status || '(clean working tree)',
    '\n### Diff stat',
    diffStat || '(no unstaged changes)',
    '\n### Recent commits',
    log || '(no commits)',
  ];

  if (diff) parts.push(diff);
  return parts.join('\n');
}

// ─── Run command ──────────────────────────────────────────────────────────────

async function runCommand(command: string, relCwd?: string): Promise<string> {
  if (!command.trim()) return 'Error: command is required';

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return 'Error: no workspace folder open.';

  const cwd = relCwd ? path.resolve(root, relCwd.replace(/^[./\\]+/, '')) : root;

  const confirm = await vscode.window.showWarningMessage(
    `DeepSeek wants to run:\n${command}`,
    { modal: true },
    'Allow',
    'Deny'
  );

  if (confirm !== 'Allow') return 'User denied the command.';

  return new Promise<string>((resolve) => {
    childProcess.exec(
      command,
      { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (err && !out) {
          resolve(`Error (exit ${err.code ?? '?'}): ${err.message}`);
        } else {
          const header = err ? `Exit code ${err.code ?? '?'}\n` : '';
          resolve(header + (out || '(no output)'));
        }
      }
    );
  });
}

function getDiagnostics(rel: string | undefined, severityName: string): string {
  const minSeverity = severityFromName(severityName);

  const targets: [vscode.Uri, vscode.Diagnostic[]][] = rel
    ? [[resolveWorkspacePath(rel), vscode.languages.getDiagnostics(resolveWorkspacePath(rel))]]
    : vscode.languages.getDiagnostics();

  const lines: string[] = [];
  let total = 0;

  for (const [uri, diags] of targets) {
    const filtered = diags.filter((d) => d.severity <= minSeverity);
    if (filtered.length === 0) continue;

    const path = vscode.workspace.asRelativePath(uri);
    lines.push(`\n${path}`);
    for (const d of filtered) {
      total++;
      const sev = severityLabel(d.severity);
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const source = d.source ? ` [${d.source}]` : '';
      lines.push(`  ${sev} ${line}:${col}${source}  ${d.message.replace(/\n/g, ' ')}`);
      if (lines.length > 200) break;
    }
    if (lines.length > 200) break;
  }

  if (total === 0) return rel ? `No diagnostics in "${rel}".` : 'No diagnostics in the workspace.';
  return `${total} diagnostic(s):${lines.join('\n')}`;
}

function severityFromName(name: string): vscode.DiagnosticSeverity {
  switch (name.toLowerCase()) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'info': return vscode.DiagnosticSeverity.Information;
    case 'hint':
    case 'all':
      return vscode.DiagnosticSeverity.Hint;
    default: return vscode.DiagnosticSeverity.Warning;
  }
}

function severityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'ERROR  ';
    case vscode.DiagnosticSeverity.Warning: return 'WARN   ';
    case vscode.DiagnosticSeverity.Information: return 'INFO   ';
    case vscode.DiagnosticSeverity.Hint: return 'HINT   ';
    default: return '       ';
  }
}

function getOpenFiles(): string {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;

  const list = tabs
    .map((tab) => {
      const input = tab.input as { uri?: vscode.Uri };
      if (!input?.uri) return null;
      const rel = vscode.workspace.asRelativePath(input.uri);
      const isActive = input.uri.fsPath === active;
      return `${isActive ? '* ' : '  '}${rel}`;
    })
    .filter(Boolean);

  if (list.length === 0) return 'No files are open.';
  return `Open files (* = active):\n${list.join('\n')}`;
}

// ─── Write tools (with user confirmation) ────────────────────────────────────

async function writeFile(rel: string, content: string): Promise<string> {
  if (!rel) return 'Error: path is required';
  const uri = resolveWorkspacePath(rel);

  let existed = true;
  let oldContent = '';
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    oldContent = Buffer.from(data).toString('utf-8');
  } catch {
    existed = false;
  }

  const action = existed ? 'overwrite' : 'create';
  const confirm = await vscode.window.showWarningMessage(
    `DeepSeek wants to ${action} "${rel}" (${describeChange(oldContent, content)}). Allow?`,
    { modal: true },
    'Allow',
    'Show Diff'
  );

  if (confirm === 'Show Diff') {
    await showDiffPreview(uri, oldContent, content);
    const after = await vscode.window.showWarningMessage(
      `Apply changes to "${rel}"?`,
      { modal: true },
      'Allow'
    );
    if (after !== 'Allow') return `User rejected the write to "${rel}".`;
  } else if (confirm !== 'Allow') {
    return `User rejected the write to "${rel}".`;
  }

  await ensureParentExists(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  return `${existed ? 'Overwrote' : 'Created'} "${rel}" (${content.length} bytes).`;
}

async function applyEdit(
  rel: string,
  oldText: string,
  newText: string
): Promise<string> {
  if (!rel) return 'Error: path is required';
  if (!oldText) return 'Error: old_text is required';

  const uri = resolveWorkspacePath(rel);
  const data = await vscode.workspace.fs.readFile(uri);
  const original = Buffer.from(data).toString('utf-8');

  const idx = original.indexOf(oldText);
  if (idx === -1) {
    return `Error: old_text not found in "${rel}". Re-read the file and provide an exact match.`;
  }
  if (original.indexOf(oldText, idx + 1) !== -1) {
    return `Error: old_text matches multiple locations in "${rel}". Add more surrounding context to make it unique.`;
  }

  const updated =
    original.slice(0, idx) + newText + original.slice(idx + oldText.length);

  const confirm = await vscode.window.showWarningMessage(
    `DeepSeek wants to edit "${rel}" (${describeChange(oldText, newText)}). Allow?`,
    { modal: true },
    'Allow',
    'Show Diff'
  );

  if (confirm === 'Show Diff') {
    await showDiffPreview(uri, original, updated);
    const after = await vscode.window.showWarningMessage(
      `Apply changes to "${rel}"?`,
      { modal: true },
      'Allow'
    );
    if (after !== 'Allow') return `User rejected the edit to "${rel}".`;
  } else if (confirm !== 'Allow') {
    return `User rejected the edit to "${rel}".`;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));
  return `Edited "${rel}" successfully.`;
}

async function ensureParentExists(uri: vscode.Uri): Promise<void> {
  const parent = vscode.Uri.joinPath(uri, '..');
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {
    /* already exists */
  }
}

async function showDiffPreview(
  targetUri: vscode.Uri,
  before: string,
  after: string
): Promise<void> {
  const beforeUri = vscode.Uri.parse(
    `untitled:${path.basename(targetUri.fsPath)} (current)`
  );
  const afterUri = vscode.Uri.parse(
    `untitled:${path.basename(targetUri.fsPath)} (proposed)`
  );

  const beforeDoc = await vscode.workspace.openTextDocument({
    content: before,
    language: detectLang(targetUri.fsPath),
  });
  const afterDoc = await vscode.workspace.openTextDocument({
    content: after,
    language: detectLang(targetUri.fsPath),
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeDoc.uri,
    afterDoc.uri,
    `DeepSeek diff: ${path.basename(targetUri.fsPath)}`
  );

  // Suppress unused locals
  void beforeUri;
  void afterUri;
}

function detectLang(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    rb: 'ruby',
    php: 'php',
    html: 'html',
    css: 'css',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shellscript',
    sql: 'sql',
  };
  return map[ext] ?? 'plaintext';
}
