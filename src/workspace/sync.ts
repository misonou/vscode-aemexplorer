import { FileSystemWatcher, RelativePattern, Uri, workspace } from "vscode";
import config from "../config";
import { NODE_TYPE, PROP } from "../core/constants";
import { deleteJcrNode, fetchJcrNode, parseJcrContentXML, saveJcrFile, saveJcrProperties } from "../core/repo";
import { onExtensionActivated } from "../extension";
import { basename, canFail, createDisposeHandler, fs, handleError, isFile, makeUri, writeMessage } from "../util";
import { resolveRemotePath } from "./project";

const fsWatchers: Record<string, FileSystemWatcher> = {};

function doForEachHost(path: string, callback: (jcrPath: Uri, node: Record<string, any> | undefined) => Promise<any>) {
    config.hosts.forEach(async (host) => {
        let jcrPath = makeUri(host, path);
        let node = await canFail(fetchJcrNode(jcrPath));
        await handleError(callback(jcrPath, node));
    });
}

async function handleLocalChange(localPath: Uri, deleted: boolean) {
    let remotePath = resolveRemotePath(localPath);
    if (remotePath) {
        let filename = basename(localPath.path);
        if (filename === '.content.xml') {
            // update properties on JCR node when .content.xml is updated
            // no need to handle if .content.xml file is deleted
            if (!deleted) {
                const props = parseJcrContentXML((await fs.readFile(localPath)).toString());
                doForEachHost(remotePath, async (jcrPath, node) => {
                    writeMessage(`sync: Updating properties of ${jcrPath.toString(true)}`);
                    await saveJcrProperties(jcrPath, props, { deleteProps: true });
                });
            }
        } else if (deleted) {
            if (config.deleteRemoteFiles) {
                doForEachHost(remotePath, async (jcrPath, node) => {
                    if (node && node[PROP.jcrPrimaryType] === NODE_TYPE.ntFile) {
                        writeMessage(`sync: Deleting ${jcrPath.toString(true)}`);
                        await deleteJcrNode(jcrPath);
                    }
                });
            }
        } else if (await isFile(localPath)) {
            const buffer = await fs.readFile(localPath);
            doForEachHost(remotePath, async (jcrPath, node) => {
                if (!node || node[PROP.jcrPrimaryType] === NODE_TYPE.ntFile) {
                    writeMessage(`sync: Updating ${jcrPath.toString(true)}`);
                    await saveJcrFile(jcrPath, buffer);
                }
            });
        }
    }
}

function monitorPaths(patterns: string[]) {
    let dict: Record<string, FileSystemWatcher> = {};
    for (let pattern of patterns) {
        for (let { uri } of workspace.workspaceFolders || []) {
            let fullPath = uri.toString(true) + pattern.replace(/^(.\/|(?!\/))/, '/');
            if (!fsWatchers[fullPath]) {
                let watcher = workspace.createFileSystemWatcher(new RelativePattern(uri, pattern));
                watcher.onDidCreate(uri => handleLocalChange(uri, false));
                watcher.onDidChange(uri => handleLocalChange(uri, false));
                watcher.onDidDelete(uri => handleLocalChange(uri, true));
                dict[fullPath] = watcher;
                writeMessage(`sync: Monitoring ${fullPath}`);
            } else {
                dict[fullPath] = fsWatchers[fullPath];
            }
        }
    }
    for (let i in fsWatchers) {
        if (!(i in dict)) {
            fsWatchers[i].dispose();
            delete fsWatchers[i];
            writeMessage(`sync: Stopped monitoring ${i}`);
        }
    }
    Object.assign(fsWatchers, dict);
}

onExtensionActivated.then(context => {
    if (workspace.workspaceFolders) {
        monitorPaths(config.syncPaths);
        context.subscriptions.push(
            config.onDidChange(e => {
                if (e.affectsConfiguration(config.keys.syncPaths)) {
                    monitorPaths(config.syncPaths);
                }
            }),
            createDisposeHandler(fsWatchers)
        );
    }
});
