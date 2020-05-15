import * as vscode from 'vscode';
import { AuthServer } from '../auth/server/localserver';
import * as request from 'request';
import { getConfig } from '../extension';
import * as keytar from 'keytar';
import e = require('express');
import { v1 as uuidv1 } from 'uuid';
import { promises } from 'fs';
import { stringify } from 'querystring';
import { AuthenticationContext, TokenResponse, ErrorResponse } from 'adal-node'


const serviceName = "vscode-webrm";

export class ConnectionExplorer implements vscode.TreeDataProvider<Connection> {
    
    private connections: Connection[] = [];
    
    constructor(private globalContext: vscode.ExtensionContext) {
        var connections =  globalContext.globalState.get<any[]>("connections", []);
        for(var i = 0; i < connections.length; i++) {
            //this.childItems.push();
            let connection = new Connection(connections[i], vscode.TreeItemCollapsibleState.None);
            this.connections.push(connection);
          
        }
    }

    private _onDidChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
    readonly onDidChangeTreeData: vscode.Event<any> = this._onDidChangeTreeData.event;
    getTreeItem(element: Connection): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }

    getChildren(element?: Connection): vscode.ProviderResult<Connection[]> {
        return this.connections;
    }

    async addItem(name: string, url: string) {
        if(this.connections.findIndex((c)=> { return c.getConnectionName() === name; }) === -1) {
            let connection = new Connection({"connectionName": name, "connectionURL": url}, vscode.TreeItemCollapsibleState.None);
            this.connections.push(connection);
            await this.globalContext.globalState.update("connections", this.connections);
            this.refresh();
            return true;
        }
        else {
            return false;
        }
        
    }

    async refreshConnectionsGlobalState() {
        await this.globalContext.globalState.update("connections", this.connections);
    }

    async removeItem(connectionToRemove: Connection) {
        let connectionToRemoveId = connectionToRemove.getConnectionId();
        this.connections = this.connections.filter((connection) => { 
            return connection.getConnectionId() !== connectionToRemoveId; 
        });
        connectionToRemove.deleteConnection();
        await this.globalContext.globalState.update("connections", this.connections);
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

}

interface RefreshResult {
    accessToken: string;
    refreshToken: string;
    tokenExpiration: Date;
}

export class Connection extends vscode.TreeItem {
    public contextValue: string = "connection";
    public label: string;
    public collapsibleState: vscode.TreeItemCollapsibleState;

    private connectionName: string;
    private connectionURL: string;
    #accessToken: string;
    #refreshToken: string;
    #tokenExpiration: Date;
    private accessTokenKey: string;
    private refreshTokenKey: string;
    private tokenExpirationKey: string;
    private connectionId: string;
    private intialized: boolean;
    public authServerDisposal: () => void;

    constructor(connectionObj: any, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(connectionObj.connectionName, collapsibleState);
        
        this.label = connectionObj.connectionName;
        this.connectionName = connectionObj.connectionName;
        this.connectionURL = connectionObj.connectionURL;
        this.#accessToken = "";
        this.#refreshToken = "";
        this.#tokenExpiration = new Date("1995-12-17T03:24:00");
        this.intialized = false;
        this.authServerDisposal = () => {};
        
        if(connectionObj.connectionId === null || typeof(connectionObj.connectionId) === "undefined" || connectionObj.connectionId === "") {
            this.connectionId = uuidv1().replace(/-/g, '');
        }
        else {
            this.connectionId = connectionObj.connectionId;
        }
    
        this.accessTokenKey = this.connectionName + "|" + this.connectionId + "|ACCESSTOKEN";
        this.refreshTokenKey = this.connectionName + "|" + this.connectionId + "|REFRESHTOKEN";
        this.tokenExpirationKey = this.connectionName + "|" + this.connectionId + "|TOKENEXPIRATION";

        this.collapsibleState = collapsibleState;
    }

    async connect() {

        let connectionSuccessful = false;

        //If not intialized, get values from the keystore
        if(this.intialized === false) {
            await this.setTokenValuesFromKeyStore();
        }

        //If the access token has expired
        if(this.getTokenExpiration() < new Date()) {

            //If there is no refresh token, then get tokens from the browser
            if(this.getRefreshToken() === "") {
                connectionSuccessful = await this.setAuthFromBrowser();
            }
            //Otherwise, attempt to refresh the token
            else {
                try {
                    connectionSuccessful = await this.refreshAccessToken();
                }
                
                catch(err) {
                    //If the refresh has an invalid grant error, try to get tokens from the browser
                    if(err === "invalid_grant") {
                        connectionSuccessful = await this.setAuthFromBrowser();
                    }
                    else {
                        throw(err);
                    }  
                    
                }       
            }
        }
        //Otherwise return connection successful as we already have tokens that are not expired
        else {
            connectionSuccessful =  true;
        }

        return connectionSuccessful;
    }

    async setAuthFromBrowser() {
        try {

            const { createServer, dispose } = await AuthServer(this.connectionURL);
            this.authServerDisposal = dispose;
            //connectionStatusController.setConnectionServerDisposal(dispose);
            let result = await createServer;
            dispose();
            this.authServerDisposal = () => {};
            this.#accessToken = result.access_token;
            this.#refreshToken = result.refresh_token;
            let asyncOps = [];
            let dateNow = new Date();
            dateNow.setMinutes(dateNow.getMinutes() + 58);
            this.#tokenExpiration = dateNow;
            asyncOps.push(keytar.setPassword(serviceName, this.accessTokenKey, this.#accessToken));
            asyncOps.push(keytar.setPassword(serviceName, this.refreshTokenKey, this.#refreshToken));
            asyncOps.push(keytar.setPassword(serviceName, this.tokenExpirationKey, this.#tokenExpiration.toISOString()));

            await Promise.all(asyncOps);
            this.intialized = true;
            return true;
    
        }
        catch(err) {
            return false;
        }
        
    }

    async refreshAccessToken() {
        let refreshToken = this.getRefreshToken();

        //If the refresh token is blank, throw an error
        if(refreshToken === ""){
            throw new Error("An attempt to refresh token was made, but no refresh token was provided");
        }

        var connectionURL = this.connectionURL;        
        let refreshResult;
        if(getConfig().get('useLocalAuth') === true) {
            refreshResult = await this.refreshTokenFromLocalAuth(refreshToken);
        }
        else {
            refreshResult = await this.refreshTokenFromAuthServer(refreshToken);
        }
        
        //Update the Connection object with the new token results
        this.setAccessToken(refreshResult.accessToken);
        this.setRefreshToken(refreshResult.refreshToken);
        this.setTokenExpiration(refreshResult.tokenExpiration);

        this.intialized = true;

        //Update the tokens in the keystore
        await this.updateTokenValuesInKeyStore(refreshResult.accessToken, refreshResult.refreshToken, refreshResult.tokenExpiration);

        return true;
    }

    private async refreshTokenFromLocalAuth(refreshToken: string) {
        let clientId = getConfig().get('appClientId') as string;
        let client_secret = getConfig().get('appClientSecret') as string;
        let  authority_url = 'https://login.windows.net';
        let authenticationContext = new AuthenticationContext(authority_url + "/common");
        let self = this;
        let refreshResult = await new Promise<RefreshResult>(function(resolve, reject){
            authenticationContext.acquireTokenWithRefreshToken(refreshToken, clientId, client_secret, self.connectionURL, function(refreshErr: Error, refreshResponse: TokenResponse|ErrorResponse){
                try {
                    if(refreshErr) {
                        refreshResponse = refreshResponse as ErrorResponse;
                        if(refreshResponse.error === "invalid_grant") {
                            reject("invalid_grant");
                        }
                        else reject(refreshResponse.error);
                    }
                    else {
                        refreshResponse = refreshResponse as TokenResponse;
                        let accessTokenResult = refreshResponse.accessToken;
                        let refreshTokenResult = refreshResponse.refreshToken;
                        let tokenExpirationResult = refreshResponse.expiresOn;
                        if(refreshTokenResult === undefined) {
                            refreshTokenResult = '';
                        }

                        if(typeof(accessTokenResult) === undefined || typeof(refreshTokenResult) === undefined  || typeof(tokenExpirationResult) === undefined) {
                            throw new Error("Could not retrieve updated access token with refresh token.\n" + refreshResponse);
                        }
                        else {
                            resolve({ accessToken: accessTokenResult, refreshToken: refreshTokenResult, tokenExpiration: new Date(tokenExpirationResult)});
                        }
                    }   
                }
                catch(e) {
                    reject(e);
                }
            });
        });
        return refreshResult;
    }

    private async refreshTokenFromAuthServer(refreshToken: string) {
        //Attempt to refresh the access token using the refresh token
        var getURL = getConfig().get('authWebServiceURL') + "/refresh_token?crm_url=" + this.connectionURL + "&refresh_token="+ refreshToken;
        let refreshResult = await new Promise<RefreshResult>(function(resolve, reject) {
            var options: any = {};
            options.url = getURL;
            request(options, (err: any, res: any, body: any) => {
                if(err) {
                    return reject(err);
                }
                try {
                    var jsonResult = JSON.parse(body);
                    if(jsonResult.error === "invalid_grant") {
                        reject("invalid_grant");
                    }
                    else if (jsonResult.error !== undefined) {
                        reject(jsonResult.error);
                    }
                    else {
                        let accessTokenResult = jsonResult.accessToken;
                        let refreshTokenResult = jsonResult.refreshToken;
                        let tokenExpirationResult = jsonResult.expiresOn;

                        if(typeof(accessTokenResult) === undefined || typeof(refreshTokenResult) === undefined  || typeof(tokenExpirationResult) === undefined) {
                            throw new Error("Could not retrieve updated access token with refresh token.\n" + jsonResult);
                        }
                        //self.updateValuesInKeyStore();
                        resolve({ accessToken: jsonResult.accessToken, refreshToken: jsonResult.refreshToken, tokenExpiration: new Date(tokenExpirationResult)});
                    }   
                }
                catch(e) {
                    reject(e);
                }
            });
        });

        return refreshResult;
    }

    private async setTokenValuesFromKeyStore() {

        const [accessToken, refreshToken, tokenExpiration ] = await Promise.all([
            keytar.getPassword(serviceName, this.accessTokenKey),
            keytar.getPassword(serviceName, this.refreshTokenKey),
            keytar.getPassword(serviceName, this.tokenExpirationKey)
        ]);
        this.setAccessToken((accessToken !== null ? accessToken : ""));
        this.setRefreshToken((refreshToken !== null ? refreshToken : ""));
        this.setTokenExpiration((tokenExpiration !== null ? new Date(tokenExpiration) : new Date("1995-12-17T03:24:00")));
        this.intialized = true;
    }

    private async updateTokenValuesInKeyStore(accessToken: string, refreshToken: string, tokenExpiration: Date) {
        let asyncOps = [];
        asyncOps.push(keytar.setPassword(serviceName, this.accessTokenKey, accessToken));
        asyncOps.push(keytar.setPassword(serviceName, this.refreshTokenKey, refreshToken));
        asyncOps.push(keytar.setPassword(serviceName, this.tokenExpirationKey, tokenExpiration.toISOString()));
        await Promise.all(asyncOps);
    }

    public async deleteConnection() {
        let deletes = [];
        deletes.push(keytar.deletePassword(serviceName, this.refreshTokenKey));
        deletes.push(keytar.deletePassword(serviceName, this.accessTokenKey));
        deletes.push(keytar.deletePassword(serviceName, this.tokenExpirationKey));
        let result = await Promise.all(deletes);

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
    public getRefreshToken() {
        return this.#refreshToken;
    }
    public setTokenExpiration(newDate: Date) {
        this.#tokenExpiration = newDate;
    }
    public getTokenExpiration() {
        return this.#tokenExpiration;
    }
    public setRefreshToken(newToken: string) {
        this.#refreshToken = newToken;
    }
    public getConnectionId() {
        return this.connectionId;
    }
    
}

