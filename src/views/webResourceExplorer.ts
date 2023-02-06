import * as vscode from "vscode";

export class WebResourceExplorer
  implements vscode.TreeDataProvider<WebResource>
{
  private _onDidChangeTreeData: vscode.EventEmitter<any> =
    new vscode.EventEmitter<any>();
  readonly onDidChangeTreeData: vscode.Event<any> =
    this._onDidChangeTreeData.event;
  private webResources: WebResource[] = [];
  private treeStructure: any;

  constructor(webResources: WebResource[]) {
    this.webResources = webResources;
  }

  getTreeItem(
    element: WebResource
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: WebResource): vscode.ProviderResult<WebResource[]> {
    if (typeof element === "undefined") {
      return this.webResources;
    } else {
      return element.children;
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  setWebResources(webResources: WebResource[]) {
    let originalPart: any = {
      webResource: new WebResource("root", "", "", "", "", "folder"),
    };

    for (var i = 0; i < webResources.length; i++) {
      let currWR = webResources[i];
      let webResourcePathParts = currWR.webResourceName.split("/");
      let prevPart = originalPart;
      if (webResourcePathParts.length === 1) {
        prevPart.webResource.children.push(currWR);
      } else {
        for (var j = 0; j < webResourcePathParts.length; j++) {
          let currFilePart = webResourcePathParts[j];

          //if its not the last part (file name)
          if (j !== webResourcePathParts.length - 1) {
            if (typeof prevPart[currFilePart] === "undefined") {
              //Create folder node
              let newWR = new WebResource(
                currFilePart,
                "",
                "",
                "",
                "",
                "folder"
              );
              prevPart.webResource.children.push(newWR);
              prevPart[currFilePart] = {
                webResource: newWR,
              };
            }
          } else {
            prevPart[currFilePart] = {
              name: currFilePart,
              webResource: currWR,
            };
            prevPart.webResource.children.push(currWR);
          }
          prevPart = prevPart[currFilePart];
        }
      }
    }
    this.webResources = originalPart.webResource.children;
  }

  clearWebResources() {
    this.webResources = [];
    this.treeStructure = {};
    this.refresh();
  }
}

export class WebResource extends vscode.TreeItem {
  public contextValue: string;
  webResourceName: string;
  webResourceId: string;
  public webResourceContent: string;
  fullPath: string;
  type: string;
  children: WebResource[];
  fileName: string;

  constructor(
    webResourceName: string,
    webResourceId: string,
    fileName: string,
    fullPath: string,
    webResourceContent: string,
    type: string
  ) {
    if (type !== "folder") {
      super(fileName, vscode.TreeItemCollapsibleState.None);
      this.contextValue = "webresource";
    } else {
      super(webResourceName, vscode.TreeItemCollapsibleState.Collapsed);
      this.contextValue = "folder";
    }

    this.webResourceName = webResourceName;
    this.webResourceId = webResourceId;
    this.webResourceContent = webResourceContent;
    this.fullPath = fullPath;
    this.fileName = fileName;
    this.type = type;
    this.children = [];
  }

  getWebResourceId() {
    return this.webResourceId;
  }
}
