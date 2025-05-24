import * as vscode from "vscode";

// #region HTML Templates for Interactive Login
const SUCCESS_TEMPLATE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 40px; text-align: center; background-color: #f0f2f5; color: #333; display: flex; justify-content: center; align-items: center; height: 90vh; }
        .container { background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 6px 12px rgba(0,0,0,0.15); display: inline-block; max-width: 500px; }
        h1 { color: #2c8c2c; font-size: 1.8em; margin-bottom: 20px; }
        p { font-size: 1.1em; line-height: 1.6; }
        .close-message { margin-top: 30px; font-size: 0.95em; color: #555; }
        .icon { font-size: 3em; color: #2c8c2c; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✓</div>
        <h1>Authentication Successful!</h1>
        <p>You have successfully signed in to the Dynamics 365 Web Resource Manager extension.</p>
        <p class="close-message">You can now close this browser window and return to VS Code.</p>
    </div>
</body>
</html>
`;

const ERROR_TEMPLATE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Failed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 40px; text-align: center; background-color: #f0f2f5; color: #333; display: flex; justify-content: center; align-items: center; height: 90vh; }
        .container { background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 6px 12px rgba(0,0,0,0.15); display: inline-block; max-width: 500px; }
        h1 { color: #d93025; font-size: 1.8em; margin-bottom: 20px; }
        p { font-size: 1.1em; line-height: 1.6; }
        .error-details { margin-top: 20px; font-size: 0.95em; color: #555; }
        .close-message { margin-top: 30px; font-size: 0.95em; color: #555; }
        .icon { font-size: 3em; color: #d93025; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✕</div>
        <h1>Authentication Failed</h1>
        <p>Oops! Something went wrong during the authentication process.</p>
        <p class="error-details">Please try again. If the problem persists, check the VS Code extension output channel (Web Resource Manager) for more details or contact your administrator.</p>
        <p class="close-message">You can close this browser window.</p>
    </div>
</body>
</html>
`;
// #endregion HTML Templates

/**
 * Handles authentication using VS Code's native authentication API.
 * Supports acquiring tokens via the built-in authentication provider.
 */
export class AuthProvider {
  /** The VS Code authentication provider ID (e.g., 'azure-account'). */
  static readonly providerId = "azure-account";
  /** The required scopes for the session. */
  readonly requiredScopes: string[];
  /** The resource for which to request a token (Dynamics 365 environment URL). */
  readonly resource: string;
  /** The URL of the Dynamics 365 environment this provider is for. */
  readonly connectionURL: string;
  /** A unique ID for the connection, used for caching. */
  readonly connectionId: string;
  /** The display name of the connection. */
  readonly connectionName: string;
  /** The current session. */
  private session?: vscode.AuthenticationSession | null;

  constructor(
    connectionURL: string,
    connectionId: string,
    connectionName: string
  ) {
    // For azure-account, scopes can be empty, but resource must be set
    this.requiredScopes = [];
    this.resource = connectionURL;
    this.connectionURL = connectionURL;
    this.connectionId = connectionId;
    this.connectionName = connectionName;
  }

  /**
   * Logs in the user and acquires an authentication token using VS Code authentication API.
   * @returns {Promise<vscode.AuthenticationSession | null>} The authentication session or null if login fails.
   */
  async login(): Promise<vscode.AuthenticationSession | null> {
    try {
      // Prompt the user to sign in if no session exists.
      this.session = await vscode.authentication.getSession(
        AuthProvider.providerId,
        this.requiredScopes,
        { createIfNone: true, resource: this.resource } as any
      );
      return this.session;
    } catch (error: unknown) {
      console.error("Login failed in AuthProvider:", error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Authentication failed: ${message}`);
    }
  }

  /**
   * Gets the current authentication session, or prompts the user if not signed in.
   * @returns {Promise<vscode.AuthenticationSession | null>} The authentication session or null.
   */
  async getSession(): Promise<vscode.AuthenticationSession | null> {
    if (this.session) {
      return this.session;
    }
    return this.login();
  }

  /**
   * Gets the access token from the current session.
   * @returns {Promise<string | null>} The access token or null if not authenticated.
   */
  async getAccessToken(): Promise<string | null> {
    const session = await this.getSession();
    return session?.accessToken || null;
  }

  /**
   * Gets the account information from the current session.
   * @returns {Promise<vscode.AuthenticationSessionAccountInformation | null>} The account info or null.
   */
  async getAccount(): Promise<vscode.AuthenticationSessionAccountInformation | null> {
    const session = await this.getSession();
    return session?.account || null;
  }
}
