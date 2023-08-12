import * as vscode from "vscode";
import { getConfig } from "../extension";

export class SolutionExplorer implements vscode.TreeDataProvider<Solution> {
    private solutions: Solution[] = [];

    constructor(solutions: Solution[]) {
        this.solutions = solutions;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<any> =
        new vscode.EventEmitter<any>();
    readonly onDidChangeTreeData: vscode.Event<any> =
        this._onDidChangeTreeData.event;
    getTreeItem(
        element: Solution
    ): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }

    getChildren(element?: Solution): vscode.ProviderResult<Solution[]> {
        const sortOrder = getConfig().get("solutionSortAscending")
            ? "asc"
            : "desc";
        return this.solutions.sort((a, b) => {
            const aL: string = a.label?.toString() || "";
            const bL: string = b.label?.toString() || "";
            const aFav = aL.startsWith("*");
            const bFav = bL.startsWith("*");

            if (aFav && !bFav) {
                return -1;
            } else if (bFav && !aFav) {
                return 1;
            }
            if (aL < bL) {
                return sortOrder === "asc" ? -1 : 1;
            }
            if (aL > bL) {
                return sortOrder === "asc" ? 1 : -1;
            }
            return 0;
        });
    }

    setSolutions(solutions: Solution[]) {
        this.solutions = solutions;
    }

    clearSolutions() {
        this.solutions = [];
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(null);
    }
}

export class Solution extends vscode.TreeItem {
    public contextValue: string = "solution";
    solutionName: string;
    solutionUniqueName: string;
    solutionId: string;
    isFavorite: boolean;
    constructor(json: any, isFavorite = false) {
        super(json.friendlyname, vscode.TreeItemCollapsibleState.None);
        this.solutionName = json.friendlyname;
        this.solutionUniqueName = json.uniquename;
        this.solutionId = json.solutionid;
        this.isFavorite = isFavorite;
        if (this.isFavorite === true) {
            this.label = `*${this.label}`;
        }
    }

    getSolutionId() {
        return this.solutionId;
    }

    async setFavorite(context: vscode.ExtensionContext) {
        if (!this.isFavorite) {
            this.isFavorite = true;
            this.label = `*${this.label}`;
            const favoriteSolutions = context.globalState.get<any>(
                "favoriteSolutions",
                {}
            );
            favoriteSolutions[this.getSolutionId()] = true;
            await context.globalState.update(
                "favoriteSolutions",
                favoriteSolutions
            );
        }
    }

    async removeFavorite(context: vscode.ExtensionContext) {
        if (this.isFavorite) {
            this.isFavorite = false;
            const label = this.label?.toString() || "";
            if (label.startsWith("*")) {
                this.label = label.substring(1);
            }
            const favoriteSolutions = context.globalState.get<any>(
                "favoriteSolutions",
                {}
            );

            delete favoriteSolutions[this.getSolutionId()];
            await context.globalState.update(
                "favoriteSolutions",
                favoriteSolutions
            );
        }
    }
}
