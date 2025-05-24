import * as vscode from "vscode";
import { ConfigurationService } from "../configurationService"; 

// This should align with the interface in crmWebAPI.ts
interface RawSolution {
    solutionid: string;
    friendlyname: string;
    uniquename: string;
}

/**
 * Implements the VS Code TreeDataProvider for the Solution Explorer view.
 * This class manages and displays a list of Dynamics 365 solutions.
 * It is responsible for handling the "favorite" status of solutions,
 * persisting this status to the extension's global state.
 */
export class SolutionExplorer implements vscode.TreeDataProvider<Solution> {
    private solutions: Solution[] = [];
    private _onDidChangeTreeData: vscode.EventEmitter<Solution | undefined | null | void> = new vscode.EventEmitter<Solution | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Solution | undefined | null | void> = this._onDidChangeTreeData.event;

    /**
     * Creates an instance of SolutionExplorer.
     * @param {vscode.ExtensionContext} globalContext The extension context, used for accessing global state.
     * @param {Solution[]} [initialSolutions=[]] An optional initial array of Solution items.
     */
    constructor(private globalContext: vscode.ExtensionContext, initialSolutions: Solution[] = []) {
        this.solutions = initialSolutions;
    }

    /**
     * Returns the TreeItem (UI representation) for the given element.
     * @param {Solution} element The Solution instance.
     * @returns {vscode.TreeItem} The TreeItem representation.
     */
    getTreeItem(element: Solution): vscode.TreeItem {
        return element;
    }

    /**
     * Returns the children for the given element or root if no element is provided.
     * Solutions are displayed as a flat list, sorted by favorite status and name.
     * @param {Solution} [element] The Solution instance. If undefined, returns root elements.
     * @returns {vscode.ProviderResult<Solution[]>} A promise resolving to an array of Solution items.
     */
    getChildren(element?: Solution): vscode.ProviderResult<Solution[]> {
        if (element) {
            return Promise.resolve([]); // Solutions are leaf items.
        }
        const sortOrder = ConfigurationService.getSolutionSortAscending() ? "asc" : "desc";
        
        return Promise.resolve([...this.solutions].sort((a, b) => {
            const aName: string = a.getFriendlyName(); 
            const bName: string = b.getFriendlyName();
            const aIsFavorite = a.isFavorite;
            const bIsFavorite = b.isFavorite;

            if (aIsFavorite && !bIsFavorite) return -1;
            if (!aIsFavorite && bIsFavorite) return 1;

            const nameAComparison = aName.toLowerCase();
            const nameBComparison = bName.toLowerCase();
            if (nameAComparison < nameBComparison) return sortOrder === "asc" ? -1 : 1;
            if (nameAComparison > nameBComparison) return sortOrder === "asc" ? 1 : -1;
            return 0;
        }));
    }

    /**
     * Sets the solutions to be displayed, processing raw solution data and favorite status.
     * @param {RawSolution[]} rawSolutions Array of raw solution data from the API.
     */
    public setSolutionsFromRaw(rawSolutions: RawSolution[]): void {
        const favoriteSolutions = this.globalContext.globalState.get<Record<string, boolean>>(
            "favoriteSolutions",
            {}
        );
        this.solutions = rawSolutions.map(rawSol => 
            new Solution(
                rawSol, 
                favoriteSolutions[rawSol.solutionid] === true,
                this // Pass reference to SolutionExplorer for callbacks
            )
        );
        this.refresh();
    }
    
    /**
     * Updates the internally held list of Solution objects.
     * This is typically called by command handlers after processing raw data.
     * @param {Solution[]} solutions An array of Solution items.
     */
    public setSolutions(solutions: Solution[]): void {
        this.solutions = solutions;
        this.refresh();
    }


    /**
     * Updates the favorite status of a solution in the global state.
     * This method is called by Solution items when their favorite status changes.
     * @param {string} solutionId The ID of the solution to update.
     * @param {boolean} isFavorite The new favorite status.
     * @returns {Promise<void>}
     * @async
     */
    public async updateFavoriteStatusInGlobalState(solutionId: string, isFavorite: boolean): Promise<void> {
        const favoriteSolutions = this.globalContext.globalState.get<Record<string, boolean>>(
            "favoriteSolutions",
            {}
        );
        if (isFavorite) {
            favoriteSolutions[solutionId] = true;
        } else {
            delete favoriteSolutions[solutionId];
        }
        await this.globalContext.globalState.update("favoriteSolutions", favoriteSolutions);
        // Find the solution in the local array and update its state if necessary, then refresh the specific item.
        // This is important if the Solution object's isFavorite state was updated before calling this.
        const solutionToUpdate = this.solutions.find(s => s.solutionId === solutionId);
        if (solutionToUpdate && solutionToUpdate.isFavorite !== isFavorite) {
            // This should not happen if Solution object updates itself first then calls this.
            // But as a safeguard:
            solutionToUpdate.isFavorite = isFavorite; 
            solutionToUpdate.updateLabel(); // Ensure label is up-to-date
        }
        this.refresh(); // Refresh the entire view for simplicity, or could target the specific item.
    }

    /**
     * Clears all solutions from the explorer.
     */
    clearSolutions(): void {
        this.solutions = [];
        this.refresh();
    }

    /**
     * Triggers a refresh of the Solution Explorer tree view.
     */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
}

/**
 * Represents a single Dynamics 365 Solution item in the Solution Explorer view.
 */
export class Solution extends vscode.TreeItem {
    public readonly contextValue: string = "solution";
    readonly solutionName: string; 
    readonly solutionUniqueName: string; 
    readonly solutionId: string; 
    isFavorite: boolean;
    /** Reference to the parent SolutionExplorer to notify of state changes. */
    private explorer: SolutionExplorer; 

    /**
     * Creates an instance of a Solution tree item.
     * @param {RawSolution} rawSolution The raw solution data from the API.
     * @param {boolean} isFavoriteInitially The initial favorite status.
     * @param {SolutionExplorer} explorer A reference to the parent SolutionExplorer.
     */
    constructor(
        rawSolution: RawSolution, 
        isFavoriteInitially: boolean = false,
        explorer: SolutionExplorer // Added explorer parameter
    ) {
        super(rawSolution.friendlyname, vscode.TreeItemCollapsibleState.None);
        this.solutionName = rawSolution.friendlyname;
        this.solutionUniqueName = rawSolution.uniquename;
        this.solutionId = rawSolution.solutionid;
        this.isFavorite = isFavoriteInitially;
        this.explorer = explorer; // Store the explorer reference.
        this.updateLabel();
    }

    /**
     * Updates the `label` and `iconPath` of the TreeItem based on favorite status.
     * @private
     */
    public updateLabel(): void { // Made public for SolutionExplorer to call if needed
        if (this.isFavorite) {
            this.label = this.solutionName; // Remove prefix
            // Optionally, set a specific icon for favorite items
            this.iconPath = new vscode.ThemeIcon("star-full"); // Example: Filled star icon
        } else {
            this.label = this.solutionName;
            // Reset to default icon or remove specific icon
            this.iconPath = undefined; // Or new vscode.ThemeIcon("symbol-package") or similar for solutions
        }
        this.tooltip = `${this.solutionName} (${this.solutionUniqueName})${this.isFavorite ? ' (Favorite)' : ''}`;
    }
    
    getFriendlyName(): string {
        return this.solutionName;
    }

    getSolutionId(): string {
        return this.solutionId;
    }

    /**
     * Marks the solution as a favorite. Updates its own state and notifies the SolutionExplorer.
     * @returns {Promise<void>}
     * @async
     */
    async setFavorite(): Promise<void> {
        if (!this.isFavorite) {
            this.isFavorite = true;
            this.updateLabel();
            // Notify SolutionExplorer to update global state and refresh the view.
            await this.explorer.updateFavoriteStatusInGlobalState(this.solutionId, true);
        }
    }

    /**
     * Removes the solution from favorites. Updates its own state and notifies the SolutionExplorer.
     * @returns {Promise<void>}
     * @async
     */
    async removeFavorite(): Promise<void> {
        if (this.isFavorite) {
            this.isFavorite = false;
            this.updateLabel();
            // Notify SolutionExplorer to update global state and refresh the view.
            await this.explorer.updateFavoriteStatusInGlobalState(this.solutionId, false);
        }
    }
}
