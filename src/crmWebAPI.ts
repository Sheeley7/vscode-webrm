import * as vscode from "vscode";
import { Connection } from "./views/connectionExplorer";
import fetch from 'node-fetch';
import { Response, RequestInit } from 'node-fetch';
import { Solution } from "./views/solutionExplorer";
import { WebResource } from "./views/webResourceExplorer";
import * as path from "path";
import { ConfigurationService } from "./configurationService";

// #region Interfaces for API Payloads and Responses
/**
 * Represents the raw data structure for a Solution record retrieved from Dynamics 365.
 */
interface RawSolution {
    solutionid: string;
    friendlyname: string;
    uniquename: string;
    // Additional properties can be added here if selected in OData queries.
}

/**
 * Represents the raw data structure for a Web Resource record (specifically from msdyn_solutioncomponentsummaries)
 * retrieved from Dynamics 365.
 */
interface RawWebResource {
    msdyn_objectid: string; // The ID of the web resource.
    msdyn_name: string;     // The full logical name/path of the web resource.
    // Additional properties can be added.
}

/**
 * Represents the structure of the response when fetching the content of a single web resource.
 */
interface WebResourceContent {
    content: string; // Base64 encoded string of the web resource content.
    webresourceid?: string; // Often included in the response.
    modifiedon: string;
    modifiedby: {
        fullname: string;
    };
}

/**
 * Represents the structure of the response from the PublishXml action.
 * This is often an empty response on success, but defining it allows for future extension.
 */
interface PublishXmlResponse {
    // Dynamics 365 PublishXml action typically returns a 200/204 status with no significant body on success.
    // If a specific structure is expected, it can be defined here.
}

/**
 * Defines the structure for updating a record, currently tailored for web resource content.
 * Can be expanded for other entity update operations.
 */
interface UpdateRequest {
    content?: string; // Base64 content for web resources.
    // Other fields for different entities can be added, e.g., 'description', 'displayname'.
    [key: string]: string | number | boolean | undefined; // Allows other string-keyed properties.
}

/**
 * Defines the structure for parameters passed to the PublishXml Dynamics 365 action.
 */
interface PublishXmlParams {
    ParameterXml: string; // XML string specifying entities to publish.
}
// #endregion Interfaces

// #region OData Constants
// Constants for OData query construction and headers.
const ODATA_MAX_VERSION = "4.0";
const ODATA_VERSION = "4.0";
const APPLICATION_JSON_CHARSET_UTF8 = "application/json; charset=utf-8";
const ODATA_INCLUDE_ANNOTATIONS = 'odata.include-annotations="*"'; // Recommended by Microsoft for full metadata.
const API_DATA_V = "/api/data/v"; // Base path for Dynamics 365 Web API.

// Entity set names used in OData queries.
const ENTITY_SOLUTIONS = "solutions";
const ENTITY_WEBRESOURCE_SET = "webresourceset"; // Entity set for web resources.
const ENTITY_MSDYN_SOLUTION_COMPONENT_SUMMARIES = "msdyn_solutioncomponentsummaries"; // For solution components.

// OData query option keywords.
const QUERY_SELECT = "?$select=";
const QUERY_FILTER = "&$filter=";
const QUERY_ORDERBY = "&$orderby=";
// #endregion OData Constants

/**
 * Provides static methods to interact with the Dynamics 365 Web API.
 * This class encapsulates data retrieval and modification operations.
 */
export class CrmWebAPI {
    /**
     * Retrieves a list of solutions from the connected Dynamics 365 environment.
     * Filters solutions based on configuration settings (name filter, visibility, managed status).
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {vscode.ExtensionContext} globalContext The VS Code extension context for accessing global state (e.g., favorite solutions).
     * @returns {Promise<Solution[]>} A promise that resolves to an array of Solution objects.
     * @throws {Error} If the API request fails or returns an unexpected response structure.
     */
    static async getSolutions(
        connection: Connection
        // globalContext: vscode.ExtensionContext, // Removed globalContext
    ): Promise<RawSolution[]> { // Return RawSolution[]
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const solutionFilter = ConfigurationService.getSolutionNameFilter();
        let additionalFilter = "";
        // Apply solution name filter if configured.
        if (solutionFilter != null && solutionFilter !== "") {
            additionalFilter =
                ` and contains(friendlyname, '${solutionFilter}')`;
        }

        const sortOrder = ConfigurationService.getSolutionSortAscending()
            ? "asc"  // Ascending sort order.
            : "desc"; // Descending sort order.

        // Construct the OData query for solutions.
        const solutionQuery = 
            `${API_DATA_V}${apiVersion}/${ENTITY_SOLUTIONS}` +
            `${QUERY_SELECT}friendlyname,uniquename,solutionid` +
            `${QUERY_FILTER}ismanaged eq false and isvisible eq true${additionalFilter}` + // Filter for unmanaged, visible solutions.
            `${QUERY_ORDERBY}friendlyname ${sortOrder}`;

        const rawSolutions = await this.getRecords<RawSolution>(connection, solutionQuery);
        
        // Logic for creating Solution objects and checking favorites is moved to SolutionExplorer/command handler.
        return rawSolutions; // Return raw data
    }

    /**
     * Retrieves the content of a specific web resource.
     * The content is fetched as a base64 encoded string and set on the provided WebResource object.
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {WebResource} webResource The WebResource object for which to fetch content. Its `webResourceContent` property will be updated.
     * @returns {Promise<void>} A promise that resolves when the content has been fetched and set.
     * @throws {Error} If the API request fails, the web resource content is not found, or the response is in an unexpected format.
     */
    static async getWebResourceDetails(
        connection: Connection,
        webResource: WebResource // Input WebResource object, its content property is updated.
    ): Promise<WebResourceContent> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        // Construct OData query to select only the 'content' field of the web resource.
        const contentQuery = `${API_DATA_V}${apiVersion}/${ENTITY_WEBRESOURCE_SET}(${webResource.getWebResourceId()})?$select=content,modifiedon&$expand=modifiedby($select=fullname)`;
        
        const webResourceRecord = await this.getRecord<WebResourceContent>(connection, contentQuery);
        
        // Validate the response and update the webResource object.
        if (webResourceRecord && typeof webResourceRecord.content === 'string') {
            return webResourceRecord;
        } else {
            throw new Error(`Web resource content for '${webResource.webResourceName}' not found or in unexpected format.`);
        }
    }

    /**
     * Retrieves web resources for a given solution.
     * Filters for web resources (component type 61).
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {Solution} solution The Solution object for which to retrieve web resources.
     * @returns {Promise<WebResource[]>} A promise that resolves to an array of WebResource objects.
     * @throws {Error} If the API request fails or if there's an issue processing the web resources (e.g., workspace path issues).
     */
    static async getWebResources(connection: Connection, solution: Solution): Promise<WebResource[]> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        // OData query for solution component summaries, filtered by solution ID and component type 61 (Web Resource).
        const wrQuery = 
            `${API_DATA_V}${apiVersion}/${ENTITY_MSDYN_SOLUTION_COMPONENT_SUMMARIES}` +
            `${QUERY_SELECT}msdyn_name,msdyn_objectid` + // Select name and object ID.
            `${QUERY_FILTER}(msdyn_solutionid eq ${solution.solutionId}) and (msdyn_componenttype eq 61)` +
            `${QUERY_ORDERBY}msdyn_name asc`; // Order by name.
        
        const rawWebResources = await this.getRecords<RawWebResource>(connection, wrQuery);
        const webResourceResults: WebResource[] = [];

        try {
            // Determine base path from workspace folders for constructing local file paths.
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                // This case should ideally be handled before calling this function,
                // but as a safeguard:
                throw new Error("No workspace folder found. Cannot determine path for web resources.");
            }
            const basePath = workspaceFolders[0].uri.fsPath;

            for (const rawWR of rawWebResources) { // Renamed loop variable for clarity
                // Parse the web resource name to determine file name and potential subfolder structure.
                const filePathParts = rawWR.msdyn_name.split('/');
                const fileName = filePathParts[filePathParts.length-1]; // Use length-1 for safety
                
                // Note: The original logic for `folderPath` and `fullFilePath` seemed to assume a flat structure
                // under `basePath`. If `msdyn_name` implies deeper paths, this would need adjustment.
                // For now, creating a conceptual local path. The actual file creation happens elsewhere.
                const conceptualFullFilePath = path.join(basePath, fileName); // Using fileName directly under basePath.

                webResourceResults.push(
                    new WebResource(
                        rawWR.msdyn_name,       // Full logical name from CRM.
                        rawWR.msdyn_objectid,   // CRM ID.
                        fileName,               // Display name (file part).
                        conceptualFullFilePath, // Conceptual local path.
                        "",                     // Content - fetched on demand.
                        "file"                  // Type.
                    )
                );
            }
            return webResourceResults;
        } catch (err: unknown) { // Catching unknown for type safety.
            if (err instanceof Error) {
                // Re-throw known errors or wrap for more context if needed.
                throw new Error(`Error processing web resources: ${err.message}`);
            }
            // Handle non-Error objects thrown, though this is rare in well-behaved async code.
            throw new Error(`An unknown error occurred while processing web resources: ${String(err)}`);
        }
    }

    /**
     * Publishes a web resource to Dynamics 365.
     * This involves two steps: updating the web resource content (PATCH) and then publishing it (POST PublishXml).
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {string} webResourceId The ID of the web resource to publish.
     * @param {string} base64Content The new content of the web resource, base64 encoded.
     * @returns {Promise<void>} A promise that resolves when the web resource is successfully updated and published.
     * @throws {Error} If any step of the publishing process fails.
     */
    static async publishWebResource(
        connection: Connection,
        webResourceId: string,
        base64Content: string
    ): Promise<void> { // Explicitly Promise<void> as it doesn't return a value on success.
        try {
            // Step 1: Update the web resource content.
            const recordToUpdate: UpdateRequest = { content: base64Content };
            await this.updateRecord(
                connection,
                recordToUpdate,
                ENTITY_WEBRESOURCE_SET,
                webResourceId
            );
            
            // Step 2: Publish the web resource using PublishXml action.
            await this.publishXML(
                connection,
                webResourceId
            );
        } catch (err: unknown) { // Catching unknown for type safety.
            // Add more context to the error if it's an Error object.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Error publishing web resource (ID: ${webResourceId}): ${message}`);
        }
    }

    /**
     * Makes a generic API request to Dynamics 365.
     * This is a private helper method that handles common request setup, execution, and error processing.
     *
     * @template TResponsePayload The expected type of the response payload.
     * @template TRequestPayload The type of the request payload (for POST/PATCH). Defaults to `void` if no payload.
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {string} method The HTTP method (e.g., "GET", "POST", "PATCH").
     * @param {string} apiQuery The OData query string or API path (appended to connection URL).
     * @param {TRequestPayload} [jsonPayload] The JSON payload for POST or PATCH requests.
     * @returns {Promise<TResponsePayload>} A promise that resolves with the response payload.
     * @throws {Error} If the request fails, returns a non-successful status code, or if response parsing fails.
     * @private
     */
    private static async makeApiRequest<TResponsePayload, TRequestPayload = void>( // Added default type for TRequestPayload
        connection: Connection,
        method: string,
        apiQuery: string, // Renamed 'select' to 'apiQuery' for clarity as it's more than just $select
        jsonPayload?: TRequestPayload 
    ): Promise<TResponsePayload> {
        // Wrap the existing Promise logic in an async IIFE to use await for connection.connect()
        return (async () => {
            try {
                // Ensure the connection is active and token is valid/renewed before making the API call.
                await connection.connect(); 
            } catch (error: unknown) {
                // If connection.connect() fails (e.g., authProvider.login() fails),
                // it should throw an error. We need to propagate this.
                console.error("Token renewal/validation failed prior to API request in makeApiRequest:", error);
                const message = error instanceof Error ? error.message : String(error);
                // Reject the promise that makeApiRequest returns
                throw new Error(`Connection validation/token renewal failed: ${message}`);
            }

            // New Promise logic using node-fetch
            try {
                const accessToken = connection.getAccessToken();
                if (!accessToken) {
                    // This case should ideally be prevented by connection.connect() throwing an error.
                    throw new Error("No access token available for API request. Please connect first.");
                }

                const headers: { [key: string]: string } = { // node-fetch headers can be a plain object
                    "OData-MaxVersion": ODATA_MAX_VERSION,
                    "OData-Version": ODATA_VERSION,
                    "Accept": "application/json",
                    "Content-Type": APPLICATION_JSON_CHARSET_UTF8,
                    "Prefer": ODATA_INCLUDE_ANNOTATIONS,
                    "Authorization": "Bearer " + accessToken,
                };

                const options: RequestInit = {
                    method: method,
                    headers: headers,
                };

                if (jsonPayload) {
                    options.body = JSON.stringify(jsonPayload);
                }

                const res: Response = await fetch(connection.getConnectionURL() + apiQuery, options);

                if (res.ok) {
                    // For PATCH (typically 204 No Content) or explicit 204, resolve with undefined as TResponsePayload
                    if (method.toUpperCase() === "PATCH" || res.status === 204) {
                        return undefined as unknown as TResponsePayload;
                    }
                    // For other success cases, parse JSON
                    return await res.json() as TResponsePayload;
                } else {
                    // Handle non-successful HTTP status codes.
                    let errorDetails = `Status Text: ${res.statusText}`;
                    try {
                        // Try to parse error details from response body if available
                        const errorBody = await res.json(); // Or res.text() if not always JSON
                        errorDetails = (errorBody as any)?.error?.message || JSON.stringify(errorBody);
                    } catch (e) {
                        // If parsing error body fails, use status text or fallback
                        console.warn("Failed to parse error body from API response:", e);
                        // errorDetails is already set to statusText, can append more if needed
                        const textBody = await res.text(); // get text as fallback
                        errorDetails = textBody || errorDetails;

                    }
                    throw new Error(`API request to '${apiQuery}' completed with status ${res.status}: ${errorDetails}`);
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                // Ensure the promise from the IIFE is rejected
                throw new Error(`API request failed: ${message}`);
            }
        })(); // Immediately invoke the async IIFE
    }

    /**
     * Retrieves multiple records from a Dynamics 365 entity set.
     * Expects the response to be an OData collection with a 'value' property containing an array of records.
     *
     * @template T The expected type of individual items in the 'value' array.
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {string} odataQuery The OData query string.
     * @returns {Promise<T[]>} A promise that resolves to an array of records of type T.
     * @throws {Error} If the API response does not match the expected OData collection structure.
     * @private
     */
    private static async getRecords<T>(connection: Connection, odataQuery: string): Promise<T[]> {
        // Defines the expected structure of an OData collection response.
        type ODataCollectionResponse<U> = { value: U[] };
        // Make the API request, expecting the ODataCollectionResponse structure.
        const result = await this.makeApiRequest<ODataCollectionResponse<T>, void>(connection, "GET", odataQuery);
        // Validate that the response has a 'value' property which is an array.
        if (result && Array.isArray(result.value)) {
            return result.value;
        }
        throw new Error(`Unexpected response structure for getRecords from '${odataQuery}': 'value' property missing or not an array.`);
    }
    
    /**
     * Retrieves a single record from Dynamics 365.
     *
     * @template T The expected type of the record being fetched.
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {string} odataQuery The OData query string for a single record.
     * @returns {Promise<T>} A promise that resolves to a single record of type T.
     * @private
     */
    private static async getRecord<T>(connection: Connection, odataQuery: string): Promise<T> {
        return this.makeApiRequest<T, void>(connection, "GET", odataQuery);
    }

    /**
     * Updates an existing record in Dynamics 365 using a PATCH request.
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {UpdateRequest} record The record data to update. Should conform to the UpdateRequest interface.
     * @param {string} entityName The logical name of the entity to update.
     * @param {string} recordId The GUID of the record to update.
     * @returns {Promise<void>} A promise that resolves when the update is successful.
     *                         Typically, a successful PATCH returns a 204 No Content response.
     * @throws {Error} If the update request fails.
     * @private
     */
    private static async updateRecord(
        connection: Connection,
        record: UpdateRequest, 
        entityName: string,
        recordId: string
    ): Promise<void> { 
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const updateQuery = `${API_DATA_V}${apiVersion}/${entityName}(${recordId})`;
        // PATCH requests typically return 204 No Content, so TResponsePayload is void.
        await this.makeApiRequest<void, UpdateRequest>(connection, "PATCH", updateQuery, record);
        // Success is implied if no error is thrown.
    }

    /**
     * Publishes XML changes to Dynamics 365. Used for publishing web resources.
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {string} webResourceId The GUID of the web resource to include in the publish XML.
     * @returns {Promise<void>} A promise that resolves when the PublishXml action is successful.
     * @throws {Error} If the PublishXml request fails.
     * @private
     */
    private static async publishXML(
        connection: Connection,
        webResourceId: string
    ): Promise<void> { 
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        // Construct the ParameterXml required by the PublishXml action.
        const parameters: PublishXmlParams = { 
            ParameterXml:
                `<importexportxml><webresources><webresource>{${webResourceId}}</webresource></webresources></importexportxml>`,
        };
        const publishQuery = `${API_DATA_V}${apiVersion}/PublishXml`; // The OData action path.
        // PublishXml action might return a specific response or just a success status.
        // Using PublishXmlResponse allows for defining a specific structure if needed.
        await this.makeApiRequest<PublishXmlResponse, PublishXmlParams>(connection, "POST", publishQuery, parameters);
        // Success is implied if no error is thrown.
    }
}
