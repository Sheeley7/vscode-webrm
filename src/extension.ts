// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { AuthServer } from './auth/server/localserver';
import { ConnectionExplorer, Connection } from './views/connectionExplorer';
import { SolutionExplorer, Solution } from './views/solutionExplorer';
import { WebResourceExplorer, WebResource} from './views/webResourceExplorer';
import { ConnectionStatusController } from './connectionStatusController';
import { CrmWebAPI } from './crmWebAPI';
import * as fs from 'fs';
import * as path from 'path';

let statusBar: vscode.StatusBarItem;

interface Settings {
	authWebServiceURL: string;
}


export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('webRM');
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	
	const connectionExplorer = new ConnectionExplorer(context);
	let solutionExplorer = new SolutionExplorer([]);
	let webResourceExplorer = new WebResourceExplorer([]);

	checkAuth();
	checkAPIVersion();
	
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.text = "Not Connected";
	statusBar.show();
	const connectionStatusController = new ConnectionStatusController(statusBar);


	const connectionTreeView = vscode.window.registerTreeDataProvider('vscode-connection-explorer', connectionExplorer);
	const solutionTreeView = vscode.window.registerTreeDataProvider('vscode-solution-explorer', solutionExplorer);
	const webResourceTreeView = vscode.window.registerTreeDataProvider('vscode-webresource-explorer', webResourceExplorer);

	const connectionAddConnectionCMD = vscode.commands.registerCommand('wrm.addConnection', async () => {

		const connectionName = await vscode.window.showInputBox({
			placeHolder: "Connection Name"
		});

		if(connectionName !== undefined) {
			let connectionNameFinal:string = connectionName === undefined ? "" : connectionName;
			const connectionURL = await vscode.window.showInputBox({
				placeHolder: "Connection URL"
			});

			let connectionURLFinal:string = connectionURL === undefined ? "" : connectionURL;

			let addConnectionResult = await connectionExplorer.addItem(connectionNameFinal, connectionURLFinal);
			if(!addConnectionResult) {
				vscode.window.showErrorMessage("Please enter a unique connection name.");
			}
		}
		else {
			vscode.window.showErrorMessage("You must provide a connection name and URL to add a new connection");
		}
		
	});

	const connectionRemoveConnectionCMD = vscode.commands.registerCommand('wrm.removeConnection', async (connection: Connection) => {
		await connectionExplorer.removeItem(connection);
		let currentConnection = connectionStatusController.getCurrentConnection();
		if(currentConnection !== null && typeof(currentConnection) !== "undefined" && currentConnection.getConnectionId() === connection.getConnectionId()) {
			solutionExplorer.clearSolutions();
			webResourceExplorer.clearWebResources();
			await connectionExplorer.refreshConnectionsGlobalState();
			connectionStatusController.disconnect();
		}
		
	});

	const connectionConnectionCMD = vscode.commands.registerCommand('wrm.connect', async (connection: Connection) => {
		if(checkAuth()) {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Connecting...",
				cancellable: true
			}, async (progress, token) => {
				token.onCancellationRequested(()=>{
					connectionStatusController.disposeOfConnectionServer();
				});
				
				connectionStatusController.setCurrentConnection(connection);
				await connectionStatusController.connect();
				progress.report({ message: "Getting Solutions..." });
	
				let solutions = await CrmWebAPI.getSolutions(connection);
				solutionExplorer.setSolutions(solutions);
				solutionExplorer.refresh();
				return;
			});
		}
	});

	const solutionGetWebResourcesCMD = vscode.commands.registerCommand("wrm.getWebResources", async (solution: Solution) => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Getting Web Resources...",
			cancellable: true
		}, async (progress, token) => {
			token.onCancellationRequested(()=>{

			});
			let currentConnection = connectionStatusController.getCurrentConnection();
			if(currentConnection !== undefined) {
				let con: Connection = currentConnection;
			
				let webResources = await CrmWebAPI.getWebResources(con, solution);
				webResourceExplorer.setWebResources(webResources);
				webResourceExplorer.refresh();
			}
			else {
				//No connection has been established
			}
		});
	});

	const openWebResourceCMD = vscode.commands.registerCommand("wrm.openWebResource", async (webResource: WebResource) => {

		let basePath: string = vscode.workspace.rootPath === undefined ? "" : vscode.workspace.rootPath;
		let filePath = webResource.webResourceName.split('/');
		let fileName = filePath.pop();
		for(var k = 0; k < filePath.length; k++) {
			basePath += "/" + filePath[k];
			if (!fs.existsSync(basePath)){
				fs.mkdirSync(basePath);
			}
		}
		let fullFilePath = basePath +'/' + fileName;
		fullFilePath = path.normalize(fullFilePath).toString();

		let res = await fs.promises.writeFile(fullFilePath, webResource.webResourceContent, {encoding: 'base64'});
		var openPath = fullFilePath;
		vscode.workspace.openTextDocument(openPath).then(doc => {
			vscode.window.showTextDocument(doc);
		});
	
		connectionStatusController.addSyncedWebResource(fullFilePath, webResource.webResourceId);

	});

	const publishWebResourceCMD = vscode.commands.registerCommand("wrm.publishWebResource", async ()=> {

		let activeEditor = vscode.window.activeTextEditor;
		if(activeEditor !== undefined) {
			let fileName = activeEditor.document.fileName;
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Publish",
				cancellable: true
			}, async (progress, token) => {
				token.onCancellationRequested(()=>{
					connectionStatusController.disposeOfConnectionServer();
				});
				let connection = connectionStatusController.getCurrentConnection();

				//If there is an active connection
				if(connection !== undefined) {
					progress.report({message: "Verifying Connection..."});

					//Attempt to connect
					try {
						await connection.connect();
					}
					catch(err) {
						connectionStatusController.disposeOfConnectionServer();
					}
					
					//Update message to Publishing Web Resources
					progress.report({message: "Publishing Web Resource..."});
					
					//Get the path of the currently active file
					let currentPath = path.normalize(fileName).toString();

					//Get the web resource id of the currently active file from the stored path
					let webResourceId = connectionStatusController.getResourceIdFromPath(currentPath);

					//If the current file has not been synced up with the recond in Dynamics
					if(typeof(webResourceId) === "undefined") {
						vscode.window.showErrorMessage("Current file not linked to record in Dynamics. Select 'Open' from the Web Resources view before publishing.");
					}
					else {
						//Get the data from the current opened file
						let data = await fs.promises.readFile(currentPath);

						//Convert it to base64
						let base64 = data.toString('base64');

						//Save and Publish the Web Resource in Dynamics
						await CrmWebAPI.publishWebResource(connection, webResourceId, base64);
					}	
				}
				else {
					//No Current Connection
					vscode.window.showErrorMessage("No active connection. Please connect to an environment before attempting to publish.");	
				}	
			});
		}
	});

	context.subscriptions.push(connectionAddConnectionCMD);
	context.subscriptions.push(connectionRemoveConnectionCMD);
	context.subscriptions.push(connectionConnectionCMD);
	context.subscriptions.push(solutionGetWebResourcesCMD);
	context.subscriptions.push(openWebResourceCMD);
	context.subscriptions.push(publishWebResourceCMD);
	context.subscriptions.push(connectionTreeView);
	context.subscriptions.push(solutionTreeView);
	context.subscriptions.push(webResourceTreeView);
	context.subscriptions.push(statusBar);
}

// this method is called when your extension is deactivated
export function deactivate() { }

function checkAuth() {

	var useLocalAuth = getConfig().get('useLocalAuth');
	if(useLocalAuth === true) {
		var clientid = getConfig().get('appClientId');
		var clientSecret = getConfig().get('appClientSecret');
		if(clientid === "" || clientid == null || clientSecret === "" || clientSecret == null) {
			vscode.window.showErrorMessage("You must provide client_id and client_secret in extension settings if using local auth.");
			return false;
		}
		else {
			return true;
		}
	}
	else {
		var authWebServiceURL = getConfig().get('authWebServiceURL');
		if(authWebServiceURL === "" || authWebServiceURL === null) {
			vscode.window.showErrorMessage("You must provide an Auth Web Service URL in the extension settings.");
			return false;
		}
		else {
			return true;
		}
	}
}

function checkAPIVersion() {
	var webServiceAPIVersion = getConfig().get('');
	if(webServiceAPIVersion === "" || webServiceAPIVersion === null) {
		vscode.window.showErrorMessage("You must provide a Web API Version in the extension settings.");
		return false;
	}
	else {
		return true;
	}
}