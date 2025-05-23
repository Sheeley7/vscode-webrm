import {
  AccountInfo,
  AuthenticationResult,
  Configuration,
  InteractionRequiredAuthError,
  PublicClientApplication,
  TokenCache, 
  SilentFlowRequest, 
  AuthorizationCodeRequest, 
} from "@azure/msal-node";

import {
  DataProtectionScope,
  PersistenceCreator,
  PersistenceCachePlugin,
} from "@azure/msal-node-extensions";

import { ConfigurationService } from "./../configurationService"; 
import * as vscode from "vscode";

/**
 * Options for an interactive token request.
 * @interface InteractiveTokenRequestOptions
 */
interface InteractiveTokenRequestOptions {
    /** Scopes to request for the token. */
    scopes: string[];
    /** Callback to open the browser for interactive login. */
    openBrowser: (url: string) => Promise<void>;
    /** Optional success template to display in the browser after successful login. */
    successTemplate?: string;
    /** Optional error template to display in the browser if login fails. */
    errorTemplate?: string;
    /** Allows other properties like correlationId. */
    [key: string]: any; 
}

/**
 * Represents a generic token request, covering properties for both silent and interactive flows.
 * @typedef { (SilentFlowRequest | Pick<AuthorizationCodeRequest, "scopes" | "correlationId">) & { account?: AccountInfo } } TokenRequest
 */
type TokenRequest = (SilentFlowRequest | Pick<AuthorizationCodeRequest, "scopes" | "correlationId">) & { account?: AccountInfo };

/**
 * Handles authentication against Azure AD using MSAL (Microsoft Authentication Library).
 * It supports acquiring tokens silently and interactively, and caches tokens securely.
 */
export class AuthProvider {
  /** The MSAL PublicClientApplication instance. Initialized in `init()`. */
  clientApplication?: PublicClientApplication;
  /** The MSAL TokenCache instance. Initialized in `init()`. */
  cache!: TokenCache; // Definite assignment: initialized in init() which is called before use.
  /** The currently signed-in user account information. */
  account?: AccountInfo | null;
  /** The URL of the Dynamics 365 environment this provider is for. */
  readonly connectionURL: string;
  /** A unique ID for the connection, used for caching. */
  readonly connectionId: string;
  /** The display name of the connection. */
  readonly connectionName: string;
  /** Scopes required for accessing the Dynamics 365 API. */
  readonly requiredScopes: string[];
  /** Flag indicating if the AuthProvider has been initialized (MSAL client and cache setup). */
  private initialized: boolean;

  /**
   * Creates an instance of AuthProvider.
   * @param {string} connectionURL The URL of the Dynamics 365 environment.
   * @param {string} connectionId A unique ID for this connection (used for cache keying).
   * @param {string} connectionName A display name for this connection.
   */
  constructor(
    connectionURL: string,
    connectionId: string,
    connectionName: string
  ) {
    // Define the default scopes required for Dynamics 365 user impersonation and basic user info.
    this.requiredScopes = [`${connectionURL}//user_impersonation`, "User.Read"];
    this.connectionURL = connectionURL;
    this.connectionId = connectionId;
    this.connectionName = connectionName;
    this.initialized = false; 
    // Note: this.cache and this.clientApplication are initialized in the async init() method.
  }

  /**
   * Initializes the MSAL PublicClientApplication and token cache.
   * This includes setting up persistent token storage using `@azure/msal-node-extensions`.
   * This method must be called before any authentication operations.
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   * @throws {Error} If MSAL client configuration or persistence setup fails.
   * @async
   * @private
   */
  async init(): Promise<void> {
    // Retrieve the folder path for storing connection cache files from configuration.
    let connectionFolder: string = ConfigurationService.getConnectionInfoFolder() || ""; 
    // Normalize folder path (remove trailing slash).
    if (connectionFolder.endsWith("/") || connectionFolder.endsWith("\\")) {
      connectionFolder = connectionFolder.slice(0, -1);
    }
    // Construct the unique file path for this connection's cache.
    const filePath = `${connectionFolder}/${this.connectionName}-${this.connectionId}.json`;
    
    // Create a persistence plugin for MSAL cache using msal-node-extensions.
    // This enables secure, persistent storage of tokens.
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: filePath,
      dataProtectionScope: DataProtectionScope.CurrentUser, // Encrypt for current user.
      serviceName: "vscode-webrm", // Arbitrary service name for keychain/libsecret.
      accountName: this.connectionId, // Arbitrary account name.
      usePlaintextFileOnLinux: false, // Avoid plaintext on Linux if possible.
    });

    // MSAL client configuration.
    const msalConfig: Configuration = {
      auth: {
        clientId: ConfigurationService.getAppClientId() || "", // Application (Client) ID from settings.
        // Authority is dynamically set if a tenant ID is provided.
      },
      cache: {
        cachePlugin: new PersistenceCachePlugin(persistence), // Use the configured persistence plugin.
      },
    };

    // If a specific tenant ID is configured, set the authority for MSAL.
    const tenantId = ConfigurationService.getAppTenantId(); 
    if (tenantId) { // Check if tenantId is not null, undefined, or empty.
      msalConfig.auth.authority = `https://login.microsoftonline.com/${tenantId}/`;
    }

    // Initialize the MSAL client application.
    this.clientApplication = new PublicClientApplication(msalConfig);
    // Get the token cache instance from the client application.
    this.cache = this.clientApplication.getTokenCache();
    this.initialized = true; // Mark as initialized.
  }

  /**
   * Logs in the user and acquires an authentication token.
   * It first attempts a silent token acquisition, and falls back to interactive login if necessary.
   * @returns {Promise<AuthenticationResult | null>} A promise that resolves with the authentication result, or null if login fails quietly (though it now throws on failure).
   * @throws {Error} If initialization or token acquisition fails.
   * @async
   */
  async login(): Promise<AuthenticationResult | null> {
    try {
      // Ensure MSAL client is initialized.
      if (!this.initialized) {
        await this.init();
      }
      // Ensure clientApplication is available after init.
      if (!this.clientApplication) {
          throw new Error("MSAL Client application could not be initialized.");
      }

      // Define the basic token request with required scopes.
      const tokenRequestBase: Pick<SilentFlowRequest, "scopes"> = { 
        scopes: this.requiredScopes,
      };
      // Attempt to get the token (silent or interactive).
      const authResponse = await this.getToken(tokenRequestBase as TokenRequest); 

      // Store the account information from the successful authentication.
      if (authResponse?.account) { // Check if authResponse and account are not null/undefined.
        this.account = authResponse.account;
      } else {
        // Fallback: If authResponse is somehow null but didn't throw, try to get account from cache.
        // This path might be less common if getToken throws on failure.
        this.account = await this.getAccount(); 
      }

      return authResponse;
    } catch (error: unknown) {
      // Log the error for debugging purposes.
      console.error("Login failed in AuthProvider:", error);
      // Ensure a user-friendly error is propagated.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Authentication failed: ${message}`);
    }
  }

  /**
   * Acquires a token, preferring silent acquisition if a cached account exists,
   * otherwise falls back to interactive acquisition.
   * @param {TokenRequest} tokenRequest The token request object, typically containing scopes.
   * @returns {Promise<AuthenticationResult | null>} A promise that resolves with the authentication result, or null.
   * @throws {Error} If MSAL client is not initialized or token acquisition fails.
   * @async
   * @private
   */
  private async getToken(tokenRequest: TokenRequest): Promise<AuthenticationResult | null> {
    let authResponse: AuthenticationResult | null | undefined; 

    // Attempt to get an account from the cache.
    const cachedAccount = await this.getAccount();

    if (cachedAccount) {
      // If an account is cached, attempt silent token acquisition.
      const silentRequest: SilentFlowRequest = {
        ...tokenRequest, // Spread common properties like scopes, correlationId
        account: cachedAccount, // Provide the cached account for silent flow.
      };
      authResponse = await this.getTokenSilent(silentRequest);
    } else {
      // If no account is cached, proceed with interactive token acquisition.
      // Prepare options for interactive flow.
      const interactiveRequestOptions: InteractiveTokenRequestOptions = {
          scopes: tokenRequest.scopes,
          openBrowser: async (url: string) => { // VS Code specific way to open a browser.
              await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(url));
          },
          successTemplate: "<h1>Successfully signed in!</h1> <p>You can close this window now.</p>",
          errorTemplate: "<h1>Oops! Something went wrong</h1> <p>Check the console for more information.</p>",
      };
      // Include correlationId if provided in the original request.
      if (tokenRequest.correlationId) {
        interactiveRequestOptions.correlationId = tokenRequest.correlationId;
      }
      authResponse = await this.getTokenInteractive(interactiveRequestOptions);
    }

    return authResponse || null; // Return null if undefined.
  }

  /**
   * Attempts to acquire a token silently using MSAL's `acquireTokenSilent`.
   * If silent acquisition fails due to requiring user interaction, it triggers an interactive flow.
   * @param {SilentFlowRequest} tokenRequest The request object for silent token acquisition.
   * @returns {Promise<AuthenticationResult | undefined | null>} A promise that resolves with the authentication result, or undefined/null if unsuccessful.
   * @throws {Error} If MSAL client is not initialized or an unexpected error occurs during silent acquisition.
   * @async
   * @private
   */
  private async getTokenSilent(tokenRequest: SilentFlowRequest): Promise<AuthenticationResult | undefined | null> {
    try {
      if (!this.clientApplication) {
        throw new Error("Client application not initialized for silent token acquisition.");
      }
      // Attempt to acquire token silently.
      return await this.clientApplication.acquireTokenSilent(tokenRequest);
    } catch (error: unknown) {
      // If silent acquisition fails because user interaction is required (e.g., expired refresh token, consent needed),
      // then fall back to interactive authentication.
      if (error instanceof InteractionRequiredAuthError) {
        console.log("Silent token acquisition failed (InteractionRequiredAuthError), attempting interactive acquisition.");
        // Transform the silent request to options suitable for the interactive flow.
        const interactiveRequestOptions: InteractiveTokenRequestOptions = {
            scopes: tokenRequest.scopes,
            openBrowser: async (url: string) => {
                await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(url));
            },
            successTemplate: "<h1>Successfully signed in!</h1> <p>You can close this window now.</p>",
            errorTemplate: "<h1>Oops! Something went wrong</h1> <p>Check the console for more information.</p>",
            ...(tokenRequest.correlationId && { correlationId: tokenRequest.correlationId }), // Preserve correlationId
        };
        return await this.getTokenInteractive(interactiveRequestOptions);
      }
      // For other types of errors during silent acquisition, log and re-throw.
      console.error("Silent token acquisition error (not InteractionRequiredAuthError):", error);
      throw error; 
    }
  }

  /**
   * Acquires a token interactively using MSAL's `acquireTokenInteractive`.
   * This involves opening a browser window for the user to enter credentials.
   * @param {InteractiveTokenRequestOptions} tokenRequestOptions The options for interactive token acquisition.
   * @returns {Promise<AuthenticationResult | null>} A promise that resolves with the authentication result, or null if user cancels or it fails.
   * @throws {Error} If MSAL client is not initialized or an error occurs during interactive acquisition.
   * @async
   * @private
   */
  private async getTokenInteractive(tokenRequestOptions: InteractiveTokenRequestOptions): Promise<AuthenticationResult | null> {
    try {
      if (!this.clientApplication) {
        throw new Error("Client application not initialized for interactive token acquisition.");
      }
      // Initiate interactive token acquisition.
      const authResponse = await this.clientApplication.acquireTokenInteractive(tokenRequestOptions);
      return authResponse;
    } catch (error: unknown) {
      // Log interactive errors and re-throw to be handled by the calling login() method.
      console.error("Interactive token acquisition error:", error);
      throw error; 
    }
  }

  /**
   * Retrieves the cached user account.
   * If multiple accounts are cached, it currently defaults to the first one.
   * @returns {Promise<AccountInfo | null>} A promise that resolves with the account information, or null if no account is found.
   * @async
   * @private
   */
  private async getAccount(): Promise<AccountInfo | null> {
    // Ensure cache is initialized. This is a safeguard.
    if (!this.cache) {
        console.log("Cache not initialized in getAccount. Attempting to initialize.");
        await this.init(); 
        if (!this.cache) { // Check again after attempting init.
            throw new Error("Cache could not be initialized in getAccount.");
        }
    }
    // Get all accounts from the cache.
    const currentAccounts = await this.cache.getAllAccounts();

    if (currentAccounts.length < 1) {
      console.log("No accounts detected in MSAL cache.");
      return null;
    }

    if (currentAccounts.length > 1) {
      // TODO: Future enhancement: Implement account selection UI if multiple accounts are common.
      console.log(`Multiple accounts (${currentAccounts.length}) detected. Defaulting to the first account.`);
      return currentAccounts[0];
    } 
    // Exactly one account found.
    return currentAccounts[0];
  }
}
