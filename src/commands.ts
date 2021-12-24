import * as vscode from "vscode";
import { Disposable, OutputChannel, Uri } from "vscode";
import { EOL } from "os";
import { v4 as uuidv4 } from "uuid";
import { NODE_TYPE, PATH, PROP, RESOURCE_TYPE } from "./core/constants";
import { onExtensionActivated } from "./extension";
import { askFor, basename, canFail, convertEOL, createDisposeHandler, executeCommand, extname, fs, handleError, makeArray, makeUri, mkdtemp } from "./util";
import { getEditableUri, openFileInWorkspace } from "./workspace/document";
import { getLocalProjects, resolveLocalPath } from "./workspace/project";
import config from "./config";
import client from "./core/client";
import { uploadAsset } from "./core/dam";
import { getOsgiConfigSchemas } from "./core/osgi";
import { readPackage, uploadPackage } from "./core/package";
import { deleteJcrNode, existJcrNode, exportJcrContent, fetchJcrProperties, moveJcrNode, saveJcrFile, saveJcrProperties } from "./core/repo";
import { createGroup, createUser, CreateUserOptions, deleteAuthorizable, getGroupMembers, getMembership, setMembership, updateGroupMembers } from "./core/security";
import { SystemLogStream, tailLog } from "./core/system";
import { createPage, CreatePageOptions } from "./core/wcm";
import { showOpenDialog, showQuickPickAuthorizable, showQuickPickMany, showQuickPickPageTemplate, showQuickPickT } from "./helpers/pickers";
import { startPublishTask } from "./helpers/publishAgent";
import * as validators from "./helpers/validators";
import { JcrNode, JcrTreeView, onTreeViewCreated } from "./views/treeView";

interface WithLocalPath { localPath?: Uri; }
interface WithRevealPathPattern { revealPathPattern?: string | ((node: JcrNode) => string); }

const { showInformationMessage, showWarningMessage, showInputBox, showSaveDialog, showQuickPick, createOutputChannel } = vscode.window;

let treeView: JcrTreeView;
let logStreams: Record<string, LogStreamView> = {};

class LogStreamView implements Disposable {
    constructor(
        public readonly stream: SystemLogStream,
        public readonly outputChannel: OutputChannel
    ) { }

    dispose() {
        this.stream.dispose();
        this.outputChannel.dispose();
    }
}

const treeViewCommands = {
    async copyPath(node: JcrNode) {
        await vscode.env.clipboard.writeText(node.jcrPath.path);
    },
    async copyURL(node: JcrNode) {
        await vscode.env.clipboard.writeText(node.jcrPath.toString(true));
    },
    async copyTagID(node: JcrNode) {
        let [ns, ...args] = node.jcrPath.path.replace(`${PATH.tags}/`, '').split('/');
        await vscode.env.clipboard.writeText(`${ns}:${args.join('/')}`);
    },
    async copyAuthorizableID(node: JcrNode) {
        await vscode.env.clipboard.writeText(node.properties[PROP.repAuthorizableId]);
    },
    async viewProperties(node: JcrNode) {
        await openFileInWorkspace('property.json', node.jcrPath);
    },
    async viewPageProperties(node: JcrNode) {
        await openFileInWorkspace('property.json', Uri.joinPath(node.jcrPath, 'jcr:content'));
    },
    async viewContentXML(node: JcrNode) {
        await openFileInWorkspace('content.xml', Uri.joinPath(node.jcrPath, node.context.hasJcrContent ? 'jcr:content' : '.'));
    },
    async openFile(node: JcrNode) {
        await openFileInWorkspace('binary', node.jcrPath);
    },
    async openInBrowser(node: JcrNode, path: string = '{}.html') {
        await executeCommand('vscode.open', Uri.parse(node.host + path.replace('{}', node.jcrPath.path)));
    },
    async editInBrowser(node: JcrNode) {
        await treeViewCommands.openInBrowser(node, '/editor.html{}.html');
    },
    async revealInBrowser(node: JcrNode & WithRevealPathPattern) {
        let { revealPathPattern } = node;
        if (revealPathPattern) {
            if (typeof revealPathPattern === 'function') {
                revealPathPattern = revealPathPattern(node);
            }
            return treeViewCommands.openInBrowser(node, revealPathPattern);
        }
    },
    async openLocalFile(node: JcrNode & WithLocalPath) {
        if (node.localPath) {
            await executeCommand('vscode.open', node.localPath);
        }
    },
    async diffLocalFile(node: JcrNode & WithLocalPath) {
        if (node.localPath) {
            const tmpPath = await getEditableUri('binary', node.jcrPath);
            await executeCommand('vscode.diff', node.localPath, tmpPath, `${basename(node.jcrPath.path)} (Diff)`);
        }
    },
    async revealInExplorer(node: JcrNode & WithLocalPath) {
        if (node.localPath) {
            await executeCommand('revealInExplorer', node.localPath);
        }
    },
    async renameContent(node: JcrNode) {
        let oldName = basename(node.jcrPath.path);
        let newName = await showInputBox({
            value: oldName,
            valueSelection: [0, extname(oldName) ? basename(oldName, extname(oldName)).length : oldName.length],
            validateInput: validators.combine(validators.validateNonEmpty, validators.validateUniqueNodeName(Uri.joinPath(node.jcrPath, '..')))
        });
        if (newName) {
            await moveJcrNode(node.jcrPath, Uri.joinPath(node.jcrPath, '..', newName));
            node.parent?.refresh();
        }
    },
    async deleteContent(node: JcrNode) {
        const execute = async (callback: (uri: Uri) => Promise<any>, confirmMessage: string, successMessage: string, label?: string) => {
            label = label || node.jcrPath.toString(true);
            if (await showWarningMessage(confirmMessage.replace('{}', label), 'Yes', 'No') === 'Yes') {
                await callback(node.jcrPath);
                showInformationMessage(successMessage.replace('{}', label));
                node.parent?.refresh();
            }
        };
        switch (node.nodeType) {
            case 'user':
            case 'group':
                return execute(deleteAuthorizable, 'Delete user/group {}?', 'User/group {} was deleted', `'${node.properties[PROP.repAuthorizableId]}' on ${node.host}`);
            default:
                return execute(deleteJcrNode, 'Delete item at {}?', 'Item at {} was deleted');
        }
    },
    async exportContent(node: JcrNode) {
        const choices = Object.fromEntries(getLocalProjects().filter(v => v.jcrRootPath).map(v => [`$(project) ${v.artifactId}`, v.jcrRootPath]));
        const selected = await showQuickPick([
            ...Object.keys(choices),
            '$(folder) Select folder'
        ], {
            placeHolder: 'Select content package or folder to save exported content'
        });
        if (selected) {
            let destPath = choices[selected];
            if (!destPath) {
                destPath = makeArray(await showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                }))[0];
            }
            if (destPath) {
                await exportJcrContent(node.jcrPath, destPath);
                showInformationMessage(`Content exported to ${destPath.fsPath}`);
            }
        }
    },
    async uploadFile(node: JcrNode) {
        let files = await showOpenDialog({ canSelectMany: true });
        if (files) {
            files.forEach(async (v) => {
                if (await handleError(uploadAsset(node.jcrPath, v))) {
                    node.refresh();
                }
            });
        }
    },
    async downloadFile(node: JcrNode) {
        if (node.nodeType === 'file' || node.nodeType === 'osgiconfig') {
            let extension = extname(node.jcrPath.path);
            let dstPath = await showSaveDialog({
                defaultUri: Uri.joinPath(Uri.file(process.env.USERPROFILE || process.env.HOME!), 'Downloads', basename(node.jcrPath.path)),
                filters: { [`*${extension}`]: [extension.slice(1)] }
            });
            if (dstPath) {
                let buffer = await client.fetch(node.jcrPath);
                await fs.writeFile(dstPath, buffer);
                showInformationMessage(`File saved to ${dstPath.fsPath}`);
            }
        }
    },
    async editCugPolicy(node: JcrNode) {
        let policy = await canFail(fetchJcrProperties(Uri.joinPath(node.jcrPath, 'rep:cugPolicy')));
        let picked = await showQuickPickAuthorizable(node.hostUri, {
            canPickMany: true,
            picked: policy?.[PROP.repPrincipalNames]
        });
        if (picked) {
            await client.post(makeUri(node.hostUri, `${node.jcrPath.path}.cugpolicy.conf`), {
                principalNames: picked.length ? picked : ''
            });
            showInformationMessage(`Closed user group updated for ${node.label}`);
        }
    },
    async downloadPackage(node: JcrNode) {
        if (node.nodeType === 'package') {
            let filename = `${node.properties.name}-${node.properties.version}.zip`;
            let dstPath = await showSaveDialog({
                defaultUri: Uri.joinPath(Uri.file(process.env.USERPROFILE || process.env.HOME!), 'Downloads', filename),
                filters: { 'FileVault Packages': ['zip'] }
            });
            if (dstPath) {
                let buffer = await client.fetch(Uri.joinPath(node.jcrPath, '../..'));
                await fs.writeFile(dstPath, buffer);
                showInformationMessage(`Package saved to ${dstPath.fsPath}`);
            }
        }
    },
    async installPackage(node: JcrNode) {
        let files = await showOpenDialog({
            canSelectMany: true,
            filters: { 'FileVault Packages': ['zip'] }
        });
        if (files) {
            for (let v of files) {
                handleError(async () => {
                    let { name, group, version } = await readPackage(v);
                    let packageName = `${group}/${name}-${version}.zip`;
                    await uploadPackage(node.host, packageName, await fs.readFile(v), true);
                    showInformationMessage(`${packageName} installed to ${node.host}`);
                    treeView.expandAndRefresh(node);
                });
            }
        }
    },
    async tailLog(node: JcrNode) {
        if (node.context.contextualType === 'logStream') {
            let logFile = node.context.contextualValue!;
            let tmpPath = Uri.joinPath(mkdtemp(), ['logs', node.hostUri.authority.replace(/\W/g, ''), ...logFile.replace('.log', '').split('/'), +new Date()].join('-') + '.log');
            let lines = await tailLog(node.host, logFile, 1000);
            await fs.writeFile(tmpPath, Buffer.from(lines.join(EOL)));
            await executeCommand('vscode.open', tmpPath);
        }
    },
    async openLogStream(node: JcrNode) {
        if (node.context.contextualType === 'logStream' && node.id) {
            if (!logStreams[node.id]) {
                let logFile = node.context.contextualValue!;
                let stream = new SystemLogStream(node.host, logFile);
                let outputChannel = createOutputChannel(`AEM Log Watcher (${logFile})`);
                stream.onDidAppendLog(arr => {
                    arr.forEach(v => outputChannel.appendLine(v));
                });
                logStreams[node.id] = new LogStreamView(stream, outputChannel);
            }
            logStreams[node.id].outputChannel.show(true);
            node.context.active = true;
            node.refresh();
        }
    },
    async closeLogStream(node: JcrNode) {
        if (node.id && logStreams[node.id]) {
            logStreams[node.id].dispose();
            delete logStreams[node.id];
            node.context.active = false;
            node.refresh();
        }
    },
    async createFolder(node: JcrNode) {
        let nodename = await showInputBox({
            placeHolder: 'Enter a unique node name',
            validateInput: validators.combine(validators.validateNonEmpty, validators.validateIDChar, validators.validateUniqueNodeName(node.jcrPath))
        });
        if (nodename) {
            const childPath = Uri.joinPath(node.jcrPath, nodename);
            await saveJcrProperties(childPath, { [PROP.jcrPrimaryType]: NODE_TYPE.slingFolder });
            treeView.expandAndRefresh(node);
        }
    },
    async createPage(node: JcrNode): Promise<void> {
        let siteNode: JcrNode | null = node;
        if (node.nodeType === 'page') {
            for (; siteNode; siteNode = siteNode?.parent) {
                if (siteNode.nodeType === 'site' || siteNode.context.contextualType === 'pages') {
                    break;
                }
            }
        }
        let params = await askFor<Omit<CreatePageOptions, 'parentPath'>>({
            label: () => showInputBox({
                prompt: 'Enter page name',
                validateInput: validators.combine(validators.validateNonEmpty, validators.validateIDChar, validators.validateUniqueNodeName(node.jcrPath))
            }),
            title: () => showInputBox({
                prompt: 'Enter page title',
                validateInput: validators.validateNonEmpty
            }),
            template: () => showQuickPickPageTemplate((siteNode || node).jcrPath, {
                placeHolder: 'Select page template'
            })
        });
        if (params) {
            await createPage(node.hostUri, { parentPath: node.jcrPath.path, ...params });
            treeView.expandAndRefresh(node);
        }
    },
    async createTag(node: JcrNode) {
        let params = await askFor({
            title: () => showInputBox({
                prompt: 'Enter tag title',
                validateInput: validators.validateNonEmpty
            }),
            description: () => showInputBox({
                prompt: 'Enter tag description (optional)'
            })
        });
        if (params) {
            if (node.context.contextualType === 'tags') {
                // create root tag for the site if not exist
                // as immediate child of cq:tags folder must also be of primary type cq:Tags
                if (!await existJcrNode(node.jcrPath)) {
                    await saveJcrProperties(node.jcrPath, {
                        [PROP.jcrPrimaryType]: NODE_TYPE.cqTag,
                        [PROP.jcrTitle]: node.parent?.label,
                        [PROP.slingResourceType]: RESOURCE_TYPE.cqTag
                    });
                }
            }
            let nodename = params.title.replace(/\W+/, '-').toLowerCase();
            await saveJcrProperties(Uri.joinPath(node.jcrPath, nodename), {
                [PROP.jcrPrimaryType]: NODE_TYPE.cqTag,
                [PROP.jcrTitle]: params.title,
                [PROP.jcrDescription]: params.description,
                [PROP.slingResourceType]: RESOURCE_TYPE.cqTag
            });
            treeView.expandAndRefresh(node);
        }
    },
    async createUser(node: JcrNode) {
        let params = await askFor<CreateUserOptions>({
            userId: () => showInputBox({
                placeHolder: 'Enter a unique user ID',
                validateInput: validators.combine(validators.validateNonEmpty, validators.validateIDChar, validators.validateUniqueAuthorizableId(node.hostUri))
            }),
            password: () => showInputBox({
                password: true,
                placeHolder: 'Enter password',
                validateInput: validators.validateNonEmpty
            }),
            groups: () => showQuickPickAuthorizable(node.hostUri, {
                canPickMany: true,
                canPickUsers: false,
                exclude: ['everyone']
            })
        });
        if (params) {
            await createUser(node.hostUri, params);
            showInformationMessage(`User ${params.userId} created on ${node.host}`);
            treeView.expandAndRefresh(node);
        }
    },
    async editMembership(node: JcrNode) {
        if (node.nodeType === 'user') {
            let curValues = await getMembership(node.jcrPath);
            let newValues = await showQuickPickAuthorizable(node.hostUri, {
                canPickMany: true,
                canPickUsers: false,
                picked: curValues,
                exclude: ['everyone']
            });
            if (newValues) {
                await setMembership(node.jcrPath, newValues);
                showInformationMessage(`Membership updated for user ${node.label} on ${node.host}`);
            }
        }
    },
    async createGroup(node: JcrNode) {
        let params = await askFor({
            groupId: () => showInputBox({
                placeHolder: 'Enter a unique group ID',
                validateInput: validators.combine(validators.validateNonEmpty, validators.validateIDChar, validators.validateUniqueAuthorizableId(node.hostUri))
            }),
            givenName: () => showInputBox({
                prompt: `Enter display name`
            })
        });
        if (params) {
            let { groupId, givenName } = params;
            let groupUri = await createGroup(node.hostUri, groupId);
            if (params.givenName) {
                await saveJcrProperties(groupUri, { profile: { givenName } });
            }
            showInformationMessage(`Group ${groupId} created on ${node.host}`);
            treeView.expandAndRefresh(node);
        }
    },
    async editGroupName(node: JcrNode) {
        if (node.nodeType === 'group') {
            let originalName = node.properties.profile?.givenName || node.properties[PROP.repAuthorizableId];
            let givenName = await showInputBox({
                prompt: `Enter display name for ${node.label}`,
                value: originalName,
                valueSelection: [0, originalName.length]
            });
            if (givenName !== undefined) {
                await saveJcrProperties(node.jcrPath, { profile: { givenName } });
                node.parent?.refresh();
            }
        }
    },
    async editGroupMember(node: JcrNode) {
        if (node.nodeType === 'group') {
            const curValues = await getGroupMembers(node.jcrPath);
            const newValues = await showQuickPickAuthorizable(node.hostUri, {
                canPickMany: true,
                picked: curValues,
                exclude: [node.properties[PROP.repAuthorizableId], 'everyone']
            });
            if (newValues) {
                await updateGroupMembers(node.jcrPath, {
                    addMembers: newValues.filter(v => !curValues.includes(v)),
                    removeMembers: curValues.filter(v => !newValues.includes(v))
                });
                showInformationMessage(`Members updated for group ${node.label} on ${node.host}`);
            }
        }
    },
    async createConfig(node: JcrNode) {
        let scopeLabels = [
            'All instances',
            'Author instance only',
            'Publish instance only'
        ];
        let params = await askFor({
            type: () => showQuickPickT(getOsgiConfigSchemas(), {
                canPickMany: false,
                matchOnDetail: true,
                getLabel: v => v.name,
                getDetail: v => v.name !== v.id ? v.id : '',
                mapResult: v => v
            }),
            scope: () => showQuickPick(scopeLabels, {
                placeHolder: 'Select instance types that this configuration will be applied to'
            })
        });
        if (params) {
            let defaults: Record<string, any> = {};
            let attributes = params.type.attributes;
            for (let i in attributes) {
                if (attributes[i].default !== undefined) {
                    defaults[i] = attributes[i].default;
                }
            }
            let content = convertEOL(JSON.stringify(defaults, null, config.tabSize), 'auto');
            let folderPath = Uri.joinPath(node.jcrPath, ['config', 'config.author', 'config.publish'][scopeLabels.indexOf(params.scope)]);
            if (!await existJcrNode(folderPath)) {
                await saveJcrProperties(folderPath, { [PROP.jcrPrimaryType]: NODE_TYPE.slingFolder });
            }
            let filePath = Uri.joinPath(folderPath, `${params.type.id}.${uuidv4()}.cfg.json`);
            await saveJcrFile(filePath, content, 'application/json');
            await openFileInWorkspace('binary', filePath);
            treeView.expandAndRefresh(node, 2);
        }
    },
    async publish(node: JcrNode) {
        startPublishTask(node.jcrPath);
    },
    async publishSubtree(node: JcrNode) {
        let choices = {
            includeNewItems: 'Include new items',
            includeUnmodifiedItems: 'Include unmodified items',
            includeDeactivatedItems: 'Include unpublished (deactivated) items'
        };
        let options = await showQuickPickMany(Object.values(choices), {
            title: `Select publish mode for ${node.label}`,
            picked: [choices.includeNewItems]
        });
        if (options) {
            startPublishTask(node.jcrPath, {
                subtree: true,
                includeNewItems: options.includes(choices.includeNewItems),
                includeUnmodifiedItems: options.includes(choices.includeUnmodifiedItems),
                includeDeactivatedItems: options.includes(choices.includeDeactivatedItems)
            });
        }
    },
    async showHiddenNodes(node: JcrNode) {
        node.context.showHiddenNodes = true;
        treeView.expandAndRefresh(node);
    },
    async refreshTreeView(node: JcrNode | undefined) {
        treeView.provider.refresh(node);
    },
    async toggleContextualView() {
        treeView.provider.enableContextualView = !treeView.provider.enableContextualView;
    }
};

function wrapCommand(command: (...args: any[]) => Promise<any>) {
    return function (...args: any[]) {
        handleError(command(...args));
    };
}

onExtensionActivated.then(context => {
    context.subscriptions.push(createDisposeHandler(logStreams));
    for (let i in treeViewCommands) {
        context.subscriptions.push(vscode.commands.registerCommand(`aemexplorer.treeView.${i}`, wrapCommand(treeViewCommands[i as keyof typeof treeViewCommands])));
    }
});

onTreeViewCreated.then(treeView_ => {
    const updateNodeContext = (node: JcrNode & WithLocalPath) => {
        node.localPath = resolveLocalPath(node.jcrPath);
        node.context.local = !!node.localPath;
        node.context.hasJcrContent = !!node.properties[PROP.jcrContent];
    };
    treeView = treeView_;
    treeView.provider.onDidCreateNode(updateNodeContext);
    treeView.provider.onDidUpdateNode(updateNodeContext);
    treeView.provider.onDidCreateNode((node: JcrNode & WithRevealPathPattern) => {
        if (node.nodeType === 'file' || node.nodeType === 'osgiconfig') {
            node.command = {
                title: 'Open',
                command: 'aemexplorer.treeView.openFile',
                arguments: [node]
            };
        }
        if (node.jcrPath.path.startsWith('/content/') && node.jcrPrimaryType !== NODE_TYPE.repACL && node.nodeType !== 'content' && node.nodeType !== 'contentRoot') {
            switch (node.jcrPath.path.split('/')[2]) {
                case 'projects':
                    node.revealPathPattern = '/projects/details.html{}';
                    break;
                case 'experience-fragments':
                    node.revealPathPattern = '/aem/experience-fragments.html{}';
                    break;
                case 'dam':
                    node.revealPathPattern = '/assets.html{}';
                    break;
                case 'screens':
                    node.revealPathPattern = '/screens.html{}';
                    break;
                case 'campaigns':
                    node.revealPathPattern = '/sites.html{}';
                    break;
                case 'cq:tags':
                    node.revealPathPattern = '/libs/cq/tagging/gui/content/tags.html{}';
                    break;
            }
            if (node.nodeType === 'page' || node.context.contextualType === 'site') {
                node.revealPathPattern = '/sites.html{}';
            }
        } else {
            switch (node.nodeType) {
                case 'group':
                    node.revealPathPattern = '/libs/granite/security/content/v2/groupeditor.html{}';
                    break;
                case 'user':
                    node.revealPathPattern = '/libs/granite/security/content/v2/usereditor.html{}';
                    break;
                case 'package':
                    node.revealPathPattern = node => '/crx/packmgr/index.jsp#' + node.jcrPath.path.replace('/jcr:content/vlt:definition', '');
                    break;
            }
        }
        node.context.revealInBrowser = !!node.revealPathPattern;
    });
});
