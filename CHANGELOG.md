# Change Log

## [1.2.0]
- Added the `webRM.webResourceRootPath` setting: a relative folder (within the workspace folder linked to a solution) that web resources are anchored to. Use it to point the manager at a `webresources/` sub-folder in a multi-component repo instead of writing into the workspace root; use `.` for the workspace root itself.
- When the root folder is not yet configured, the extension now prompts for it the first time it needs to read or write web resource files (and when linking a solution), then saves it to the folder's settings.
- The setting is resource-scoped, so each folder in a multi-root workspace can have its own web resource root.

## [1.1.9]
- Updated MSAL to `@azure/msal-node` 5.1.5 and raised the VS Code engine/runtime target for Node 20 support.
- Removed the `uuid` dependency and now use Node's built-in UUID generation.
- Added selected-solution tracking and a status bar indicator for the solution used when publishing.
- Publishing no longer requires opening a web resource from the extension first. The active file is matched to a server web resource by workspace-relative path.
- If the active file is not in the selected solution, the extension prompts to add it before publishing.
- If the active file does not exist on the server, the extension prompts to create it, add it to the selected solution, and publish it.
- Removed `webRM.pullLatestVersionFromServer`. Opening a web resource from the extension now always pulls the server version, while still warning when an existing local file differs from a server version modified by another user.
- Cleaned up duplicate Cancel buttons in publish confirmation dialogs.

## [1.1.8]
- Added a new setting `webRM.pullLatestVersionFromServer` to control whether the latest version of a web resource is pulled from the CRM server when a file is opened.
- Added a warning that appears if the file on the server was last modified by a different user and the local content is different from the server content.
- The comparison between local and server content is now always performed, regardless of the `webRM.pullLatestVersionFromServer` setting.

## [1.1.2]
- Updated code for web resource retrieval.

## [1.1.0]
- Added feature for adding and removing solutions as favorites by right clicking.

## [1.0.1]
- Initial release.
