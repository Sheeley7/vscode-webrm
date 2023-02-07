import * as vscode from "vscode";
import * as keytar from "keytar";
import e = require("express");
import { v1 as uuidv1 } from "uuid";
import { AuthProvider } from "../auth/authProvider";
import { getConfig } from "./../extension";
import * as fs from "fs";

const serviceName = "vscode-webrm";

export class ConnectionExplorer implements vscode.TreeDataProvider<Connection> {
  private connections: Connection[] = [];

  constructor(private globalContext: vscode.ExtensionContext) {
    var connections = globalContext.globalState.get<any[]>("connections", []);
    for (var i = 0; i < connections.length; i++) {
      let connection = new Connection(
        connections[i],
        vscode.TreeItemCollapsibleState.None
      );
      this.connections.push(connection);
    }
  }

  private _onDidChangeTreeData: vscode.EventEmitter<any> =
    new vscode.EventEmitter<any>();
  readonly onDidChangeTreeData: vscode.Event<any> =
    this._onDidChangeTreeData.event;
  getTreeItem(
    element: Connection
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: Connection): vscode.ProviderResult<Connection[]> {
    return this.connections;
  }

  async addItem(name: string, url: string) {
    if (
      this.connections.findIndex((c) => {
        return c.getConnectionName() === name;
      }) === -1
    ) {
      let connection = new Connection(
        { connectionName: name, connectionURL: url },
        vscode.TreeItemCollapsibleState.None
      );
      this.connections.push(connection);
      await this.globalContext.globalState.update(
        "connections",
        this.connections
      );
      this.refresh();
      return true;
    } else {
      return false;
    }
  }

  async refreshConnectionsGlobalState() {
    await this.globalContext.globalState.update(
      "connections",
      this.connections
    );
  }

  async removeItem(connectionToRemove: Connection) {
    let connectionToRemoveId = connectionToRemove.getConnectionId();
    this.connections = this.connections.filter((connection) => {
      return connection.getConnectionId() !== connectionToRemoveId;
    });
    connectionToRemove.deleteConnection();
    await this.globalContext.globalState.update(
      "connections",
      this.connections
    );
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }
}

export class Connection extends vscode.TreeItem {
  public contextValue: string = "connection";
  public label: string;
  public collapsibleState: vscode.TreeItemCollapsibleState;

  private connectionName: string;
  private connectionURL: string;
  #accessToken: string;
  #tokenExpiration: Date;

  private connectionId: string;
  private intialized: boolean;
  private authProvider: AuthProvider;

  constructor(
    connectionObj: any,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(connectionObj.connectionName, collapsibleState);

    this.label = connectionObj.connectionName;
    this.connectionName = connectionObj.connectionName;
    this.connectionURL = connectionObj.connectionURL;
    this.#accessToken = "";
    this.#tokenExpiration = new Date("1995-12-17T03:24:00");
    //this.#accountInfoString = "";
    this.intialized = false;

    if (
      connectionObj.connectionId === null ||
      typeof connectionObj.connectionId === "undefined" ||
      connectionObj.connectionId === ""
    ) {
      this.connectionId = uuidv1().replace(/-/g, "");
    } else {
      this.connectionId = connectionObj.connectionId;
    }

    this.authProvider = new AuthProvider(
      this.connectionURL,
      this.connectionId,
      this.connectionName
    );

    this.collapsibleState = collapsibleState;
  }

  async connect() {
    let connectionSuccessful = false;

    if (this.getTokenExpiration() < new Date()) {
      const authResult = await this.authProvider.login();

      if (authResult === null) {
        throw "AuthError";
      }

      this.setAccessToken(authResult.accessToken);
      this.setTokenExpiration(authResult.expiresOn);

      connectionSuccessful = true;

      this.intialized = true;
    }
    //Otherwise return connection successful as we already have tokens that are not expired
    else {
      connectionSuccessful = true;
    }

    return connectionSuccessful;
  }

  public async deleteConnection() {
    //Delete connection file from file system
    const fileName = `${getConfig().get("connectionInfoFolder")}/${
      this.connectionName
    }-${this.connectionId}.json`;

    try {
      fs.unlinkSync(fileName);
    } catch (error) {
      console.log("could not delete file");
    }
  }

  public getConnectionName() {
    return this.connectionName;
  }
  public getConnectionURL() {
    return this.connectionURL;
  }
  public getAccessToken() {
    return this.#accessToken;
  }
  public setAccessToken(newToken: string) {
    this.#accessToken = newToken;
  }

  public setTokenExpiration(newDate: Date | null) {
    const dateNowPlus1Hour = new Date();
    dateNowPlus1Hour.setMinutes(dateNowPlus1Hour.getMinutes() + 58);
    this.#tokenExpiration = newDate || dateNowPlus1Hour;
  }
  public getTokenExpiration() {
    return this.#tokenExpiration;
  }
  public getConnectionId() {
    return this.connectionId;
  }
}
