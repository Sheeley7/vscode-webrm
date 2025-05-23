import * as vscode from "vscode";
// Keytar and Express imports were commented out as unused. If needed, they should be uncommented.
// import * as keytar from "keytar"; 
// import e = require("express"); 
import { v1 as uuidv1 } from "uuid";
import { AuthProvider } from "../auth/authProvider";
import { ConfigurationService } from "./../configurationService"; 
import * as fs from "fs";
import { AuthenticationResult } from "@azure/msal-node"; 

// serviceName constant was commented out as unused.
// const serviceName = "vscode-webrm"; 

/**
 * Interface representing the data structure for a connection object stored in global state
 * or used for creating new `Connection` instances.
 * @interface ConnectionObject
 */
export interface ConnectionObject {
    /** The display name of the connection. */
    connectionName: string;
    /** The URL of the Dynamics 365 environment. */
    connectionURL: string;
    /** A unique identifier for the connection. Optional, as it's generated if not provided. */
    connectionId?: string; 
}

/**
 * Implements the VS Code TreeDataProvider for the Connection Explorer view.
 * This class manages and displays a list of Dynamics 365 connections.
 */
export class ConnectionExplorer implements vscode.TreeDataProvider<Connection> {
    /** Array holding the Connection instances displayed in the tree view. */
    private connections: Connection[] = [];
    /** Emitter for tree data change events. VS Code listens to this to refresh the view. */
    private _onDidChangeTreeData: vscode.EventEmitter<Connection | undefined | null | void> = new vscode.EventEmitter<Connection | undefined | null | void>();
    /** Event that VS Code subscribes to for tree data changes. */
    readonly onDidChangeTreeData: vscode.Event<Connection | undefined | null | void> = this._onDidChangeTreeData.event;

    /**
     * Creates an instance of ConnectionExplorer.
     * Loads existing connections from the global extension state.
     * @param {vscode.ExtensionContext} globalContext The extension context, used for accessing global state.
     */
    constructor(private globalContext: vscode.ExtensionContext) {
        // Retrieve stored connection data from global state.
        const connectionsData = globalContext.globalState.get<ConnectionObject[]>(
            "connections", // Key used for storing connections.
            [] // Default to an empty array if no connections are found.
        );
        // Map stored ConnectionObject data to Connection instances.
        this.connections = connectionsData.map(connObj => 
            new Connection(
                connObj,
                vscode.TreeItemCollapsibleState.None // Connections are leaf nodes.
            )
        );
    }

    /**
     * Returns the TreeItem (UI representation) for the given element.
     * @param {Connection} element The Connection instance for which to get the TreeItem.
     * @returns {vscode.TreeItem} The TreeItem representation of the element.
     */
    getTreeItem(element: Connection): vscode.TreeItem {
        return element; // The Connection class itself extends TreeItem.
    }

    /**
     * Returns the children for the given element or root if no element is provided.
     * Since connections are displayed as a flat list, this returns all connections if `element` is undefined (root),
     * or an empty array if `element` is a Connection (as they have no children).
     * @param {Connection} [element] The Connection instance for which to get children. If undefined, returns root elements.
     * @returns {vscode.ProviderResult<Connection[]>} A promise resolving to an array of child Connection items.
     */
    getChildren(element?: Connection): vscode.ProviderResult<Connection[]> {
        if (element) {
            // Connections are leaf items in this tree view.
            return Promise.resolve([]); 
        }
        // When element is undefined, VS Code is asking for the root level items.
        return Promise.resolve(this.connections);
    }

    /**
     * Adds a new connection to the explorer and persists it to global state.
     * @param {string} name The display name for the new connection.
     * @param {string} url The URL of the Dynamics 365 environment.
     * @returns {Promise<boolean>} A promise that resolves to `true` if the item was added successfully (unique name), `false` otherwise.
     * @async
     */
    async addItem(name: string, url: string): Promise<boolean> {
        // Check if a connection with the same name already exists.
        if (this.connections.findIndex(c => c.getConnectionName() === name) === -1) {
            // Create a new ConnectionObject and then a Connection instance.
            const newConnectionObject: ConnectionObject = { connectionName: name, connectionURL: url };
            const connection = new Connection(
                newConnectionObject,
                vscode.TreeItemCollapsibleState.None
            );
            this.connections.push(connection);
            // Persist the updated list of connections to global state.
            await this.updateConnectionsInGlobalState();
            this.refresh(); // Notify VS Code to refresh the tree view.
            return true;
        } else {
            // Connection name is not unique.
            return false;
        }
    }
    
    /**
     * Helper method to persist the current list of connections to global state.
     * @private
     * @async
     */
    private async updateConnectionsInGlobalState(): Promise<void> {
        // Map Connection instances back to ConnectionObject for storage.
        const connectionsToStore = this.connections.map(c => ({
            connectionName: c.getConnectionName(),
            connectionURL: c.getConnectionURL(),
            connectionId: c.getConnectionId()
        } as ConnectionObject));
        await this.globalContext.globalState.update("connections", connectionsToStore);
    }

    // Removed deprecated refreshConnectionsGlobalState method.
    // State persistence is handled by addItem and removeItem via updateConnectionsInGlobalState.

    /**
     * Removes a connection from the explorer and global state.
     * Also handles deleting associated cached connection information.
     * @param {Connection} connectionToRemove The Connection instance to remove.
     * @returns {Promise<void>} A promise that resolves when the item is removed.
     * @async
     */
    async removeItem(connectionToRemove: Connection): Promise<void> {
        const connectionToRemoveId = connectionToRemove.getConnectionId();
        // Filter out the connection to be removed.
        this.connections = this.connections.filter(
            connection => connection.getConnectionId() !== connectionToRemoveId
        );
        // Delete any cached/persisted data associated with the connection (e.g., token cache file).
        await connectionToRemove.deleteConnection(); 
        
        // Persist the updated list of connections.
        await this.updateConnectionsInGlobalState();
        this.refresh(); // Notify VS Code to refresh the tree view.
    }

    /**
     * Triggers a refresh of the Connection Explorer tree view.
     * Call this method when the underlying data (`this.connections`) changes.
     */
    refresh(): void {
        // Firing with undefined or null signals that the root of the tree has changed.
        this._onDidChangeTreeData.fire();
    }
}

/** Threshold in minutes before token expiry to attempt proactive renewal. */
const TOKEN_EXPIRATION_BUFFER_MINUTES = 5;

/**
 * Represents a single Dynamics 365 connection item in the Connection Explorer view.
 * Extends vscode.TreeItem to be directly usable by the TreeDataProvider.
 */
export class Connection extends vscode.TreeItem {
    /** Context value used for VS Code's "when" clauses in package.json for context menus. */
    public readonly contextValue: string = "connection";
    /** The collapsible state of the tree item. Connections are typically leaf nodes. */
    public collapsibleState: vscode.TreeItemCollapsibleState;

    /** The display name of the connection. */
    private readonly connectionName: string;
    /** The URL of the Dynamics 365 environment. */
    private readonly connectionURL: string;
    /** The access token for the connection. Undefined if not authenticated. */
    #accessToken: string | undefined; 
    /** The expiration date of the access token. Undefined if not authenticated. */
    #tokenExpiration: Date | undefined; 

    /** A unique identifier for the connection. */
    private readonly connectionId: string;
    /** Flag indicating if the connection (specifically AuthProvider) has been initialized. */
    private initialized: boolean; 
    /** The AuthProvider instance responsible for handling authentication for this connection. */
    private readonly authProvider: AuthProvider;

    /**
     * Creates an instance of a Connection tree item.
     * @param {ConnectionObject} connectionObj The data object containing connection details.
     * @param {vscode.TreeItemCollapsibleState} collapsibleState The collapsible state of the item.
     */
    constructor(
        connectionObj: ConnectionObject, 
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        // Call the TreeItem constructor to set the label and collapsible state.
        // The label is the connectionName.
        super(connectionObj.connectionName, collapsibleState);
        
        this.connectionName = connectionObj.connectionName;
        this.connectionURL = connectionObj.connectionURL;
        this.collapsibleState = collapsibleState; // Set from parameter.
        this.initialized = false; // Initialized state of the AuthProvider for this connection.

        // Generate a unique ID for the connection if one is not provided.
        // This ID is used for cache keying and internal tracking.
        if (
            connectionObj.connectionId === null ||
            typeof connectionObj.connectionId === "undefined" ||
            connectionObj.connectionId === ""
        ) {
            this.connectionId = uuidv1().replace(/-/g, ""); // Generate a UUID and remove hyphens.
        } else {
            this.connectionId = connectionObj.connectionId;
        }

        // Initialize the AuthProvider for this specific connection.
        this.authProvider = new AuthProvider(
            this.connectionURL,
            this.connectionId,
            this.connectionName
        );
    }

    /**
     * Connects to the Dynamics 365 environment associated with this connection.
     * Handles token acquisition and proactive renewal. If the current token is expired
     * or within the renewal buffer period, a new token is acquired.
     * @returns {Promise<boolean>} A promise that resolves to `true` if connection/token validation is successful.
     * @throws {Error} If authentication or token renewal fails.
     * @async
     */
    async connect(): Promise<boolean> {
        const now = new Date();
        const currentTokenExpiry = this.getTokenExpiration();
        let renewalThresholdTime: Date | null = null;

        if (currentTokenExpiry) {
            renewalThresholdTime = new Date(currentTokenExpiry.getTime() - TOKEN_EXPIRATION_BUFFER_MINUTES * 60 * 1000);
        }

        // Condition for renewal:
        // 1. No token expiration date is set (implies first-time login or state loss).
        // 2. Token has expired (current time is past expiration time).
        // 3. Token is within the proactive renewal buffer (current time is past the threshold time).
        if (!currentTokenExpiry || now > currentTokenExpiry || (renewalThresholdTime && now > renewalThresholdTime)) {
            if (currentTokenExpiry) {
                console.log(`Token for ${this.connectionName} requires renewal (expired or within ${TOKEN_EXPIRATION_BUFFER_MINUTES} min buffer). Current expiry: ${currentTokenExpiry}. Attempting renewal.`);
            } else {
                console.log(`No token expiry found for ${this.connectionName}. Attempting login/renewal.`);
            }
            
            const authResult: AuthenticationResult | null = await this.authProvider.login();

            // Validate the authentication result.
            if (authResult === null || !authResult.accessToken || !authResult.expiresOn) {
                // AuthProvider.login() is expected to throw on critical failures based on prior refactoring.
                // This explicit throw handles cases where it might return null without throwing for some reason.
                throw new Error(`Authentication failed for connection "${this.connectionName}". Unable to retrieve a valid access token or expiration date.`);
            }

            // Store the new token and its expiration date.
            this.setAccessToken(authResult.accessToken);
            this.setTokenExpiration(authResult.expiresOn); // expiresOn from MSAL should be a non-null Date.
            console.log(`Token for ${this.connectionName} successfully renewed/acquired. New expiry: ${this.getTokenExpiration()}`);
        } else {
            // Token is still valid and not within the renewal buffer.
            console.log(`Token for ${this.connectionName} is still valid. Expiry: ${this.getTokenExpiration()}`);
        }

        this.initialized = true; // Mark as initialized (or re-initialized).
        return true; // Connection and token validation successful.
    }

    /**
     * Deletes any persisted cache files associated with this connection.
     * This is typically called when a connection is removed from the explorer.
     * @returns {Promise<void>} A promise that resolves when the deletion attempt is complete.
     * @async
     */
    public async deleteConnection(): Promise<void> {
        // Get the configured folder for storing connection cache files.
        const connectionFolder: string = ConfigurationService.getConnectionInfoFolder() || ""; 
        // Normalize folder path.
        const normalizedConnectionFolder = connectionFolder.endsWith("/") || connectionFolder.endsWith("\\")
            ? connectionFolder.slice(0, -1)
            : connectionFolder;
        
        // Construct the expected file name for this connection's cache.
        const fileName = `${normalizedConnectionFolder}/${this.connectionName}-${this.connectionId}.json`;

        try {
            // Check if the cache file exists before attempting to delete it.
            if (fs.existsSync(fileName)) { 
                await fs.promises.unlink(fileName); // Use asynchronous unlink.
                console.log(`Successfully deleted connection cache file: ${fileName}`);
            } else {
                // File not found, could have been deleted manually or never created.
                console.log(`Connection cache file not found (presumed already deleted or never existed): ${fileName}`);
            }
        } catch (error: unknown) { 
            // Handle errors during file deletion (e.g., permissions issues).
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete connection cache file '${fileName}': ${message}`);
            // Optionally re-throw if the caller (e.g., removeItem in ConnectionExplorer) should handle this.
            // For example, to prevent the connection from being removed from the UI if its cache can't be cleaned up.
            // throw new Error(`Failed to delete connection file '${fileName}': ${message}`);
        }
    }

    /**
     * Gets the display name of the connection.
     * @returns {string} The connection name.
     */
    public getConnectionName(): string {
        return this.connectionName;
    }

    /**
     * Gets the URL of the Dynamics 365 environment for this connection.
     * @returns {string} The connection URL.
     */
    public getConnectionURL(): string {
        return this.connectionURL;
    }

    /**
     * Gets the access token for this connection.
     * @returns {string | undefined} The access token, or undefined if not authenticated.
     */
    public getAccessToken(): string | undefined {
        return this.#accessToken;
    }

    /**
     * Sets the access token for this connection.
     * @param {string} newToken The new access token.
     */
    public setAccessToken(newToken: string): void {
        this.#accessToken = newToken;
    }

    /**
     * Sets the expiration date of the access token.
     * @param {Date | null} newDate The new expiration date. If null, a default expiration (e.g., 1 hour from now) might be set.
     */
    public setTokenExpiration(newDate: Date | null): void {
        if (newDate) {
            this.#tokenExpiration = newDate;
        } else {
            // Fallback if null is passed, though MSAL's authResult.expiresOn should always be a Date.
            // Setting a default expiration slightly less than an hour for safety margin.
            // This fallback might be less relevant if authResult.expiresOn is guaranteed to be a Date.
            const dateNowPlusShortExpiry = new Date();
            dateNowPlusShortExpiry.setMinutes(dateNowPlusShortExpiry.getMinutes() + 58); // e.g., 58 minutes
            this.#tokenExpiration = dateNowPlusShortExpiry;
            console.warn(`Token expiration date was null, using fallback: ${this.#tokenExpiration}`);
        }
    }

    /**
     * Gets the expiration date of the access token.
     * @returns {Date | undefined} The token expiration date, or undefined if not set.
     */
    public getTokenExpiration(): Date | undefined {
        return this.#tokenExpiration;
    }

    /**
     * Gets the unique identifier for this connection.
     * @returns {string} The connection ID.
     */
    public getConnectionId(): string {
        return this.connectionId;
    }
}
