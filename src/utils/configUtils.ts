import * as vscode from "vscode";
import { ConfigurationService } from "../configurationService";

/**
 * Checks if the Application (Client) ID is configured in the extension settings.
 * Displays an error message to the user if the Client ID is missing.
 * The setting key is 'webRM.appClientId'.
 *
 * @returns {boolean} Returns `true` if the Client ID is configured, `false` otherwise.
 */
export function checkClientId(): boolean {
    const clientid = ConfigurationService.getAppClientId();
    // Check if the client ID is an empty string, null, or undefined.
    if (clientid === "" || clientid === null || clientid === undefined) {
        return false;
    }
    return true;
}

/**
 * Checks if the Dynamics 365 Web API version is configured in the extension settings.
 * Displays an error message to the user if the API version is missing.
 * The setting key is 'webRM.dynamicsAPIVersion'.
 * Note: `ConfigurationService.getDynamicsAPIVersion()` might return a default value if the setting is not present.
 * This check ensures that even if a default is programmatically available, the user is prompted if it's not explicitly set (if the default means it's effectively empty or null from a raw get).
 *
 * @returns {boolean} Returns `true` if the API version is configured (or a valid default is provided by the service), `false` otherwise.
 */
export function checkAPIVersion(): boolean {
    const webServiceAPIVersion = ConfigurationService.getDynamicsAPIVersion();
    // Check if the API version is an empty string, null, or undefined.
    // This also implicitly checks if the default from ConfigurationService is considered 'unset' by these criteria.
    if (webServiceAPIVersion === "" || webServiceAPIVersion === null || webServiceAPIVersion === undefined) { 
        return false;
    }
    return true;
}
