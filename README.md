# vscode-webrm README

Dynamics 365 Web Resource Extension for Visual Studio Code.

## Features

This extensions allows for connecting to Dynamics 365 to modify and publish various web resources.

## Requirements

You must create an app registration that has impersonation rights for Dynamics CRM and User.Read for the Graph API.

## Extension Settings

This extension contributes the following settings:

- `webRM.appClientId`: (REQUIRED) Client Id of your registered app in Azure
- `webRM.appTenantId`: (REQUIRED FOR SINGLE TENANT APPS) Tenant Id of your registered app in Azure. Leave blank if Mult-Tenant
- `webRM.connectionInfoFolder`: (REQUIRED) Folder to store encrypted connection info
- `webRM.dynamicsAPIVersion`: (REQUIRED) API Version for Dynamics 365 Web API
- `webRM.solutionNameFilter`: Used to filter solution list retrieved from Dynamics
- `webRM.solutionSortAscending`: Used to change sort order of returned solution list

## Known Issues

## Limitations

Currently, this extension only works for Dynamics 365 Online. I have not tested with any other versions other than 9.0+

## Release Notes

Updated to MSAL library for authentication.

### 1.0.1

Initial release with updated authentication libraries

### 1.1.0

Added feature for adding and removing solutions as favorites by right clicking them.

## How to Use

### Config App Registration

Make sure user impersonation is checked when adding Dynamics 365 permissions.
![png](instructions/app_registration_permissions.png)

Make sure http://localhost is added to redirect uri for "Desktop Application"
![png](instructions/app_registration_redirect.png)

Don't forget to add the required configuration settings from your app registration to the vscode extension settings.

### Add Connection

![gif](instructions/addconnection.gif)

### Authenticate

![gif](instructions/authenticate.gif)

### Download and Open Web Resource

![gif](instructions/downloadandopen.gif)

### Publish Web Resource

Open the command palette (ctrl+shift+p) and select 'Dynamics: Publish Web Resource'
![gif](instructions/publish.gif)
