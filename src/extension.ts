import * as vscode from "vscode";
import { ConnectionExplorer } from "./views/connectionExplorer";
import { SolutionExplorer } from "./views/solutionExplorer";
import { WebResourceExplorer } from "./views/webResourceExplorer";
import { ConnectionStatusController } from "./connectionStatusController";
import { registerCommands } from "./commandHandlers";
import { checkClientId, checkConfigFolder, checkAPIVersion } from "./utils/configUtils";
import * as fs from 'fs';
import * as path from 'path';

/**
 * The status bar item instance used by the extension.
 * Exported for potential external use if needed, but primarily managed internally.
 * @type {vscode.StatusBarItem}
 */
let statusBar: vscode.StatusBarItem; 

/**
 * Performs initial configuration and workspace checks essential for the extension's operation.
 * This includes verifying required settings (Client ID, API Version, Config Folder) and ensuring a workspace is open.
 *
 * @returns {string} Returns a string code indicating the outcome: 
 *                   "CRITICAL_SETTINGS_MISSING", "WORKSPACE_MISSING", or "ALL_CHECKS_PASSED".
 */
function performInitialChecks(): string {
    // Check for mandatory configuration settings.
    if (!checkClientId() || !checkAPIVersion() || !checkConfigFolder()) {
        // Note: The individual check functions no longer show error messages.
        // Error messages related to critical settings will be handled by the caller if needed.
        return "CRITICAL_SETTINGS_MISSING";
    }

    // Check if a workspace or folder is open, as the extension operates on workspace files.
    const wsf = vscode.workspace?.workspaceFolders;
    if (!wsf || wsf.length < 1) {
        vscode.window.showErrorMessage(
            "You must be working inside a folder/workspace to use this extension."
        );
        return "WORKSPACE_MISSING";
    }
    return "ALL_CHECKS_PASSED";
}

/**
 * Initializes the Visual Studio Code status bar item for the extension.
 * The status bar item displays the current connection status.
 */
function initializeStatusBar(): void {
    // Create the status bar item, aligned to the left, with a default priority.
    statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100 // A common priority for status bar items.
    );
    statusBar.text = "Not Connected"; // Initial text.
    statusBar.tooltip = "Dynamics 365 Web Resource Manager: Connection Status";
    // Command to be executed when the status bar item is clicked (optional).
    // statusBar.command = "wrm.showConnectionManager"; // Example: if you add a command to manage connections.
    statusBar.show(); // Make the status bar item visible.
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
    // Register the ConnectionExplorer for the 'vscode-connection-explorer' view.
    const connectionTreeView = vscode.window.registerTreeDataProvider(
        "vscode-connection-explorer", // Matches the view ID in package.json
        connectionExplorer
    );
    // Register the SolutionExplorer for the 'vscode-solution-explorer' view.
    const solutionTreeView = vscode.window.registerTreeDataProvider(
        "vscode-solution-explorer", // Matches the view ID in package.json
        solutionExplorer
    );
    // Register the WebResourceExplorer for the 'vscode-webresource-explorer' view.
    const webResourceTreeView = vscode.window.registerTreeDataProvider(
        "vscode-webresource-explorer", // Matches the view ID in package.json
        webResourceExplorer
    );

    // Add the tree view registrations to the extension's subscriptions
    // to ensure they are disposed of when the extension is deactivated.
    context.subscriptions.push(connectionTreeView, solutionTreeView, webResourceTreeView);
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
            'webRMSettingsForm', // Identifies the type of the webview.
            'Web Resource Manager Settings', // Title of the panel.
            vscode.ViewColumn.One, // Editor column to show the new webview panel in.
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webviews')],
                retainContextWhenHidden: true // Keep state when tab is not visible
            }
        );

        const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webviews', 'settingsForm.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, panel.webview.cspSource);
        panel.webview.html = htmlContent;

        // Send current settings to the webview to pre-fill the form
        panel.webview.postMessage({ command: 'loadSettings', settings: currentSettings });

        panel.onDidDispose(() => {
            resolve('CANCELLED'); // Resolve as cancelled if panel is closed by user
        });

        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'save':
                        const settingsToUpdate = [
                            'appClientId', 'appTenantId', 'connectionInfoFolder',
                            'dynamicsAPIVersion', 'solutionNameFilter', 'solutionSortAscending'
                        ];
                        const config = vscode.workspace.getConfiguration('webRM');
                        for (const key of settingsToUpdate) {
                            if (message.data.hasOwnProperty(key)) {
                                try {
                                    await config.update(key, message.data[key], vscode.ConfigurationTarget.Global);
                                } catch (error) {
                                    console.error(`Failed to update setting ${key}:`, error);
                                    vscode.window.showErrorMessage(`Failed to save setting: ${key}`);
                                    // Potentially resolve('CANCELLED') or let user try again? For now, continue saving others.
                                }
                            }
                        }
                        vscode.window.showInformationMessage('Web Resource Manager settings saved.');
                        resolve('SAVED');
                        panel.dispose();
                        return;
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
        let initialCheckResult = performInitialChecks();

        if (initialCheckResult === "CRITICAL_SETTINGS_MISSING") {
            vscode.window.showWarningMessage(
                "Required Web Resource Manager settings are missing. Please configure them to proceed."
            );
            
            // Prepare current settings to pass to the form
            const webRMConfig = vscode.workspace.getConfiguration('webRM');
            const currentSettings: { [key: string]: any } = {};
            const settingKeys = [
                'appClientId', 'appTenantId', 'connectionInfoFolder',
                'dynamicsAPIVersion', 'solutionNameFilter', 'solutionSortAscending'
            ];
            for (const key of settingKeys) {
                currentSettings[key] = webRMConfig.get(key);
            }

            const formResult = await showSettingsForm(context, currentSettings);

            if (formResult === 'SAVED') {
                // Re-check settings after user saves them
                initialCheckResult = performInitialChecks();
                if (initialCheckResult !== "ALL_CHECKS_PASSED") {
                    if (initialCheckResult === "CRITICAL_SETTINGS_MISSING") {
                         vscode.window.showErrorMessage("Critical settings are still missing after configuration. Extension will not activate.");
                    }
                    // WORKSPACE_MISSING message is handled by performInitialChecks
                    return; // Halt activation
                }
                // If checks now pass, fall through to normal activation
            } else { // CANCELLED
                vscode.window.showInformationMessage("Settings configuration was cancelled. Extension will not activate.");
                return; // Halt activation
            }
        } else if (initialCheckResult === "WORKSPACE_MISSING") {
            // Error message already shown by performInitialChecks
            return; // Halt activation
        }
        // If initialCheckResult is "ALL_CHECKS_PASSED", proceed with normal activation.

        // Setup UI elements like the status bar.
        initializeStatusBar();

        // Initialize core components:
        const connectionExplorer = new ConnectionExplorer(context);
        const solutionExplorer = new SolutionExplorer(context, []);
        const webResourceExplorer = new WebResourceExplorer([]);
        const connectionStatusController = new ConnectionStatusController(statusBar);
        
        registerTreeDataProviders(context, connectionExplorer, solutionExplorer, webResourceExplorer);

        registerCommands(
            context,
            connectionExplorer,
            solutionExplorer,
            webResourceExplorer,
            connectionStatusController
        );
        
        context.subscriptions.push(statusBar);

        // No general "extension active" message as per previous user request

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Error activating Web Resource Manager extension: ${message}`);
        // Log the full error to the console for more detailed debugging.
        console.error("Activation Error in Web Resource Manager:", error);
    }
}

/**
 * The deactivation function for the extension.
 * This function is called by VS Code when the extension is deactivated
 * (e.g., when VS Code is closed or the extension is disabled/uninstalled).
 * It's used to clean up resources, such as disposables like event listeners, status bar items, etc.
 */
export function deactivate(): void {
    // Dispose of the status bar item if it was created.
    if (statusBar) {
        statusBar.dispose();
    }
    // Other deactivation logic, such as cleaning up temporary files or states, can go here.
    // Subscriptions added to context.subscriptions in activate() are automatically disposed of by VS Code.
    vscode.window.showInformationMessage("Web Resource Manager for Dynamics 365 has been deactivated.");
}
