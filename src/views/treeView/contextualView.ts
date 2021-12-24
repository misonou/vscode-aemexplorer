import { ThemeIcon, TreeItemCollapsibleState, Uri } from "vscode";
import QueryBuilder from "aem-querybuilder";
import { basename, makeUri, resolveRelativePath } from "../../util";
import { NODE_TYPE, PATH, PROP, PROP2, RESOURCE_TYPE } from "../../core/constants";
import { executeQuery, fetchJcrChildNodes, fetchJcrNode, FetchMode } from "../../core/repo";
import { listLogFiles } from "../../core/system";
import JcrNode from "./JcrNode";
import JcrNodeFactory from "./JcrNodeFactory";

export type ContextualNodeType = 'sites' | 'site' | 'xf' | 'pages' | 'assets' | 'components' | 'componentGroup' | 'templates' | 'templateGroup' | 'models' | 'modelGroup' | 'model' | 'modelField' | 'tags' | 'packages' | 'packageGroup' | 'security' | 'users' | 'groups' | 'config' | 'configGroup' | 'logs' | 'logStream';

type ParentNodeType = ContextualNodeType | `node:${JcrNode['nodeType']}`;

const definitions: Record<string, Definition> = {};

const modelFieldIcons: Record<string, ThemeIcon> = {
    'text-single': new ThemeIcon('symbol-string'),
    'text-multi': new ThemeIcon('symbol-string'),
    'date': new ThemeIcon('calendar'),
    'tags': new ThemeIcon('tag'),
    'boolean': new ThemeIcon('symbol-boolean'),
    'number': new ThemeIcon('symbol-numeric'),
    'reference': new ThemeIcon('symbol-reference'),
};

interface ContextualNodeOptions {
    jcrPath?: Uri;
    label?: string;
    icon?: ThemeIcon;
    description?: string;
    contextualValue?: string;
}

interface Definition {
    readonly key: string;
    readonly children: ContextualNodeType[];
    label: string
    icon: ThemeIcon;
    onWillCreate(options: ContextualNodeOptions, parent: JcrNode): ContextualNodeOptions;
    onWillGetChildren?: (node: JcrNode) => Promise<any>;
    onDidCreate(node: JcrNode): void;
    getChildren(node: JcrNode, factory: JcrNodeFactory): Promise<JcrNode[]>;
}

class DefinitionImpl implements Definition {
    children: ContextualNodeType[] = [];
    label = '';
    icon = ThemeIcon.File;
    onWillCreate = (o: ContextualNodeOptions) => o;
    onDidCreate = () => { };
    getChildren = () => Promise.resolve([]);

    constructor(public readonly key: string) { }
}

function registerContextualNode(key: ContextualNodeType, props: Partial<Definition & { childOf: ParentNodeType[] }>) {
    let self = definitions[key] || (definitions[key] = new DefinitionImpl(key));
    Object.assign(self, props);
    props.childOf?.forEach(v => {
        let other = definitions[v] || (definitions[v] = new DefinitionImpl(v));
        other.children.push(key);
    });
}

function createContextualNode(factory: JcrNodeFactory, parent: JcrNode, type: ContextualNodeType, options?: ContextualNodeOptions) {
    let def = definitions[type];
    options = def.onWillCreate(options || {}, parent);

    let jcrPath = (options.jcrPath || parent.jcrPath).with({ fragment: (/#(.+)/.test(parent.id) ? RegExp.$1 + '&' : '') + type + (options.contextualValue ? '=' + options.contextualValue : '') });
    let child = factory.createNode(parent, options.label || def.label, jcrPath);
    child.tooltip = options.label || def.label;
    child.iconPath = options.icon || def.icon;
    if (child.label !== options.description) {
        child.description = options.description;
    }
    child.context.contextualType = type;
    child.context.contextualValue = options.contextualValue;
    def.onDidCreate(child);
    return child;
}

export async function getContextualNodes(factory: JcrNodeFactory, parent: JcrNode) {
    let props = definitions[parent.nodeType === 'contextual' ? parent.context.contextualType! : `node:${parent.nodeType}`];
    if (props) {
        if (props.onWillGetChildren) {
            await props.onWillGetChildren(parent);
        }
        return [
            ...props.children.map(v => createContextualNode(factory, parent, v)),
            ...await props.getChildren(parent, factory)
        ];
    }
    return [];
}

export function getContextualLabel(properties: Record<string, any>, parent: JcrNode): string | null {
    switch (properties[PROP.jcrPrimaryType]) {
        case NODE_TYPE.cqTag:
            return properties[PROP.jcrTitle];
    }
    return null;
}

registerContextualNode('sites', {
    label: 'Sites',
    icon: new ThemeIcon('globe'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        let exclude = [
            'campaigns',
            'catalogs',
            'communities',
            'community',
            'community-components',
            'cq:graphql',
            'cq:tags',
            'dam',
            'experience-fragments',
            'forms',
            'launches',
            'oak:index',
            'projects',
            'screens',
            'sites',
            'usergenerated'
        ];
        let children = await fetchJcrChildNodes(makeUri(node.hostUri, PATH.content));
        let searchPaths: string[] = [];
        for (let i in children) {
            if (!exclude.includes(i) && children[i][PROP.jcrPrimaryType] !== NODE_TYPE.cqPage) {
                searchPaths.push(`${PATH.content}/${i}`);
            }
        }
        let items = await executeQuery(node.hostUri, {
            path: [QueryBuilder.scope.children(PATH.content), ...searchPaths],
            type: NODE_TYPE.cqPage,
            where: {
                [PROP2.parent.jcrPrimaryType]: { ne: NODE_TYPE.cqPage }
            },
            select: [PROP.jcrPath, PROP2.jcrContent.jcrTitle]
        });
        let nodes = items.map(v => {
            let sitePath = resolveRelativePath(v[PROP.jcrPath], PATH.content) || '';
            return createContextualNode(factory, node, 'site', {
                label: v[PROP.jcrContent]?.[PROP.jcrTitle] || basename(v[PROP.jcrPath]),
                description: sitePath,
                contextualValue: sitePath
            });
        });
        return nodes.sort((a, b) => {
            return a.label!.toString().toLowerCase().localeCompare(b.label!.toString().toLowerCase());
        });
    }
});

registerContextualNode('site', {
    icon: new ThemeIcon('globe'),
    onWillCreate(options, parent) {
        return { jcrPath: makeUri(parent.hostUri, `${PATH.content}/${options.contextualValue}`), ...options };
    }
});

registerContextualNode('xf', {
    label: 'Experience Fragments',
    icon: new ThemeIcon('extensions'),
    childOf: ['site'],
    onWillCreate(options, parent) {
        let sitePath = parent.context.contextualValue;
        return { jcrPath: makeUri(parent.hostUri, `${PATH.experienceFragments}/${sitePath}`), ...options };
    },
    getChildren(node, factory) {
        let query = new QueryBuilder({
            path: node.jcrPath.path,
            type: NODE_TYPE.cqPage,
            where: { [PROP2.jcrContent.slingResourceType]: RESOURCE_TYPE.cqExperienceFragment },
            select: [PROP2.jcrContent.jcrTitle],
            orderBy: { property: PROP2.jcrContent.jcrTitle, ignoreCase: true }
        });
        return factory.getChildNodesByQuery(node, query, PROP2.jcrContent.jcrTitle);
    }
});

registerContextualNode('pages', {
    label: 'Pages',
    icon: new ThemeIcon('file-code'),
    childOf: ['site'],
    onWillCreate(options, parent) {
        let sitePath = parent.context.contextualValue;
        return { jcrPath: makeUri(parent.hostUri, `${PATH.content}/${sitePath}`), ...options };
    },
    async getChildren(node, factory) {
        let jcrPath = node.jcrPath;
        let data = await fetchJcrNode(jcrPath);
        return [factory.createNode(node, basename(jcrPath.path), jcrPath, data)];
    }
});

registerContextualNode('assets', {
    label: 'Assets',
    icon: new ThemeIcon('file-media'),
    childOf: ['site'],
    onWillCreate(options, parent) {
        let sitePath = parent.context.contextualValue;
        return { jcrPath: makeUri(parent.hostUri, `${PATH.dam}/${sitePath}`), ...options };
    },
    getChildren(node, factory) {
        return factory.getChildNodes(node);
    }
});

registerContextualNode('components', {
    label: 'Components',
    icon: new ThemeIcon('extensions'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        let items = await executeQuery(node.hostUri, {
            path: [PATH.apps, PATH.libs],
            type: NODE_TYPE.cqComponent
        });
        let key: Record<string, string> = {};
        for (let { path } of items) {
            if (/^\/(?:apps|libs)\/(.+)\/components/.test(path)) {
                key[RegExp.$1] = RegExp.lastMatch;
            }
        }
        return Object.keys(key).sort().map(v => {
            return createContextualNode(factory, node, 'componentGroup', { label: v, jcrPath: makeUri(node.hostUri, key[v]) });
        });
    }
});

registerContextualNode('componentGroup', {
    icon: new ThemeIcon('symbol-package'),
    getChildren(node, factory) {
        let query = new QueryBuilder({
            path: node.jcrPath.path,
            type: NODE_TYPE.cqComponent,
            select: '*',
            orderBy: { property: PROP.jcrTitle, ignoreCase: true }
        });
        return factory.getChildNodesByQuery(node, query, PROP.jcrTitle);
    }
});

registerContextualNode('templates', {
    label: 'Page Templates',
    icon: new ThemeIcon('extensions'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        let items = await executeQuery(node.hostUri, {
            path: PATH.conf,
            type: NODE_TYPE.cqPage,
            nodename: 'templates',
            orderBy: { property: 'path', ignoreCase: true }
        });
        return items.map(v => {
            return createContextualNode(factory, node, 'templateGroup', {
                label: v.path.replace(/^\/conf\/|\/settings\/wcm\/templates$/g, ''),
                jcrPath: makeUri(node.hostUri, v.path)
            });
        });
    }
});

registerContextualNode('templateGroup', {
    icon: new ThemeIcon('symbol-package'),
    getChildren(node, factory) {
        let query = new QueryBuilder({
            path: node.jcrPath.path,
            type: NODE_TYPE.cqTemplate,
            select: [PROP2.jcrContent.jcrTitle],
            orderBy: { property: PROP2.jcrContent.jcrTitle, ignoreCase: true }
        });
        return factory.getChildNodesByQuery(node, query, PROP2.jcrContent.jcrTitle);
    }
});

registerContextualNode('models', {
    label: 'Content Fragment Models',
    icon: new ThemeIcon('symbol-structure'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        let items = await executeQuery(node.hostUri, {
            path: PATH.conf,
            type: NODE_TYPE.cqPage,
            nodename: 'models',
            orderBy: { property: 'path', ignoreCase: true }
        });
        return items.map(v => {
            return createContextualNode(factory, node, 'modelGroup', {
                label: v.path.replace(/^\/conf\/|\/settings\/dam\/cfm\/models$/g, ''),
                jcrPath: makeUri(node.hostUri, v.path)
            });
        });
    }
});

registerContextualNode('modelGroup', {
    icon: new ThemeIcon('symbol-package'),
    async getChildren(node, factory) {
        let items = await executeQuery(node.hostUri, {
            path: node.jcrPath.path,
            type: NODE_TYPE.cqTemplate,
            select: [PROP2.jcrContent.jcrTitle, PROP.jcrPath],
            orderBy: { property: PROP2.jcrContent.jcrTitle, ignoreCase: true }
        });
        return items.map(v => {
            return createContextualNode(factory, node, 'model', {
                label: v[PROP.jcrContent][PROP.jcrTitle],
                description: basename(v[PROP.jcrPath]),
                jcrPath: makeUri(node.hostUri, v[PROP.jcrPath])
            });
        });
    }
});

registerContextualNode('model', {
    icon: new ThemeIcon('symbol-structure'),
    async getChildren(node, factory) {
        let itemsPath = Uri.joinPath(node.jcrPath, 'jcr:content/model/cq:dialog/content/items');
        let items = await fetchJcrChildNodes(itemsPath);
        for (let i in items) {
            items[i].path = Uri.joinPath(itemsPath, i);
        }
        return Object.values(items).sort((a, b) => +a.listOrder - +b.listOrder).map(v => {
            return createContextualNode(factory, node, 'modelField', {
                icon: modelFieldIcons[v.metaType],
                label: v.fieldLabel || v['cfm-element'] || v.name,
                description: v.name,
                jcrPath: v.path
            });
        });
    }
});

registerContextualNode('modelField', {
    icon: new ThemeIcon('symbol-property'),
    onDidCreate(node) {
        node.collapsibleState = TreeItemCollapsibleState.None;
    }
});

registerContextualNode('tags', {
    label: 'Tags',
    icon: new ThemeIcon('tag'),
    childOf: ['node:root'],
    onWillCreate(options, parent) {
        return { jcrPath: makeUri(parent.hostUri, PATH.tags), ...options };
    },
    getChildren(node, factory) {
        return factory.getChildNodes(node, v => v[PROP.jcrPrimaryType] === NODE_TYPE.cqTag);
    }
});

registerContextualNode('packages', {
    label: 'Packages',
    icon: new ThemeIcon('package'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        let items = await executeQuery(node.hostUri, {
            path: PATH.packages,
            nodename: 'vlt:definition',
            where: {
                group: { notLike: '%.snapshot' }
            },
            select: ['group']
        });
        let groups: Record<string, boolean> = {};
        for (let { group } of items) {
            groups[group.split('/')[0]] = true;
        }
        return Object.keys(groups).sort().map(v => {
            return createContextualNode(factory, node, 'packageGroup', { label: v, contextualValue: v });
        });
    }
});

registerContextualNode('packageGroup', {
    label: 'Package Group',
    icon: new ThemeIcon('symbol-package'),
    async getChildren(node, factory) {
        let packageGroup = node.context.contextualValue!;
        let query = new QueryBuilder({
            path: PATH.packages,
            nodename: 'vlt:definition',
            where: {
                group: {
                    like: [packageGroup, `${packageGroup}/%`],
                    notLike: '%.snapshot'
                }
            },
            select: '*',
            orderBy: ['name']
        });
        return factory.getChildNodesByQuery(node, query, 'name', 'version');
    }
});

registerContextualNode('security', {
    label: 'Security',
    icon: new ThemeIcon('lock'),
    childOf: ['node:root']
});

registerContextualNode('users', {
    label: 'Users',
    icon: new ThemeIcon('person'),
    childOf: ['security'],
    getChildren(node, factory) {
        let query = new QueryBuilder({
            type: NODE_TYPE.repUser,
            select: [PROP.repAuthorizableId, PROP.jcrUUID],
            orderBy: PROP.repAuthorizableId
        });
        return factory.getChildNodesByQuery(node, query, PROP.repAuthorizableId, PROP.repAuthorizableId);
    }
});

registerContextualNode('groups', {
    label: 'Groups',
    icon: new ThemeIcon('organization'),
    childOf: ['security'],
    getChildren(node, factory) {
        let query = new QueryBuilder({
            type: NODE_TYPE.repGroup,
            select: [PROP.repAuthorizableId, PROP.jcrUUID, 'profile/givenName'],
            orderBy: PROP.repAuthorizableId
        });
        return factory.getChildNodesByQuery(node, query, ['profile/givenName', PROP.repAuthorizableId], PROP.repAuthorizableId);
    }
});

registerContextualNode('config', {
    label: 'OSGi Config',
    icon: new ThemeIcon('settings'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        let exclude = [
            'clientlibs',
            'components',
            'i18n',
            'install'
        ];
        let folders = await fetchJcrNode(makeUri(node.hostUri, PATH.apps), FetchMode.RecursiveChildren, 1);
        let configPaths: string[] = [];
        let searchPaths: string[] = [];
        for (let i in folders) {
            if (!i.endsWith('-packages')) {
                if (folders[i].osgiconfig) {
                    configPaths.push(`${PATH.apps}/${i}/osgiconfig`);
                } else if (Object.keys(folders[i]).some(v => /^config(\..+)?$/.test(v))) {
                    configPaths.push(`${PATH.apps}/${i}`);
                } else if (Object.keys(folders[i]).some(v => !exclude.includes(v))) {
                    searchPaths.push(`${PATH.apps}/${i}`);
                }
            }
        }
        if (searchPaths.length) {
            let items = await executeQuery(node.hostUri, {
                path: searchPaths,
                type: NODE_TYPE.ntFolder,
                nodename: ['config', 'config..+'],
                excludePaths: ['.*/(clientlibs|components|i18n|install)/.*']
            });
            let match: Record<string, any> = {};
            for (let { path } of items) {
                match[path.replace(/\/config(\..+)?$/, '')] = true;
            }
            configPaths.push(...Object.keys(match));
        }
        return configPaths.sort((a, b) => a.localeCompare(b)).map(v => {
            return createContextualNode(factory, node, 'configGroup', {
                jcrPath: makeUri(node.hostUri, v),
                label: v.replace(/^\/apps\/|\/osgiconfig$/g, '')
            });
        });
    }
});

registerContextualNode('configGroup', {
    icon: new ThemeIcon('symbol-package'),
    getChildren(node, factory) {
        return factory.getChildNodes(node, (v, i) => i === 'config' || i.startsWith('config.'));
    }
});

registerContextualNode('logs', {
    label: 'Logs',
    icon: new ThemeIcon('console'),
    childOf: ['node:root'],
    async getChildren(node, factory) {
        const files = await listLogFiles(node.host);
        return files.sort().map(v => {
            return createContextualNode(factory, node, 'logStream', { label: basename(v), contextualValue: v });
        });
    }
});

registerContextualNode('logStream', {
    icon: new ThemeIcon('console'),
    onDidCreate(node) {
        node.collapsibleState = TreeItemCollapsibleState.None;
    }
});
