# vscode-webrm README

Dynamics 365 Web Resource Extension for Visual Studio Code.

## Features

This extensions allows for connecting to Dynamics 365 to modify and publish various web resources.

## Requirements

You must create an app registration that has impersonation rights for Dynamics CRM and User.Read for the Graph API.

## Extension Settings

This extension contributes the following settings:

- `webRM.appClientId`: (REQUIRED) Client Id of Your Registered App in Azure
- `webRM.appTenantId`: (REQUIRED FOR SINGLE TENANT APPS) Tenant Id of Your Registered App in Azure. Leave Blank if Mult-Tenant
- `webRM.connectionInfoFolder`: (REQUIRED) Folder to Store Encryped Connection Info
- `webRM.dynamicsAPIVersion`: (REQUIRED) API Version for Dynamics 365 Web API
- `webRM.solutionNameFilter`: Used to Filter Solution List Retrieved from Dynamics
- `webRM.solutionSortAscending`: Used to Change Sort Order of Returned Solution List

## Known Issues

## Limitations

Currently, this extension only works for Dynamics 365 Online. I have not tested with any other versions other than 9.0+

## Release Notes

Updated to MSAL library for authentication.

### 0.0.17

Initial pre-release.

## How to Use

### Config App Registration

Make sure user impersonation is check when adding Dynamics 365 permissions.
![png](instructions/app_registration_permissions.png)

Make sure http://localhost is added to redirect uri for "Desktop Application"
![png](instructions/app_registration_redirect.png)

Don't forget to add the required configration settings from your app registration to the vscode extensions.

### Add Connection

![gif](instructions/addconnection.gif)

### Authenticate

![gif](instructions/authenticate.gif)

### Download and Open Web Resource

![gif](instructions/downloadandopen.gif)

### Publish Web Resource

Open the command palette (ctrl+shift+p) and select 'Dynamics: Publish Web Resource'
![gif](instructions/publish.gif)
