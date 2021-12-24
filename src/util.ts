import * as vscode from "vscode";
import { Disposable, DocumentSymbol, FileType, Memento, OutputChannel, TextDocumentShowOptions, Uri } from "vscode";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as os from "os";
import { URL, URLSearchParams } from "url";
import { createHash } from "crypto";
import { promisify } from "util";
import { exec } from "child_process";
import _ from "promise-any-polyfill";
import archiver from "archiver";
import * as mimetypes from "mime-types";
import * as unzipper from "unzipper";
import config from "./config";

export const { basename, dirname, extname } = path.posix;
export const fs = vscode.workspace.fs;

type IfEquals<X, Y, A, B> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? A : B;
type WritableKeysOf<T> = { [P in keyof T]: IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] }, P, never> }[keyof T];
type WritablePart<T> = Pick<T, WritableKeysOf<T>>;
type DeepReadonly<T> = T extends (infer U)[] ? readonly U[] : T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
type EOLMode = 'lf' | 'crlf' | 'none' | 'mixed' | '-text';

const VERBOSE_LOGGING = process.env.VSCODE_VERBOSE_LOGGING === 'true';
const tmpdir = Uri.joinPath(Uri.file(os.tmpdir()), 'aemexplorer');
let outputChannel: OutputChannel;

interface BuiltInCommands {
    ['vscode.executeDocumentSymbolProvider']: (uri: Uri) => DocumentSymbol[];
    ['vscode.open']: (uri: Uri, options?: TextDocumentShowOptions, label?: string) => void;
    ['vscode.diff']: (left: Uri, right: Uri, title?: string, options?: TextDocumentShowOptions) => void;
    ['revealInExplorer']: (uri: Uri) => void;
}

export type FetchOptions = https.RequestOptions & { body?: Buffer };

export class FetchError extends Error {
    constructor(
        public readonly url: string,
        public readonly body: string,
        public readonly response: http.IncomingMessage
    ) {
        super(`Server returned ${response.statusCode}`);
        writeMessage(`[ERROR] ${url} returned ${response.statusCode}`);
        if (VERBOSE_LOGGING && (response.statusCode || 0) >= 500) {
            writeMessage(body);
        }
    }
}

export class Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void = () => { };
    readonly reject: (reason?: any) => void = () => { };

    constructor() {
        let obj = this as { -readonly [P in keyof Deferred<T>]?: Deferred<T>[P] };
        this.promise = new Promise<T>((resolve, reject) => {
            obj.resolve = resolve;
            obj.reject = reject;
        });
    }
}

export function writeMessage(message: string) {
    (outputChannel || (outputChannel = vscode.window.createOutputChannel('AEM Explorer'))).appendLine(message);
}

export function createNotifier<T>(): [Promise<T>, (value: T | PromiseLike<T>) => void] {
    let { promise, resolve } = new Deferred<T>();
    return [promise, resolve];
}

export function createDisposeHandler(target: Record<string, Disposable>): Disposable {
    return {
        dispose() {
            for (let i in target) {
                target[i].dispose();
                delete target[i];
            }
        }
    };
}

export function onInterval(ms: number, callback: () => any): Disposable {
    let disposed = false;
    let timeout = setTimeout(async function process() {
        let ts = +new Date();
        await canFail(callback);
        if (!disposed) {
            timeout = setTimeout(process, Math.max(0, ms - (+new Date() - ts)));
        }
    }, ms);
    return {
        dispose() {
            disposed = true;
            clearTimeout(timeout);
        }
    };
}

export function deepFreeze<T>(obj: T) {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        for (let i of Object.getOwnPropertyNames(obj)) {
            deepFreeze((obj as any)[i]);
        }
    }
    return obj as DeepReadonly<T>;
}

export function matchString<T extends string>(str: string, ...args: T[]) {
    return args.some(v => v === str) && str as T;
}

export function md5base64(str: string) {
    return createHash('md5').update(str).digest('base64');
}

export function mkdtemp(...args: string[]) {
    return Uri.joinPath(tmpdir, ...args);
}

export function makeArray<T = any>(value: T | readonly T[] | undefined | null) {
    if (Array.isArray(value)) {
        return value;
    }
    if (value === undefined || value === null) {
        return [];
    }
    return [value];
}

export function unique<T>(values: Iterable<T>) {
    return [...new Set<T>(values).values()];
}

export function parseJSON(data: string | Buffer | Uint8Array) {
    try {
        return JSON.parse(data.toString());
    } catch { }
}

export function encodeXML(str: string) {
    const encoded: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\"': '&quot;',
        '\'': '&apos;',
        '\r': '&#xd;',
        '\n': '&#xa;'
    };
    return str.replace(/[&<>"'\r\n]/g, v => encoded[v] || v);
}

export function formatXML(xml: string, tab?: number | string, wrapAttributes?: boolean) {
    var formatted = '';
    var indent = '';
    var tabstr = typeof tab === 'number' ? ' '.repeat(tab) : tab || '\t';
    xml.split(/>\s*</).forEach(function (node) {
        if (node.match(/^\/\w/)) {
            indent = indent.substring(tabstr.length);
        } else if (wrapAttributes && !node.startsWith('<?xml')) {
            node = node.replace(/\s(\w[^=]*="[^"]*")/g, (v, a) => os.EOL + indent + tabstr + a);
        }
        formatted += indent + '<' + node + '>' + os.EOL;
        if (node.match(/^<?\w[^>]*[^\/]$/)) {
            indent += tabstr;
        }
    });
    return formatted.substring(1, formatted.length - 3);
}

export function canFail<T>(thenable: (() => Thenable<T>) | Thenable<T>): Thenable<T | undefined> {
    return new Promise<T | undefined>(resolve => {
        if (typeof thenable === 'function') {
            thenable = thenable();
        }
        thenable.then(resolve, () => resolve(undefined));
    });
}

export function handleError<T>(thenable: (() => Thenable<T>) | Thenable<T>): Thenable<T | undefined> {
    return new Promise<T | undefined>(resolve => {
        if (typeof thenable === 'function') {
            thenable = thenable();
        }
        thenable.then(resolve, err => {
            vscode.window.showErrorMessage(err?.message);
            console.error(err);
            resolve(undefined);
        });
    });
}

export async function executeCommand<T extends keyof BuiltInCommands>(command: T, ...args: Parameters<BuiltInCommands[T]>): Promise<ReturnType<BuiltInCommands[T]>> {
    return await vscode.commands.executeCommand(command, ...args) as ReturnType<BuiltInCommands[T]>;
}

export function resolveRelativePath(path: string | Uri, base: string | Uri) {
    let a = path.toString(true);
    let b = base.toString(true);
    let c = b[b.length - 1] === '/';
    return a.startsWith(b) && (c || a.length === b.length || a[b.length] === '/') && a.slice(b.length + +!c);
}

export async function isFile(path: Uri) {
    try {
        return ((await fs.stat(path)).type & FileType.File) !== 0;
    } catch {
        return false;
    }
}

export async function isDirectory(path: Uri) {
    try {
        return ((await fs.stat(path)).type & FileType.Directory) !== 0;
    } catch {
        return false;
    }
}

export function isTextFile(filename: string) {
    let mimetype = (mimetypes.contentType(extname(filename)) || '').split(';')[0];
    return /^text\/|[\/+](xml|json)$/.test(mimetype) || mimetype === 'application/javascript' || mimetype === 'application/ecmascript';
}

export function memoize<T extends new (...args: any[]) => object>(fn: T, state: Memento, prefix: string, memoizableProps: Partial<WritablePart<T extends new (...args: any[]) => infer W ? W : never>>): T {
    return new Proxy(fn, {
        construct(t, args, newFunction) {
            let instance = Reflect.construct(t, args, newFunction);
            for (let i in memoizableProps) {
                let v = state.get(`${prefix}.${i}`);
                if (v !== undefined) {
                    (instance as any)[i] = v;
                }
            }
            return new Proxy(instance, {
                set(t, k, v) {
                    t[k] = v;
                    if (typeof k === 'string' && k in memoizableProps) {
                        state.update(`${prefix}.${k}`, v);
                        if (typeof t.refresh === 'function') {
                            t.refresh();
                        }
                    }
                    return true;
                }
            });
        }
    });
}

export function getHostFromUrl(url: string | Uri) {
    if (typeof url === 'string') {
        url = Uri.parse(url);
    }
    return url.scheme + '://' + url.authority;
}

export function makeUri(host: string | Uri, path: string, query?: string | Record<string, any>) {
    if (typeof host === 'string') {
        host = Uri.parse(host);
    }
    if (typeof query === 'object') {
        let params = new URLSearchParams();
        for (let i in query) {
            params.append(i, String(query[i]));
        }
        query = params.toString();
    }
    return host.with({ path, query });
}

export async function fetch(url: string, options: FetchOptions = {}) {
    let { protocol, hostname, port, pathname, search } = new URL(url);
    let proxy = config.httpProxy.get(hostname);
    if (proxy) {
        protocol = proxy.protocol;
        options = {
            ...options,
            host: proxy.hostname,
            port: proxy.port,
            path: url,
            rejectUnauthorized: false
        };
    } else {
        options = {
            ...options,
            host: hostname,
            port: port,
            path: pathname + search,
        };
    }
    writeMessage(`fetch: ${options.method || 'GET'} ${url}`);
    return new Promise<Buffer>((resolve, reject) => {
        const req = (protocol === 'https:' ? https : http).request(options, (res) => {
            let chunks: Buffer[] = [];
            res.on('data', d => {
                chunks.push(d);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new FetchError(url, body.toString(), res));
                } else {
                    resolve(body);
                }
            });
        });
        req.on('error', err => {
            writeMessage(`[ERROR] Unable to fetch ${url}: ${err?.message}`);
            reject(err);
        });
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

export async function createZip(fsPath: string) {
    return new Promise<Buffer>((resolve, reject) => {
        let chunks: Buffer[] = [];
        let archive = archiver('zip');
        archive.on('error', reject);
        archive.on('data', d => {
            chunks.push(d);
        });
        archive.on('finish', () => {
            resolve(Buffer.concat(chunks));
        });
        archive.directory(fsPath, false);
        archive.finalize();
    });
}

export async function unzip(buffer: Buffer | Uint8Array, callback: (entry: unzipper.Entry) => Promise<any>) {
    const unzip = unzipper.Parse();
    unzip.on('entry', callback);
    unzip.write(buffer, 'binary');
    return unzip.promise();
}

export function getEOLResolver(path: Uri) {
    let eolHints: Record<string, EOLMode>;
    return async (relpath: string): Promise<EOLMode> => {
        if (!eolHints) {
            const { stdout } = await canFail(promisify(exec)('git ls-files --eol', { cwd: path.fsPath, encoding: 'utf8' })) || {};
            eolHints = {};
            for (let line of (stdout || '').split(/\r?\n/)) {
                if (/w\/(none|lf|crlf|mixed|-text)?[^\t]+\t(.+)/.test(line)) {
                    eolHints[RegExp.$2] = RegExp.$1 as EOLMode;
                }
            }
        }
        return eolHints[relpath] || (isTextFile(relpath) ? (os.EOL === '\n' ? 'lf' : 'crlf') : 'none');
    };
}

export function convertEOL(content: string, eol: 'lf' | 'crlf' | 'auto') {
    if (eol === 'auto') {
        eol = os.EOL === '\n' ? 'lf' : 'crlf';
    }
    if (eol === 'lf') {
        return content.replace(/\r\n/g, '\n');
    } else {
        return content.replace(/(^|[^\r])(\n+)/g, (v, a, b) => a + '\r\n'.repeat(b.length));
    }
}

export async function askFor<T>(handlers: { [P in keyof T]: () => Thenable<T[P] | undefined> }): Promise<T | undefined> {
    let result: Partial<T> = {};
    for (let k in handlers) {
        let v = await handlers[k]();
        if (v === undefined) {
            return;
        }
        result[k] = v;
    }
    return result as T;
}
