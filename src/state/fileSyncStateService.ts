import * as vscode from "vscode";
import * as fs from "fs";
import * as crypto from "crypto";

interface FileSyncState {
    guid: string;
    published: boolean;
    /** SHA-256 hash of the raw bytes last known to match the server, in hex. */
    hash?: string;
}

/**
 * Owns the in-memory publish/sync state for local files and the file status
 * bar that reflects it. Extracted from `extension.ts` so `commandHandlers.ts`
 * can depend on it directly instead of importing back into the composition
 * root (which previously created a circular module dependency and a dynamic
 * `require('./extension')` fallback).
 *
 * Hashes are computed over raw file bytes (not decoded text), so binary web
 * resources (images, .resx, etc.) are tracked correctly.
 */
export class FileSyncStateService {
    private readonly fileSyncState = new Map<string, FileSyncState>();

    constructor(private readonly fileStatusBar: vscode.StatusBarItem) {}

    static computeFileHash(content: Buffer): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    /** Records a file as synced with the server, optionally marking it published with a content hash. */
    setFileSyncState(filePath: string, guid: string, published: boolean, hash?: string): void {
        const prev = this.fileSyncState.get(filePath);
        if (published) {
            this.fileSyncState.set(filePath, { guid, published: true, hash });
        } else if (prev) {
            this.fileSyncState.set(filePath, { guid, published: false, hash: prev.hash });
        } else {
            this.fileSyncState.set(filePath, { guid, published: false, hash });
        }
        this.updateStatusBar();
    }

    /** Re-checks a saved file's bytes against its last-published hash and updates the status bar. */
    async updateFilePublishStateOnSave(filePath: string): Promise<void> {
        const state = this.fileSyncState.get(filePath);
        if (!state) {
            return;
        }
        try {
            const bytes = await fs.promises.readFile(filePath);
            const currentHash = FileSyncStateService.computeFileHash(bytes);
            state.published = !!state.hash && currentHash === state.hash;
        } catch {
            state.published = false;
        }
        this.fileSyncState.set(filePath, state);
        this.updateStatusBar();
    }

    /** Clears all tracked state, e.g. when the active connection changes. */
    resetAll(): void {
        this.fileSyncState.clear();
        this.updateStatusBar();
    }

    updateStatusBar(editor?: vscode.TextEditor): void {
        const activeEditor = editor ?? vscode.window.activeTextEditor;
        if (!activeEditor) {
            this.fileStatusBar.hide();
            return;
        }
        const filePath = activeEditor.document.uri.fsPath;
        const state = this.fileSyncState.get(filePath);
        if (state) {
            this.fileStatusBar.text = state.published ? "$(cloud-upload) Published" : "$(sync-ignored) Not Published";
        } else {
            this.fileStatusBar.text = "File: Not Synced";
        }
        this.fileStatusBar.show();
    }

    registerListeners(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => this.updateStatusBar(editor)),
            vscode.workspace.onDidSaveTextDocument(document => {
                const filePath = document.fileName;
                if (this.fileSyncState.has(filePath)) {
                    void this.updateFilePublishStateOnSave(filePath);
                }
            })
        );
    }
}
