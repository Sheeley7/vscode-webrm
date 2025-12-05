import * as vscode from "vscode";
import { ConnectionExplorer, Connection } from "./views/connectionExplorer";
import { SolutionExplorer, Solution } from "./views/solutionExplorer";
import { WebResourceExplorer, WebResource } from "./views/webResourceExplorer";
import { ConnectionStatusController } from "./connectionStatusController";
import { CrmWebAPI } from "./crmWebAPI";
import * as fs from "fs";
import * as path from "path";
import { ConfigurationService } from "./configurationService";
import { resetAllFileSyncState, setFileSyncState, computeFileHash } from "./extension";

/**
 * Prepares the local file system path for a web resource, creating necessary directories.
 * @param {string} webResourceName The full logical name of the web resource (e.g., "new_scripts/myfolder/myscript.js").
 * @returns {Promise<string | undefined>} The normalized local file path, or undefined if path preparation fails (e.g., no workspace).
 * @async
 */
async function prepareWebResourceFilePath(webResourceName: string): Promise<string | undefined> {
    // Ensure a workspace folder is open
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No workspace folder is open. Please open a folder to download web resources.");
        return undefined;
    }
    // Use the path of the first workspace folder as the root for saving web resources
    const rootPath = workspaceFolders[0].uri.fsPath;

    // Web resources in CRM use '/' as a path separator. Split to get individual parts.
    const filePathParts = webResourceName.split('/'); 
    const fileName = filePathParts.pop(); // The last part is the file name

    // Validate that a file name exists
    if (!fileName) {
        vscode.window.showErrorMessage(`Invalid web resource name (missing file name part): ${webResourceName}`);
        return undefined;
    }

    // Construct the target folder path using platform-specific separators
    const targetFolderPath = path.join(rootPath, ...filePathParts);

    try {
        // Create the target directory structure recursively.
        // This will create all necessary parent directories.
        // It does not throw an error if the directory already exists.
        await fs.promises.mkdir(targetFolderPath, { recursive: true });
    } catch (error: unknown) {
        // Handle potential errors during directory creation
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to create directory '${targetFolderPath}': ${message}`);
        return undefined; 
    }

    // Construct the full file path and normalize it
    const fullFilePath = path.join(targetFolderPath, fileName);
    return path.normalize(fullFilePath);
}

/**
 * Registers all commands for the extension.
 * Each command is wrapped in a try-catch block for robust error handling.
 *
 * @param {vscode.ExtensionContext} context The extension context provided by VS Code.
 * @param {ConnectionExplorer} connectionExplorer Instance of the ConnectionExplorer view.
 * @param {SolutionExplorer} solutionExplorer Instance of the SolutionExplorer view.
 * @param {WebResourceExplorer} webResourceExplorer Instance of the WebResourceExplorer view.
 * @param {ConnectionStatusController} connectionStatusController Instance of the ConnectionStatusController.
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    connectionExplorer: ConnectionExplorer,
    solutionExplorer: SolutionExplorer,
    webResourceExplorer: WebResourceExplorer,
    connectionStatusController: ConnectionStatusController
): void {
    /**
     * Command: Add a new Dynamics 365 connection.
     * Prompts the user for connection details and saves the new connection.
     */
    const wrmAddConnection = vscode.commands.registerCommand(
        "wrm.addConnection",
        async () => {
            // Determine the column to show the webview in
            const column = vscode.window.activeTextEditor
                ? vscode.window.activeTextEditor.viewColumn
                : undefined;

            // Create and show a new webview panel
            const panel = vscode.window.createWebviewPanel(
                'addCrmConnection', // Identifies the type of the webview. Used internally.
                'Add New CRM Connection', // Title of the panel displayed to the user.
                column || vscode.ViewColumn.One, // Editor column to show the new webview panel in.
                {
                    enableScripts: true, // Enable JavaScript in the webview.
                    // Restrict the webview to only loading content from our extension's directory.
                    // localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webviews')] 
                    // For a single HTML file with inline CSS/JS, context.extensionUri is a broad but acceptable root.
                    localResourceRoots: [context.extensionUri] 
                }
            );

            // Get the path to the HTML file on disk
            // Now webviews/ is at the root of the extension, not in src/
            const htmlFilePath = vscode.Uri.joinPath(context.extensionUri, 'webviews', 'newConnectionForm.html');
            
            try {
                // Read the HTML content from the file
                let htmlContent = fs.readFileSync(htmlFilePath.fsPath, 'utf8');
                
                // Replace placeholders for CSP source with the correct webview URI
                // This is crucial for Content Security Policy when loading resources in the webview.
                // Note: The placeholder ${webview.cspSource} was in the HTML; here we replace it.
                // However, a more robust way is to use `panel.webview.asWebviewUri` for *each* resource if they were separate files.
                // Since CSS and JS are inline in this HTML, the primary concern is script execution enabled by `enableScripts: true`
                // and the `Content-Security-Policy` meta tag in the HTML itself.
                // The provided HTML already contains: <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource};">
                // So, we need to replace ${webview.cspSource} with panel.webview.cspSource
                htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, panel.webview.cspSource);
                
                panel.webview.html = htmlContent;

                // Handle messages from the webview (form submission, cancellation)
                // This will be detailed in the next subtask.
                panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'saveConnection':
                                try {
                                    // Remove trailing slash from URL if present
                                    let url = message.data.url;
                                    if (url.endsWith("/") || url.endsWith("\\")) {
                                        url = url.slice(0, -1);
                                    }

                                    const addConnectionResult = await connectionExplorer.addItem(
                                        message.data.name,
                                        url
                                    );
                                    if (addConnectionResult) {
                                        panel.dispose(); // Close the webview panel on success
                                    } else {
                                        // Send error back to webview
                                        panel.webview.postMessage({ command: 'showError', text: 'Failed to add connection. A connection with this name might already exist or the details are invalid.' });
                                    }
                                } catch (error: unknown) {
                                    const errorMsg = error instanceof Error ? error.message : String(error);
                                    // Send error back to webview
                                    panel.webview.postMessage({ command: 'showError', text: `Failed to add connection: ${errorMsg}` });
                                }
                                return;
                            case 'cancelConnectionForm':
                                panel.dispose(); // Close the webview panel
                                return;
                        }
                    },
                    undefined,
                    context.subscriptions
                );

                // Handle panel disposal (e.g., when user closes it)
                panel.onDidDispose(
                    () => {
                        // Clean up resources or state if needed
                        console.log("Add Connection webview panel disposed.");
                    },
                    null,
                    context.subscriptions
                );

            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                console.error("Error setting up webview for Add Connection:", errorMsg);
                vscode.window.showErrorMessage(`Failed to open Add Connection form: ${errorMsg}`);
                panel.dispose(); // Clean up panel if HTML load or setup fails
                return; 
            }
        }
    );

    /**
     * Command: Remove an existing Dynamics 365 connection.
     * Removes the selected connection from the configuration.
     * @param {Connection} connection The connection item selected in the ConnectionExplorer view.
     */
    const wrmRemoveConnection = vscode.commands.registerCommand(
        "wrm.removeConnection",
        async (connection: Connection) => {
            try {
                if (!connection) {
                    vscode.window.showErrorMessage("No connection selected to remove. Please select a connection from the explorer.");
                    return;
                }
                await connectionExplorer.removeItem(connection);
                const currentCrmConnection = connectionStatusController.getCurrentConnection();
                // If the removed connection was the active one, update UI and disconnect
                if (
                    currentCrmConnection?.getConnectionId() === connection.getConnectionId()
                ) {
                    solutionExplorer.clearSolutions();
                    webResourceExplorer.clearWebResources();
                    connectionStatusController.disconnect();
                    resetAllFileSyncState();
                }
                vscode.window.showInformationMessage(`Connection '${connection.label}' removed successfully.`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to remove connection: ${message}`);
            }
        }
    );

    /**
     * Command: Connect to a Dynamics 365 environment.
     * Establishes a connection and fetches solutions.
     * @param {Connection} connection The connection item selected in the ConnectionExplorer view.
     */
    const wrmConnect = vscode.commands.registerCommand(
        "wrm.connect",
        async (connection: Connection) => {
            if (!connection) {
                vscode.window.showErrorMessage("No connection selected to connect. Please select a connection from the explorer.");
                return;
            }
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Connecting to '${connection.label}'...`,
                        cancellable: true, // Allow user to cancel the connection attempt
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            vscode.window.showInformationMessage("Connection process cancelled by user.");
                        });

                        if (token.isCancellationRequested) return;

                        connectionStatusController.setCurrentConnection(connection);
                        webResourceExplorer.clearWebResources(); // Clear web resources when connection changes
                        
                        progress.report({ increment: 20, message: "Authenticating..." });
                        await connectionStatusController.connect(); // Handles authentication
                        resetAllFileSyncState();

                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 50, message: "Getting Solutions..." });

                        // Fetch raw solutions data from CRM
                        const rawSolutions = await CrmWebAPI.getSolutions(connection);

                        if (token.isCancellationRequested) return;

                        // Get favorite solutions from global state
                        const favoriteSolutions = context.globalState.get<Record<string, boolean>>(
                            "favoriteSolutions",
                            {} 
                        );

                        // Map RawSolution[] to Solution[], incorporating favorite status
                        const solutionViewModels = rawSolutions.map(rawSol => 
                            new Solution(
                                rawSol, 
                                favoriteSolutions[rawSol.solutionid] === true,
                                solutionExplorer // Pass SolutionExplorer instance
                            )
                        );
                        
                        if (token.isCancellationRequested) return;
                        // Update solution explorer view
                        solutionExplorer.setSolutions(solutionViewModels);
                        // solutionExplorer.refresh(); // setSolutions now calls refresh
                        progress.report({ increment: 100, message: `Successfully connected to '${connection.label}'.`});
                    }
                );
            } catch (error: unknown) { 
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to connect to '${connection.label}': ${message}`);
                connectionStatusController.disconnect(); // Ensure disconnected state on failure
            }
        }
    );

    /**
     * Command: Get web resources for a selected solution.
     * Fetches and displays web resources in the WebResourceExplorer view.
     * @param {Solution} solution The solution item selected in the SolutionExplorer view.
     */
    const wrmGetWebResources = vscode.commands.registerCommand(
        "wrm.getWebResources",
        async (solution: Solution) => {
            if (!solution || !solution.solutionId) { // Check for solution and its ID
                vscode.window.showErrorMessage("No solution selected or invalid solution. Please select a solution from the explorer.");
                return;
            }
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Getting Web Resources for '${solution.label}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            vscode.window.showInformationMessage("Getting web resources cancelled by user.");
                        });

                        if (token.isCancellationRequested) return;

                        const currentCrmConnection = connectionStatusController.getCurrentConnection();
                        if (!currentCrmConnection) {
                            vscode.window.showErrorMessage("No active connection. Please connect first to get web resources.");
                            return;
                        }
                        
                        progress.report({ increment: 30, message: "Fetching from CRM..." });
                        const webResources = await CrmWebAPI.getWebResources(
                            currentCrmConnection,
                            solution
                        );

                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 70, message: "Populating explorer..." });
                        // Update web resource explorer view
                        webResourceExplorer.setWebResources(webResources);
                        webResourceExplorer.refresh();
                        progress.report({ increment: 100, message: `Web resources for '${solution.label}' loaded.`});
                    }
                );
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to get web resources for '${solution.label}': ${message}`);
            }
        }
    );

    /**
     * Command: Add a solution to favorites.
     * Marks the selected solution as a favorite.
     * @param {Solution} solution The solution item selected in the SolutionExplorer view.
     */
    const wrmAddFavoriteSolution = vscode.commands.registerCommand(
        "wrm.addFavoriteSolution",
        async (solution: Solution) => {
            if (!solution || !solution.solutionId) {
                vscode.window.showErrorMessage("No solution selected to add to favorites.");
                return;
            }
            try {
                await solution.setFavorite(); // No longer needs context, calls SolutionExplorer method
                // solutionExplorer.refresh(); // Refresh is now handled by setFavorite potentially through SolutionExplorer
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    `Error adding solution '${solution.getFriendlyName()}' to favorites: ${message}`
                );
            }
        }
    );

    /**
     * Command: Remove a solution from favorites.
     * Unmarks the selected solution as a favorite.
     * @param {Solution} solution The solution item selected in the SolutionExplorer view.
     */
    const wrmRemoveFavoriteSolution = vscode.commands.registerCommand(
        "wrm.removeFavoriteSolution",
        async (solution: Solution) => {
            if (!solution || !solution.solutionId) {
                vscode.window.showErrorMessage("No solution selected to remove from favorites.");
                return;
            }
            try {
                await solution.removeFavorite(); // No longer needs context
                // solutionExplorer.refresh(); // Refresh is now handled by removeFavorite potentially through SolutionExplorer
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    `Error removing solution '${solution.getFriendlyName()}' from favorites: ${message}`
                );
            }
        }
    );

    /**
     * Command: Open a web resource.
     * Downloads the content of the selected web resource and opens it in a new editor tab.
     * @param {WebResource} webResource The web resource item selected in the WebResourceExplorer view.
     */
    const wrmOpenWebResource = vscode.commands.registerCommand(
        "wrm.openWebResource",
        async (webResource: WebResource) => {
            if (!webResource || !webResource.webResourceName || webResource.type === 'folder') {
                vscode.window.showErrorMessage("Invalid web resource selected. Please select a file node.");
                return;
            }
            try {
                const fullFilePath = await prepareWebResourceFilePath(webResource.webResourceName);
                if (!fullFilePath) { 
                    // Error message already shown in prepareWebResourceFilePath
                    return; 
                }

                const currentCrmConnection = connectionStatusController.getCurrentConnection();
                if (!currentCrmConnection) {
                    vscode.window.showErrorMessage("No active connection. Please connect first to open web resources.");
                    return;
                }

                // Always fetch web resource content from CRM for comparison
                const webResourceDetails = await CrmWebAPI.getWebResourceDetails(currentCrmConnection, webResource);
                if (webResourceDetails.content === undefined) {
                    vscode.window.showErrorMessage(`Failed to retrieve content for web resource: ${webResource.webResourceName}`);
                    return;
                }

                const currentUser = currentCrmConnection.getConnectionUserName();

                let localContentBase64 = '';
                try {
                    const localContent = await fs.promises.readFile(fullFilePath);
                    localContentBase64 = localContent.toString('base64');
                } catch (error: any) {
                    if (error.code !== 'ENOENT') {
                        // ENOENT is fine, means the file doesn't exist locally yet.
                        // Other errors should be logged.
                        console.error(`Error reading local file: ${error.message}`);
                    }
                }

                const isContentDifferent = localContentBase64 !== webResourceDetails.content;

                // Always show the warning if conditions are met
                if (currentUser && webResourceDetails.modifiedby.fullname !== currentUser && isContentDifferent) {
                    vscode.window.showWarningMessage(`The file on the server was last modified by "${webResourceDetails.modifiedby.fullname}" on "${new Date(webResourceDetails.modifiedon).toLocaleString()}". Please verify that two developers aren't working on the same file.`, { modal: true });
                }

                const pullLatest = ConfigurationService.getPullLatestVersionFromServer();
                if (pullLatest) {
                    // Only write content to the local file if the setting is enabled
                    await fs.promises.writeFile(
                        fullFilePath,
                        webResourceDetails.content,
                        { encoding: "base64" } // Assuming content is base64 encoded
                    );
                } else {
                    // If not pulling latest, check if the file exists locally
                    try {
                        await fs.promises.access(fullFilePath);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Local file not found for '${webResource.webResourceName}'. Enable "Pull Latest Version from CRM Server" to download it.`, { modal: true });
                        return; // Stop execution
                    }
                }
                
                // Open the local file in VS Code editor
                const doc = await vscode.workspace.openTextDocument(fullFilePath);
                await vscode.window.showTextDocument(doc);

                // Track the synced web resource for publishing
                connectionStatusController.addSyncedWebResource(
                    fullFilePath,
                    webResource.webResourceId
                );

                // --- Add file sync status bar update ---
                // Set the file as synced (published = true by default on open)
                try {
                    const ext = require('./extension');
                    if (ext && typeof ext.setFileSyncState === 'function' && typeof ext.computeFileHash === 'function') {
                        // Read file content as text (after writing base64 decoded content)
                        const fileContent = await fs.promises.readFile(fullFilePath, 'utf8');
                        const hash = ext.computeFileHash(fileContent);
                        ext.setFileSyncState(fullFilePath, webResource.webResourceId, pullLatest, hash);
                    }
                } catch (e) {
                    // fallback: do nothing if import fails
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to open web resource '${webResource.webResourceName}': ${message}`);
            }
        }
    );

    /**
     * Command: Publish the active web resource.
     * Publishes changes from the active editor to Dynamics 365.
     */
    const wrmPublishWebResource = vscode.commands.registerCommand(
        "wrm.publishWebResource",
        async () => {
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    vscode.window.showInformationMessage("No active editor. Please open a web resource file to publish.");
                    return;
                }
                const document = activeEditor.document;
                const fileName = document.fileName; // Full local path of the active file
                const baseName = path.basename(fileName); // File name part for messages

                // Prompt to save if dirty
                if (document.isDirty) {
                    const saveChoice = await vscode.window.showWarningMessage(
                        `'${baseName}' has unsaved changes. Save before publishing?`,
                        { modal: true },
                        "Save and Publish", "Cancel"
                    );
                    if (saveChoice === "Save and Publish") {
                        await document.save();
                    } else {
                        vscode.window.showInformationMessage("Publish cancelled by user.");
                        return;
                    }
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Publishing '${baseName}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            vscode.window.showInformationMessage("Publish operation cancelled by user.");
                        });
                        if (token.isCancellationRequested) return;

                        const connection = connectionStatusController.getCurrentConnection();
                        if (!connection) {
                            vscode.window.showErrorMessage(
                                "No active connection. Please connect to an environment before attempting to publish."
                            );
                            return;
                        }
                        
                        progress.report({ increment: 10, message: "Verifying connection..." });
                        await connection.connect(); // Ensure connection is active and token is valid

                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 30, message: `Reading file ${baseName}...` });

                        const currentPath = path.normalize(fileName);
                        // Retrieve the CRM web resource ID linked to this local file path
                        const webResourceId = connectionStatusController.getResourceIdFromPath(currentPath);

                        if (typeof webResourceId === "undefined") {
                            vscode.window.showErrorMessage(
                                `'${baseName}' is not linked to a Dynamics record. Please 'Open' the web resource from the explorer first to establish the link.`
                            );
                            return;
                        }
                        
                        const data = await fs.promises.readFile(currentPath);
                        if (token.isCancellationRequested) return;

                        progress.report({ increment: 60, message: `Publishing to CRM...` });
                        const base64 = data.toString("base64"); // Convert file content to base64
                        await CrmWebAPI.publishWebResource(
                            connection,
                            webResourceId,
                            base64
                        );
                        progress.report({ increment: 100, message: `Successfully published '${baseName}'.`});

                        // Update the status bar to 'Published' and update hash
                        const fileContent = await fs.promises.readFile(fileName, 'utf8');
                        const hash = computeFileHash(fileContent);
                        setFileSyncState(fileName, webResourceId, true, hash);
                    }
                );
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to publish web resource: ${message}`);
            }
        }
    );

    /**
     * Command: Filter solutions by name.
     * Updates the solution name filter and refreshes the SolutionExplorer view.
     */
    const wrmFilterSolutions = vscode.commands.registerCommand(
        "wrm.filterSolutions",
        async () => {
            const currentFilter = ConfigurationService.getSolutionNameFilter() || "";
            const newFilter = await vscode.window.showInputBox({
                prompt: "Enter a filter string for solutions (case-insensitive)",
                value: currentFilter,
                placeHolder: "e.g. MySolution, Contoso, etc.",
                ignoreFocusOut: true
            });

            if (typeof newFilter === 'string') {
                await ConfigurationService.updateSetting(
                    "solutionNameFilter",
                    newFilter,
                    vscode.ConfigurationTarget.Workspace
                );

                const currentCrmConnection = connectionStatusController.getCurrentConnection();
                if (!currentCrmConnection) {
                    vscode.window.showErrorMessage("No active connection. Please connect to an environment to apply the filter.");
                    return;
                }

                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: "Applying filter and refreshing solutions...",
                            cancellable: false
                        },
                        async (progress) => {
                            progress.report({ increment: 20, message: "Connecting..." });
                            await currentCrmConnection.connect(); // Ensure token is valid

                            progress.report({ increment: 50, message: "Fetching filtered solutions..." });
                            const rawSolutions = await CrmWebAPI.getSolutions(currentCrmConnection);
                            
                            progress.report({ increment: 80, message: "Updating view..." });
                            solutionExplorer.setSolutionsFromRaw(rawSolutions); // This will also call refresh
                            
                            progress.report({ increment: 100, message: "Filter applied." });
                        }
                    );
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Error applying filter: ${message}`);
                }
            }
        }
    );

    const wrmToggleSolutionSortOrder = vscode.commands.registerCommand(
        "wrm.toggleSolutionSortOrder",
        async () => {
            try {
                const currentSortAscending = ConfigurationService.getSolutionSortAscending();
                const newSortAscending = !currentSortAscending;
                await ConfigurationService.updateSetting(
                    "solutionSortAscending", 
                    newSortAscending, 
                    vscode.ConfigurationTarget.Workspace
                );
                // The SolutionExplorer.getChildren method already reads this setting, 
                // so we just need to refresh the view.
                solutionExplorer.refresh(); 
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error toggling solution sort order: ${message}`);
            }
        }
    );

    const wrmCopyConnectionUrl = vscode.commands.registerCommand(
        "wrm.copyConnectionUrl",
        async (connection: Connection) => {
            if (!connection) {
                return;
            }
            const url = connection.getConnectionURL();
            await vscode.env.clipboard.writeText(url);
        }
    );

    // Add all registered commands to the extension's subscriptions for proper disposal on deactivation
    context.subscriptions.push(
        wrmAddConnection,
        wrmRemoveConnection,
        wrmConnect,
        wrmGetWebResources,
        wrmAddFavoriteSolution,
        wrmRemoveFavoriteSolution,
        wrmOpenWebResource,
        wrmPublishWebResource,
        wrmFilterSolutions,
        wrmToggleSolutionSortOrder,
        wrmCopyConnectionUrl
    );
}
