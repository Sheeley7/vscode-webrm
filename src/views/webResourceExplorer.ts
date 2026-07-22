import * as vscode from "vscode";
import { buildResourceTree, ResourceTreeNode } from "./webResourceTree";

/**
 * Implements the VS Code TreeDataProvider for the Web Resource Explorer view.
 * This class manages and displays a hierarchical structure of Dynamics 365 web resources
 * (JavaScript, HTML, CSS, images, etc.) based on their logical names/paths from CRM.
 */
export class WebResourceExplorer implements vscode.TreeDataProvider<WebResource> {
    /** Emitter for tree data change events. VS Code listens to this to refresh the view. */
    private _onDidChangeTreeData: vscode.EventEmitter<WebResource | undefined | null | void> = new vscode.EventEmitter<WebResource | undefined | null | void>();
    /** Event that VS Code subscribes to for tree data changes. */
    readonly onDidChangeTreeData: vscode.Event<WebResource | undefined | null | void> = this._onDidChangeTreeData.event;
    
    /** Holds the root-level WebResource items (top-level folders and files). */
    private rootWebResources: WebResource[] = [];

    /**
     * Creates an instance of WebResourceExplorer.
     * @param {WebResource[]} [initialWebResources=[]] An optional initial flat list of web resources to populate the explorer.
     */
    constructor(initialWebResources: WebResource[] = []) {
        if (initialWebResources.length > 0) {
            this.setWebResources(initialWebResources);
        }
    }

    /**
     * Returns the TreeItem (UI representation) for the given element.
     * @param {WebResource} element The WebResource instance for which to get the TreeItem.
     * @returns {vscode.TreeItem} The TreeItem representation of the element.
     */
    getTreeItem(element: WebResource): vscode.TreeItem {
        return element; // The WebResource class itself extends TreeItem.
    }

    /**
     * Returns the children for the given element or root if no element is provided.
     * If an element is provided (a folder), its children are returned.
     * If no element is provided, the root-level web resources are returned.
     * Children are expected to be sorted by the `setWebResources` method.
     * @param {WebResource} [element] The WebResource instance (folder) for which to get children.
     * @returns {vscode.ProviderResult<WebResource[]>} A promise resolving to an array of child WebResource items.
     */
    getChildren(element?: WebResource): vscode.ProviderResult<WebResource[]> {
        if (element) {
            // If the element is a folder, return its children (which should already be sorted).
            return element.children;
        }
        // If no element (root level), return the sorted root web resources.
        return this.rootWebResources;
    }

    /**
     * Triggers a refresh of the Web Resource Explorer tree view.
     * Call this method when the underlying data changes.
     */
    refresh(): void {
        // Firing with undefined or null signals that the root of the tree has changed.
        this._onDidChangeTreeData.fire();
    }

    /**
     * Sets the web resources to be displayed in the explorer.
     * This method takes a flat list of web resources (as retrieved from CRM)
     * and builds a hierarchical tree structure based on their logical names (paths).
     * The resulting tree is then sorted.
     * @param {WebResource[]} flatWebResources A flat list of WebResource objects.
     */
    public setWebResources(flatWebResources: WebResource[]): void {
        // Build the pure (VS Code-independent) tree structure from logical names,
        // then wrap each node in a WebResource TreeItem, looking up local path/content
        // for file nodes from the original flat list.
        const byId = new Map(flatWebResources.map(wr => [wr.webResourceId, wr]));
        const tree = buildResourceTree(flatWebResources.map(wr => ({ name: wr.webResourceName, id: wr.webResourceId })));
        this.rootWebResources = tree.map(node => this.toTreeItem(node, byId));
        this.refresh(); // Notify VS Code to update the tree view.
    }

    /**
     * Converts a pure `ResourceTreeNode` into a `WebResource` TreeItem, recursively
     * converting its children. File nodes look up their local path/content from the
     * original flat list (folders have no direct CRM record).
     * @private
     */
    private toTreeItem(node: ResourceTreeNode, byId: Map<string, WebResource>): WebResource {
        if (node.type === "file") {
            const source = byId.get(node.id);
            return new WebResource(
                node.fullPath,
                node.id,
                node.name,
                source?.fullPath ?? "",
                source?.webResourceContent ?? "",
                "file"
            );
        }
        const folder = new WebResource(node.fullPath, "", node.name, "", "", "folder");
        folder.children = node.children.map(child => this.toTreeItem(child, byId));
        return folder;
    }

    /**
     * Clears all web resources from the explorer view.
     */
    clearWebResources(): void {
        this.rootWebResources = []; // Reset the root items.
        this.refresh(); // Notify VS Code to update the view.
    }
}

/**
 * Represents a single web resource (file or folder) in the Web Resource Explorer view.
 * Extends vscode.TreeItem to be directly usable by the TreeDataProvider.
 */
export class WebResource extends vscode.TreeItem {
  /** Context value used for VS Code's "when" clauses for context menus. Differentiates files and folders. */
  public readonly contextValue: string;
  /** The full logical name/path of the web resource as it appears in Dynamics 365 (e.g., "new_scripts/myfolder/myscript.js"). */
  readonly webResourceName: string; 
  /** The GUID of the web resource record in Dynamics 365. Empty for virtual folder nodes. */
  readonly webResourceId: string;   
  /** The content of the web resource (if it's a file), typically base64 encoded. Fetched on demand. */
  webResourceContent: string;       
  /** The local file system path where this web resource is (or will be) saved. Empty for virtual folder nodes. */
  readonly fullPath: string;         
  /** The type of the tree item: either a 'file' (actual web resource) or a 'folder' (virtual). */
  readonly type: "file" | "folder";
  /** An array of child WebResource items, used if this item is a folder. */
  children: WebResource[];
  /** 
   * The display name for this tree item. 
   * For files, it's the actual file name (e.g., "myscript.js").
   * For folders, it's the name of that folder segment (e.g., "myfolder").
   */
  readonly fileName: string;         
  /** Flag to identify the conceptual root node used internally for tree building. Not displayed. */
  readonly isRootNode: boolean;      

  /**
   * Creates an instance of a WebResource tree item.
   * @param {string} webResourceName The full logical name/path from CRM (for files) or the constructed path (for folders).
   * @param {string} webResourceId The CRM GUID of the web resource (empty for folders).
   * @param {string} fileName The display name for this node (file name or folder name). This is used as the TreeItem's label.
   * @param {string} fullPath The local file system path (empty for folders).
   * @param {string} webResourceContent The content of the web resource (empty for folders or if not yet fetched).
   * @param {"file" | "folder"} type The type of the node.
   * @param {boolean} [isRootNode=false] Internal flag to mark the conceptual root node.
   */
  constructor(
    webResourceName: string,
    webResourceId: string,
    fileName: string,            
    fullPath: string,
    webResourceContent: string,
    type: "file" | "folder",
    isRootNode: boolean = false   
  ) {
    // Call the vscode.TreeItem constructor. The label is the fileName.
    // Folders are collapsible, files are not.
    super(fileName, type === "folder" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    
    this.webResourceName = webResourceName;
    this.webResourceId = webResourceId;
    this.fileName = fileName; 
    this.fullPath = fullPath;
    this.webResourceContent = webResourceContent;
    this.type = type;
    this.children = []; // Initialize children array, populated if this is a folder.
    this.isRootNode = isRootNode; // Store the internal root node flag.

    // Set the contextValue based on type, used for context menus in package.json.
    // The conceptual root node might have a different context if needed, but currently treated as a normal folder.
    if (type === "folder") {
      this.contextValue = this.isRootNode ? "rootNode" : "folder"; // Example: "rootNode" if special actions for root.
    } else {
      this.contextValue = "webresource"; // For file web resources.
    }
    // Set a tooltip for better user experience, showing the full logical name.
    this.tooltip = this.webResourceName; 
  }

  /**
   * Gets the Dynamics 365 web resource ID (GUID).
   * @returns {string} The web resource ID. Returns an empty string for folder nodes.
   */
  getWebResourceId(): string {
    return this.webResourceId;
  }
}
