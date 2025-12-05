import * as vscode from "vscode";
// Keytar and Express imports were commented out as unused. If needed, they should be uncommented.
import { v1 as uuidv1 } from "uuid";
import { AuthProvider } from "../auth/authProvider";
import { ConfigurationService } from "./../configurationService"; 
import * as fs from "fs";
import { AuthenticationResult } from "@azure/msal-node"; 

// serviceName constant was commented out as unused.

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
                vscode.TreeItemCollapsibleState.None, // Connections are leaf nodes.
                globalContext // Pass context to Connection
            )
        );
    }

    /**
     * Returns the TreeItem (UI representation) for the given element.
     * Adds a tooltip with the connection URL.
     * @param {Connection} element The Connection instance for which to get the TreeItem.
     * @returns {vscode.TreeItem} The TreeItem representation of the element.
     */
    getTreeItem(element: Connection): vscode.TreeItem {
        element.tooltip = `URL: ${element.getConnectionURL()}`;
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
                vscode.TreeItemCollapsibleState.None,
                this.globalContext // Pass context to Connection
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
    /**
     * Context value used for VS Code's "when" clauses in package.json for context menus.
     */
    public readonly contextValue: string = "connection";
    /** The collapsible state of the tree item. Connections are typically leaf nodes. */
    public collapsibleState: vscode.TreeItemCollapsibleState;

    /** The display name of the connection. */
    private readonly connectionName: string;
    /** The URL of the Dynamics 365 environment. */
    private readonly connectionURL: string;

    /** A unique identifier for the connection. */
    private readonly connectionId: string;
    /** The AuthProvider instance responsible for handling authentication for this connection. */
    private readonly authProvider: AuthProvider;
    /** The VS Code extension context for accessing SecretStorage. */
    private readonly context: vscode.ExtensionContext;

    /**
     * Creates an instance of a Connection tree item.
     * @param {ConnectionObject} connectionObj The data object containing connection details.
     * @param {vscode.TreeItemCollapsibleState} collapsibleState The collapsible state of the item.
     * @param {vscode.ExtensionContext} context The extension context for accessing SecretStorage.
     */
    constructor(
        connectionObj: ConnectionObject, 
        collapsibleState: vscode.TreeItemCollapsibleState,
        context: vscode.ExtensionContext
    ) {
        // Call the TreeItem constructor to set the label and collapsible state.
        // The label is the connectionName.
        super(connectionObj.connectionName, collapsibleState);
        
        this.connectionName = connectionObj.connectionName;
        this.connectionURL = connectionObj.connectionURL;
        this.collapsibleState = collapsibleState; // Set from parameter.
        this.context = context;

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
            this.connectionName,
            context
        );
    }

    /**
     * Connects to the Dynamics 365 environment associated with this connection.
     * Handles token acquisition and proactive renewal via AuthProvider.
     * @returns {Promise<boolean>} A promise that resolves to `true` if connection/token validation is successful.
     * @throws {Error} If authentication or token renewal fails.
     * @async
     */
    async connect(): Promise<boolean> {
        // Only delegate to AuthProvider for login/token management
        const authResult = await this.authProvider.login();
        if (!authResult || !authResult.accessToken || !authResult.expiresOn) {
            throw new Error(`Authentication failed for connection "${this.connectionName}". Unable to retrieve a valid access token or expiration date.`);
        }
        return true;
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
     * Gets the access token for this connection from AuthProvider.
     * @returns {string | undefined} The access token, or undefined if not authenticated.
     */
    public getAccessToken(): string | undefined {
        return this.authProvider.getAccessToken();
    }

    /**
     * Gets the expiration date of the access token from AuthProvider.
     * @returns {Date | undefined} The token expiration date, or undefined if not set.
     */
    public getTokenExpiration(): Date | undefined {
        return this.authProvider.getTokenExpiration();
    }

    /**
     * Gets the unique identifier for this connection.
     * @returns {string} The connection ID.
     */
    public getConnectionId(): string {
        return this.connectionId;
    }

    /**
     * Gets the user name from the authenticated account.
     * @returns {string | undefined} The user name, or undefined if not authenticated.
     */
    public getConnectionUserName(): string | undefined {
        const accountInfo = this.authProvider.getAccountInfo();
        return accountInfo?.name;
    }
}
