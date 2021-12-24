import { Disposable, EventEmitter, FileSystemWatcher, RelativePattern, Uri, workspace } from "vscode";
import * as xml from "fast-xml-parser";
import { onExtensionActivated } from "../extension";
import { canFail, createDisposeHandler, createNotifier, deepFreeze, fs, isDirectory, makeArray, resolveRelativePath, writeMessage } from "../util";
import { fileSystemToJcr } from "../core/repo";
import client from "../core/client";

const MVN_PROPS = Object.freeze({
    authorHost: 'aem.host',
    authorPort: 'aem.port',
    publishHost: 'aem.publish.host',
    publishPort: 'aem.publish.port',
    username: 'sling.user',
    password: 'sling.password',
});

const [onLocalProjectLoaded, notifyLocalProjectLoaded] = createNotifier<void>();
const onDidUpdateLocalProjectEmitter = new EventEmitter<{ localFiles?: boolean }>();
const onDidUpdateLocalProject = onDidUpdateLocalProjectEmitter.event;
const projects: Record<string, Project> = {};

export {
    onLocalProjectLoaded,
    onDidUpdateLocalProject
};

class Project implements Disposable {
    private fsWatcher?: FileSystemWatcher;
    readonly rootPath: string;
    readonly artifactId: string;
    readonly localFiles: Record<string, string>;
    readonly initialized: Promise<void>;
    jcrRootPath?: Uri;

    constructor(
        public readonly rootUri: Uri,
        public readonly definition: any,
    ) {
        writeMessage(`Discovered project at ${rootUri.toString(true)}`);
        deepFreeze(definition);
        this.rootPath = rootUri.toString(true);
        this.artifactId = definition.project?.artifactId;

        let prev = projects[this.rootPath];
        this.localFiles = prev?.localFiles || {};
        this.fsWatcher = prev?.fsWatcher;
        this.initialized = this.initJcrRootPath();
        this.setCredential();
    }

    get properties(): Record<string, string> {
        return this.definition.project.properties || {};
    }

    dispose() {
        if (this.fsWatcher) {
            this.fsWatcher.dispose();
        }
    }

    private async initJcrRootPath() {
        for (let { groupId, artifactId, configuration } of makeArray(this.definition.project?.build?.plugins?.plugin)) {
            if (groupId === 'org.apache.jackrabbit' && artifactId === 'filevault-package-maven-plugin') {
                let jcrRootDirs = configuration.jcrRootSourceDirectory || 'jcr_root,src/main/jcr_root,src/main/content/jcr_root,src/content/jcr_root';
                for (let path of jcrRootDirs.split(',')) {
                    let dirUri = Uri.joinPath(this.rootUri, path);
                    if (await isDirectory(dirUri)) {
                        this.jcrRootPath = dirUri;
                        if (this.localFiles['.'] !== dirUri.toString(true)) {
                            if (this.fsWatcher) {
                                this.fsWatcher.dispose();
                            }
                            this.localFiles['.'] = dirUri.toString(true);
                            this.fsWatcher = initLocalFileWatcher(dirUri, this.localFiles);
                        }
                        return;
                    }
                }
            }
        }
    }

    private setCredential() {
        let {
            [MVN_PROPS.authorHost]: authorHost,
            [MVN_PROPS.authorPort]: authorPort,
            [MVN_PROPS.publishHost]: publishHost,
            [MVN_PROPS.publishPort]: publishPort,
            [MVN_PROPS.username]: username,
            [MVN_PROPS.password]: password,
        } = this.properties;
        if (username && password) {
            if (authorHost && authorPort) {
                client.setCredential(`http://${authorHost}:${authorPort}`, { username, password });
            }
            if (publishHost && publishPort) {
                client.setCredential(`http://${publishHost}:${publishPort}`, { username, password });
            }
        }
    }
}

function initLocalFileWatcher(jcrRoot: Uri, localFiles: Record<string, string>) {
    let pattern = new RelativePattern(jcrRoot, '**/*');
    let basePath = jcrRoot.toString(true);
    let fsWatcher = workspace.createFileSystemWatcher(pattern, false, true, false);

    let toRemotePath = (v: Uri) => fileSystemToJcr(v.toString(true).slice(basePath.length).replace(/\/.content.xml$/, ''));
    fsWatcher.onDidCreate(v => {
        localFiles[toRemotePath(v)] = v.toString(true);
        onDidUpdateLocalProjectEmitter.fire({ localFiles: true });
    });
    fsWatcher.onDidDelete(v => {
        delete localFiles[toRemotePath(v)];
        onDidUpdateLocalProjectEmitter.fire({ localFiles: true });
    });
    workspace.findFiles(pattern).then(files => {
        for (let v of files) {
            localFiles[toRemotePath(v)] = v.toString(true);
        }
        onDidUpdateLocalProjectEmitter.fire({ localFiles: true });
    });
    return fsWatcher;
}

function readProjectFile(uri: Uri) {
    return canFail(async () => {
        let buffer = await fs.readFile(uri);
        let pom = xml.parse(buffer.toString(), { ignoreAttributes: false });
        if (pom.project?.['@_xmlns'] === 'http://maven.apache.org/POM/4.0.0') {
            let instance = new Project(Uri.joinPath(uri, '..'), pom);
            projects[instance.rootPath] = instance;
            await instance.initialized;
        }
    });
}

export function getLocalProjects() {
    return Object.values(projects);
}

export function resolveLocalPath(jcrPath: Uri) {
    for (let project of getLocalProjects()) {
        if (project.localFiles[jcrPath.path]) {
            return Uri.parse(project.localFiles[jcrPath.path]);
        }
    }
}

export function resolveRemotePath(localPath: Uri) {
    for (let project of getLocalProjects()) {
        if (project.jcrRootPath && resolveRelativePath(localPath, project.jcrRootPath)) {
            return fileSystemToJcr(localPath.toString(true).slice(project.jcrRootPath.toString(true).length).replace(/\/.content.xml$/, ''));
        }
    }
}

onExtensionActivated.then(context => {
    if (workspace.workspaceFolders) {
        let fsWatcher = workspace.createFileSystemWatcher('**/pom.xml');
        fsWatcher.onDidCreate(readProjectFile);
        fsWatcher.onDidChange(readProjectFile);
        fsWatcher.onDidDelete(e => {
            let project = projects[Uri.joinPath(e, '..').toString(true)];
            if (project) {
                delete projects[project.rootPath];
                project.dispose();
                if (Object.keys(project.localFiles).length > 0) {
                    onDidUpdateLocalProjectEmitter.fire({ localFiles: true });
                }
            }
        });
        canFail(async () => {
            let files = await workspace.findFiles('**/pom.xml');
            await Promise.all(files.map(readProjectFile));
            notifyLocalProjectLoaded();
        });
        context.subscriptions.push(fsWatcher);
        context.subscriptions.push(createDisposeHandler(projects));
    } else {
        notifyLocalProjectLoaded();
    }
});
