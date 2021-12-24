import { Disposable, EventEmitter, Uri } from "vscode";
import { decode as decodeHTMLEntities } from "html-entities";
import { createNotifier, makeUri, onInterval } from "../util";
import client from "./client";

export interface ReplicationLogEntry {
    readonly timestamp: number;
    readonly level: string;
    readonly agentId: string;
    readonly message: string;
}

export async function listLogFiles(host: string) {
    const url = makeUri(host, '/system/console/status-Configurations.txt');
    const res = (await client.fetch(url)).toString();
    const paths = new Set<string>();
    for (let m of res.matchAll(/org\.apache\.sling\.commons\.log\.file = ([^\r\n]+)/g)) {
        paths.add(m[1]);
    }
    return [...paths.values()];
}

export async function tailLog(host: string, logFile: string, count: number) {
    // last line is always an empty line
    // request one extra line and drop the last line from result
    let url = makeUri(host, '/system/console/slinglog/tailer.txt', { name: `/${logFile}`, tail: ++count });
    let arr = (await client.fetch(url)).toString().split(/\r?\n/);
    arr.pop();
    return arr;
}

export abstract class LogStream<T = string> implements Disposable {
    public static readonly WINDOW_SIZE = 10;
    public static readonly FETCH_COUNT = 20;
    public static readonly FETCH_INTERVAL = 2000;

    private readonly onDidAppendLogEmitter = new EventEmitter<T[]>();
    private readonly tailWindow: string[] = [];
    private fetchCount = LogStream.FETCH_COUNT;
    private disposables: Disposable[] = [];
    private disposed = false;

    readonly onDidAppendLog = this.onDidAppendLogEmitter.event;
    readonly ready: Promise<void>;

    constructor() {
        let [ready, notifyReady] = createNotifier<void>();
        this.ready = ready;
        Promise.resolve().then(async () => {
            let arr = await this.getLog(LogStream.WINDOW_SIZE);
            if (!this.disposed) {
                this.tailWindow.push(...arr.slice(-LogStream.WINDOW_SIZE));
                this.disposables.push(
                    onInterval(LogStream.FETCH_INTERVAL, this.fetch.bind(this))
                );
                notifyReady();
            }
        });
    }

    dispose() {
        this.disposed = true;
        this.disposables.forEach(v => v.dispose());
    }

    protected abstract getLog(count: number): Promise<string[]>;

    protected abstract transform(line: string): T;

    private async fetch() {
        while (true) {
            let tailWindow = this.tailWindow;
            let arr = await this.getLog(this.fetchCount);
            let index = arr.lastIndexOf(tailWindow[tailWindow.length - 1]);
            while (index >= 0) {
                let offset = Math.max(0, index - tailWindow.length + 1);
                if (tailWindow.every((v, i) => v === arr[i + offset])) {
                    let newlines = arr.slice(index + 1);
                    if (newlines.length) {
                        tailWindow.splice(0, newlines.length);
                        tailWindow.push(...newlines.slice(-LogStream.WINDOW_SIZE));
                        this.onDidAppendLogEmitter.fire(newlines.map(this.transform.bind(this)));
                    }
                    if (this.fetchCount > LogStream.FETCH_COUNT && newlines.length + LogStream.WINDOW_SIZE < this.fetchCount / 2) {
                        this.fetchCount = this.fetchCount / 2;
                    }
                    return;
                }
                index = arr.lastIndexOf(tailWindow[tailWindow.length - 1], index - 1);
            }
            this.fetchCount = Math.max(this.fetchCount, arr.length) * 2;
        }
    }
}

export class SystemLogStream extends LogStream {
    constructor(
        private readonly host: string,
        private readonly logFile: string
    ) { super(); }

    protected getLog(count: number) {
        return tailLog(this.host, this.logFile, count);
    }

    protected transform(line: string) {
        return line;
    }
}

export class ReplicationLogStream extends LogStream<ReplicationLogEntry> {
    constructor(
        private readonly agentUri: Uri
    ) { super(); }

    protected async getLog(): Promise<string[]> {
        let body = (await client.fetch(makeUri(this.agentUri, `${this.agentUri.path}.log.html`))).toString();
        let arr = body.substring(body.indexOf('<code>') + 6, body.lastIndexOf('</code>')).split('<br>\n');
        arr.pop();
        return arr;
    }

    protected transform(line: string): ReplicationLogEntry {
        let m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - ([A-Z]+) - ([\w-]+) : (.+)/.exec(line);
        return {
            timestamp: +new Date(m![1]),
            level: m![2],
            agentId: m![3],
            message: decodeHTMLEntities(m![4])
        };
    }
}
