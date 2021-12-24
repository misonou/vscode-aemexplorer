import { CancellationToken, CancellationTokenSource, Event, EventEmitter, Uri } from "vscode";
import { decode as decodeHTMLEntities } from "html-entities";
import FormData from "form-data";
import { canFail, Deferred, fetch, FetchError, FetchOptions, getHostFromUrl, makeArray, parseJSON } from "../util";

export type Credential = { username: string, password: string } | { accessToken: string } | { cookie: string };

export interface RequestCredentialEvent {
    readonly host: string;
    readonly cancellationToken: CancellationToken;
    cancel(reason?: any): void;
}

function appendHeader(options: FetchOptions = {}, headers: Record<string, string> = {}) {
    return {
        ...options,
        headers: {
            ...options.headers,
            ...headers
        }
    };
}

function getAuthHeader(cred: Credential): Record<string, string> {
    if ('accessToken' in cred) {
        return { authorization: 'Bearer ' + cred.accessToken };
    }
    if ('cookie' in cred) {
        return { cookie: 'login-token=' + cred.cookie };
    }
    if ('password' in cred) {
        return { authorization: 'Basic ' + Buffer.from(cred.username + ':' + cred.password).toString('base64') };
    }
    throw new Error('Unsupported credential type');
}

function getErrorMessage(body: string) {
    let message = parseJSON(body)?.error?.message;
    if (!message && (/<div id="Message">([^<]+)<\/div>/.test(body) || /<h1>([^<]+)<\/h1>/.test(body))) {
        message = decodeHTMLEntities(RegExp.$1);
    }
    return message || 'Unknown error';
}

class FetchClient {
    private readonly authHeaders: Record<string, Record<string, string>> = {};
    private readonly pending: Record<string, Deferred<Credential> & { event: RequestCredentialEvent }> = {};
    private readonly onDidRequestAuthenticationEmitter = new EventEmitter<RequestCredentialEvent>();
    private readonly onDidFailAuthenticationEmitter = new EventEmitter<RequestCredentialEvent>();

    readonly onDidRequestAuthentication = this.onDidRequestAuthenticationEmitter.event;
    readonly onDidFailAuthentication = this.onDidFailAuthenticationEmitter.event;

    constructor() {
        let defaultCred = getAuthHeader({ username: 'admin', password: 'admin' });
        this.authHeaders['http://localhost:4502'] = defaultCred;
        this.authHeaders['http://localhost:4503'] = defaultCred;
        this.onDidRequestAuthentication = this.wrapRequestCredentialEvent(this.onDidRequestAuthentication);
        this.onDidFailAuthentication = this.wrapRequestCredentialEvent(this.onDidFailAuthentication);
    }

    setCredential<T extends Credential>(host: string, cred: T) {
        this.authHeaders[host] = getAuthHeader(cred);
        this.pending[host]?.resolve(cred);
    }

    async fetch(url: string | Uri, options?: FetchOptions): Promise<Buffer> {
        let host = getHostFromUrl(url);
        if (!this.authHeaders[host]) {
            await this.requestCredential(host, this.onDidRequestAuthenticationEmitter);
        }
        let header = this.authHeaders[host];
        try {
            return await fetch(url.toString(true), appendHeader(options, header));
        } catch (err: any) {
            if (err instanceof FetchError) {
                let statusCode = err.response.statusCode || 0;
                if (statusCode >= 500) {
                    throw new Error(getErrorMessage(err.body));
                }
                if (statusCode === 401 && !options?.headers?.['x-retry']) {
                    if (this.authHeaders[host] !== header || await canFail(this.requestCredential(host, this.onDidFailAuthenticationEmitter))) {
                        return this.fetch(url, appendHeader(options, { 'x-retry': '1' }));
                    }
                }
            }
            throw err;
        }
    }

    async fetchJSON(url: string | Uri, options?: FetchOptions) {
        const data = await this.fetch(url, appendHeader(options, { accept: 'application/json' }));
        return parseJSON(data) || { body: data.toString() };
    }

    async post(url: string | Uri, formData: FormData | Record<string, string | number | boolean | string[]> = {}, options?: Omit<FetchOptions, 'method' | 'body'>) {
        if (!(formData instanceof FormData)) {
            let instance = new FormData();
            for (let i in formData) {
                for (let v of makeArray(formData[i])) {
                    instance.append(i, String(v));
                }
            }
            formData = instance;
        }
        return this.fetchJSON(url, {
            ...options,
            method: 'POST',
            headers: {
                ...options?.headers,
                ...formData.getHeaders()
            },
            body: formData.getBuffer()
        });
    }

    private requestCredential(host: string, emitter: EventEmitter<RequestCredentialEvent>) {
        if (!this.pending[host]) {
            let def = new Deferred<Credential>();
            let cts = new CancellationTokenSource();
            let event = Object.freeze({
                host: host,
                cancel: def.reject,
                cancellationToken: cts.token
            });
            def.promise.finally(() => {
                delete this.pending[host];
                cts.cancel();
            });
            this.pending[host] = Object.assign(def, { event });
            emitter.fire(event);
        }
        return this.pending[host].promise;
    }

    private wrapRequestCredentialEvent(event: Event<RequestCredentialEvent>) {
        // notifies new listener to prevent pending requests being halted forever
        // because it is not guranteed that existing listeners
        // at the time event was triggered will actually provide credentials
        return new Proxy(event, {
            apply: (target, thisArg, argArray: Parameters<Event<RequestCredentialEvent>>) => {
                let [listener, listenerThis] = argArray;
                for (let { event } of Object.values(this.pending)) {
                    try {
                        listener.call(listenerThis, event);
                    } catch { }
                }
                return target.apply(thisArg, argArray);
            }
        });
    }
}

const client = new FetchClient();
export default client;
