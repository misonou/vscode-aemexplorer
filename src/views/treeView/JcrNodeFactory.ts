import { Uri } from "vscode";
import QueryBuilder from "aem-querybuilder";
import { makeArray, makeUri, matchString, resolveRelativePath } from "../../util";
import { NODE_TYPE, PROP } from "../../core/constants";
import { executeQuery, fetchJcrChildNodes } from "../../core/repo";
import JcrNode from "./JcrNode";
import { getContextualLabel, getContextualNodes } from "./contextualView";

// hidden child nodes that will be shown in *reversed* order when showHiddenNodes context flags is true
const hiddenNodes = [
    PROP.repRepoPolicy,
    PROP.repCugPolicy,
    PROP.repPolicy,
    PROP.jcrContent,
];

// specifies primary types that are considered a file which will be collectively sorted after folder nodes
const fileTypeNodes = [
    NODE_TYPE.ntFile,
    NODE_TYPE.damAsset,
    NODE_TYPE.slingOsgiConfig
];

function createReducer(...props: string[]) {
    let arr = props.map(a => {
        let b = a.split('/');
        return (obj: any) => b.reduce((v, a) => v?.[a], obj);
    });
    return (obj: any) => arr.reduce((v, fn) => v || fn(obj), '');
}

function isFile(props: Record<string, any>) {
    return !!matchString(props[PROP.jcrPrimaryType], ...fileTypeNodes);
}

export default class JcrNodeFactory {
    constructor(
        private readonly getChildren: (node: JcrNode) => readonly JcrNode[]
    ) { }

    createNode(parent: JcrNode, label: string, jcrPath: Uri, properties: Record<string, any> = {}) {
        let id = jcrPath.toString(true);
        let cur = this.getChildren(parent).find(v => v.id === id);
        if (cur && cur.nodeType === JcrNode.getNodeType(parent, jcrPath, properties)) {
            return Object.assign(cur, { properties });
        }
        return new JcrNode(parent.provider, parent, id, label, jcrPath.with({ fragment: '' }), properties);
    }

    async getContextualChildNodes(parent: JcrNode) {
        return getContextualNodes(this, parent);
    }

    async getChildNodes(parent: JcrNode, filter?: (node: Record<string, any>, name: string) => boolean) {
        return this.getChildNodesByPath(parent, parent.jcrPath.path, filter);
    }

    async getChildNodesByPath(parent: JcrNode, path: string, filter: (node: Record<string, any>, name: string) => boolean = () => true) {
        let uri = makeUri(parent.hostUri, path);
        let data = await fetchJcrChildNodes(uri);
        let keys = Object.keys(data).filter(v => filter(data[v], v));
        let labels: Record<string, [string, string]> = {};

        if (parent.sortChildren) {
            for (let i of keys) {
                let label = (parent.provider.enableContextualView && getContextualLabel(data[i], parent)) || i;
                labels[i] = [label, label.toLowerCase()];
            }
            keys.sort((a, b) => {
                return (+isFile(data[a]) - +isFile(data[b])) || labels[a][1].localeCompare(labels[b][1]);
            });
        }
        for (let prop of hiddenNodes) {
            if (data[prop]) {
                keys.splice(keys.indexOf(prop), 1);
                if (parent.provider.showHiddenNodes || parent.context.showHiddenNodes) {
                    keys.unshift(prop);
                }
            }
        }
        return keys.map(name => {
            let child = this.createNode(parent, labels[name]?.[0] || name, Uri.joinPath(uri, name), data[name]);
            if (child.label !== name) {
                child.description = name;
            }
            return child;
        });
    }

    async getChildNodesByQuery(parent: JcrNode, query: QueryBuilder.QueryProps, labelProp: string | string[], descProp?: string | string[]) {
        if (!query.select || query.select !== '*') {
            query = { ...query };
            query.select = [...makeArray(query.select)];
            if (!query.select.includes(PROP.jcrPrimaryType)) {
                query.select.push(PROP.jcrPrimaryType);
            }
            if (!query.select.includes(PROP.jcrPath)) {
                query.select.push(PROP.jcrPath);
            }
        }
        const items = await executeQuery(parent.hostUri, query);
        const getLabel = createReducer(...makeArray(labelProp));
        const getDescription = createReducer(...makeArray(descProp));
        return items.map(v => {
            let jcrPath = makeUri(parent.hostUri, v[PROP.jcrPath]);
            let child = this.createNode(parent, getLabel(v), jcrPath, v);
            child.description = getDescription(v) || resolveRelativePath(jcrPath.path, parent.jcrPath.path) || '';
            if (child.description === child.label) {
                child.description = '';
            }
            return child;
        });
    }
}
