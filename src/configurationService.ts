import * as vscode from "vscode";

/**
 * Provides a centralized way to access extension configuration settings.
 */
export class ConfigurationService {
    /**
     * Retrieves the workspace configuration for the 'webRM' extension.
     * @returns {vscode.WorkspaceConfiguration} The workspace configuration object.
     * @private
     */
    private static getConfiguration(): vscode.WorkspaceConfiguration {
        // Fetches the configuration section specific to this extension.
        return vscode.workspace.getConfiguration("webRM");
    }

    /**
     * Gets the 'authWebServiceURL' from the extension settings.
     * This URL is used for authentication purposes.
     * @returns {string | undefined} The authentication web service URL, or undefined if not set.
     */
    static getAuthWebServiceURL(): string | undefined {
        return this.getConfiguration().get("authWebServiceURL");
    }

    /**
     * Gets the 'appClientId' (Application Client ID) from the extension settings.
     * This ID is used for OAuth 2.0 authentication with Azure AD.
     * @returns {string | undefined} The Application Client ID, or undefined if not set.
     */
    static getAppClientId(): string | undefined {
        return this.getConfiguration().get("appClientId");
    }

    /**
     * Gets the 'connectionInfoFolder' from the extension settings.
     * This folder is used to store connection information files.
     * @returns {string | undefined} The path to the connection info folder, or undefined if not set.
     */
    static getConnectionInfoFolder(): string | undefined {
        return this.getConfiguration().get("connectionInfoFolder");
    }

    /**
     * Gets the 'dynamicsAPIVersion' from the extension settings.
     * This specifies the version of the Dynamics 365 Web API to use (e.g., "9.1", "9.2").
     * Defaults to "9.2" if not explicitly set.
     * @returns {string | undefined} The Dynamics API version string, or "9.2" if not set.
     */
    static getDynamicsAPIVersion(): string | undefined {
        // Default to 9.2 if not set, as it's a common and recent version.
        // Callers should handle the possibility of this being undefined if the default is removed.
        return this.getConfiguration().get("dynamicsAPIVersion") || "9.2";
    }

    /**
     * Gets the 'solutionNameFilter' from the extension settings.
     * This filter is used to narrow down the list of solutions displayed.
     * @returns {string | undefined} The solution name filter string, or undefined if not set.
     */
    static getSolutionNameFilter(): string | undefined {
        return this.getConfiguration().get("solutionNameFilter");
    }

    /**
     * Gets the 'solutionSortAscending' boolean flag from the extension settings.
     * Determines if solutions should be sorted in ascending order by name.
     * Defaults to true (ascending) if not set.
     * @returns {boolean} True if solutions should be sorted ascending, false for descending.
     */
    static getSolutionSortAscending(): boolean {
        // Defaults to true (ascending sort) if the setting is not found.
        return this.getConfiguration().get("solutionSortAscending", true);
    }

    /**
     * Gets the 'appTenantId' (Application Tenant ID) from the extension settings.
     * This ID specifies the Azure AD tenant to authenticate against.
     * @returns {string | undefined} The Application Tenant ID, or undefined if not set.
     */
    static getAppTenantId(): string | undefined {
        return this.getConfiguration().get("appTenantId");
    }
}
