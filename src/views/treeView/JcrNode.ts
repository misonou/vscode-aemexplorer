import { ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri } from "vscode";
import { NODE_TYPE, PATH, PROP } from "../../core/constants";
import { basename, getHostFromUrl, matchString, resolveRelativePath } from "../../util";
import { ContextualNodeType } from "./contextualView";
import JcrTreeDataProvider from "./JcrTreeDataProvider";

type JcrNodeType = 'generic' | 'contextual' | 'root' | 'site' | 'page' | 'component' | 'dialog' | 'xf' | 'tag' | 'file' | 'folder' | 'osgiconfig' | 'package' | 'contentRoot' | 'content' | 'user' | 'group' | 'acl' | 'ace';

interface JcrNodeContext extends Record<string | symbol, any> {
    showHiddenNodes: boolean;
    hasJcrContent?: boolean;
    contextualType?: ContextualNodeType;
    contextualValue?: string;
    serverStatus?: 'online' | 'offline' | 'authenticationFailed' | 'unknown';
}

const nodeIcons: Record<JcrNodeType, ThemeIcon> = {
    generic: ThemeIcon.Folder,
    contextual: ThemeIcon.Folder,
    root: new ThemeIcon('remote-explorer'),
    site: new ThemeIcon('globe'),
    page: new ThemeIcon('file-code'),
    component: new ThemeIcon('extensions'),
    xf: new ThemeIcon('extensions'),
    tag: new ThemeIcon('tag'),
    dialog: new ThemeIcon('window'),
    file: ThemeIcon.File,
    folder: ThemeIcon.Folder,
    osgiconfig: new ThemeIcon('wrench'),
    package: new ThemeIcon('package'),
    contentRoot: new ThemeIcon('code'),
    content: new ThemeIcon('symbol-object'),
    user: new ThemeIcon('person'),
    group: new ThemeIcon('organization'),
    acl: new ThemeIcon('lock'),
    ace: new ThemeIcon('symbol-object'),
};

export default class JcrNode extends TreeItem {
    readonly nodeType: JcrNodeType = 'generic';
    readonly context: JcrNodeContext;
    readonly host: string;
    readonly hostUri: Uri;
    readonly resourceUri: Uri;
    sortChildren: boolean = true;

    constructor(
        public readonly provider: JcrTreeDataProvider,
        public readonly parent: JcrNode | null,
        public readonly id: string,
        label: string,
        public readonly jcrPath: Uri,
        public readonly properties: Record<string, any> = {},
        collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.Collapsed
    ) {
        super(label, collapsibleState);
        if (parent && parent.provider !== provider) {
            throw new Error('Child node must have the same provider as parent node');
        }
        this.nodeType = JcrNode.getNodeType(parent, jcrPath, properties);
        this.tooltip = jcrPath.toString(true);
        this.iconPath = nodeIcons[this.nodeType];
        this.sortChildren = !matchString<JcrNodeType>(this.nodeType, 'contentRoot', 'content', 'dialog');
        this.resourceUri = jcrPath;
        this.host = parent?.host || getHostFromUrl(jcrPath);
        this.hostUri = parent?.hostUri || Uri.parse(this.host);
        this.context = new Proxy<JcrNodeContext>({ showHiddenNodes: provider.showHiddenNodes }, {
            set: (t, p, v) => {
                if (t[p] !== v) {
                    t[p] = v;
                    this.setContextValue();
                }
                return true;
            }
        });
        this.setContextValue();
    }

    get isRoot(): boolean {
        return !this.parent;
    }

    get jcrPrimaryType(): string | undefined {
        return this.properties[PROP.jcrPrimaryType];
    }

    refresh() {
        this.provider.refresh(this);
    }

    static getNodeType(parent: JcrNode | null, jcrPath: Uri, properties: Record<string, any>): JcrNodeType {
        if (!parent) {
            return 'root';
        }
        if (!properties[PROP.jcrPrimaryType]) {
            return 'contextual';
        }
        switch (properties[PROP.jcrPrimaryType]) {
            case NODE_TYPE.repGroup:
                return 'group';
            case NODE_TYPE.repUser:
            case NODE_TYPE.repSystemUser:
                return 'user';
            case NODE_TYPE.repACL:
            case NODE_TYPE.repCugPolicy:
                return 'acl';
            case NODE_TYPE.repGrantACE:
            case NODE_TYPE.repDenyACE:
                return 'ace';
            case NODE_TYPE.vltPackageDefinition:
                return 'package';
            case NODE_TYPE.slingFolder:
            case NODE_TYPE.slingOrderedFolder:
            case NODE_TYPE.ntFolder:
                return 'folder';
            case NODE_TYPE.cqComponent:
            case NODE_TYPE.cqTemplate:
                return 'component';
            case NODE_TYPE.cqTag:
                return 'tag';
            case NODE_TYPE.cqPage:
                if (parent.nodeType === 'folder') {
                    return resolveRelativePath(jcrPath.path, PATH.experienceFragments) ? 'xf' : 'site';
                }
                return 'page';
            case NODE_TYPE.slingOsgiConfig:
                return 'osgiconfig';
            case NODE_TYPE.ntFile:
                if (resolveRelativePath(jcrPath.path, PATH.apps) && /\.(config|cfg|cfg\.json)$/.test(jcrPath.path)) {
                    return 'osgiconfig';
                }
                return 'file';
            case NODE_TYPE.damAsset:
                return 'file';
        }
        switch (basename(jcrPath.path)) {
            case 'jcr:content':
                return 'contentRoot';
            case 'cq:dialog':
            case 'cq:design_dialog':
                return 'dialog';
        }
        if (parent.nodeType === 'contentRoot' || parent.nodeType === 'content' || parent.nodeType === 'dialog') {
            return 'content';
        }
        return 'generic';
    }

    private setContextValue() {
        this.contextValue = this.nodeType + ' path:' + this.jcrPath.path;
        for (let i in this.context) {
            this.contextValue += ` ${i}:${this.context[i]}`;
        }
    }
}
