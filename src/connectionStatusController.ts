import { Connection } from "./views/connectionExplorer";
import { StatusBarItem, Disposable } from "vscode"; 

/**
 * Manages the connection status of the extension, updating the Visual Studio Code status bar
 * and keeping track of the currently active Dynamics 365 connection.
 * It also maintains a lookup for web resources synced from CRM to local file paths.
 */
export class ConnectionStatusController {
  /** Flag indicating if there is an active connection to a Dynamics 365 environment. */
  private isConnected: boolean = false;
  /** The currently active Dynamics 365 Connection object, or undefined if not connected. */
  private currentConnection: Connection | undefined;
  /** The VS Code StatusBarItem used to display connection status. */
  private statusBar: StatusBarItem;
  /** 
   * A lookup mapping local file paths of synced web resources to their Dynamics 365 web resource IDs.
   * This is used to identify which CRM record to update when publishing a local file.
   * Example: `{"/path/to/local/script.js": "crm-guid-of-script"}`
   */
  private webResourceLookup: Record<string, string>;

  /**
   * Creates an instance of ConnectionStatusController.
   * @param {StatusBarItem} statusBar The VS Code StatusBarItem to be managed by this controller.
   */
  constructor(statusBar: StatusBarItem) {
    this.statusBar = statusBar;
    this.webResourceLookup = {}; // Initialize with an empty lookup.
  }

  /**
   * Sets the currently active Dynamics 365 connection.
   * @param {Connection} connection The Connection object representing the active connection.
   */
  public setCurrentConnection(connection: Connection): void {
    this.currentConnection = connection;
  }

  /**
   * Retrieves the currently active Dynamics 365 connection.
   * @returns {Connection | undefined} The active Connection object, or undefined if no connection is active.
   */
  public getCurrentConnection(): Connection | undefined {
    return this.currentConnection;
  }

  /**
   * Retrieves the Dynamics 365 web resource ID associated with a local file path.
   * @param {string} path The local file path of the synced web resource.
   * @returns {string | undefined} The CRM web resource ID, or undefined if the path is not found in the lookup.
   */
  public getResourceIdFromPath(path: string): string | undefined {
    return this.webResourceLookup[path];
  }

  /**
   * Sets or replaces the entire web resource lookup table.
   * This might be used if an initial set of synced resources is loaded from elsewhere.
   * @param {Record<string, string>} webResourceLookup A record mapping local file paths to CRM web resource IDs.
   */
  public setWebResources(webResourceLookup: Record<string, string>): void {
    this.webResourceLookup = webResourceLookup;
  }

  /**
   * Establishes a connection to the Dynamics 365 environment using the current connection details.
   * Updates the status bar to reflect the connected state.
   * Resets the web resource lookup on a new successful connection.
   * @returns {Promise<void>} A promise that resolves when the connection is successfully established.
   * @throws {Error} If no current connection is set or if the connection attempt via `currentConnection.connect()` fails.
   * @async
   */
  public async connect(): Promise<void> {
    this.webResourceLookup = {}; // Resetting lookup on new connection, assuming fresh sync or context.
    if (this.currentConnection !== undefined) {
      try {
        // Delegate the actual connection and authentication logic to the Connection object.
        await this.currentConnection.connect(); 
        this.isConnected = true;
        // Update status bar to show the name of the connected environment.
        this.statusBar.text = `Connected: ${this.currentConnection.getConnectionName()}`;
        this.statusBar.tooltip = `Connected to Dynamics 365 environment: ${this.currentConnection.getConnectionName()} (${this.currentConnection.getConnectionURL()})`;
        this.statusBar.show();
      } catch (error: unknown) {
        // If connection fails, update status and re-throw to notify the user via command handler.
        this.isConnected = false; 
        this.statusBar.text = "Connection Failed";
        this.statusBar.tooltip = "Failed to connect to Dynamics 365 environment.";
        throw error; // Propagate the error for user notification.
      }
    } else {
        // This indicates a programming error, as setCurrentConnection should be called before connect.
        throw new Error("Cannot connect: No current connection has been set.");
    }
  }

  /**
   * Disconnects from the current Dynamics 365 environment.
   * Updates the status bar and clears any connection-specific state.
   */
  public disconnect(): void {
    // Clear current connection details.
    this.currentConnection = undefined;
    this.isConnected = false;
    // Update status bar to reflect the disconnected state.
    this.statusBar.text = "Not Connected";
    this.statusBar.tooltip = "Dynamics 365 Web Resource Manager: Not Connected";
    this.statusBar.show();
    // Clear the web resource lookup as it's specific to a connection.
    this.webResourceLookup = {}; 
  }

  /**
   * Adds a mapping between a local file path and a Dynamics 365 web resource ID.
   * This is typically called after a web resource is downloaded (opened) to track it for publishing.
   * @param {string} filePath The local file path of the synced web resource.
   * @param {string} webResourceId The CRM ID of the web resource.
   */
  public addSyncedWebResource(filePath: string, webResourceId: string): void {
    this.webResourceLookup[filePath] = webResourceId;
  }

  /**
   * Gets the current connection status.
   * @returns {boolean} True if connected, false otherwise.
   */
  public getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Ensures that the current active connection is valid by attempting to connect (which includes token validation/renewal).
   * Updates the status bar upon successful validation.
   * @returns {Promise<void>} A promise that resolves if the connection is validated successfully.
   * @throws {Error} If no active connection exists, or if the validation/token renewal process fails.
   * @async
   */
  public async ensureActiveConnectionIsValid(): Promise<void> {
    if (!this.currentConnection) {
      // No connection has been set as active.
      throw new Error("No active connection. Please connect to an environment first.");
    }

    try {
      // Call the connect method on the Connection object.
      // This method contains the logic for token validation and proactive renewal.
      await this.currentConnection.connect(); 
      
      // If connect() succeeds, the token is valid or has been renewed.
      // Update isConnected flag and status bar to reflect the confirmed connected state.
      this.isConnected = true; 
      this.statusBar.text = `Connected: ${this.currentConnection.getConnectionName()}`;
      this.statusBar.tooltip = `Connected to Dynamics 365 environment: ${this.currentConnection.getConnectionName()} (${this.currentConnection.getConnectionURL()})`;
      this.statusBar.show(); // Ensure it's visible.
      console.log(`Active connection to '${this.currentConnection.getConnectionName()}' validated successfully.`);

    } catch (error: unknown) {
      // If this.currentConnection.connect() throws an error (e.g., token renewal failed),
      // it means the connection is no longer valid.
      console.error(`Failed to ensure active connection to '${this.currentConnection.getConnectionName()}' is valid:`, error);
      
      // Update internal state and UI to reflect that the connection is now considered invalid/failed.
      // Calling disconnect() will reset the state and update the status bar.
      this.disconnect(); 
      
      // Re-throw a new error to inform the caller about the validation failure.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to validate active connection to '${this.currentConnection.getConnectionName()}': ${message}`);
    }
  }
}
