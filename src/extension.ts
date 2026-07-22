import * as vscode from "vscode";
import { ConnectionExplorer } from "./views/connectionExplorer";
import { SolutionExplorer, Solution } from "./views/solutionExplorer";
import { WebResourceExplorer } from "./views/webResourceExplorer";
import { ConnectionStatusController } from "./connectionStatusController";
import { registerCommands } from "./commandHandlers";
import { checkClientId, checkAPIVersion } from "./utils/configUtils";
import { FileSyncStateService } from "./state/fileSyncStateService";
import { generateNonce } from "./utils/nonce";
import { initLogger } from "./utils/logger";
import * as fs from 'fs';

let statusBar: vscode.StatusBarItem;
let fileStatusBar: vscode.StatusBarItem;
let solutionStatusBar: vscode.StatusBarItem;
let fileSyncStateService: FileSyncStateService;

class LoadingTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly loadingItem = new vscode.TreeItem("Loading Web Resource Manager...", vscode.TreeItemCollapsibleState.None);

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
        return [this.loadingItem];
    }
}

/**
 * Performs initial configuration and workspace checks essential for the extension's operation.
 * This includes verifying required settings (Client ID, API Version, Config Folder) and ensuring a workspace is open.
 *
 * @returns {string} Returns a string code indicating the outcome:
 *                   "CRITICAL_SETTINGS_MISSING", "WORKSPACE_MISSING", or "ALL_CHECKS_PASSED".
 */
function performInitialChecks(): { status: string; missing: string[] } {
    const missingSettings: string[] = [];
    if (!checkClientId()) {
        missingSettings.push('webRM.appClientId');
    }
    if (!checkAPIVersion()) {
        missingSettings.push('webRM.dynamicsAPIVersion');
    }

    if (missingSettings.length > 0) {
        return { status: "CRITICAL_SETTINGS_MISSING", missing: missingSettings };
    }

    // Check if a workspace or folder is open, as the extension operates on workspace files.
    const wsf = vscode.workspace?.workspaceFolders;
    if (!wsf || wsf.length < 1) {
        vscode.window.showErrorMessage(
            "You must be working inside a folder/workspace to use this extension."
        );
        return { status: "WORKSPACE_MISSING", missing: [] };
    }
    return { status: "ALL_CHECKS_PASSED", missing: [] };
}

function initializeStatusBar(): void {
    statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    statusBar.text = "Not Connected";
    statusBar.tooltip = "Dynamics 365 Web Resource Manager: Connection Status";
    statusBar.show();
}

function initializeFileStatusBar(): void {
    fileStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    fileStatusBar.text = "File: Not Synced";
    fileStatusBar.tooltip = "Shows Dynamics sync and publish status for the current file.";
    fileStatusBar.show();
}

function initializeSolutionStatusBar(): void {
    solutionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99.5);
    solutionStatusBar.text = "Solution: None";
    solutionStatusBar.tooltip = "Selected Dynamics solution for publishing web resources.";
    solutionStatusBar.show();
}

function updateSolutionStatusBar(solution?: Solution, workspaceFolder?: vscode.WorkspaceFolder): void {
    if (solution) {
        solutionStatusBar.text = `Solution: ${solution.getFriendlyName()}`;
        const folderSuffix = workspaceFolder ? ` — ${workspaceFolder.name}` : "";
        solutionStatusBar.tooltip = `Selected Dynamics solution: ${solution.getFriendlyName()} (${solution.solutionUniqueName})${folderSuffix}`;
    } else {
        solutionStatusBar.text = "Solution: None";
        solutionStatusBar.tooltip = "Select a Dynamics solution before publishing files that are not already linked.";
    }
    solutionStatusBar.show();
}

/**
 * Registers all tree data providers for the extension's custom views.
 * This includes explorers for Connections, Solutions, and Web Resources.
 *
 * @param {vscode.ExtensionContext} context The extension context provided by VS Code, used for subscriptions.
 * @param {ConnectionExplorer} connectionExplorer The instance of the ConnectionExplorer.
 * @param {SolutionExplorer} solutionExplorer The instance of the SolutionExplorer.
 * @param {WebResourceExplorer} webResourceExplorer The instance of the WebResourceExplorer.
 */
function registerTreeDataProviders(
    context: vscode.ExtensionContext,
    connectionExplorer: ConnectionExplorer,
    solutionExplorer: SolutionExplorer,
    webResourceExplorer: WebResourceExplorer
): void {
    const loadingTreeView = vscode.window.registerTreeDataProvider(
        "vscode-webrm-loading",
        new LoadingTreeDataProvider()
    );
    const connectionTreeView = vscode.window.registerTreeDataProvider(
        "vscode-connection-explorer",
        connectionExplorer
    );
    const solutionTreeView = vscode.window.createTreeView(
        "vscode-solution-explorer",
        { treeDataProvider: solutionExplorer }
    );
    const solutionSelectionListener = solutionTreeView.onDidChangeSelection(event => {
        solutionExplorer.setSelectedSolution(event.selection[0]);
    });
    const webResourceTreeView = vscode.window.registerTreeDataProvider(
        "vscode-webresource-explorer",
        webResourceExplorer
    );

    context.subscriptions.push(loadingTreeView, connectionTreeView, solutionTreeView, solutionSelectionListener, webResourceTreeView);
}

/**
 * Shows a webview form to configure extension settings.
 * @param context The extension context.
 * @param currentSettings An object containing the current values of the extension settings.
 * @returns A Promise that resolves to 'SAVED' if settings were saved, or 'CANCELLED' otherwise.
 */
async function showSettingsForm(
    context: vscode.ExtensionContext,
    currentSettings: { [key: string]: any }
): Promise<'SAVED' | 'CANCELLED'> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'webRMSettingsForm',
            'Web Resource Manager Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webviews')],
                retainContextWhenHidden: true
            }
        );

        const nonce = generateNonce();
        const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'webviews', 'settingsForm.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        htmlContent = htmlContent
            .replace(/\$\{webview.cspSource\}/g, panel.webview.cspSource)
            .replace(/\$\{nonce\}/g, nonce);
        panel.webview.html = htmlContent;

        panel.webview.postMessage({ command: 'loadSettings', settings: currentSettings });

        panel.onDidDispose(() => {
            resolve('CANCELLED');
        });

        const settingsToUpdate = [
            'appClientId', 'appTenantId',
            'dynamicsAPIVersion', 'solutionNameFilter', 'solutionSortAscending'
        ] as const;

        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message?.command) {
                    case 'save': {
                        const data = message.data;
                        if (typeof data !== 'object' || data === null) {
                            vscode.window.showErrorMessage('Received an invalid settings payload from the settings form.');
                            return;
                        }
                        const config = vscode.workspace.getConfiguration('webRM');
                        for (const key of settingsToUpdate) {
                            if (!Object.prototype.hasOwnProperty.call(data, key)) {
                                continue;
                            }
                            const value = (data as Record<string, unknown>)[key];
                            if (key === 'solutionSortAscending' && typeof value !== 'boolean') {
                                continue;
                            }
                            if (key !== 'solutionSortAscending' && typeof value !== 'string') {
                                continue;
                            }
                            try {
                                await config.update(key, value, vscode.ConfigurationTarget.Global);
                            } catch (error) {
                                console.error(`Failed to update setting ${key}:`, error);
                                vscode.window.showErrorMessage(`Failed to save setting: ${key}`);
                            }
                        }
                        vscode.window.showInformationMessage('Web Resource Manager settings saved.');
                        resolve('SAVED');
                        panel.dispose();
                        return;
                    }
                    case 'cancel':
                        resolve('CANCELLED');
                        panel.dispose();
                        return;
                }
            },
            undefined,
            context.subscriptions
        );
    });
}

/**
 * The main activation function for the extension.
 * This function is called by VS Code when the extension is activated.
 * Activation events are defined in `package.json` (e.g., on command execution, workspace load).
 *
 * @param {vscode.ExtensionContext} context The extension context provided by VS Code.
 *                                         This context is used to register commands, views, and other extension components,
 *                                         and to manage their lifecycle (e.g., subscriptions for disposables).
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    try {
        await vscode.commands.executeCommand("setContext", "wrm.viewsReady", false);
        await vscode.commands.executeCommand("setContext", "wrm.solutionLinked", false);
        await vscode.commands.executeCommand("setContext", "wrm.connected", false);

        initLogger(context);

        // Register providers first so the activity bar icon and tree views appear as soon as the extension is ready.
        initializeStatusBar();
        initializeFileStatusBar();
        initializeSolutionStatusBar();
        fileSyncStateService = new FileSyncStateService(fileStatusBar);

        const connectionExplorer = new ConnectionExplorer(context);
        const solutionExplorer = new SolutionExplorer(context, []);
        const webResourceExplorer = new WebResourceExplorer([]);
        const connectionStatusController = new ConnectionStatusController(statusBar);
        const selectedSolutionListener = solutionExplorer.onDidChangeSelectedSolution(solution => {
            updateSolutionStatusBar(solution, solutionExplorer.getBoundWorkspaceFolder());
            void vscode.commands.executeCommand("setContext", "wrm.solutionLinked", !!solution);
        });

        registerTreeDataProviders(context, connectionExplorer, solutionExplorer, webResourceExplorer);

        registerCommands(
            context,
            connectionExplorer,
            solutionExplorer,
            webResourceExplorer,
            connectionStatusController,
            fileSyncStateService
        );

        fileSyncStateService.registerListeners(context);

        context.subscriptions.push(statusBar, fileStatusBar, solutionStatusBar, selectedSolutionListener);
        await vscode.commands.executeCommand("setContext", "wrm.viewsReady", true);

        let initialCheckResult = performInitialChecks();

        if (initialCheckResult.status === "CRITICAL_SETTINGS_MISSING") {
            const missingSettingsStr = initialCheckResult.missing.join(', ');
            vscode.window.showWarningMessage(
                `Required Web Resource Manager settings are missing: ${missingSettingsStr}. Please configure them to proceed.`
            );

            // Prepare current settings to pass to the form
            const webRMConfig = vscode.workspace.getConfiguration('webRM');
            const currentSettings: { [key: string]: any } = {};
            const settingKeys = [
                'appClientId', 'appTenantId',
                'dynamicsAPIVersion', 'solutionNameFilter', 'solutionSortAscending'
            ];
            for (const key of settingKeys) {
                currentSettings[key] = webRMConfig.get(key);
            }

            const formResult = await showSettingsForm(context, currentSettings);

            if (formResult === 'SAVED') {
                // Re-check settings after user saves them
                initialCheckResult = performInitialChecks();
                if (initialCheckResult.status !== "ALL_CHECKS_PASSED") {
                    if (initialCheckResult.status === "CRITICAL_SETTINGS_MISSING") {
                        const stillMissing = initialCheckResult.missing.join(', ');
                        vscode.window.showErrorMessage(`Critical settings are still missing after configuration: ${stillMissing}. Configure them before connecting.`);
                    }
                    // WORKSPACE_MISSING message is handled by performInitialChecks
                    return;
                }
                // If checks now pass, fall through to normal activation
            } else { // CANCELLED
                vscode.window.showInformationMessage("Settings configuration was cancelled. Configure settings before connecting.");
                return;
            }
        } else if (initialCheckResult.status === "WORKSPACE_MISSING") {
            // Error message already shown by performInitialChecks
            return;
        }

    } catch (error: unknown) {
        await vscode.commands.executeCommand("setContext", "wrm.viewsReady", false);
        await vscode.commands.executeCommand("setContext", "wrm.solutionLinked", false);
        await vscode.commands.executeCommand("setContext", "wrm.connected", false);
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Error activating Web Resource Manager extension: ${message}`);
        console.error("Activation Error in Web Resource Manager:", error);
    }
}

/**
 * The deactivation function for the extension.
 * Disposes of status bars. Per-connection MSAL caches are intentionally left
 * in SecretStorage on ordinary deactivation, since silent re-login on the
 * next activation depends on them; secrets are only removed explicitly when
 * a connection is removed (see `wrm.removeConnection`).
 */
export async function deactivate(): Promise<void> {
    statusBar?.dispose();
    fileStatusBar?.dispose();
    solutionStatusBar?.dispose();
}
