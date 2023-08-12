import * as vscode from "vscode";
import { Connection } from "./views/connectionExplorer";
import * as request from "request";
import { Solution } from "./views/solutionExplorer";
import { WebResource } from "./views/webResourceExplorer";
import * as path from "path";
import { getConfig } from "./extension";

export class CrmWebAPI {
    static async getSolutions(
        connection: Connection,
        globalContext: vscode.ExtensionContext
    ) {
        let apiVersion = getConfig().get("dynamicsAPIVersion");
        let solutionFilter = getConfig().get("solutionNameFilter");
        let additionalFilter = "";
        if (solutionFilter != null && solutionFilter !== "") {
            additionalFilter =
                " and contains(friendlyname, '" + solutionFilter + "')";
        }

        const sortOrder = getConfig().get("solutionSortAscending")
            ? "asc"
            : "desc";

        let solutions = await this.getRecords(
            connection,
            "/api/data/v" +
                apiVersion +
                "/solutions?$select=friendlyname,uniquename,solutionid&$filter=ismanaged eq false and isvisible eq true" +
                additionalFilter +
                "&$orderby=friendlyname " +
                sortOrder
        );
        var solutionObjs = [];
        const favoriteSolutions = globalContext.globalState.get<any>(
            "favoriteSolutions",
            {}
        );
        for (var i = 0; i < solutions.length; i++) {
            const currSolution = solutions[i];
            solutionObjs.push(
                new Solution(
                    currSolution,
                    favoriteSolutions[currSolution.solutionid]
                )
            );
        }
        return solutionObjs;
    }

    static async getWebResourceContent(
        connection: Connection,
        webResource: WebResource
    ) {
        let apiVersion = getConfig().get("dynamicsAPIVersion");

        var select = `/api/data/v${apiVersion}/webresourceset(${webResource.getWebResourceId()})?$select=content`;
        const webResouceRecord = await this.getRecord(connection, select);
        console.log(webResouceRecord);
        webResource.webResourceContent = webResouceRecord.content;
    }

    static async getWebResources(connection: Connection, solution: Solution) {
        let apiVersion = getConfig().get("dynamicsAPIVersion");
        var wrSelect = `/api/data/v${apiVersion}/msdyn_solutioncomponentsummaries?$select=msdyn_name,msdyn_objectid&$filter=(msdyn_solutionid eq ${solution.solutionId}) and ((msdyn_componenttype eq 61))&$orderby=msdyn_name asc`;
        const webResources = await this.getRecords(connection, wrSelect);

        const webResourceResults: WebResource[] = [];

        try {
            let folders = vscode.workspace.workspaceFolders;
            let [
                {
                    uri: { path: basePath },
                },
            ] = vscode.workspace?.workspaceFolders || [{ uri: { path: "" } }];

            for (let i = 0; i < webResources.length; i++) {
                let currWebResource = webResources[i];
                let filePath = currWebResource.msdyn_name.split("/");
                let fileName = filePath.pop();
                let folderPath = basePath;
                let fullFilePath = folderPath + "/" + fileName;
                fullFilePath = path?.normalize(fullFilePath).toString() || "";

                webResourceResults.push(
                    new WebResource(
                        currWebResource.msdyn_name,
                        currWebResource.msdyn_objectid,
                        fileName,
                        fullFilePath,
                        "",
                        "file"
                    )
                );
            }
            return webResourceResults;
        } catch (err: any) {
            throw new Error(err);
        }
    }

    static async publishWebResource(
        connection: Connection,
        webResourceId: string,
        base64Content: string
    ) {
        try {
            let record: any = {};
            record.content = base64Content;
            let updated = await this.updateRecord(
                connection,
                record,
                "webresourceset",
                webResourceId
            );
            if (updated) {
                let published = await this.publishXML(
                    connection,
                    webResourceId
                );
            }
        } catch (err: any) {
            throw new Error(err);
        }
    }

    private static async getRecords(connection: Connection, select: string) {
        return new Promise<[any]>(function (resolve, reject) {
            var headers = {
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                Accept: "application/json",
                "Content-Type": "application/json; charset=utf-8",
                Prefer: 'odata.include-annotations="*"',
                Authorization: "Bearer " + connection.getAccessToken(),
            };
            var options = {
                url: connection.getConnectionURL() + select,
                method: "GET",
                headers: headers,
            };
            request(options, (err: any, res: any, body: any) => {
                if (err) {
                    return reject(err);
                }
                try {
                    var result = JSON.parse(body).value;
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    private static async getRecord(connection: Connection, select: string) {
        return new Promise<any>(function (resolve, reject) {
            var headers = {
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                Accept: "application/json",
                "Content-Type": "application/json; charset=utf-8",
                Prefer: 'odata.include-annotations="*"',
                Authorization: "Bearer " + connection.getAccessToken(),
            };
            var options = {
                url: connection.getConnectionURL() + select,
                method: "GET",
                headers: headers,
            };
            request(options, (err: any, res: any, body: any) => {
                if (err) {
                    return reject(err);
                }
                try {
                    var result = JSON.parse(body);
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    private static async updateRecord(
        connection: Connection,
        record: any,
        entityName: string,
        recordId: string
    ) {
        return new Promise<boolean>(function (resolve, reject) {
            let apiVersion = getConfig().get("dynamicsAPIVersion");
            var headers = {
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                Accept: "application/json",
                "Content-Type": "application/json; charset=utf-8",
                Prefer: 'odata.include-annotations="*"',
                Authorization: "Bearer " + connection.getAccessToken(),
            };
            var options = {
                url:
                    connection.getConnectionURL() +
                    "/api/data/v" +
                    apiVersion +
                    "/" +
                    entityName +
                    "(" +
                    recordId +
                    ")",
                method: "PATCH",
                json: record,
                headers: headers,
            };
            request(options, (err: any, res: any, body: any) => {
                if (err) {
                    return reject(err);
                }
                try {
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    private static async publishXML(
        connection: Connection,
        webResourceId: string
    ) {
        return new Promise<boolean>(function (resolve, reject) {
            let apiVersion = getConfig().get("dynamicsAPIVersion");
            let parameters = {
                ParameterXml:
                    "<importexportxml><webresources><webresource>{" +
                    webResourceId +
                    "}</webresource></webresources></importexportxml>",
            };

            var headers = {
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                Accept: "application/json",
                "Content-Type": "application/json; charset=utf-8",
                Prefer: 'odata.include-annotations="*"',
                Authorization: "Bearer " + connection.getAccessToken(),
            };
            var options = {
                url:
                    connection.getConnectionURL() +
                    "/api/data/v" +
                    apiVersion +
                    "/PublishXml",
                method: "POST",
                json: parameters,
                headers: headers,
            };
            request(options, (err: any, res: any, body: any) => {
                if (err) {
                    return reject(err);
                }
                try {
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
}
