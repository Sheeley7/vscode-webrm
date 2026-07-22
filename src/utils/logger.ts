import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

/** Creates the "Web Resource Manager" output channel referenced by the auth error page. */
export function initLogger(context: vscode.ExtensionContext): void {
    channel = vscode.window.createOutputChannel("Web Resource Manager");
    context.subscriptions.push(channel);
}

export function logError(source: string, error: unknown): void {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[${source}]`, error);
    channel?.appendLine(`[${new Date().toISOString()}] ERROR (${source}): ${message}`);
}
