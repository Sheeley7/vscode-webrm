import * as vscode from 'vscode';

export class SolutionExplorer implements vscode.TreeDataProvider<Solution> {
    
    private solutions: Solution[] = [];
    
    constructor(solutions: Solution[]) {
        this.solutions = solutions;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
    readonly onDidChangeTreeData: vscode.Event<any> = this._onDidChangeTreeData.event;
    getTreeItem(element: Solution): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }

    getChildren(element?: Solution): vscode.ProviderResult<Solution[]> {
        return this.solutions;
    }

    setSolutions(solutions: Solution[]) {
        this.solutions = solutions;
    }

    clearSolutions() {
        this.solutions = [];
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

}

export class Solution extends vscode.TreeItem {
    public contextValue: string = "solution";
    solutionName: string;
    solutionUniqueName: string;
    solutionId: string;
    constructor(json: any) {
        super(json.friendlyname, vscode.TreeItemCollapsibleState.None);
        this.solutionName = json.friendlyname;
        this.solutionUniqueName = json.uniquename;
        this.solutionId = json.solutionid;
    }

    getSolutionId() {
        return this.solutionId;
    }

}