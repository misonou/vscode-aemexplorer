import * as vscode from "vscode";
import { EventEmitter, Uri, workspace, WorkspaceConfiguration } from "vscode";
import { URL } from "url";

const configKeys = Object.freeze({
    tabSize: 'editor.tabSize',
    hosts: 'aemexplorer.hosts',
    httpProxy: 'aemexplorer.httpProxy',
    syncPaths: 'aemexplorer.syncPaths',
    deleteRemoteFiles: 'aemexplorer.deleteRemoteFiles',
});

interface ConfigurationChangeEvent extends vscode.ConfigurationChangeEvent {
    readonly oldValues: Configuration;
}

interface Proxy {
    readonly protocol: string;
    readonly hostname: string;
    readonly port: string;
}

class HTTPProxyConfiguration {
    private readonly entries: { match: RegExp, proxy: Proxy }[] = [];
    private readonly cache: Record<string, Proxy | null> = {
        'localhost': null,
        '127.0.0.1': null
    };

    constructor(entries: Record<string, string>) {
        for (let i in entries) {
            try {
                let { hostname, port, protocol } = new URL(entries[i]);
                this.entries.push({
                    match: new RegExp('^' + i.replace(/\./g, '\\.').replace(/\*/g, '.+') + '$'),
                    proxy: Object.freeze({ hostname, port, protocol, toString: () => entries[i] })
                });
            } catch { }
        }
    }

    get(hostname: string) {
        if (!(hostname in this.cache)) {
            this.cache[hostname] = null;
            for (let { match, proxy } of this.entries) {
                if (match.test(hostname)) {
                    this.cache[hostname] = proxy;
                    break;
                }
            }
        }
        return this.cache[hostname];
    }
}

class Configuration {
    private readonly onDidChangeEmitter = new EventEmitter<ConfigurationChangeEvent>();
    private config: WorkspaceConfiguration;
    private values: Record<string, any> = {};

    readonly onDidChange = this.onDidChangeEmitter.event;
    readonly keys = configKeys;

    constructor(listenChanges = true) {
        this.config = workspace.getConfiguration();
        if (listenChanges) {
            this.listenChanges();
        }
    }

    get tabSize() {
        return this.getValue(configKeys.tabSize, 4);
    }

    get hosts() {
        return this.getValue(configKeys.hosts, ['http://localhost:4502'], values => {
            let dict: Record<string, Uri> = {};
            for (let v of values) {
                try {
                    let uri = Uri.parse(v).with({ path: '', query: '', fragment: '' });
                    dict[uri.toString()] = uri;
                } catch { }
            }
            return Object.values(dict);
        });
    }

    get httpProxy() {
        return this.getValue(configKeys.httpProxy, {}, v => new HTTPProxyConfiguration(v));
    }

    get syncPaths() {
        return this.getValue(configKeys.syncPaths, [] as string[]);
    }

    get deleteRemoteFiles() {
        return this.getValue(configKeys.deleteRemoteFiles, false);
    }

    private getValue<T, V = T>(key: string, defaultValue: T, mapFn?: (value: T) => V) {
        if (!(key in this.values)) {
            let value = this.config.get(key, defaultValue);
            this.values[key] = mapFn ? mapFn(value) : value;
        }
        return this.values[key] as V;
    }

    private listenChanges() {
        workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
            if (Object.keys(this.values).some(v => affectsConfiguration(v))) {
                let oldValues = new Configuration(false);
                oldValues.config = this.config;
                oldValues.values = this.values;
                this.config = workspace.getConfiguration();
                this.values = {};
                this.onDidChangeEmitter.fire({ oldValues, affectsConfiguration });
            }
        });
    }
}

const config = new Configuration();
export default config;
