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

import { ConfigurationService } from "./../configurationService"; 
import * as vscode from "vscode";
import { SUCCESS_TEMPLATE_HTML, ERROR_TEMPLATE_HTML } from "./authTemplates";

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
  private clientApplication?: PublicClientApplication;
  /** The MSAL TokenCache instance. Initialized in `init()`. */
  private cache!: TokenCache; // Definite assignment: initialized in init() which is called before use.
  /** The currently signed-in user account information. */
  private account?: AccountInfo | null;
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
  /** The VS Code extension context for SecretStorage (optional for compatibility). */
  private context?: vscode.ExtensionContext;
  /** The cache key for storing the token cache in SecretStorage. */
  private cacheKey?: string;
  /**
   * Returns the last authentication result (access token and expiration) if available.
   */
  private lastAuthResult?: AuthenticationResult | null;

  /**
   * Creates an instance of AuthProvider.
   * @param {string} connectionURL The URL of the Dynamics 365 environment.
   * @param {string} connectionId A unique ID for this connection (used for cache keying).
   * @param {string} connectionName A display name for this connection.
   * @param {vscode.ExtensionContext} [context] The VS Code extension context for SecretStorage (optional for compatibility).
   */
  constructor(
    connectionURL: string,
    connectionId: string,
    connectionName: string,
    context?: vscode.ExtensionContext
  ) {
    // Define the default scopes required for Dynamics 365 user impersonation and basic user info.
    this.requiredScopes = [`${connectionURL}/.default`];
    this.connectionURL = connectionURL;
    this.connectionId = connectionId;
    this.connectionName = connectionName;
    this.initialized = false; 
    this.context = context;
    // Note: this.cache and this.clientApplication are initialized in the async init() method.
  }

  /**
   * Initializes the MSAL PublicClientApplication and token cache.
   * This method must be called before any authentication operations.
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   * @throws {Error} If MSAL client configuration or persistence setup fails.
   * @async
   */
  async init(): Promise<void> {
    let connectionFolder: string = ConfigurationService.getConnectionInfoFolder() || "";
    if (connectionFolder.endsWith("/") || connectionFolder.endsWith("\\")) {
      connectionFolder = connectionFolder.slice(0, -1);
    }

    // MSAL client configuration.
    const msalConfig: Configuration = {
      auth: {
        clientId: ConfigurationService.getAppClientId() || "",
      },
    };

    const tenantId = ConfigurationService.getAppTenantId();
    if (tenantId) {
      msalConfig.auth.authority = `https://login.microsoftonline.com/${tenantId}/`;
    }

    this.clientApplication = new PublicClientApplication(msalConfig);
    this.cache = this.clientApplication.getTokenCache();

    // Load cache from SecretStorage if present
    if (this.context) {
      const cacheKey = `${this.connectionId}_msalTokenCache`;
      const persistedCache = await this.context.secrets.get(cacheKey);
      if (persistedCache) {
        await this.cache.deserialize(persistedCache);
      }
      this.cacheKey = cacheKey;
    }
    this.initialized = true;
  }

  /**
   * Persist the MSAL token cache to SecretStorage (if context is available).
   */
  private async persistCache(): Promise<void> {
    if (this.context && this.cacheKey) {
      const serialized = await this.cache.serialize();
      await this.context.secrets.store(this.cacheKey, serialized);
    }
  }

  /**
   * Helper to build interactive token request options.
   */
  private buildInteractiveRequestOptions(scopes: string[], correlationId?: string): InteractiveTokenRequestOptions {
    return {
      scopes,
      openBrowser: async (url: string) => {
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(url));
      },
      successTemplate: SUCCESS_TEMPLATE_HTML,
      errorTemplate: ERROR_TEMPLATE_HTML,
      ...(correlationId && { correlationId }),
    };
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
      if (!this.clientApplication) {
        throw new Error("MSAL Client application could not be initialized.");
      }
      // Try to acquire token silently first (using refresh token if available)
      const tokenRequestBase: Pick<SilentFlowRequest, "scopes"> = {
        scopes: this.requiredScopes,
      };
      let authResponse: AuthenticationResult | null = null;
      let account: AccountInfo | undefined = this.account ?? undefined;
      if (!account) {
        const found = await this.getAccount();
        account = found ?? undefined;
      }
      try {
        // Try silent acquisition (uses refresh token if present in MSAL cache)
        if (account) {
          authResponse = await this.clientApplication.acquireTokenSilent({
            ...tokenRequestBase,
            account,
            forceRefresh: false, // allow MSAL to use refresh token if access token expired
          });
        } else {
          throw new Error("No account available for silent token acquisition.");
        }
      } catch (silentError) {
        // If silent fails (no refresh token, or needs interaction), fallback to interactive
        authResponse = await this.getToken(tokenRequestBase as TokenRequest);
      }
      if (authResponse?.account) {
        this.account = authResponse.account;
      } else {
        this.account = await this.getAccount();
      }
      this.lastAuthResult = authResponse;
      await this.persistCache();
      return authResponse;
    } catch (error: unknown) {
      console.error("Login failed in AuthProvider:", error);
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
    const cachedAccount = await this.getAccount();
    if (cachedAccount) {
      const silentRequest: SilentFlowRequest = {
        ...tokenRequest,
        account: cachedAccount,
      };
      authResponse = await this.getTokenSilent(silentRequest);
    } else {
      const interactiveRequestOptions = this.buildInteractiveRequestOptions(
        tokenRequest.scopes,
        tokenRequest.correlationId
      );
      authResponse = await this.getTokenInteractive(interactiveRequestOptions);
    }
    await this.persistCache();
    return authResponse || null;
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
      const result = await this.clientApplication.acquireTokenSilent(tokenRequest);
      await this.persistCache();
      return result;
    } catch (error: unknown) {
      if (error instanceof InteractionRequiredAuthError) {
        console.log("Silent token acquisition failed (InteractionRequiredAuthError), attempting interactive acquisition.");
        const interactiveRequestOptions = this.buildInteractiveRequestOptions(
          tokenRequest.scopes,
          tokenRequest.correlationId
        );
        const result = await this.getTokenInteractive(interactiveRequestOptions);
        await this.persistCache();
        return result;
      }
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
      // Ensure our custom templates are passed if not already set in tokenRequestOptions (though getToken sets them)
      const requestWithOptions = {
          ...tokenRequestOptions,
          successTemplate: tokenRequestOptions.successTemplate || SUCCESS_TEMPLATE_HTML,
          errorTemplate: tokenRequestOptions.errorTemplate || ERROR_TEMPLATE_HTML,
      };
      // Initiate interactive token acquisition.
      const authResponse = await this.clientApplication.acquireTokenInteractive(requestWithOptions);
      await this.persistCache();
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

  /**
   * Returns the currently signed-in user account information, if any.
   */
  getAccountInfo(): AccountInfo | null | undefined {
    return this.account;
  }

  /**
   * Gets the last access token if available.
   */
  getAccessToken(): string | undefined {
    return this.lastAuthResult?.accessToken;
  }

  /**
   * Gets the last token expiration if available.
   */
  getTokenExpiration(): Date | undefined {
    return this.lastAuthResult?.expiresOn ?? undefined;
  }

  /**
   * Returns whether the AuthProvider has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
