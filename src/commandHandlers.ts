import * as vscode from "vscode";
import { ConnectionExplorer, Connection } from "./views/connectionExplorer";
import { SolutionExplorer, Solution } from "./views/solutionExplorer";
import { WebResourceExplorer, WebResource } from "./views/webResourceExplorer";
import { ConnectionStatusController } from "./connectionStatusController";
import { CrmWebAPI, ConcurrencyConflictError } from "./crmWebAPI";
import * as fs from "fs";
import * as path from "path";
import { ConfigurationService } from "./configurationService";
import { FileSyncStateService } from "./state/fileSyncStateService";
import { generateNonce } from "./utils/nonce";
import { logError } from "./utils/logger";
import {
    resolveWebResourcePath,
    resolveWebResourceRootDir,
    toWebResourceName,
    UnsafeWebResourceNameError,
    UnsafeWebResourceRootError,
} from "./workspace/workspaceMapper";

/**
 * Prompts the user to choose a workspace folder when more than one is open,
 * auto-selects the only folder otherwise. Used so a linked solution is bound
 * to one specific folder instead of implicitly assuming `workspaceFolders[0]`.
 */
async function chooseWorkspaceFolderForSolution(solutionName: string): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("No workspace folder is open. Please open a folder before linking a solution.");
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    const picked = await vscode.window.showQuickPick(
        folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        { placeHolder: `Choose the workspace folder to use for solution '${solutionName}'`, ignoreFocusOut: true }
    );
    return picked?.folder;
}

/** Returns the workspace folder bound to the linked solution, resolving/binding one if needed. */
async function resolveBoundWorkspaceFolder(
    solutionExplorer: SolutionExplorer,
    solutionName: string
): Promise<vscode.WorkspaceFolder | undefined> {
    const bound = solutionExplorer.getBoundWorkspaceFolder();
    if (bound) {
        return bound;
    }
    const chosen = await chooseWorkspaceFolderForSolution(solutionName);
    if (chosen) {
        solutionExplorer.setBoundWorkspaceFolder(chosen);
    }
    return chosen;
}

/** Bound folder if a solution is linked, otherwise the sole/first open workspace folder. */
function getBoundOrSingleWorkspaceFolder(solutionExplorer: SolutionExplorer): vscode.WorkspaceFolder | undefined {
    return solutionExplorer.getBoundWorkspaceFolder() ?? vscode.workspace.workspaceFolders?.[0];
}

/**
 * Resolves the configured web resource root for `workspaceFolder` to an absolute
 * directory, without prompting. Falls back to the workspace folder root when the
 * setting is blank or invalid. Used where prompting is inappropriate (e.g. when
 * probing several folders to reverse-map a file to a logical name).
 */
function getConfiguredWebResourceRootDir(workspaceFolder: vscode.WorkspaceFolder): string {
    const configured = ConfigurationService.getWebResourceRootPath(workspaceFolder.uri);
    try {
        return resolveWebResourceRootDir(workspaceFolder.uri.fsPath, configured);
    } catch {
        return path.normalize(workspaceFolder.uri.fsPath);
    }
}

/**
 * Prompts for the web resource root folder (relative to `workspaceFolder`) and
 * persists it. Returns the entered value, or undefined if the user cancels.
 */
async function promptForWebResourceRootPath(workspaceFolder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: "Web Resource Root Folder",
        prompt: `Relative folder within '${workspaceFolder.name}' where web resources live. Use '.' for the workspace root.`,
        placeHolder: "e.g. webresources",
        value: "webresources",
        ignoreFocusOut: true,
        validateInput: value => {
            if (value.trim() === "") {
                return "Enter a relative folder, or '.' for the workspace root.";
            }
            try {
                resolveWebResourceRootDir(workspaceFolder.uri.fsPath, value);
                return undefined;
            } catch (error) {
                return error instanceof UnsafeWebResourceRootError ? error.message : String(error);
            }
        },
    });

    if (input === undefined) {
        return undefined;
    }
    const value = input.trim();
    await ConfigurationService.updateWebResourceRootPath(value, workspaceFolder.uri);
    return value;
}

/**
 * Returns the absolute directory web resource logical names are anchored to for
 * `workspaceFolder`: the folder joined with the configured relative root path.
 * Prompts for (and saves) the root path the first time it is needed. Returns
 * undefined if the user dismisses the prompt or the stored value is invalid.
 */
async function getWebResourceRootDir(workspaceFolder: vscode.WorkspaceFolder): Promise<string | undefined> {
    let rootPath = ConfigurationService.getWebResourceRootPath(workspaceFolder.uri);
    if (rootPath.trim() === "") {
        const entered = await promptForWebResourceRootPath(workspaceFolder);
        if (entered === undefined) {
            vscode.window.showInformationMessage(
                "A web resource root folder is required before reading or writing web resources."
            );
            return undefined;
        }
        rootPath = entered;
    }

    try {
        return resolveWebResourceRootDir(workspaceFolder.uri.fsPath, rootPath);
    } catch (error: unknown) {
        const message = error instanceof UnsafeWebResourceRootError ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Invalid web resource root folder '${rootPath}': ${message} Update the 'webRM.webResourceRootPath' setting.`
        );
        return undefined;
    }
}

/**
 * Resolves a web resource's logical name to a local path under `rootDir`,
 * creating parent directories. Rejects names that would escape the root.
 */
async function prepareWebResourceFilePath(
    webResourceName: string,
    rootDir: string
): Promise<string | undefined> {
    let fullFilePath: string;
    try {
        fullFilePath = resolveWebResourcePath(rootDir, webResourceName);
    } catch (error: unknown) {
        const message = error instanceof UnsafeWebResourceNameError ? error.message : String(error);
        vscode.window.showErrorMessage(`Cannot map web resource '${webResourceName}' to a local path: ${message}`);
        return undefined;
    }

    try {
        await fs.promises.mkdir(path.dirname(fullFilePath), { recursive: true });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to create directory for '${webResourceName}': ${message}`);
        return undefined;
    }

    return fullFilePath;
}

function getLocalFilePathForWebResourceName(
    webResourceName: string,
    rootDir: string
): string | undefined {
    try {
        return resolveWebResourcePath(rootDir, webResourceName);
    } catch (error: unknown) {
        logError("workspaceMapper.resolveWebResourcePath", error);
        return undefined;
    }
}

async function getWebResourceNameFromDocument(
    document: vscode.TextDocument
): Promise<{ filePath: string; webResourceName?: string }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let rawFilePath = document.uri.fsPath || document.fileName;
    if (workspaceFolders?.length === 1 && rawFilePath && !path.isAbsolute(rawFilePath)) {
        rawFilePath = path.join(workspaceFolders[0].uri.fsPath, rawFilePath);
    }
    const filePath = path.normalize(rawFilePath);

    if (!workspaceFolders || workspaceFolders.length === 0 || document.uri.scheme !== "file") {
        return { filePath };
    }

    const directFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (directFolder) {
        const rootDir = await getWebResourceRootDir(directFolder);
        if (rootDir === undefined) {
            return { filePath };
        }
        return { filePath, webResourceName: toWebResourceName(rootDir, filePath) };
    }

    // File isn't inside any workspace folder's tree via getWorkspaceFolder: probe each
    // folder's configured root without prompting, and take the closest logical name.
    const candidates = workspaceFolders
        .map(folder => toWebResourceName(getConfiguredWebResourceRootDir(folder), filePath))
        .filter((name): name is string => !!name)
        .sort((a, b) => a.length - b.length);

    return { filePath, webResourceName: candidates[0] };
}

async function readFileBase64IfExists(filePath: string): Promise<string | undefined> {
    try {
        const content = await fs.promises.readFile(filePath);
        return content.toString("base64");
    } catch (error: any) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

function resolveSolutionArgument(solutionArg: unknown, solutionExplorer: SolutionExplorer): Solution | undefined {
    if (
        solutionArg instanceof Solution ||
        (
            typeof solutionArg === "object" &&
            solutionArg !== null &&
            "solutionId" in solutionArg &&
            typeof (solutionArg as { solutionId?: unknown }).solutionId === "string"
        )
    ) {
        return solutionArg as Solution;
    }

    return solutionExplorer.getSelectedSolution();
}

/**
 * Fetches the server's current copy of a web resource before publishing, both to warn when
 * another user last changed it and to capture the `@odata.etag` used as `If-Match` so a
 * concurrent server-side change since the read is rejected (412) instead of silently overwritten.
 */
async function checkServerStateBeforePublish(
    connection: Connection,
    webResourceName: string,
    webResourceId: string,
    localPath: string
): Promise<{ shouldContinue: boolean; etag?: string }> {
    const webResource = new WebResource(
        webResourceName,
        webResourceId,
        path.basename(webResourceName),
        localPath,
        "",
        "file"
    );
    const serverDetails = await CrmWebAPI.getWebResourceDetails(connection, webResource);
    const etag = serverDetails["@odata.etag"];

    const currentUser = connection.getConnectionUserName();
    const lastModifiedBy = serverDetails.modifiedby?.fullname;
    if (!currentUser || !lastModifiedBy || lastModifiedBy === currentUser) {
        return { shouldContinue: true, etag };
    }

    const lastModifiedOn = new Date(serverDetails.modifiedon).toLocaleString();
    const continueChoice = await vscode.window.showWarningMessage(
        `The server version of '${webResourceName}' was last changed by ${lastModifiedBy} on ${lastModifiedOn}. You are signed in as ${currentUser}. Publishing will overwrite the server version.`,
        { modal: true },
        "Continue Publish"
    );

    return { shouldContinue: continueChoice === "Continue Publish", etag };
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
 * @param {FileSyncStateService} fileSyncStateService Owns file publish/sync state and the file status bar.
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    connectionExplorer: ConnectionExplorer,
    solutionExplorer: SolutionExplorer,
    webResourceExplorer: WebResourceExplorer,
    connectionStatusController: ConnectionStatusController,
    fileSyncStateService: FileSyncStateService
): void {
    /**
     * Command: Add a new Dynamics 365 connection.
     * Prompts the user for connection details and saves the new connection.
     */
    const wrmAddConnection = vscode.commands.registerCommand(
        "wrm.addConnection",
        async () => {
            const column = vscode.window.activeTextEditor
                ? vscode.window.activeTextEditor.viewColumn
                : undefined;

            const panel = vscode.window.createWebviewPanel(
                'addCrmConnection',
                'Add New CRM Connection',
                column || vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webviews')],
                }
            );

            const htmlFilePath = vscode.Uri.joinPath(context.extensionUri, 'webviews', 'newConnectionForm.html');

            try {
                const nonce = generateNonce();
                let htmlContent = fs.readFileSync(htmlFilePath.fsPath, 'utf8');
                htmlContent = htmlContent
                    .replace(/\$\{webview.cspSource\}/g, panel.webview.cspSource)
                    .replace(/\$\{nonce\}/g, nonce);
                panel.webview.html = htmlContent;

                panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message?.command) {
                            case 'saveConnection': {
                                try {
                                    const data = message.data;
                                    if (
                                        typeof data !== 'object' || data === null ||
                                        typeof data.name !== 'string' || typeof data.url !== 'string'
                                    ) {
                                        panel.webview.postMessage({ command: 'showError', text: 'Invalid connection details received.' });
                                        return;
                                    }

                                    const name = data.name.trim();
                                    let url = data.url.trim();
                                    if (!name || !url) {
                                        panel.webview.postMessage({ command: 'showError', text: 'Connection name and URL are required.' });
                                        return;
                                    }
                                    if (url.endsWith("/") || url.endsWith("\\")) {
                                        url = url.slice(0, -1);
                                    }

                                    const addConnectionResult = await connectionExplorer.addItem(name, url);
                                    if (addConnectionResult) {
                                        panel.dispose();
                                    } else {
                                        panel.webview.postMessage({ command: 'showError', text: 'Failed to add connection. A connection with this name might already exist or the details are invalid.' });
                                    }
                                } catch (error: unknown) {
                                    const errorMsg = error instanceof Error ? error.message : String(error);
                                    panel.webview.postMessage({ command: 'showError', text: `Failed to add connection: ${errorMsg}` });
                                }
                                return;
                            }
                            case 'cancelConnectionForm':
                                panel.dispose();
                                return;
                        }
                    },
                    undefined,
                    context.subscriptions
                );

            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                logError("wrm.addConnection (webview setup)", err);
                vscode.window.showErrorMessage(`Failed to open Add Connection form: ${errorMsg}`);
                panel.dispose();
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
                if (
                    currentCrmConnection?.getConnectionId() === connection.getConnectionId()
                ) {
                    solutionExplorer.clearSolutions();
                    webResourceExplorer.clearWebResources();
                    connectionStatusController.disconnect();
                    await vscode.commands.executeCommand("setContext", "wrm.connected", false);
                    await vscode.commands.executeCommand("setContext", "wrm.solutionLinked", false);
                    fileSyncStateService.resetAll();
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
            let wasCancelled = false;
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Connecting to '${connection.label}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            wasCancelled = true;
                            vscode.window.showInformationMessage("Connection process cancelled by user.");
                        });

                        if (token.isCancellationRequested) { wasCancelled = true; return; }

                        connectionStatusController.setCurrentConnection(connection);
                        webResourceExplorer.clearWebResources();

                        progress.report({ increment: 20, message: "Authenticating..." });
                        await connectionStatusController.connect();
                        if (token.isCancellationRequested) { wasCancelled = true; return; }

                        await vscode.commands.executeCommand("setContext", "wrm.connected", true);
                        fileSyncStateService.resetAll();

                        progress.report({ increment: 50, message: "Getting Solutions..." });
                        const rawSolutions = await CrmWebAPI.getSolutions(connection, token);
                        if (token.isCancellationRequested) { wasCancelled = true; return; }

                        const favoriteSolutions = context.globalState.get<Record<string, boolean>>(
                            "favoriteSolutions",
                            {}
                        );

                        const solutionViewModels = rawSolutions.map(rawSol =>
                            new Solution(
                                rawSol,
                                favoriteSolutions[rawSol.solutionid] === true,
                                solutionExplorer
                            )
                        );

                        if (token.isCancellationRequested) { wasCancelled = true; return; }
                        solutionExplorer.setSolutions(solutionViewModels);
                        progress.report({ increment: 100, message: `Successfully connected to '${connection.label}'.` });
                    }
                );

                if (wasCancelled) {
                    // Ensure a cancelled connect never leaves half-applied state (e.g. connected
                    // context set but no solutions loaded).
                    solutionExplorer.clearSolutions();
                    webResourceExplorer.clearWebResources();
                    connectionStatusController.disconnect();
                    await vscode.commands.executeCommand("setContext", "wrm.connected", false);
                    await vscode.commands.executeCommand("setContext", "wrm.solutionLinked", false);
                    fileSyncStateService.resetAll();
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to connect to '${connection.label}': ${message}`);
                connectionStatusController.disconnect();
                await vscode.commands.executeCommand("setContext", "wrm.connected", false);
                await vscode.commands.executeCommand("setContext", "wrm.solutionLinked", false);
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
            if (!solution || !solution.solutionId) {
                vscode.window.showErrorMessage("No solution selected or invalid solution. Please select a solution from the explorer.");
                return;
            }

            const workspaceFolder = await chooseWorkspaceFolderForSolution(solution.getFriendlyName());
            if (!workspaceFolder) {
                return;
            }

            solutionExplorer.setSelectedSolution(solution);
            solutionExplorer.setBoundWorkspaceFolder(workspaceFolder);

            // Establish the web resource root up front (prompting if unset) so files
            // land under the configured sub-folder rather than the workspace root. A
            // cancelled prompt doesn't block browsing; each pull/push re-checks it.
            await getWebResourceRootDir(workspaceFolder);

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
                            solution,
                            token
                        );

                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 70, message: "Populating explorer..." });
                        webResourceExplorer.setWebResources(webResources);
                        webResourceExplorer.refresh();
                        progress.report({ increment: 100, message: `Web resources for '${solution.label}' loaded.` });
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
                await solution.setFavorite();
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
                await solution.removeFavorite();
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    `Error removing solution '${solution.getFriendlyName()}' from favorites: ${message}`
                );
            }
        }
    );

    const wrmPushSolutionLocalFiles = vscode.commands.registerCommand(
        "wrm.pushSolutionLocalFiles",
        async (solutionArg?: unknown) => {
            const solution = resolveSolutionArgument(solutionArg, solutionExplorer);
            if (!solution || !solution.solutionId) {
                vscode.window.showErrorMessage("Link a solution before pushing local files.");
                return;
            }
            solutionExplorer.setSelectedSolution(solution);

            const connection = connectionStatusController.getCurrentConnection();
            if (!connection) {
                vscode.window.showErrorMessage("No active connection. Please connect to an environment before pushing local files.");
                return;
            }

            const solutionName = solution.getFriendlyName();
            const workspaceFolder = await resolveBoundWorkspaceFolder(solutionExplorer, solutionName);
            if (!workspaceFolder) {
                return;
            }
            const rootDir = await getWebResourceRootDir(workspaceFolder);
            if (!rootDir) {
                return;
            }

            const candidates: Array<{ webResource: WebResource; localPath: string; base64Content: string; etag?: string }> = [];
            let wasCancelled = false;

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Checking local files for '${solutionName}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            wasCancelled = true;
                            vscode.window.showInformationMessage("Push local files cancelled by user.");
                        });

                        await connection.connect();
                        if (token.isCancellationRequested) return;

                        const webResources = await CrmWebAPI.getWebResources(connection, solution, token);
                        const serverDetailsById = await CrmWebAPI.getWebResourceDetailsBatch(connection, webResources, 10);
                        const total = webResources.length || 1;

                        for (let i = 0; i < webResources.length; i++) {
                            if (token.isCancellationRequested) return;

                            const webResource = webResources[i];
                            const localPath = getLocalFilePathForWebResourceName(webResource.webResourceName, rootDir);
                            if (!localPath) {
                                progress.report({ increment: 50 / total });
                                continue;
                            }

                            const localContentBase64 = await readFileBase64IfExists(localPath);
                            if (localContentBase64 === undefined) {
                                progress.report({ increment: 50 / total });
                                continue;
                            }

                            const serverDetails = serverDetailsById.get(webResource.webResourceId);
                            if (!serverDetails) {
                                throw new Error(`Could not retrieve server details for '${webResource.webResourceName}'.`);
                            }
                            if (localContentBase64 !== serverDetails.content) {
                                candidates.push({
                                    webResource,
                                    localPath,
                                    base64Content: localContentBase64,
                                    etag: serverDetails["@odata.etag"],
                                });
                            }

                            progress.report({ increment: 50 / total });
                        }
                    }
                );

                if (wasCancelled) {
                    return;
                }

                if (candidates.length === 0) {
                    vscode.window.showInformationMessage(`No local files need to be pushed for solution '${solutionName}'.`);
                    return;
                }

                const pushLabel = `Push ${candidates.length} Web Resource${candidates.length === 1 ? "" : "s"}`;
                const confirm = await vscode.window.showWarningMessage(
                    `${candidates.length} web resource${candidates.length === 1 ? "" : "s"} in solution '${solutionName}' will be updated on the server from local files. Continue?`,
                    { modal: true },
                    pushLabel
                );
                if (confirm !== pushLabel) {
                    vscode.window.showInformationMessage("Push local files cancelled by user.");
                    return;
                }

                let conflictedIds = new Set<string>();

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Pushing ${candidates.length} web resource${candidates.length === 1 ? "" : "s"} to '${solutionName}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            wasCancelled = true;
                        });

                        if (token.isCancellationRequested) {
                            vscode.window.showInformationMessage("Push local files cancelled by user.");
                            return;
                        }

                        const result = await CrmWebAPI.updateWebResourcesBatch(
                            connection,
                            candidates.map(candidate => ({
                                webResourceId: candidate.webResource.webResourceId,
                                base64Content: candidate.base64Content,
                                etag: candidate.etag,
                            }))
                        );
                        conflictedIds = new Set(result.conflictedWebResourceIds);
                        progress.report({ increment: 75 });

                        if (token.isCancellationRequested) {
                            vscode.window.showInformationMessage("Push local files cancelled by user.");
                            return;
                        }

                        const succeeded = candidates.filter(candidate => !conflictedIds.has(candidate.webResource.webResourceId));
                        if (succeeded.length > 0) {
                            await CrmWebAPI.publishWebResources(
                                connection,
                                succeeded.map(candidate => candidate.webResource.webResourceId)
                            );
                        }
                        progress.report({ increment: 25 });

                        for (const candidate of succeeded) {
                            const hash = FileSyncStateService.computeFileHash(Buffer.from(candidate.base64Content, "base64"));
                            connectionStatusController.addSyncedWebResource(candidate.localPath, candidate.webResource.webResourceId);
                            fileSyncStateService.setFileSyncState(candidate.localPath, candidate.webResource.webResourceId, true, hash);
                        }
                    }
                );

                if (wasCancelled) {
                    return;
                }

                const succeededCount = candidates.length - conflictedIds.size;
                vscode.window.showInformationMessage(`Pushed ${succeededCount} web resource${succeededCount === 1 ? "" : "s"} to Dynamics for solution '${solutionName}'.`);

                if (conflictedIds.size > 0) {
                    const conflictedNames = candidates
                        .filter(candidate => conflictedIds.has(candidate.webResource.webResourceId))
                        .map(candidate => candidate.webResource.webResourceName)
                        .join(", ");
                    vscode.window.showWarningMessage(
                        `${conflictedIds.size} web resource${conflictedIds.size === 1 ? "" : "s"} changed on the server since being read and were NOT pushed: ${conflictedNames}. Pull the latest server version before retrying.`
                    );
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to push local files for solution '${solutionName}': ${message}`);
            }
        }
    );

    const wrmPullSolutionServerFiles = vscode.commands.registerCommand(
        "wrm.pullSolutionServerFiles",
        async (solutionArg?: unknown) => {
            const solution = resolveSolutionArgument(solutionArg, solutionExplorer);
            if (!solution || !solution.solutionId) {
                vscode.window.showErrorMessage("Link a solution before replacing local files.");
                return;
            }
            solutionExplorer.setSelectedSolution(solution);

            const connection = connectionStatusController.getCurrentConnection();
            if (!connection) {
                vscode.window.showErrorMessage("No active connection. Please connect to an environment before replacing local files.");
                return;
            }

            const solutionName = solution.getFriendlyName();
            const workspaceFolder = await resolveBoundWorkspaceFolder(solutionExplorer, solutionName);
            if (!workspaceFolder) {
                return;
            }
            const rootDir = await getWebResourceRootDir(workspaceFolder);
            if (!rootDir) {
                return;
            }

            const candidates: Array<{ webResource: WebResource; localPath: string; serverContent: string }> = [];
            let wasCancelled = false;

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Checking server files for '${solutionName}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            wasCancelled = true;
                            vscode.window.showInformationMessage("Replace local files cancelled by user.");
                        });

                        await connection.connect();
                        if (token.isCancellationRequested) return;

                        const webResources = await CrmWebAPI.getWebResources(connection, solution, token);
                        const serverDetailsById = await CrmWebAPI.getWebResourceDetailsBatch(connection, webResources, 10);
                        const total = webResources.length || 1;

                        for (let i = 0; i < webResources.length; i++) {
                            if (token.isCancellationRequested) return;

                            const webResource = webResources[i];
                            const localPath = await prepareWebResourceFilePath(webResource.webResourceName, rootDir);
                            if (!localPath) {
                                throw new Error(`Could not prepare local path for '${webResource.webResourceName}'.`);
                            }

                            const serverDetails = serverDetailsById.get(webResource.webResourceId);
                            if (!serverDetails) {
                                throw new Error(`Could not retrieve server details for '${webResource.webResourceName}'.`);
                            }
                            const localContentBase64 = await readFileBase64IfExists(localPath);
                            if (localContentBase64 !== serverDetails.content) {
                                candidates.push({
                                    webResource,
                                    localPath,
                                    serverContent: serverDetails.content,
                                });
                            }

                            progress.report({ increment: 50 / total });
                        }
                    }
                );

                if (wasCancelled) {
                    return;
                }

                if (candidates.length === 0) {
                    vscode.window.showInformationMessage(`No local files need to be replaced for solution '${solutionName}'.`);
                    return;
                }

                const replaceLabel = `Replace ${candidates.length} Local File${candidates.length === 1 ? "" : "s"}`;
                const confirm = await vscode.window.showWarningMessage(
                    `${candidates.length} local file${candidates.length === 1 ? "" : "s"} for solution '${solutionName}' will be replaced with the server version. Continue?`,
                    { modal: true },
                    replaceLabel
                );
                if (confirm !== replaceLabel) {
                    vscode.window.showInformationMessage("Replace local files cancelled by user.");
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Replacing ${candidates.length} local file${candidates.length === 1 ? "" : "s"} for '${solutionName}'...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            wasCancelled = true;
                        });
                        const total = candidates.length || 1;
                        for (const candidate of candidates) {
                            if (token.isCancellationRequested) {
                                vscode.window.showInformationMessage("Replace local files cancelled by user.");
                                return;
                            }

                            await fs.promises.writeFile(
                                candidate.localPath,
                                candidate.serverContent,
                                { encoding: "base64" }
                            );
                            const hash = FileSyncStateService.computeFileHash(Buffer.from(candidate.serverContent, "base64"));
                            connectionStatusController.addSyncedWebResource(candidate.localPath, candidate.webResource.webResourceId);
                            fileSyncStateService.setFileSyncState(candidate.localPath, candidate.webResource.webResourceId, true, hash);
                            progress.report({ increment: 100 / total });
                        }
                    }
                );

                if (wasCancelled) {
                    return;
                }

                vscode.window.showInformationMessage(`Replaced ${candidates.length} local file${candidates.length === 1 ? "" : "s"} from Dynamics for solution '${solutionName}'.`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to replace local files for solution '${solutionName}': ${message}`);
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
                const workspaceFolder = getBoundOrSingleWorkspaceFolder(solutionExplorer);
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage("No workspace folder is open. Please open a folder to download web resources.");
                    return;
                }

                const rootDir = await getWebResourceRootDir(workspaceFolder);
                if (!rootDir) {
                    return;
                }

                const fullFilePath = await prepareWebResourceFilePath(webResource.webResourceName, rootDir);
                if (!fullFilePath) {
                    return;
                }

                const currentCrmConnection = connectionStatusController.getCurrentConnection();
                if (!currentCrmConnection) {
                    vscode.window.showErrorMessage("No active connection. Please connect first to open web resources.");
                    return;
                }

                const webResourceDetails = await CrmWebAPI.getWebResourceDetails(currentCrmConnection, webResource);
                if (webResourceDetails.content === undefined) {
                    vscode.window.showErrorMessage(`Failed to retrieve content for web resource: ${webResource.webResourceName}`);
                    return;
                }

                let localContentBase64 = '';
                let localFileExists = false;
                try {
                    const localContent = await fs.promises.readFile(fullFilePath);
                    localContentBase64 = localContent.toString('base64');
                    localFileExists = true;
                } catch (error: any) {
                    if (error.code !== 'ENOENT') {
                        console.error(`Error reading local file: ${error.message}`);
                    }
                }

                const isContentDifferent = localContentBase64 !== webResourceDetails.content;

                if (localFileExists && isContentDifferent) {
                    const overwriteChoice = await vscode.window.showWarningMessage(
                        `The server version of '${webResource.webResourceName}' is different from your local version. It was last modified by ${webResourceDetails.modifiedby.fullname} on ${new Date(webResourceDetails.modifiedon).toLocaleString()}. Downloading it will overwrite your local file.`,
                        { modal: true },
                        "Overwrite Local File"
                    );

                    if (overwriteChoice !== "Overwrite Local File") {
                        vscode.window.showInformationMessage("Download cancelled by user.");
                        return;
                    }
                }

                await fs.promises.writeFile(
                    fullFilePath,
                    webResourceDetails.content,
                    { encoding: "base64" }
                );

                const doc = await vscode.workspace.openTextDocument(fullFilePath);
                await vscode.window.showTextDocument(doc);

                connectionStatusController.addSyncedWebResource(
                    fullFilePath,
                    webResource.webResourceId
                );

                const hash = FileSyncStateService.computeFileHash(Buffer.from(webResourceDetails.content, "base64"));
                fileSyncStateService.setFileSyncState(fullFilePath, webResource.webResourceId, true, hash);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to open web resource '${webResource.webResourceName}': ${message}`);
            }
        }
    );

    /**
     * Command: Pull the active file from the matching server web resource.
     */
    const wrmPullCurrentFileFromServer = vscode.commands.registerCommand(
        "wrm.pullCurrentFileFromServer",
        async () => {
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    vscode.window.showInformationMessage("No active editor. Please open a web resource file to pull from the server.");
                    return;
                }

                const document = activeEditor.document;
                const baseName = path.basename(document.fileName);
                const { filePath: currentPath, webResourceName } = await getWebResourceNameFromDocument(document);

                if (!webResourceName) {
                    vscode.window.showErrorMessage(
                        `'${baseName}' is not inside the current workspace. Open the file from this workspace before pulling from the server.`
                    );
                    return;
                }

                const connection = connectionStatusController.getCurrentConnection();
                if (!connection) {
                    vscode.window.showErrorMessage("No active connection. Please connect to an environment before pulling from the server.");
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Pulling '${webResourceName}' from Dynamics...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        token.onCancellationRequested(() => {
                            vscode.window.showInformationMessage("Pull from server cancelled by user.");
                        });

                        await connection.connect();
                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 25 });

                        const serverWebResource = await CrmWebAPI.getWebResourceByName(connection, webResourceName);
                        if (!serverWebResource) {
                            vscode.window.showErrorMessage(`Web resource '${webResourceName}' does not exist on the server.`);
                            return;
                        }

                        const webResource = new WebResource(
                            serverWebResource.name,
                            serverWebResource.webresourceid,
                            path.basename(serverWebResource.name),
                            currentPath,
                            "",
                            "file"
                        );
                        const serverDetails = await CrmWebAPI.getWebResourceDetails(connection, webResource);
                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 50 });

                        const localContentBase64 = await readFileBase64IfExists(currentPath);
                        if (localContentBase64 !== undefined && localContentBase64 !== serverDetails.content) {
                            const overwriteChoice = await vscode.window.showWarningMessage(
                                `The server version of '${webResourceName}' is different from your local version. Pulling it will overwrite your local file.`,
                                { modal: true },
                                "Overwrite Local File"
                            );

                            if (overwriteChoice !== "Overwrite Local File") {
                                vscode.window.showInformationMessage("Pull from server cancelled by user.");
                                return;
                            }
                        }

                        await fs.promises.mkdir(path.dirname(currentPath), { recursive: true });
                        await fs.promises.writeFile(
                            currentPath,
                            serverDetails.content,
                            { encoding: "base64" }
                        );
                        connectionStatusController.addSyncedWebResource(currentPath, serverWebResource.webresourceid);
                        const hash = FileSyncStateService.computeFileHash(Buffer.from(serverDetails.content, "base64"));
                        fileSyncStateService.setFileSyncState(currentPath, serverWebResource.webresourceid, true, hash);

                        const doc = await vscode.workspace.openTextDocument(currentPath);
                        await vscode.window.showTextDocument(doc);
                        progress.report({ increment: 25 });
                    }
                );
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to pull current file from server: ${message}`);
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
                const fileName = document.fileName;
                const baseName = path.basename(fileName);
                const { filePath: currentPath, webResourceName } = await getWebResourceNameFromDocument(document);
                const progressName = webResourceName ?? baseName;

                if (document.isDirty) {
                    const saveChoice = await vscode.window.showWarningMessage(
                        `'${progressName}' has unsaved changes. Save before publishing?`,
                        { modal: true },
                        "Save and Publish"
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
                        title: `Publishing '${progressName}' to Dynamics...`,
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

                        progress.report({ increment: 10 });
                        await connection.connect();

                        if (token.isCancellationRequested) return;
                        progress.report({ increment: 30 });

                        if (!webResourceName) {
                            vscode.window.showErrorMessage(
                                `'${baseName}' is not inside the current workspace. Open the file from this workspace before publishing.`
                            );
                            return;
                        }

                        const selectedSolution = solutionExplorer.getSelectedSolution();
                        if (!selectedSolution) {
                            vscode.window.showErrorMessage(
                                "Select a solution before publishing so the extension knows which solution to check or add the file to."
                            );
                            return;
                        }

                        const data = await fs.promises.readFile(currentPath);
                        if (token.isCancellationRequested) return;
                        const base64 = data.toString("base64");

                        progress.report({ increment: 45 });

                        let webResourceId = connectionStatusController.getResourceIdFromPath(currentPath);
                        let addedToSelectedSolution = false;
                        let etagForUpdate: string | undefined;

                        if (typeof webResourceId === "undefined") {
                            const serverWebResource = await CrmWebAPI.getWebResourceByName(connection, webResourceName);
                            webResourceId = serverWebResource?.webresourceid;

                            if (!webResourceId) {
                                const createChoice = await vscode.window.showWarningMessage(
                                    `Web resource '${webResourceName}' does not exist on the server and is not currently in solution '${selectedSolution.getFriendlyName()}'. Create it, add it to solution '${selectedSolution.getFriendlyName()}', and publish?`,
                                    { modal: true },
                                    "Create, Add, and Publish"
                                );

                                if (createChoice !== "Create, Add, and Publish") {
                                    vscode.window.showInformationMessage("Publish cancelled by user.");
                                    return;
                                }

                                progress.report({ increment: 55 });
                                const createdWebResource = await CrmWebAPI.createWebResource(
                                    connection,
                                    webResourceName,
                                    base64
                                );
                                webResourceId = createdWebResource.webresourceid;
                                await CrmWebAPI.addWebResourceToSolution(
                                    connection,
                                    selectedSolution,
                                    webResourceId
                                );
                                addedToSelectedSolution = true;
                            }
                        }

                        if (!webResourceId) {
                            vscode.window.showErrorMessage(`Could not resolve Dynamics web resource '${webResourceName}'.`);
                            return;
                        }

                        if (!addedToSelectedSolution) {
                            const { shouldContinue, etag } = await checkServerStateBeforePublish(
                                connection,
                                webResourceName,
                                webResourceId,
                                currentPath
                            );
                            if (!shouldContinue) {
                                vscode.window.showInformationMessage("Publish cancelled by user.");
                                return;
                            }
                            etagForUpdate = etag;
                        }

                        if (token.isCancellationRequested) return;

                        if (!addedToSelectedSolution) {
                            progress.report({ increment: 55 });
                            const isInSelectedSolution = await CrmWebAPI.isWebResourceInSolution(
                                connection,
                                selectedSolution,
                                webResourceId
                            );

                            if (!isInSelectedSolution) {
                                const addChoice = await vscode.window.showWarningMessage(
                                    `Web resource '${webResourceName}' exists on the server but is not currently in solution '${selectedSolution.getFriendlyName()}'. Add it to solution '${selectedSolution.getFriendlyName()}' and publish?`,
                                    { modal: true },
                                    "Add to Solution and Publish"
                                );

                                if (addChoice !== "Add to Solution and Publish") {
                                    vscode.window.showInformationMessage("Publish cancelled by user.");
                                    return;
                                }

                                progress.report({ increment: 65 });
                                await CrmWebAPI.addWebResourceToSolution(
                                    connection,
                                    selectedSolution,
                                    webResourceId
                                );
                            }
                        }

                        connectionStatusController.addSyncedWebResource(currentPath, webResourceId);

                        progress.report({ increment: 80 });
                        await CrmWebAPI.publishWebResource(
                            connection,
                            webResourceId,
                            base64,
                            etagForUpdate
                        );
                        progress.report({ increment: 100 });

                        const hash = FileSyncStateService.computeFileHash(data);
                        fileSyncStateService.setFileSyncState(fileName, webResourceId, true, hash);
                    }
                );
            } catch (error: unknown) {
                if (error instanceof ConcurrencyConflictError) {
                    vscode.window.showWarningMessage(
                        `Publish stopped: the server version changed since it was last read. Pull the latest version and try again. (${error.message})`
                    );
                    return;
                }
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
                            await currentCrmConnection.connect();

                            progress.report({ increment: 50, message: "Fetching filtered solutions..." });
                            const rawSolutions = await CrmWebAPI.getSolutions(currentCrmConnection);

                            progress.report({ increment: 80, message: "Updating view..." });
                            solutionExplorer.setSolutionsFromRaw(rawSolutions);

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
        wrmPushSolutionLocalFiles,
        wrmPullSolutionServerFiles,
        wrmOpenWebResource,
        wrmPullCurrentFileFromServer,
        wrmPublishWebResource,
        wrmFilterSolutions,
        wrmToggleSolutionSortOrder,
        wrmCopyConnectionUrl
    );
}
