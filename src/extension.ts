import * as vscode from "vscode";
import { ConnectionExplorer } from "./views/connectionExplorer";
import { SolutionExplorer } from "./views/solutionExplorer";
import { WebResourceExplorer } from "./views/webResourceExplorer";
import { ConnectionStatusController } from "./connectionStatusController";
import { registerCommands } from "./commandHandlers";
import { checkClientId, checkConfigFolder, checkAPIVersion } from "./utils/configUtils";

/**
 * The status bar item instance used by the extension.
 * Exported for potential external use if needed, but primarily managed internally.
 * @type {vscode.StatusBarItem}
 */
let statusBar: vscode.StatusBarItem; 

/**
 * Performs initial configuration and workspace checks essential for the extension's operation.
 * This includes verifying required settings (Client ID, API Version, Config Folder) and ensuring a workspace is open.
 * Displays error messages to the user if checks fail.
 *
 * @returns {boolean} Returns `true` if all checks pass, `false` otherwise, indicating activation should halt.
 */
function performInitialChecks(): boolean {
    // Check for mandatory configuration settings.
    if (!checkClientId() || !checkAPIVersion() || !checkConfigFolder()) {
        return false; // Error messages are shown by the check functions.
    }

    // Check if a workspace or folder is open, as the extension operates on workspace files.
    const wsf = vscode.workspace?.workspaceFolders;
    if (!wsf || wsf.length < 1) {
        vscode.window.showErrorMessage(
            "You must be working inside a folder/workspace to use this extension."
        );
        return false;
    }
    return true;
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
 * The main activation function for the extension.
 * This function is called by VS Code when the extension is activated.
 * Activation events are defined in `package.json` (e.g., on command execution, workspace load).
 *
 * @param {vscode.ExtensionContext} context The extension context provided by VS Code.
 *                                         This context is used to register commands, views, and other extension components,
 *                                         and to manage their lifecycle (e.g., subscriptions for disposables).
 */
export function activate(context: vscode.ExtensionContext): void {
    try {
        // Perform critical startup checks. If these fail, halt further activation.
        if (!performInitialChecks()) {
            return; 
        }

        // Setup UI elements like the status bar.
        initializeStatusBar();

        // Initialize core components:
        // - View providers for custom tree views.
        // - Controllers for managing state (e.g., connection status).
        const connectionExplorer = new ConnectionExplorer(context);
        const solutionExplorer = new SolutionExplorer([]); // Initialized with an empty array of solutions.
        const webResourceExplorer = new WebResourceExplorer([]); // Initialized with an empty array of web resources.
        const connectionStatusController = new ConnectionStatusController(statusBar);
        
        // Register the tree data providers with VS Code.
        registerTreeDataProviders(context, connectionExplorer, solutionExplorer, webResourceExplorer);

        // Register all extension commands (defined in commandHandlers.ts).
        // This populates context.subscriptions with the registered command disposables.
        registerCommands(
            context,
            connectionExplorer,
            solutionExplorer,
            webResourceExplorer,
            connectionStatusController
        );
        
        // Add the status bar item to subscriptions to ensure it's disposed upon deactivation.
        context.subscriptions.push(statusBar);

        // Notify the user that the extension is active.
        vscode.window.showInformationMessage("Web Resource Manager for Dynamics 365 is now active.");

    } catch (error: unknown) {
        // Catch any unexpected errors during activation.
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
