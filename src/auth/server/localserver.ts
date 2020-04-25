import * as express from 'express';
import { Server } from 'http';
import { getConfig } from './../../extension';
import { WorkspaceConfiguration } from "vscode";


export interface AuthServerPromise {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

export const AuthServer = () => {
    let server: Server;
    const createServer = new Promise<AuthServerPromise>((resolve, reject)=>{
        setTimeout(() => {
            reject('Timeout error. No response for 10 minutes.');
        }, 10 * 60 * 1000 /*10 minutes*/);

        try {
            const app = express();

            app.get("/result", (request: any, reponse: any) => {
                const { error } = request.query;
                if(!error) {
                    resolve(request.query);
                }
                else {
                    reject(error);
                }
                reponse.redirect(`${getConfig().get('authWebServiceURL')}/?message=${encodeURIComponent('You can now close this tab')}`);
                request.destroy();
            });

            server = app.listen(8350);
        }
        catch(err) {
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