import { TreeItemCollapsibleState, TreeView, window } from "vscode";
import { onExtensionActivated } from "../../extension";
import config from "../../config";
import { createNotifier, memoize } from "../../util";
import { onDidUpdateLocalProject } from "../../workspace/project";
import JcrNode from "./JcrNode";
import JcrTreeDataProvider from "./JcrTreeDataProvider";

const [onTreeViewCreated, notifyTreeViewCreated] = createNotifier<JcrTreeView>();

export {
    JcrNode,
    JcrTreeDataProvider,
    onTreeViewCreated
};

export interface JcrTreeView extends TreeView<JcrNode> {
    provider: JcrTreeDataProvider;
    expandAndRefresh(node: JcrNode, level?: number): void;
}

function expandAndRefresh(treeView: JcrTreeView, node: JcrNode, level?: number) {
    treeView.reveal(node, { expand: level || true });
    node.refresh();
}

onExtensionActivated.then(context => {
    let provider = new (memoize(JcrTreeDataProvider, context.workspaceState, 'treeView', {
        enableContextualView: true,
        showHiddenNodes: true
    }))();
    let treeView = window.createTreeView('aemexplorer.treeView', { treeDataProvider: provider }) as JcrTreeView;
    treeView.provider = provider;
    treeView.expandAndRefresh = expandAndRefresh.bind(null, treeView);

    context.subscriptions.push(treeView);
    context.subscriptions.push(
        treeView.onDidExpandElement(e => {
            e.element.collapsibleState = TreeItemCollapsibleState.Expanded;
            context.workspaceState.update(`treeView.collapsibleState.${e.element.id}`, e.element.collapsibleState);
        }),
        treeView.onDidCollapseElement(e => {
            e.element.collapsibleState = TreeItemCollapsibleState.Collapsed;
            context.workspaceState.update(`treeView.collapsibleState.${e.element.id}`, e.element.collapsibleState);
        }),
        provider.onDidCreateNode(node => {
            let savedState = context.workspaceState.get<TreeItemCollapsibleState>(`treeView.collapsibleState.${node.id}`);
            if (savedState !== undefined && node.collapsibleState !== TreeItemCollapsibleState.None) {
                node.collapsibleState = savedState;
            }
        }),
        onDidUpdateLocalProject(() => {
            provider.refresh();
        }),
        config.onDidChange(e => {
            if (e.affectsConfiguration(config.keys.hosts) || e.affectsConfiguration(config.keys.httpProxy)) {
                provider.refresh();
            }
        }),
        window.onDidChangeWindowState(e => {
            if (e.focused) {
                provider.refresh();
            }
        })
    );
    notifyTreeViewCreated(treeView);
});
