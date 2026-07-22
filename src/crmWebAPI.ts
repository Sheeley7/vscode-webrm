import * as vscode from "vscode";
import { Connection } from "./views/connectionExplorer";
import { Solution } from "./views/solutionExplorer";
import { WebResource } from "./views/webResourceExplorer";
import * as path from "path";
import { ConfigurationService } from "./configurationService";
import { logError } from "./utils/logger";
import { encodeODataLiteral, getWebResourceTypeFromName, createBoundary } from "./dataverse/odataUtils";
import {
    buildGetBatchBody,
    buildPatchBatchBody,
    parseBatchJsonResponses,
    parseBatchResponseItems,
} from "./dataverse/batchUtils";

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

interface ServerWebResource {
    webresourceid: string;
    name: string;
    webresourcetype?: number;
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
    /** OData concurrency token, present because requests set `Prefer: odata.include-annotations="*"`. */
    "@odata.etag"?: string;
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

interface WebResourceBatchDetail extends WebResourceContent {
    webResourceId: string;
}

interface WebResourceContentUpdate {
    webResourceId: string;
    base64Content: string;
    /** Optional `@odata.etag` captured at read time, sent as `If-Match` for optimistic concurrency. */
    etag?: string;
}

/**
 * Defines the structure for parameters passed to the PublishXml Dynamics 365 action.
 */
interface PublishXmlParams {
    ParameterXml: string; // XML string specifying entities to publish.
}
// #endregion Interfaces

/** Thrown when a PATCH's `If-Match` precondition fails (HTTP 412): the server record changed since it was read. */
export class ConcurrencyConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConcurrencyConflictError";
    }
}

/** Result of a chunked batch content update, distinguishing concurrency conflicts from success. */
export interface BatchUpdateResult {
    conflictedWebResourceIds: string[];
}

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

/** Hard ceiling on pages followed via @odata.nextLink, so a bug or huge org can't spin forever. */
const MAX_PAGES = 200;
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
     * @returns {Promise<Solution[]>} A promise that resolves to an array of Solution objects.
     * @throws {Error} If the API request fails or returns an unexpected response structure.
     */
    static async getSolutions(
        connection: Connection,
        cancellationToken?: vscode.CancellationToken
    ): Promise<RawSolution[]> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const solutionFilter = ConfigurationService.getSolutionNameFilter();
        let additionalFilter = "";
        // Apply solution name filter if configured. Escaped and URL-encoded since it is
        // interpolated directly into the query string.
        if (solutionFilter != null && solutionFilter !== "") {
            additionalFilter = ` and contains(friendlyname, '${encodeODataLiteral(solutionFilter)}')`;
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

        return this.getRecords<RawSolution>(connection, solutionQuery, cancellationToken);
    }

    /**
     * Retrieves the content of a specific web resource.
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {WebResource} webResource The WebResource object for which to fetch content.
     * @returns {Promise<WebResourceContent>} A promise that resolves to the web resource's content and metadata.
     * @throws {Error} If the API request fails, the web resource content is not found, or the response is in an unexpected format.
     */
    static async getWebResourceDetails(
        connection: Connection,
        webResource: WebResource
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
    static async getWebResources(
        connection: Connection,
        solution: Solution,
        cancellationToken?: vscode.CancellationToken
    ): Promise<WebResource[]> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        // OData query for solution component summaries, filtered by solution ID and component type 61 (Web Resource).
        const wrQuery =
            `${API_DATA_V}${apiVersion}/${ENTITY_MSDYN_SOLUTION_COMPONENT_SUMMARIES}` +
            `${QUERY_SELECT}msdyn_name,msdyn_objectid` + // Select name and object ID.
            `${QUERY_FILTER}(msdyn_solutionid eq ${solution.solutionId}) and (msdyn_componenttype eq 61)` +
            `${QUERY_ORDERBY}msdyn_name asc`; // Order by name.

        const rawWebResources = await this.getRecords<RawWebResource>(connection, wrQuery, cancellationToken);
        const webResourceResults: WebResource[] = [];

        for (const rawWR of rawWebResources) {
            const fileName = path.basename(rawWR.msdyn_name.split("/").filter(Boolean).pop() ?? rawWR.msdyn_name);
            webResourceResults.push(
                new WebResource(
                    rawWR.msdyn_name,       // Full logical name from CRM.
                    rawWR.msdyn_objectid,   // CRM ID.
                    fileName,               // Display name (file part).
                    "",                     // Local path is resolved later against the bound workspace folder.
                    "",                     // Content - fetched on demand.
                    "file"                  // Type.
                )
            );
        }
        return webResourceResults;
    }

    /**
     * Finds a web resource by its logical name anywhere on the server.
     */
    static async getWebResourceByName(connection: Connection, webResourceName: string): Promise<ServerWebResource | null> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const query =
            `${API_DATA_V}${apiVersion}/${ENTITY_WEBRESOURCE_SET}` +
            `${QUERY_SELECT}webresourceid,name,webresourcetype` +
            `${QUERY_FILTER}name eq '${encodeODataLiteral(webResourceName)}'&$top=1`;

        const results = await this.getRecords<ServerWebResource>(connection, query);
        return results[0] ?? null;
    }

    /**
     * Checks whether a web resource is already part of a solution.
     */
    static async isWebResourceInSolution(
        connection: Connection,
        solution: Solution,
        webResourceId: string
    ): Promise<boolean> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const query =
            `${API_DATA_V}${apiVersion}/${ENTITY_MSDYN_SOLUTION_COMPONENT_SUMMARIES}` +
            `${QUERY_SELECT}msdyn_objectid` +
            `${QUERY_FILTER}(msdyn_solutionid eq ${solution.solutionId}) and ` +
            `(msdyn_componenttype eq 61) and (msdyn_objectid eq ${webResourceId})&$top=1`;

        const results = await this.getRecords<RawWebResource>(connection, query);
        return results.length > 0;
    }

    /**
     * Creates a new web resource record using the provided base64 content.
     */
    static async createWebResource(
        connection: Connection,
        webResourceName: string,
        base64Content: string
    ): Promise<ServerWebResource> {
        const fileName = path.basename(webResourceName);
        const webResourceType = getWebResourceTypeFromName(webResourceName);
        await this.createRecord(
            connection,
            {
                name: webResourceName,
                displayname: fileName,
                webresourcetype: webResourceType,
                content: base64Content,
            },
            ENTITY_WEBRESOURCE_SET
        );

        const createdWebResource = await this.getWebResourceByName(connection, webResourceName);
        if (!createdWebResource) {
            throw new Error(`Created web resource '${webResourceName}', but could not retrieve it from the server.`);
        }
        return createdWebResource;
    }

    /**
     * Adds an existing web resource to a solution.
     */
    static async addWebResourceToSolution(
        connection: Connection,
        solution: Solution,
        webResourceId: string
    ): Promise<void> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const addSolutionComponentQuery = `${API_DATA_V}${apiVersion}/AddSolutionComponent`;
        await this.makeApiRequest<unknown, Record<string, string | number | boolean>>(
            connection,
            "POST",
            addSolutionComponentQuery,
            {
                ComponentId: webResourceId,
                ComponentType: 61,
                SolutionUniqueName: solution.solutionUniqueName,
                AddRequiredComponents: false,
            }
        );
    }

    /**
     * Publishes a web resource to Dynamics 365.
     * This involves two steps: updating the web resource content (PATCH) and then publishing it (POST PublishXml).
     *
     * @param {Connection} connection The active Dynamics 365 connection object.
     * @param {string} webResourceId The ID of the web resource to publish.
     * @param {string} base64Content The new content of the web resource, base64 encoded.
     * @param {string} [etag] Optional `@odata.etag` captured at read time; sent as `If-Match` so a concurrent
     *                        server-side change since the read is rejected instead of silently overwritten.
     * @returns {Promise<void>} A promise that resolves when the web resource is successfully updated and published.
     * @throws {ConcurrencyConflictError} If `etag` no longer matches the server's current version.
     * @throws {Error} If any other step of the publishing process fails.
     */
    static async publishWebResource(
        connection: Connection,
        webResourceId: string,
        base64Content: string,
        etag?: string
    ): Promise<void> {
        try {
            // Step 1: Update the web resource content.
            const recordToUpdate: UpdateRequest = { content: base64Content };
            await this.updateRecord(
                connection,
                recordToUpdate,
                ENTITY_WEBRESOURCE_SET,
                webResourceId,
                etag
            );

            // Step 2: Publish the web resource using PublishXml action.
            await this.publishXML(
                connection,
                [webResourceId]
            );
        } catch (err: unknown) {
            if (err instanceof ConcurrencyConflictError) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Error publishing web resource (ID: ${webResourceId}): ${message}`);
        }
    }

    /**
     * Updates multiple web resource records via chunked, non-transactional OData batch requests.
     * Each update may carry an `etag` for optimistic concurrency; conflicting updates (HTTP 412)
     * are reported back rather than thrown, so callers can present one consolidated conflict list.
     */
    static async updateWebResourcesBatch(
        connection: Connection,
        updates: WebResourceContentUpdate[],
        batchSize: number = 10
    ): Promise<BatchUpdateResult> {
        const conflictedWebResourceIds: string[] = [];
        if (updates.length === 0) {
            return { conflictedWebResourceIds };
        }

        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const apiDataPrefix = `${API_DATA_V}${apiVersion}/`;

        for (let i = 0; i < updates.length; i += batchSize) {
            const batchUpdates = updates.slice(i, i + batchSize);
            const batchBoundary = createBoundary("batch");
            const batchBody = buildPatchBatchBody(
                batchBoundary,
                apiDataPrefix,
                batchUpdates.map(update => ({
                    relativeUrl: `${ENTITY_WEBRESOURCE_SET}(${update.webResourceId})`,
                    body: { content: update.base64Content },
                    ifMatch: update.etag,
                }))
            );

            const responseText = await this.makeRawApiRequest(
                connection,
                "POST",
                `${API_DATA_V}${apiVersion}/$batch`,
                batchBody,
                `multipart/mixed; boundary="${batchBoundary}"`
            );

            const items = parseBatchResponseItems(responseText, batchUpdates.length);
            items.forEach((item, index) => {
                if (item.status === 412) {
                    conflictedWebResourceIds.push(batchUpdates[index].webResourceId);
                } else if (item.status < 200 || item.status >= 300) {
                    throw new Error(`Batch update returned inner HTTP status ${item.status} for '${batchUpdates[index].webResourceId}': ${responseText}`);
                }
            });
        }

        return { conflictedWebResourceIds };
    }

    /**
     * Retrieves web resource details in chunked, non-transactional OData batch GET requests.
     */
    static async getWebResourceDetailsBatch(
        connection: Connection,
        webResources: WebResource[],
        batchSize: number = 10
    ): Promise<Map<string, WebResourceBatchDetail>> {
        const details = new Map<string, WebResourceBatchDetail>();
        if (webResources.length === 0) {
            return details;
        }

        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const apiDataPrefix = `${API_DATA_V}${apiVersion}/`;

        for (let i = 0; i < webResources.length; i += batchSize) {
            const batchWebResources = webResources.slice(i, i + batchSize);
            const batchBoundary = createBoundary("batch");
            const batchBody = buildGetBatchBody(
                batchBoundary,
                apiDataPrefix,
                batchWebResources.map(webResource => ({
                    relativeUrl: `${ENTITY_WEBRESOURCE_SET}(${webResource.webResourceId})?$select=content,modifiedon&$expand=modifiedby($select=fullname)`,
                }))
            );

            const responseText = await this.makeRawApiRequest(
                connection,
                "POST",
                `${API_DATA_V}${apiVersion}/$batch`,
                batchBody,
                `multipart/mixed; boundary="${batchBoundary}"`
            );

            const responsePayloads = parseBatchJsonResponses(responseText, batchWebResources.length);
            responsePayloads.forEach((payload, index) => {
                const webResource = batchWebResources[index];
                const webResourceDetails = payload as Partial<WebResourceContent>;
                if (typeof webResourceDetails.content !== "string") {
                    throw new Error(`Web resource content for '${webResource.webResourceName}' not found or in unexpected format.`);
                }
                details.set(webResource.webResourceId, {
                    ...(webResourceDetails as WebResourceContent),
                    webResourceId: webResource.webResourceId,
                });
            });
        }

        return details;
    }

    /**
     * Publishes multiple web resources using one PublishXml request.
     */
    static async publishWebResources(
        connection: Connection,
        webResourceIds: string[]
    ): Promise<void> {
        if (webResourceIds.length === 0) {
            return;
        }
        await this.publishXML(connection, webResourceIds);
    }

    /**
     * Makes a generic API request to Dynamics 365.
     * @private
     */
    private static async makeApiRequest<TResponsePayload, TRequestPayload = void>(
        connection: Connection,
        method: string,
        apiQuery: string,
        jsonPayload?: TRequestPayload,
        extraHeaders?: Record<string, string>
    ): Promise<TResponsePayload> {
        try {
            // Ensure the connection is active and token is valid/renewed before making the API call.
            await connection.connect();
        } catch (error: unknown) {
            logError("CrmWebAPI.makeApiRequest (token renewal)", error);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Connection validation/token renewal failed: ${message}`);
        }

        try {
            const accessToken = connection.getAccessToken();
            if (!accessToken) {
                throw new Error("No access token available for API request. Please connect first.");
            }

            const headers: Record<string, string> = {
                "OData-MaxVersion": ODATA_MAX_VERSION,
                "OData-Version": ODATA_VERSION,
                "Accept": "application/json",
                "Content-Type": APPLICATION_JSON_CHARSET_UTF8,
                "Prefer": ODATA_INCLUDE_ANNOTATIONS,
                "Authorization": "Bearer " + accessToken,
                ...extraHeaders,
            };

            const options: RequestInit = {
                method: method,
                headers: headers,
            };

            if (jsonPayload) {
                options.body = JSON.stringify(jsonPayload);
            }

            const requestUrl = apiQuery.startsWith("http")
                ? apiQuery
                : connection.getConnectionURL() + apiQuery;
            const res: Response = await fetch(requestUrl, options);

            if (res.ok) {
                if (method.toUpperCase() === "PATCH" || res.status === 204) {
                    return undefined as unknown as TResponsePayload;
                }
                return await res.json() as TResponsePayload;
            }

            if (res.status === 412) {
                throw new ConcurrencyConflictError(
                    `The record at '${apiQuery}' was changed on the server since it was last read.`
                );
            }

            let errorDetails = `Status Text: ${res.statusText}`;
            try {
                const errorBody = await res.json();
                errorDetails = (errorBody as any)?.error?.message || JSON.stringify(errorBody);
            } catch (e) {
                console.warn("Failed to parse error body from API response:", e);
                const textBody = await res.text();
                errorDetails = textBody || errorDetails;
            }
            throw new Error(`API request to '${apiQuery}' completed with status ${res.status}: ${errorDetails}`);
        } catch (err: unknown) {
            if (err instanceof ConcurrencyConflictError) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`API request failed: ${message}`);
        }
    }

    private static async makeRawApiRequest(
        connection: Connection,
        method: string,
        apiQuery: string,
        body: string,
        contentType: string
    ): Promise<string> {
        await connection.connect();

        const accessToken = connection.getAccessToken();
        if (!accessToken) {
            throw new Error("No access token available for API request. Please connect first.");
        }

        const headers: Record<string, string> = {
            "OData-MaxVersion": ODATA_MAX_VERSION,
            "OData-Version": ODATA_VERSION,
            "Accept": "application/json",
            "Content-Type": contentType,
            "Authorization": "Bearer " + accessToken,
        };

        const res: Response = await fetch(connection.getConnectionURL() + apiQuery, {
            method,
            headers,
            body,
        });
        const responseText = await res.text();

        if (!res.ok) {
            throw new Error(`API request to '${apiQuery}' completed with status ${res.status}: ${responseText || res.statusText}`);
        }

        return responseText;
    }

    /**
     * Retrieves multiple records from a Dynamics 365 entity set, following
     * `@odata.nextLink` until the collection is exhausted (bounded by `MAX_PAGES`
     * as a safety limit) so large solutions/resource sets are not silently truncated.
     * @private
     */
    private static async getRecords<T>(
        connection: Connection,
        odataQuery: string,
        cancellationToken?: vscode.CancellationToken
    ): Promise<T[]> {
        type ODataCollectionResponse<U> = { value: U[]; "@odata.nextLink"?: string };

        const allRecords: T[] = [];
        let nextUrl: string | undefined = odataQuery;
        let pages = 0;

        while (nextUrl) {
            if (cancellationToken?.isCancellationRequested) {
                return allRecords;
            }

            const result: ODataCollectionResponse<T> = await this.makeApiRequest<ODataCollectionResponse<T>, void>(
                connection,
                "GET",
                nextUrl
            );
            if (!result || !Array.isArray(result.value)) {
                throw new Error(`Unexpected response structure for getRecords from '${odataQuery}': 'value' property missing or not an array.`);
            }
            allRecords.push(...result.value);

            nextUrl = result["@odata.nextLink"];
            pages++;
            if (nextUrl && pages >= MAX_PAGES) {
                console.warn(`getRecords stopped after ${MAX_PAGES} pages for query '${odataQuery}'; results may be incomplete.`);
                break;
            }
        }

        return allRecords;
    }

    /**
     * Retrieves a single record from Dynamics 365.
     * @private
     */
    private static async getRecord<T>(connection: Connection, odataQuery: string): Promise<T> {
        return this.makeApiRequest<T, void>(connection, "GET", odataQuery);
    }

    /**
     * Updates an existing record in Dynamics 365 using a PATCH request.
     * @private
     */
    private static async updateRecord(
        connection: Connection,
        record: UpdateRequest,
        entityName: string,
        recordId: string,
        etag?: string
    ): Promise<void> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const updateQuery = `${API_DATA_V}${apiVersion}/${entityName}(${recordId})`;
        const extraHeaders = etag ? { "If-Match": etag } : undefined;
        await this.makeApiRequest<void, UpdateRequest>(connection, "PATCH", updateQuery, record, extraHeaders);
    }

    /**
     * Creates a record in Dynamics 365 using a POST request.
     * @private
     */
    private static async createRecord(
        connection: Connection,
        record: UpdateRequest,
        entityName: string
    ): Promise<void> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const createQuery = `${API_DATA_V}${apiVersion}/${entityName}`;
        await this.makeApiRequest<void, UpdateRequest>(connection, "POST", createQuery, record);
    }

    /**
     * Publishes XML changes to Dynamics 365. Used for publishing web resources.
     * @private
     */
    private static async publishXML(
        connection: Connection,
        webResourceIds: string[]
    ): Promise<void> {
        const apiVersion = ConfigurationService.getDynamicsAPIVersion();
        const webResourceXml = webResourceIds
            .map(webResourceId => `<webresource>{${webResourceId}}</webresource>`)
            .join("");
        const parameters: PublishXmlParams = {
            ParameterXml:
                `<importexportxml><webresources>${webResourceXml}</webresources></importexportxml>`,
        };
        const publishQuery = `${API_DATA_V}${apiVersion}/PublishXml`;
        await this.makeApiRequest<PublishXmlResponse, PublishXmlParams>(connection, "POST", publishQuery, parameters);
    }
}
