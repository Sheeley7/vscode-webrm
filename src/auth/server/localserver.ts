import * as express from 'express';
import { Server } from 'http';
import { getConfig } from './../../extension';
import { WorkspaceConfiguration } from "vscode";
import * as querystring from 'querystring'
import { AuthenticationContext } from 'adal-node';
import * as vscode from 'vscode';
import * as cookieParser from 'cookie-parser';

const redirect_uri = 'http://localhost:8350';
const authority_url = "https://login.windows.net";
const auth_url = authority_url + "/common/oauth2/authorize";
const stateKey = 'dynamics_auth_state';


export interface AuthServerPromise {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}
export const AuthServer = async (connectionURL: string) => {
    if (getConfig().get('useLocalAuth') === true) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(getConfig().get('authWebServiceURL') + '/login?crm_url=' + connectionURL));
        return ExternalAuthServer(connectionURL);
    }
    else {

        return LocalAuthServer(connectionURL);
    }
}

const ExternalAuthServer = (connectionURL: string) => {
    let server: Server;
    const createServer = new Promise<AuthServerPromise>((resolve, reject) => {
        setTimeout(() => {
            reject('Timeout error. No response for 10 minutes.');
        }, 10 * 60 * 1000 /*10 minutes*/);

        try {
            const app = express();

            app.get("/result", (request: any, reponse: any) => {
                const { error } = request.query;
                if (!error) {
                    resolve(request.query);
                }
                else {
                    reject(error);
                }
                reponse.redirect(`${getConfig().get('authWebServiceURL')}/?message=${encodeURIComponent('You can now close this tab')}`);
                request.destroy();
            });

            server = app.listen(8350);
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(getConfig().get('authWebServiceURL') + '/login?crm_url=' + connectionURL));
        }
        catch (err) {
            reject(err);
        }
    });

    return {
        createServer, dispose: () => {
            server && server.close(() => {
            });
        }
    }
}

const LocalAuthServer = async (connectionURL: string) => {
    let server: Server;
    const createServer = new Promise<AuthServerPromise>((resolve, reject) => {
        setTimeout(() => {
            reject('Timeout error. No response for 10 minutes.');
        }, 10 * 60 * 1000 /*10 minutes*/);

        try {
            const app = express();
            app.use(express.static(__dirname + '/public'))
                .use(cookieParser());

            let state = generateRandomString(16);   

            app.get('/auth', (req, res) => {
                let url = auth_url + '?' +
                querystring.stringify({
                    response_type: 'code',
                    client_id: getConfig().get('appClientId'),
                    redirect_uri: redirect_uri + "/code",
                    resource: connectionURL,
                    prompt: "consent",
                    state: state
                });
                res.cookie(stateKey, state);
                res.redirect(url);
            });
            //Callback after user has logged in via the web browser
            app.get('/code', function (req: any, res: any) {
                const state = req.query.state || null;
                const storedState = req.cookies ? req.cookies[stateKey] : null;
                //If the states mismatch, throw an error
                if(state === null || state !== storedState) {
                    console.error('state_mismatch', state, storedState);
                }
                const code = req.query.code || null;

                var authenticationContext = new AuthenticationContext(authority_url + "/common");
                authenticationContext.acquireTokenWithAuthorizationCode(req.query.code, redirect_uri + "/code", connectionURL, getConfig().get('appClientId') as string, getConfig().get('appClientSecret') as string, function (err: any, response: any) {
                    var message = '';
                    if (err) {
                        message = 'error: ' + err.message + '\n';
                    }
                    message += 'response: ' + JSON.stringify(response);

                    let finalResult = {
                        access_token: response.accessToken,
                        refresh_token: response.refreshToken,
                        expires_in: response.expiresIn,
                        expires_on: response.expiresOn
                    };

                    resolve(finalResult);
                    res.send('You can now close this browser window.');
                });

            });
            server = app.listen(8350);
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(redirect_uri + '/auth'));
        }
        catch (err) {
            reject(err);
        }
    });
    return {
        createServer, dispose: () => {
            server && server.close(() => {
            });
        }
    }
}

const generateRandomString = function (length: number) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};