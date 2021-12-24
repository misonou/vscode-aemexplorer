import * as vscode from "vscode";
import { GlobPattern, Memento, RelativePattern, TextDocument, Uri } from "vscode";
import * as mimetypes from "mime-types";
import config from "../config";
import client from "../core/client";
import { PROP } from "../core/constants";
import { convertToJcrContentXML, existJcrNode, fetchJcrNode, fetchJcrProperties, FetchMode, jcrToFileSystem, parseJcrContentXML, saveJcrFile, saveJcrProperties } from "../core/repo";
import { onExtensionActivated } from "../extension";
import { basename, canFail, dirname, executeCommand, extname, formatXML, fs, handleError, md5base64, mkdtemp, parseJSON, resolveRelativePath } from "../util";
import { JcrContentLanguageProvider, OsgiConfigLanguageProvider } from "../providers/intellisense";

const jcrContentFilePatterns: GlobPattern[] = [
    '**/jcr_root/**/.content.xml',
    new RelativePattern(mkdtemp(), '**/*~{content.xml,property.json}'),
];
const osgiConfigFilePatterns: GlobPattern[] = [
    '**/jcr_root/**/*.{cfg.json,config}',
    new RelativePattern(mkdtemp(), '**/*.{cfg.json,config}'),
    new RelativePattern(mkdtemp(), '**/*~property.json')
];

const mappedPaths: Record<string, Uri> = {};
const closedFiles: Record<string, any> = {};
let memento: Memento;

interface FileOpenHandler {
    provideContent(jcrPath: Uri): Promise<string | Buffer>;
    onDidSave(jcrPath: Uri, doc: TextDocument, mimeType: string): Promise<any>;
}

interface FileOpenHandlerState {
    context: keyof typeof handlers;
    jcrPath: string;
    mimeType: string;
}

const handlers = {
    'binary': <FileOpenHandler>{
        provideContent(jcrPath) {
            return client.fetch(jcrPath);
        },
        onDidSave(jcrPath, doc, mimeType) {
            return saveJcrFile(jcrPath, doc.getText(), mimeType);
        }
    },
    'property.json': <FileOpenHandler>{
        async provideContent(jcrPath) {
            const props = await fetchJcrProperties(jcrPath);
            const sorted: Record<string, any> = {};
            for (let i of Object.keys(props).sort()) {
                if (i[0] !== ':') {
                    sorted[i] = props[i];
                }
            }
            return JSON.stringify(sorted, null, config.tabSize);
        },
        async onDidSave(jcrPath, doc) {
            let properties = parseJSON(doc.getText());
            if (properties) {
                await saveJcrProperties(jcrPath, properties, { deleteProps: true });
            }
        }
    },
    'content.xml': <FileOpenHandler>{
        async provideContent(jcrPath) {
            let json = await fetchJcrNode(jcrPath, FetchMode.Recursive);
            let data = convertToJcrContentXML({ [basename(jcrPath.path)]: json });
            return formatXML(data, config.tabSize, true);
        },
        async onDidSave(jcrPath, doc) {
            let node = await canFail(async () => parseJcrContentXML(doc.getText()));
            if (node && node[PROP.jcrContent]) {
                await saveJcrProperties(jcrPath, node[PROP.jcrContent], {
                    ignoreProps: [PROP.jcrMixinTypes, PROP.jcrPredecessors],
                    deleteProps: true,
                    deleteChildren: true
                });
            }
        }
    }
};

function onDidOpenTextDocument(doc: TextDocument) {
    delete closedFiles[doc.uri.fsPath];
}

function onDidCloseTextDocument(doc: TextDocument) {
    if (resolveRelativePath(doc.uri, mkdtemp())) {
        // some operation will re-open the document and thus fire onDidCloseTextDocument event
        // wait some time to see if onDidOpenTextDocument event is fired for the same document before deleting
        closedFiles[doc.uri.fsPath] = true;
        setTimeout(() => {
            if (closedFiles[doc.uri.fsPath]) {
                canFail(fs.delete(doc.uri));
            }
        }, 1000);
    }
}

async function onDidSaveTextDocument(doc: TextDocument) {
    const state = memento.get<FileOpenHandlerState>(`tmpPath.${doc.uri.fsPath}`);
    if (state && handlers[state.context]) {
        const uri = Uri.parse(state.jcrPath);
        if (await existJcrNode(uri)) {
            handleError(handlers[state.context].onDidSave(uri, doc, state.mimeType));
        } else if (await vscode.window.showErrorMessage(`${basename(doc.uri.path)} was deleted on server. Close and discard document?`, 'Yes', 'No') === 'Yes') {
            canFail(fs.delete(doc.uri));
        }
    }
}

function setTextDocumentLanguageForOsgiConfig(doc: TextDocument) {
    if (osgiConfigFilePatterns.some(pattern => vscode.languages.match({ pattern }, doc))) {
        if (extname(doc.uri.path) === '.config' && doc.languageId !== 'ini') {
            vscode.languages.setTextDocumentLanguage(doc, 'ini');
        }
    }
}

export function getRemoteUri(doc: TextDocument) {
    let state = memento.get<FileOpenHandlerState>(`tmpPath.${doc.uri.fsPath}`);
    return state && Uri.parse(state.jcrPath);
}

export async function getEditableUri(mode: keyof typeof handlers, jcrPath: Uri) {
    let filename = jcrToFileSystem(basename(jcrPath.path));
    let mimeType = '';
    if (mode !== 'binary') {
        filename += '~' + mode;
    } else if (!extname(filename)) {
        let node = await fetchJcrNode(jcrPath, FetchMode.Recursive, 1);
        mimeType = node[PROP.jcrContent][PROP.jcrMimeType] || '';
        filename += (mimetypes.extension(mimeType) || '').replace(/^(.)/, '.$1');
    }

    let key = dirname(jcrPath.path);
    let tmpdir = mappedPaths[key] || (mappedPaths[key] = mkdtemp(jcrPath.authority.replace(/\W/g, ''), md5base64(key).replace('/', '-').slice(0, 8)));
    let filePath = Uri.joinPath(tmpdir, filename);
    let state: FileOpenHandlerState = {
        context: mode,
        jcrPath: jcrPath.toString(true),
        mimeType: mimeType || mimetypes.contentType(filename) || ''
    };
    memento?.update(`tmpPath.${filePath.fsPath}`, state);

    await fs.createDirectory(tmpdir);
    await fs.writeFile(filePath, Buffer.from(await handlers[mode].provideContent(jcrPath)));
    return filePath;
}

export async function openFileInWorkspace(mode: keyof typeof handlers, jcrPath: Uri) {
    let uri = await getEditableUri(mode, jcrPath);
    await executeCommand('vscode.open', uri);
}

onExtensionActivated.then(context => {
    memento = context.workspaceState;
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(setTextDocumentLanguageForOsgiConfig),
        vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument),
        vscode.workspace.onDidSaveTextDocument(onDidSaveTextDocument),
        vscode.workspace.onDidCloseTextDocument(onDidCloseTextDocument),
        new JcrContentLanguageProvider(jcrContentFilePatterns),
        new OsgiConfigLanguageProvider(osgiConfigFilePatterns)
    );
    vscode.workspace.textDocuments.forEach(setTextDocumentLanguageForOsgiConfig);
});
