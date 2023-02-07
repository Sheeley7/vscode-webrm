import {
  AccountInfo,
  AuthenticationResult,
  Configuration,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from "@azure/msal-node";

import {
  DataProtectionScope,
  PersistenceCreator,
  PersistenceCachePlugin,
  FilePersistence,
} from "@azure/msal-node-extensions";

import { getConfig } from "./../extension";

import * as vscode from "vscode";

export class AuthProvider {
  clientApplication?: PublicClientApplication;
  cache: any;
  account?: AccountInfo | null;
  connectionURL: string;
  connectionId: string;
  connectionName: string;
  requiredScopes: any;
  initialized: boolean;

  constructor(
    connectionURL: string,
    connectionId: string,
    connectionName: string
  ) {
    this.requiredScopes = [`${connectionURL}//user_impersonation`, "User.Read"];
    this.connectionURL = connectionURL;
    this.connectionId = connectionId;
    this.connectionName = connectionName;
    this.initialized = false;
  }

  async init() {
    let connectionFolder: string =
      getConfig().get("connectionInfoFolder") || "";
    if (connectionFolder.endsWith("/") || connectionFolder.endsWith("\\")) {
      connectionFolder = connectionFolder.slice(0, -1);
    }
    let filePath = `${connectionFolder}/${this.connectionName}-${this.connectionId}.json`;
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: filePath,
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "vscode-webrm",
      accountName: this.connectionId,
      usePlaintextFileOnLinux: false,
    });

    const msalConfig: Configuration = {
      auth: {
        clientId: getConfig().get("appClientId") || "",
      },
      cache: {
        cachePlugin: new PersistenceCachePlugin(persistence),
      },
    };
    const tenantId = getConfig().get("appTenantId");
    if (tenantId !== null && tenantId !== "" && tenantId !== undefined) {
      msalConfig.auth.authority = `https://login.microsoftonline.com/${tenantId}/`;
    }

    this.clientApplication = new PublicClientApplication(msalConfig);
    this.cache = this.clientApplication.getTokenCache();
    this.initialized = true;
  }
  async login(): Promise<AuthenticationResult | null> {
    try {
      if (!this.initialized) {
        await this.init();
      }
      const tokenRequest = {
        scopes: this.requiredScopes,
      };
      const authResponse = await this.getToken(tokenRequest);

      if (authResponse !== null) {
        this.account = authResponse.account;
      } else {
        this.account = await this.getAccount();
      }

      return authResponse;
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  async getToken(tokenRequest: any) {
    let authResponse;

    const account = await this.getAccount();

    if (account) {
      tokenRequest.account = account;
      authResponse = await this.getTokenSilent(tokenRequest);
    } else {
      authResponse = await this.getTokenInteractive(tokenRequest);
    }

    return authResponse || null;
  }

  async getTokenSilent(tokenRequest: any) {
    try {
      return await this.clientApplication?.acquireTokenSilent(tokenRequest);
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        console.log(
          "Silent token acquisition failed, acquiring token interactive"
        );
        return await this.getTokenInteractive(tokenRequest);
      }

      console.log(error);
    }
  }
  async getTokenInteractive(tokenRequest: any) {
    try {
      const openBrowser = async (url: string) => {
        vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(url));
      };

      const authResponse =
        await this.clientApplication?.acquireTokenInteractive({
          ...tokenRequest,
          openBrowser,
          successTemplate:
            "<h1>Successfully signed in!</h1> <p>You can close this window now.</p>",
          errorTemplate:
            "<h1>Oops! Something went wrong</h1> <p>Check the console for more information.</p>",
        });

      return authResponse;
    } catch (error) {
      throw error;
    }
  }

  async getAccount() {
    const currentAccounts = await this.cache.getAllAccounts();

    if (currentAccounts.length < 1) {
      console.log("No accounts detected");
      return null;
    }

    if (currentAccounts.length > 1) {
      // Add choose account code here
      console.log(
        "Multiple accounts detected, need to add choose account code."
      );
      return currentAccounts[0];
    } else if (currentAccounts.length === 1) {
      return currentAccounts[0];
    } else {
      return null;
    }
  }
}
