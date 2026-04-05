import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAPI_PATTERN = /^(openapi|swagger)\s*:/m;
const SPEC_GLOB = "**/*.{yaml,yml,json}";
const OUTPUT_CHANNEL_NAME = "Delimit";
const STATUS_ACTIVE = "$(check) Delimit";
const STATUS_WARN = "$(warning) Delimit";
const STATUS_SPIN = "$(sync~spin) Delimit";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let diagnosticCollection: vscode.DiagnosticCollection;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  diagnosticCollection =
    vscode.languages.createDiagnosticCollection("delimit");

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBarItem.command = "delimit.status";
  statusBarItem.tooltip = "Delimit API Governance";
  context.subscriptions.push(statusBarItem, outputChannel, diagnosticCollection);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("delimit.lint", cmdLint),
    vscode.commands.registerCommand("delimit.doctor", cmdDoctor),
    vscode.commands.registerCommand("delimit.init", cmdInit),
    vscode.commands.registerCommand("delimit.status", cmdStatus),
    vscode.commands.registerCommand("delimit.simulate", cmdSimulate),
    vscode.commands.registerCommand("delimit.report", cmdReport)
  );

  // Auto-lint on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const config = vscode.workspace.getConfiguration("delimit");
      if (!config.get<boolean>("autoLint", true)) {
        return;
      }
      if (isOpenApiSpec(doc)) {
        lintFile(doc.uri);
      }
    })
  );

  // Initial status check
  refreshStatus();
}

export function deactivate(): void {
  // cleanup handled by disposables
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLint(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Delimit: Open an OpenAPI spec file first.");
    return;
  }
  await lintFile(editor.document.uri);
}

async function cmdDoctor(): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine("--- delimit doctor ---");
  setStatus(STATUS_SPIN, "Running doctor...");

  const cwd = workspaceRoot();
  const result = await runCli("doctor", cwd);

  outputChannel.appendLine(result.stdout);
  if (result.stderr) {
    outputChannel.appendLine(result.stderr);
  }

  if (result.exitCode === 0) {
    setStatus(STATUS_ACTIVE, "Governance healthy");
    vscode.window.showInformationMessage("Delimit: Governance health check passed.");
  } else {
    setStatus(STATUS_WARN, "Governance issues found");
    vscode.window.showWarningMessage(
      "Delimit: Governance issues detected. See Output panel for details."
    );
  }
}

async function cmdInit(): Promise<void> {
  const terminal = vscode.window.createTerminal("Delimit Init");
  terminal.show();
  terminal.sendText(`${cliCommand()} init --preset default`);
}

async function cmdStatus(): Promise<void> {
  await refreshStatus(true);
}

async function cmdSimulate(): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine("--- delimit simulate ---");
  setStatus(STATUS_SPIN, "Simulating...");

  const cwd = workspaceRoot();
  const result = await runCli("simulate --commit", cwd);

  outputChannel.appendLine(result.stdout);
  if (result.stderr) {
    outputChannel.appendLine(result.stderr);
  }

  if (result.stdout.includes("BLOCK")) {
    setStatus(STATUS_WARN, "Simulation: would be blocked");
    vscode.window.showWarningMessage(
      "Delimit: Governance simulation found blocking issues. See Output panel."
    );
  } else {
    setStatus(STATUS_ACTIVE, "Simulation: would pass");
    vscode.window.showInformationMessage("Delimit: Governance simulation passed.");
  }
}

async function cmdReport(): Promise<void> {
  const cwd = workspaceRoot();
  const result = await runCli("report --since 7d --format md", cwd);

  if (result.exitCode === 0 && result.stdout.trim()) {
    const doc = await vscode.workspace.openTextDocument({
      content: result.stdout,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  } else {
    vscode.window.showWarningMessage("Delimit: Could not generate report.");
    outputChannel.appendLine(result.stderr || "No report output");
  }
}

// ---------------------------------------------------------------------------
// Lint logic
// ---------------------------------------------------------------------------

async function lintFile(uri: vscode.Uri): Promise<void> {
  setStatus(STATUS_SPIN, "Linting...");
  outputChannel.appendLine(`--- lint: ${uri.fsPath} ---`);

  const cwd = workspaceRoot();
  const result = await runCli(`lint "${uri.fsPath}"`, cwd);

  const combined = result.stdout + "\n" + result.stderr;
  outputChannel.appendLine(combined);

  const diagnostics = parseDiagnostics(combined, uri);
  diagnosticCollection.set(uri, diagnostics);

  if (result.exitCode === 0 && diagnostics.length === 0) {
    setStatus(STATUS_ACTIVE, "No breaking changes");
  } else if (diagnostics.length > 0) {
    const errors = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error
    ).length;
    const warnings = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Warning
    ).length;
    setStatus(
      STATUS_WARN,
      `${errors} error(s), ${warnings} warning(s)`
    );
  } else {
    setStatus(STATUS_WARN, "Lint completed with issues");
  }
}

// ---------------------------------------------------------------------------
// Diagnostics parser
// ---------------------------------------------------------------------------

function parseDiagnostics(
  output: string,
  uri: vscode.Uri
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Match patterns like:  ERROR: some message
    //                       WARNING: some message
    //                       BREAKING: some message
    const errorMatch = line.match(
      /^\s*(ERROR|BREAKING|error|breaking)[:\s]+(.+)/i
    );
    const warnMatch = line.match(
      /^\s*(WARNING|WARN|warning|warn|NON-BREAKING|non-breaking)[:\s]+(.+)/i
    );

    if (errorMatch) {
      const diag = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        errorMatch[2].trim(),
        vscode.DiagnosticSeverity.Error
      );
      diag.source = "delimit";
      diagnostics.push(diag);
    } else if (warnMatch) {
      const diag = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        warnMatch[2].trim(),
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = "delimit";
      diagnostics.push(diag);
    }

    // Match patterns with line numbers: path/file.yaml:10: message
    const lineNumMatch = line.match(/^.*?:(\d+)[:\s]+(.+)/);
    if (lineNumMatch && !errorMatch && !warnMatch) {
      const lineNum = Math.max(0, parseInt(lineNumMatch[1], 10) - 1);
      const msg = lineNumMatch[2].trim();
      if (msg.length > 5) {
        const severity = /error|breaking/i.test(msg)
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;
        const diag = new vscode.Diagnostic(
          new vscode.Range(lineNum, 0, lineNum, 200),
          msg,
          severity
        );
        diag.source = "delimit";
        diagnostics.push(diag);
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

async function refreshStatus(showMessage = false): Promise<void> {
  const cwd = workspaceRoot();

  // Check for delimit.yml / .delimit/ in workspace
  const hasConfig = await hasGovernanceConfig(cwd);

  if (!hasConfig) {
    setStatus(STATUS_WARN, "No governance config");
    statusBarItem.show();
    if (showMessage) {
      const action = await vscode.window.showWarningMessage(
        "Delimit: No governance configuration found in this workspace.",
        "Initialize"
      );
      if (action === "Initialize") {
        vscode.commands.executeCommand("delimit.init");
      }
    }
    return;
  }

  // Check CLI availability
  const result = await runCli("--version", cwd);
  if (result.exitCode !== 0) {
    setStatus(STATUS_WARN, "CLI not found");
    statusBarItem.show();
    if (showMessage) {
      vscode.window.showWarningMessage(
        "Delimit: CLI not found. Install with: npm install -g delimit-cli"
      );
    }
    return;
  }

  setStatus(STATUS_ACTIVE, `Active (CLI ${result.stdout.trim()})`);
  statusBarItem.show();

  if (showMessage) {
    vscode.window.showInformationMessage(
      `Delimit: Governance active. CLI version ${result.stdout.trim()}`
    );
  }
}

function setStatus(text: string, tooltip: string): void {
  statusBarItem.text = text;
  statusBarItem.tooltip = `Delimit: ${tooltip}`;
  statusBarItem.show();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOpenApiSpec(doc: vscode.TextDocument): boolean {
  const ext = path.extname(doc.fileName).toLowerCase();
  if (![".yaml", ".yml", ".json"].includes(ext)) {
    return false;
  }
  const text = doc.getText(new vscode.Range(0, 0, 5, 0));
  return OPENAPI_PATTERN.test(text);
}

async function hasGovernanceConfig(cwd: string): Promise<boolean> {
  const candidates = [
    path.join(cwd, "delimit.yml"),
    path.join(cwd, "delimit.yaml"),
    path.join(cwd, ".delimit"),
    path.join(cwd, ".delimit", "policies.yml"),
  ];
  for (const p of candidates) {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      // not found, continue
    }
  }
  return false;
}

function cliCommand(): string {
  const config = vscode.workspace.getConfiguration("delimit");
  const custom = config.get<string>("cliPath", "");
  if (custom) {
    return custom;
  }
  return "npx delimit-cli";
}

function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return process.cwd();
}

function runCli(
  args: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cmd = `${cliCommand()} ${args}`;
    exec(cmd, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        exitCode: error ? error.code ?? 1 : 0,
      });
    });
  });
}
