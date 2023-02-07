import { Connection } from "./views/connectionExplorer";
import { StatusBarItem } from "vscode";

export class ConnectionStatusController {
  private isConnected = false;
  private currentConnection: Connection | undefined;
  private statusBar: StatusBarItem;
  private webResourceLookup: any;
  private disposalFunction: any;

  constructor(statusBar: StatusBarItem) {
    this.statusBar = statusBar;
    this.webResourceLookup = {};
  }

  setCurrentConnection(connection: Connection) {
    this.currentConnection = connection;
  }

  getCurrentConnection() {
    return this.currentConnection;
  }

  getResourceIdFromPath(path: string) {
    return this.webResourceLookup[path];
  }

  setWebResources(webResourceLookup: any) {
    this.webResourceLookup = webResourceLookup;
  }

  async connect() {
    this.webResourceLookup = {};
    if (this.currentConnection !== undefined) {
      await this.currentConnection.connect();

      this.isConnected = true;
      this.statusBar.text =
        "Connected to: " + this.currentConnection.getConnectionName();
      this.statusBar.show();
    }
  }

  disconnect() {
    this.currentConnection = undefined;
    this.isConnected = false;
    this.statusBar.text = "Not Connected";
    this.statusBar.show();
  }

  public addSyncedWebResource(filePath: string, webResourceId: string) {
    this.webResourceLookup[filePath] = webResourceId;
  }
}
