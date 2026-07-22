/**
 * Pure tree-building logic for turning a flat list of Dataverse web resource
 * logical names into a virtual folder hierarchy. Deliberately has no VS Code
 * dependency so it can be unit tested; `WebResourceExplorer` wraps the
 * resulting nodes in `vscode.TreeItem`-derived objects.
 */

export interface FlatResourceItem {
    /** Full logical name, '/'-separated (e.g. "new_/scripts/account.js"). */
    name: string;
    id: string;
}

export interface ResourceTreeNode {
    /** Display name: the final path segment. */
    name: string;
    /** Full logical name/path up to and including this node. */
    fullPath: string;
    /** Web resource GUID; empty string for folder nodes. */
    id: string;
    type: "file" | "folder";
    children: ResourceTreeNode[];
}

function findOrCreateFolder(parent: ResourceTreeNode, folderName: string, fullPath: string): ResourceTreeNode {
    let folder = parent.children.find(child => child.type === "folder" && child.name === folderName);
    if (!folder) {
        folder = { name: folderName, fullPath, id: "", type: "folder", children: [] };
        parent.children.push(folder);
    }
    return folder;
}

function addItem(root: ResourceTreeNode, item: FlatResourceItem): void {
    const segments = item.name.split("/").filter(segment => segment.length > 0);
    if (segments.length === 0) {
        return;
    }

    let current = root;
    let currentPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
        currentPath = i === 0 ? segments[i] : `${currentPath}/${segments[i]}`;
        current = findOrCreateFolder(current, segments[i], currentPath);
    }

    const fileName = segments[segments.length - 1];
    current.children.push({
        name: fileName,
        fullPath: item.name,
        id: item.id,
        type: "file",
        children: [],
    });
}

function sortRecursive(node: ResourceTreeNode): void {
    node.children.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === "folder" ? -1 : 1;
        }
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
    });
    for (const child of node.children) {
        if (child.type === "folder") {
            sortRecursive(child);
        }
    }
}

/**
 * Builds a sorted virtual folder tree (folders before files, alphabetical
 * within each type) from a flat list of logical web resource names.
 */
export function buildResourceTree(items: FlatResourceItem[]): ResourceTreeNode[] {
    const root: ResourceTreeNode = { name: "", fullPath: "", id: "", type: "folder", children: [] };
    for (const item of items) {
        addItem(root, item);
    }
    sortRecursive(root);
    return root.children;
}
