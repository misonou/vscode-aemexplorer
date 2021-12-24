import { CompletionItemKind, RelativePattern, Uri, workspace } from "vscode";
import { fs, getHostFromUrl, makeUri, matchString, resolveRelativePath, unique } from "../../util";
import { PATH, NODE_TYPE, PROP } from "../../core/constants";
import { executeQuery, fetchJcrChildNodes, fetchJcrNode, FetchMode, parseJcrContentXML } from "../../core/repo";
import { getRemoteUri } from "../../workspace/document";
import { getLocalProjects, onLocalProjectLoaded } from "../../workspace/project";
import { CompletionState, ValueCompletionItemProps } from "./CompletionHandler";

const resourceTypeCache: Record<string, string[]> = {};
const defaultUri = Uri.parse('http://localhost:4502');

// specifies primary types that are considered a file
const fileTypeNodes = [
    NODE_TYPE.ntFile,
    NODE_TYPE.damAsset,
    NODE_TYPE.slingOsgiConfig
];

function getDefaultCompletionItemKind(data: Record<string, any>) {
    return matchString(data[PROP.jcrPrimaryType], ...fileTypeNodes) ? CompletionItemKind.File : CompletionItemKind.Folder;
}

function extractPathInfo(state: CompletionState) {
    let path = state.currentValueLeftText!.replace(/\/[^\/]*$/, '');
    return {
        host: getHostFromUrl(getRemoteUri(state.document) || defaultUri),
        path: path,
        next: /\/([^\/]+)/.test((state.currentValue as string).slice(path.length)) ? RegExp.$1 : ''
    };
}

export async function suggestResourceTypes(state: CompletionState) {
    let { host } = extractPathInfo(state);
    let key = host.toString();
    if (!resourceTypeCache[key]) {
        let items = await executeQuery(host, {
            path: [PATH.apps, PATH.libs],
            type: NODE_TYPE.cqComponent
        });
        resourceTypeCache[key] = unique([
            ...items.map(v => v.path.replace(/^\/[^\/]+\//, '')),
            ...resourceTypeCache.local,
        ]);
    }
    return resourceTypeCache[key];
}

export async function suggestPaths(state: CompletionState) {
    let { host, path, next } = extractPathInfo(state);
    let children = await fetchJcrChildNodes(makeUri(host, path));
    return Object.keys(children).map(v => {
        return <ValueCompletionItemProps>{
            value: `${path}/${v}`,
            kind: getDefaultCompletionItemKind(children[v]),
            preselect: v === next
        };
    });
}

export async function suggestTags(state: CompletionState) {
    let { host, path, next } = extractPathInfo(state);
    if (!path) {
        let children = await fetchJcrNode(makeUri(host, PATH.tags), FetchMode.Recursive, 2);
        return Object.entries(children).flatMap(([i, v]) => {
            return Object.keys(v).filter(w => v[w][PROP.jcrPrimaryType] === NODE_TYPE.cqTag).map(w => {
                return <ValueCompletionItemProps>{
                    value: `${i}:${w}`,
                    kind: CompletionItemKind.EnumMember
                };
            });
        });
    } else {
        let children = await fetchJcrChildNodes(makeUri(host, `${PATH.tags}/${path.replace(':', '/')}`));
        return Object.keys(children).map(v => {
            return <ValueCompletionItemProps>{
                value: `${path}/${v}`,
                kind: CompletionItemKind.EnumMember,
                preselect: v === next
            };
        });
    }
}

onLocalProjectLoaded.then(async () => {
    resourceTypeCache.local = [];
    for (let project of getLocalProjects()) {
        if (project.jcrRootPath) {
            let files = await workspace.findFiles(new RelativePattern(project.jcrRootPath, '**/.content.xml'));
            files.forEach(async (v) => {
                let data = parseJcrContentXML((await fs.readFile(v)).toString());
                let path = resolveRelativePath(v, project.jcrRootPath!);
                let resourceType = path && path.substring(path.indexOf('/') + 1, path.lastIndexOf('/'));
                if (resourceType && data[PROP.slingResourceSuperType]) {
                    resourceTypeCache.local.push(resourceType);
                }
            });
        }
    }
});
