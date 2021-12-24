import { Uri } from "vscode";
import { onExtensionActivated } from "../../extension";
import { canFail, deepFreeze, fs, makeUri, parseJSON } from "../../util";
import { NODE_TYPE, PATH, PROP } from "../../core/constants";
import config from "../../config";
import { fetchJcrProperties, parseJcrContentXML } from "../../core/repo";
import { getLocalProjects } from "../../workspace/project";

const resourceBasePath = [
    PATH.apps,
    PATH.libs
];

const nodeTypes: Record<string, NodeType> = {};
const resourceTypes: Record<string, ResourceType> = {};

export interface NodeType {
    readonly nodeTypeName: string;
    readonly description?: string;
    readonly supertypes: readonly string[];
    readonly isAbstract: boolean;
    readonly isMixin: boolean;
    readonly isQueryable: boolean;
    readonly hasOrderableChildNodes: boolean;
    readonly hasProtectedResidualChildNodes: boolean;
    readonly hasProtectedResidualProperties: boolean;
    readonly namedChildNodeDefinitions?: Readonly<Record<string, NamedChildNodeDefinition>>;
    readonly namedPropertyDefinitions?: Readonly<Record<string, NamedPropertyDefinition>>;
    readonly residualChildNodeDefinitions?: Readonly<Record<string, ResidualChildNodeDefinition>>;
    readonly residualPropertyDefinitions?: Readonly<Record<string, ResidualPropertyDefinition>>;
}

export interface ResourceType {
    readonly resourceType: string;
    readonly resourceSuperType?: string;
    readonly properties: Readonly<Record<string, NamedPropertyDefinition>>;
}

export interface NamedChildNodeDefinition {
    readonly name: string;
    readonly description?: string;
    readonly declaringNodeType: string;
    readonly requiredPrimaryTypes: readonly string[];
    readonly autoCreated?: boolean;
    readonly mandatory?: boolean;
    readonly protected?: boolean;
    readonly sameNameSiblings?: boolean;
}

export interface ResidualChildNodeDefinition {
    readonly description?: string;
    readonly declaringNodeType: string;
    readonly defaultPrimaryType: string;
    readonly requiredPrimaryTypes: readonly string[];
    readonly protected?: boolean;
    readonly sameNameSiblings?: boolean;
}

export interface NamedPropertyDefinition {
    readonly name: string;
    readonly description?: string;
    readonly declaringNodeType?: string;
    readonly requiredType: string;
    readonly defaultValues?: boolean | number | readonly string[];
    readonly valueConstraints?: readonly string[];
    readonly autoCreated?: boolean;
    readonly isFullTextSearchable?: boolean;
    readonly isQueryOrderable?: boolean;
    readonly mandatory?: boolean;
    readonly multiple?: boolean;
    readonly protected?: boolean;
}

export interface ResidualPropertyDefinition {
    readonly description?: string;
    readonly declaringNodeType: string;
    readonly requiredType: string;
    readonly isFullTextSearchable?: boolean;
    readonly isQueryOrderable?: boolean;
    readonly multiple?: boolean;
    readonly protected?: boolean;
}

export function getNodeTypes() {
    return Object.values(nodeTypes);
}

export function getNodeTypeNames(filter?: (v: NodeType) => boolean) {
    let names = Object.keys(nodeTypes);
    if (filter) {
        return names.filter(v => filter(nodeTypes[v]));
    }
    return names;
}

export function getNodeProperties(type: string): Record<string, NamedPropertyDefinition> {
    return nodeTypes[type]?.namedPropertyDefinitions || nodeTypes[NODE_TYPE.ntBase].namedPropertyDefinitions || {};
}

export async function getSlingResourceProperties(type: string): Promise<Record<string, NamedPropertyDefinition>> {
    if (!resourceTypes[type]) {
        await fetchSlingResourceInfo(type);
    }
    if (resourceTypes[type]) {
        let { properties, resourceSuperType } = resourceTypes[type];
        if (resourceSuperType) {
            let baseProps = await getSlingResourceProperties(resourceSuperType);
            return { ...baseProps, ...properties };
        }
        return properties;
    }
    return {};
}

async function fetchSlingResourceInfo(resourceType: string) {
    let data = await canFail(Promise.any(getLocalProjects().filter(v => v.jcrRootPath).flatMap(v => {
        return resourceBasePath.map(async (w) => {
            let buffer = await fs.readFile(Uri.joinPath(v.jcrRootPath!, `${w}/${resourceType}/.content.xml`));
            return parseJcrContentXML(buffer.toString());
        });
    })));
    if (!data) {
        data = await canFail(Promise.any(config.hosts.flatMap(v => {
            return resourceBasePath.map(w => fetchJcrProperties(makeUri(v, `${w}/${resourceType}`)));
        })));
    }
    resourceTypes[resourceType] = {
        resourceType,
        resourceSuperType: data?.[PROP.slingResourceSuperType],
        properties: {}
    };
}

async function populateData<T>(dict: Record<string, T>, key: string, filePath: Uri) {
    for (let v of parseJSON(await fs.readFile(filePath))) {
        dict[v[key]] = deepFreeze(v);
    }
}

onExtensionActivated.then(context => {
    populateData(nodeTypes, 'nodeTypeName', Uri.joinPath(context.extensionUri, 'assets/data/nodetypes.json'));
    populateData(resourceTypes, 'resourceType', Uri.joinPath(context.extensionUri, 'assets/data/resourceTypes.json'));
});
