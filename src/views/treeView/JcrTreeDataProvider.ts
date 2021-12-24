import { EventEmitter, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from "vscode";
import config from "../../config";
import client, { RequestCredentialEvent } from "../../core/client";
import { FetchError, getHostFromUrl } from "../../util";
import JcrNode from "./JcrNode";
import JcrNodeFactory from "./JcrNodeFactory";

export default class JcrTreeDataProvider implements TreeDataProvider<JcrNode> {
    private readonly onDidChangeTreeDataEmitter = new EventEmitter<JcrNode | undefined | void>();
    private readonly onDidCreateNodeEmitter = new EventEmitter<JcrNode>();
    private readonly onDidUpdateNodeEmitter = new EventEmitter<JcrNode>();
    private readonly rootNodes: Record<string, JcrNode> = {};
    private readonly childNodes = new WeakMap<JcrNode, [JcrNode[], JcrNode[]] | null>();
    private readonly factory = new JcrNodeFactory(v => this.childNodes.get(v)?.[+this.enableContextualView] || []);

    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    readonly onDidCreateNode = this.onDidCreateNodeEmitter.event;
    readonly onDidUpdateNode = this.onDidUpdateNodeEmitter.event;
    enableContextualView: boolean = false;
    showHiddenNodes: boolean = false;

    refresh(element?: JcrNode): void {
        if (!element || this.childNodes.has(element)) {
            this.onDidChangeTreeDataEmitter.fire(element);
        }
    }

    getTreeItem(element: JcrNode): TreeItem {
        return element;
    }

    getParent(element: JcrNode): JcrNode | null {
        return element.parent;
    }

    async getChildren(element?: JcrNode): Promise<JcrNode[]> {
        if (!element) {
            let rootNodes = config.hosts.map(v => this.getRootNode(v));
            for (let i in this.rootNodes) {
                let node = this.rootNodes[i];
                if (!rootNodes.includes(node)) {
                    delete this.rootNodes[i];
                } else {
                    this.monitor(node, () => client.fetch(node.hostUri, { method: 'HEAD' }));
                }
            }
            return rootNodes;
        }

        let enableContextualView = this.enableContextualView;
        let rootNode = this.rootNodes[element.host];
        let entry = this.childNodes.get(element) || [[], []];

        if (rootNode.context.serverStatus !== 'online') {
            // return cached children if server is unavailable
            // will also prevent refreshing of the tree got halted
            return entry[+enableContextualView];
        }

        let childNodes: JcrNode[] = [];
        await this.monitor(element, async () => {
            if (enableContextualView) {
                childNodes.push(...await this.factory.getContextualChildNodes(element));
            }
            if (element.nodeType !== 'contextual' && (!enableContextualView || !element.isRoot)) {
                childNodes.push(...await this.factory.getChildNodes(element));
            }
        });
        if (rootNode.context.serverStatus !== 'online') {
            return entry[+enableContextualView];
        }

        if (enableContextualView && element.nodeType !== 'contextual') {
            // remove duplicated non-contextual nodes which may have been
            // already listed in the parent contextual node
            let arr = this.childNodes.get(this.getContextualParent(element)!)?.[1] || [];
            childNodes = childNodes.filter(v => {
                return v.nodeType === 'contextual' || !arr.some(w => v.id === w.id);
            });
        }
        for (let node of entry[+enableContextualView]) {
            if (!childNodes.includes(node)) {
                this.removeNode(node);
            }
        }
        childNodes.forEach(v => {
            if (!this.childNodes.has(v)) {
                this.onDidCreateNodeEmitter.fire(v);
                this.childNodes.set(v, null);
            } else {
                this.onDidUpdateNodeEmitter.fire(v);
            }
        });
        entry[+enableContextualView] = childNodes;
        this.childNodes.set(element, entry);
        return childNodes;
    }

    private getContextualParent(node: JcrNode) {
        for (; !node.isRoot; node = node.parent!) {
            if (node.nodeType === 'contextual') {
                return node;
            }
        }
    }

    private getRootNode(rootPath: Uri) {
        let host = getHostFromUrl(rootPath);
        if (!this.rootNodes[host]) {
            let node = new JcrNode(this, null, rootPath.toString(true), rootPath.authority, rootPath, {}, TreeItemCollapsibleState.Expanded);
            node.context.serverStatus = 'online';
            this.rootNodes[host] = node;
            this.childNodes.set(node, [[], []]);
            this.onDidCreateNodeEmitter.fire(node);
        }
        return this.rootNodes[host];
    }

    private removeNode(node: JcrNode) {
        let entry = this.childNodes.get(node) || [[], []];
        this.childNodes.delete(node);
        for (let child of [...entry[0], ...entry[1]]) {
            this.removeNode(child);
        }
    }

    private monitor(element: JcrNode, callback: () => any) {
        return new Promise<void>(async (resolve) => {
            let rootNode = this.rootNodes[element.host];
            let handler = (e: RequestCredentialEvent) => {
                if (e.host === element.host) {
                    this.setServerStatus(rootNode, 'authenticationFailed');
                    resolve();
                }
            };
            let disposables = [
                client.onDidRequestAuthentication(handler),
                client.onDidFailAuthentication(handler)
            ];
            try {
                await callback();
                this.setServerStatus(rootNode, 'online');
            } catch (err: any) {
                if (!(err instanceof FetchError) || !err.response.statusCode) {
                    this.setServerStatus(rootNode, 'offline');
                } else if (err.response.statusCode === 401) {
                    this.setServerStatus(rootNode, 'authenticationFailed');
                }
            }
            disposables.forEach(v => v.dispose());
            resolve();
        });
    }

    private setServerStatus(node: JcrNode, status: JcrNode['context']['serverStatus']) {
        if (node.context.serverStatus !== status) {
            node.context.serverStatus = status;
            node.iconPath = status === 'online' ? new ThemeIcon('remote-explorer') : new ThemeIcon('warning');
            node.label = node.hostUri.authority + (status === 'offline' ? ' (Offline)' : '');
            node.refresh();
        }
    }
}
