import * as vscode from "vscode";
import { CancellationToken, Disposable, SecretStorage } from "vscode";
import { URL } from "url";
import config from "../config";
import { onExtensionActivated } from "../extension";
import { askFor, parseJSON, writeMessage } from "../util";
import client, { Credential } from "../core/client";

let pendingHints: Record<string, Disposable> = {};
let secrets: SecretStorage;

async function acquireCookieInteractive(host: string) {
    return new Promise<string | undefined>(async (resolve) => {
        try {
            let execArgs = [];
            let proxy = config.httpProxy.get(new URL(host).hostname);
            if (proxy) {
                execArgs.push('--proxy-server=' + proxy);
            }
            let puppeteer = (await import('puppeteer')).default;
            let browser = await puppeteer.launch({
                headless: false,
                ignoreHTTPSErrors: true,
                args: execArgs
            });
            browser.on('disconnected', () => {
                resolve(undefined);
            });
            let [page] = await browser.pages();
            page.on('framenavigated', async (frame) => {
                if (frame.url().startsWith(host)) {
                    for (let cookie of await page.cookies()) {
                        if (cookie.name === 'login-token') {
                            resolve(cookie.value);
                            browser.close();
                        }
                    }
                }
            });
            await page.goto(host);
        } catch (err: any) {
            writeMessage(`[ERROR] Unable to launch login page: ${err?.message}`);
            resolve(undefined);
        }
    });
}

export function showCredentialRequiredHint(host: string, cancellationToken?: CancellationToken) {
    if (!pendingHints[host]) {
        let item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        item.text = '$(alert) AEM requires authorization';
        item.command = {
            title: '',
            command: 'aemexplorer.workspace.acquireCredential',
            arguments: [host, cancellationToken]
        };
        item.show();
        pendingHints[host] = {
            dispose() {
                delete pendingHints[host];
                item.dispose();
            }
        };
    }
    cancellationToken?.onCancellationRequested(() => {
        pendingHints[host]?.dispose();
    });
}

export async function requestCredential(host: string, cancellationToken?: CancellationToken) {
    let cred: Credential | undefined;
    let choices = [
        'Login with username and password',
        'Login with developer access token',
        'Login interactively'
    ];
    switch (await vscode.window.showQuickPick(choices, { placeHolder: `Select login method for ${host}` })) {
        case choices[0]:
            cred = await askFor({
                username: () => vscode.window.showInputBox({
                    placeHolder: 'Username'
                }),
                password: () => vscode.window.showInputBox({
                    placeHolder: 'Password',
                    password: true
                })
            });
            break;
        case choices[1]:
            cred = await askFor({
                accessToken: () => vscode.window.showInputBox({
                    placeHolder: 'Developer access token'
                })
            });
            break;
        case choices[2]:
            cred = await askFor({
                cookie: () => acquireCookieInteractive(host)
            });
            break;
    }
    if (!cred || cancellationToken?.isCancellationRequested) {
        return false;
    }
    secrets.store(`cred.${host}`, JSON.stringify(cred));
    client.setCredential(host, cred);
    pendingHints[host]?.dispose();
    return true;
}

onExtensionActivated.then(context => {
    secrets = context.secrets;
    context.subscriptions.push(
        client.onDidRequestAuthentication(async (event) => {
            let cred = parseJSON(await context.secrets.get(`cred.${event.host}`) || '');
            if (cred) {
                client.setCredential(event.host, cred);
            } else {
                showCredentialRequiredHint(event.host, event.cancellationToken);
            }
        }),
        client.onDidFailAuthentication((event) => {
            context.secrets.delete(`cred.${event.host}`);
            showCredentialRequiredHint(event.host, event.cancellationToken);
        }),
        vscode.commands.registerCommand('aemexplorer.workspace.acquireCredential', (host: string, cancellationToken?: CancellationToken) => {
            requestCredential(host, cancellationToken);
        })
    );
});
