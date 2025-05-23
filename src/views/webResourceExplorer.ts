import * as vscode from "vscode";

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
        // Create a conceptual root node to serve as the parent for all top-level items.
        // This node itself is not displayed in the tree.
        const conceptualRootNode = new WebResource("root", "", "root", "", "", "folder", true); 

        // Process each web resource from the flat list and add it to the hierarchy.
        for (const wr of flatWebResources) {
            this.addWebResourceToHierarchy(conceptualRootNode, wr);
        }
        
        // After building the entire tree structure, sort all children recursively.
        this.sortChildrenRecursive(conceptualRootNode); 
        // The children of the conceptual root node are the actual top-level items to display.
        this.rootWebResources = conceptualRootNode.children;
        this.refresh(); // Notify VS Code to update the tree view.
    }
    
    /**
     * Adds a single web resource to its correct place in the hierarchical tree structure
     * under the given `rootNode`.
     * @param {WebResource} rootNode The current root or parent folder node under which to place the web resource.
     * @param {WebResource} webResourceToAdd The WebResource object (representing a file) to be added.
     * @private
     */
    private addWebResourceToHierarchy(rootNode: WebResource, webResourceToAdd: WebResource): void {
        // Split the web resource's logical name (e.g., "new_scripts/myfolder/myscript.js") into parts.
        const pathParts = webResourceToAdd.webResourceName.split('/');
        let currentNode = rootNode; // Start traversal from the rootNode.
        let currentPath = ""; // Accumulates the full path for creating folder nodes.

        // Iterate through the path parts to create/find folder nodes.
        // The loop goes up to `pathParts.length - 1` because the last part is the file itself.
        for (let i = 0; i < pathParts.length - 1; i++) {
            const folderNamePart = pathParts[i];
            // Construct the full logical path for the current folder being processed.
            if (i === 0) {
                currentPath = folderNamePart;
            } else {
                currentPath = `${currentPath}/${folderNamePart}`;
            }
            // Find or create the folder node at the current level of the hierarchy.
            currentNode = this.findOrCreateFolderNode(currentNode, folderNamePart, currentPath);
        }

        // The last part of the path is the file name.
        const fileName = pathParts[pathParts.length - 1];
        // Create the file node. It's important to use the correct `fileName` for the label
        // and the full `webResourceName` as its logical identifier.
        const fileNode = new WebResource(
            webResourceToAdd.webResourceName, // Full logical name from CRM.
            webResourceToAdd.webResourceId,   // CRM ID.
            fileName,                         // Display name (the file name part).
            webResourceToAdd.fullPath,        // Local file system path (if applicable).
            webResourceToAdd.webResourceContent, // Content (usually fetched on demand).
            "file"                            // Type identifier.
        );
        // Add the file node as a child of the deepest folder node found or created.
        currentNode.children.push(fileNode);
    }

    /**
     * Finds an existing folder node within the children of `parentNode` or creates a new one if it doesn't exist.
     * @param {WebResource} parentNode The parent WebResource node (must be of type 'folder').
     * @param {string} folderName The name of the folder to find or create (a single segment of the path).
     * @param {string} fullFolderPath The full logical path from CRM up to and including this folder.
     * @returns {WebResource} The found or newly created folder WebResource node.
     * @private
     */
    private findOrCreateFolderNode(parentNode: WebResource, folderName: string, fullFolderPath: string): WebResource {
        // Search for an existing folder with the same name among the parent's children.
        let folderNode = parentNode.children.find(child => child.fileName === folderName && child.type === "folder");

        if (!folderNode) {
            // If not found, create a new WebResource item to represent the folder.
            folderNode = new WebResource(
                fullFolderPath, // The full logical name/path for this folder.
                "",             // Folders in this tree representation don't have a direct CRM ID.
                folderName,     // The display name for this folder is the folderName itself.
                "",             // Local fullPath is typically not applicable for virtual folders.
                "",             // Folders don't have content.
                "folder"        // Type identifier.
            );
            // Add the new folder node to the parent's children.
            parentNode.children.push(folderNode);
        }
        return folderNode; // Return the found or newly created folder node.
    }

    /**
     * Recursively sorts the `children` array of a given `WebResource` node.
     * The sorting criteria are:
     * 1. Folders appear before files.
     * 2. Within each type (folders, files), items are sorted alphabetically by their `fileName` (display name), case-insensitive.
     * @param {WebResource} node The WebResource node whose children need to be sorted.
     * @private
     */
    private sortChildrenRecursive(node: WebResource): void {
        if (node.children && node.children.length > 0) {
            node.children.sort((a, b) => {
                // Rule 1: Folders before files.
                if (a.type === "folder" && b.type === "file") {
                    return -1; // a (folder) comes before b (file).
                }
                if (a.type === "file" && b.type === "folder") {
                    return 1;  // b (folder) comes before a (file).
                }
                
                // Rule 2: Alphabetical sort within the same type (case-insensitive).
                const nameA = a.fileName.toLowerCase();
                const nameB = b.fileName.toLowerCase();
                if (nameA < nameB) {
                    return -1;
                }
                if (nameA > nameB) {
                    return 1;
                }
                return 0; // Names are equal.
            });

            // After sorting the immediate children, recursively sort the children of any folder nodes.
            for (const child of node.children) {
                if (child.type === "folder") {
                    this.sortChildrenRecursive(child);
                }
            }
        }
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
