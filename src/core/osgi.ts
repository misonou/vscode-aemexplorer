import { Uri } from "vscode";
import assert from "assert";
import { onExtensionActivated } from "../extension";
import { basename, deepFreeze, fs, makeUri, parseJSON } from "../util";
import client from "./client";

const typePrefix: Record<OsgiConfigValueType, string> = {
    String: 'T',
    Integer: 'I',
    Long: 'L',
    Float: 'F',
    Double: 'D',
    Byte: 'X',
    Short: 'S',
    Character: 'C',
    Boolean: 'B',
};

const schemas: Record<string, OsgiConfigSchema> = {};

export type OsgiConfigValueType = 'String' | 'Boolean' | 'Integer' | 'Short' | 'Long' | 'Double' | 'Float' | 'Byte' | 'Character';

export interface OsgiConfigSchema {
    id: string;
    name: string;
    description: string;
    bundleName: string;
    attributes: Record<string, OsgiConfigAttribute>;
}

export interface OsgiConfigAttribute {
    schema: OsgiConfigSchema;
    id: string;
    name: string;
    description: string;
    type: OsgiConfigValueType;
    cardinality: 'required' | 'unlimited' | number;
    default?: string | number | boolean | string[];
    options?: { label: string; value: string; }[];
    hint?: 'path' | 'url' | 'resourceType' | 'nodeType';
}

export function parseOsgiConfigValue(value: string, matches?: RegExpMatchArray[]) {
    if (value[0] === '[') {
        matches = matches || [];
        assert(matches.length === 0, 'Matches array must be initially empty');
        matches.push(...value.matchAll(/"((?:[^"]|\\")*)"/g));
        return matches.map(v => v[1].replace(/\\"/g, '"'));
    }
    if (/^([A-Z]?)"((?:[^"]|\\")*)"$/.test(value)) {
        switch (RegExp.$1) {
            case typePrefix.Integer:
            case typePrefix.Long:
            case typePrefix.Float:
            case typePrefix.Double:
            case typePrefix.Byte:
            case typePrefix.Short:
                return +RegExp.$2;
            case typePrefix.Boolean:
                return RegExp.$2 === 'true';
            default:
                return RegExp.$2.replace(/\\"/g, '"');
        }
    }
}

export function formatOsgiConfigValue(value: string | number | boolean | readonly string[], valueType: OsgiConfigValueType): string {
    if (Array.isArray(value)) {
        return '[' + value.map(v => formatOsgiConfigValue(v, 'String')) + ']';
    }
    if (valueType === 'String') {
        return `"${String(value).replace(/"/g, '\\"')}"`;
    }
    return `${typePrefix[valueType]}"${value}"`;
}

export function getOsgiConfigSchemas() {
    return Object.values(schemas);
}

export function resolveOsgiConfigSchema(uri: Uri) {
    let pid = basename(uri.path).replace(/[~-].+/, '');
    while (!schemas[pid]) {
        let index = pid.lastIndexOf('.');
        if (index < 0) {
            return;
        }
        pid = pid.slice(0, index);
    }
    return schemas[pid];
}

export async function loadOsgiConfigSchemas(host: string | Uri): Promise<OsgiConfigSchema[]> {
    let { bundles } = await client.fetchJSON(makeUri(host, '/system/console/status-metatype.json'));
    let schemas: OsgiConfigSchema[] = bundles.flatMap((v: any) => {
        return v.configs.map(({ attributes, ...props }: Omit<OsgiConfigSchema, 'attributes'> & { attributes: OsgiConfigAttribute[] }) => {
            let schema: OsgiConfigSchema = {
                ...props,
                bundleName: v.bundleName,
                attributes: {}
            };
            if (schema.name === `${schema.id}.name`) {
                schema.name = schema.id;
            }
            if (schema.description === `${schema.id}.description`) {
                schema.description = '';
            }
            for (let v of attributes) {
                schema.attributes[v.id] = v;
                v.schema = schema;
                if (v.name === `${schema.id}.${v.id}.name`) {
                    v.name = v.id;
                }
                if (v.description === `${schema.id}.${v.id}.description`) {
                    v.description = '';
                }
                if (!isNaN(+v.cardinality)) {
                    v.cardinality = +v.cardinality;
                }
                if (Array.isArray(v.default) && v.default.length === 1 && v.cardinality === 'required') {
                    v.default = v.type === 'String' ? v.default[0] : v.type === 'Boolean' ? v.default[0] === 'true' : +v.default[0];
                }
            }
            return schema;
        });
    });
    schemas.sort((a, b) => a.id.localeCompare(b.id));
    return schemas;
}

onExtensionActivated.then(async (context) => {
    let metatypes = parseJSON(await fs.readFile(Uri.joinPath(context.extensionUri, 'assets/data/metatypes.json')));
    for (let type of metatypes) {
        for (let prop in type.attributes) {
            type.attributes[prop].id = prop;
            type.attributes[prop].schema = type;
        }
        schemas[type.id] = deepFreeze(type);
    }
});
