import { Uri } from "vscode";
import assert from "assert";
import QueryBuilder from "aem-querybuilder";
import FormData from "form-data";
import { decode as decodeXML } from "html-entities";
import * as xml from "fast-xml-parser";
import * as mimetypes from "mime-types";
import { basename, canFail, convertEOL, createZip, encodeXML, FetchError, fs, getEOLResolver, getHostFromUrl, makeArray, makeUri, mkdtemp, unzip, writeMessage } from "../util";
import { NODE_TYPE, PROP, VALUE_TYPE, XMLNS } from "./constants";
import { createPackageMetaInf, managePackage, uploadPackage } from "./package";
import client from "./client";

const CRX_ROOT = '/crx/server/crx.default/jcr:root';
const FETCH_FILTER = 1;
const FETCH_FILTER_CHILDREN = 2;
const FETCH_RECURSIVE = 4;

const internalProps = [
    PROP.jcrCreated,
    PROP.jcrCreatedBy,
    PROP.jcrLastModified,
    PROP.jcrLastModifiedBy,
    PROP.cqLastModified,
    PROP.cqLastModifiedBy,
    PROP.cqLastReplicated,
    PROP.cqLastReplicatedBy,
    PROP.cqLastReplicationAction
];

export enum FetchMode {
    Normal,
    Property = FETCH_FILTER,
    Children = FETCH_FILTER | FETCH_FILTER_CHILDREN,
    Recursive = FETCH_RECURSIVE,
    RecursiveChildren = FETCH_FILTER | FETCH_FILTER_CHILDREN | FETCH_RECURSIVE
}

export class OperationError extends Error {
    constructor(message: string) {
        super(message);
        writeMessage(`[ERROR] ${message}`);
    }
}

function isChildNode(data: Record<string, any>, i: string) {
    return typeof data[i] === 'object' && !Array.isArray(data[i]);
}

function getJcrValueType(value: any): string {
    switch (typeof value) {
        case 'string':
            return VALUE_TYPE.string;
        case 'boolean':
            return VALUE_TYPE.boolean;
        case 'number':
            return (Math.floor(value) - value === 0) ? VALUE_TYPE.long : VALUE_TYPE.double;
        case 'object':
            if (Array.isArray(value)) {
                let type = getJcrValueType(value[0]);
                return type && type + '[]';
            }
            if (value instanceof Date) {
                return VALUE_TYPE.date;
            }
    }
    return '';
}

function formatJcrValue(value: any): string {
    switch (getJcrValueType(value)) {
        case VALUE_TYPE.date:
            return value.toISOString();
    }
    return String(value);
}

function parseJcrValue(value: string, typeHint: string = '') {
    value = value.replace(/\\(u([0-9a-f]{4})|[,\\\[\{])/gi, v => v[2] ? String.fromCodePoint(parseInt(v[2], 16)) : v[1]);
    if (!typeHint) {
        if (value === 'true' || value === 'false') {
            typeHint = VALUE_TYPE.boolean;
        } else if (/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)((-(\d{2}):(\d{2})|Z)?)$/.test(value)) {
            typeHint = VALUE_TYPE.date;
        } else if (value && !isNaN(+value)) {
            typeHint = VALUE_TYPE.double;
        }
    }
    switch (typeHint) {
        case VALUE_TYPE.boolean:
            return value === 'true';
        case VALUE_TYPE.date:
            return new Date(value);
        case VALUE_TYPE.double:
        case VALUE_TYPE.long:
            return +value;
    }
    if (value === '\\0') {
        return '';
    }
    return value;
}

export function serializeJcrValue(value: any): string {
    if (!Array.isArray(value)) {
        // escape starting [ and { character to disambiguous with array or type hint
        return formatJcrValue(value).replace(/^[\[{]/, '\\$1');
    }
    if (value.length === 1 && value[0] === '') {
        // encode single empty string element as \0 to disambiguous with empty array
        return '[\\0]';
    }
    return '[' + value.map(v => formatJcrValue(v).replace(/,/g, '\\,')).join(',') + ']';
}

export function unserializeJcrValue(str: string, matches?: RegExpMatchArray[]) {
    let value;
    let typeHint = '';
    if (/^\{(\w+)\}/.test(str)) {
        str = str.slice(RegExp.lastMatch.length);
        typeHint = RegExp.$1;
    }
    let isArray = str[0] === '[';
    if (isArray) {
        let lastIndex = 0;
        matches = matches || [];
        assert(matches.length === 0, 'Matches array must be initially empty');
        for (let m of str.matchAll(/^\[|((?:\\[,\]]|[^,\]])*)(?=,|\])/g)) {
            if (m.index! > lastIndex) {
                matches.push(m);
                lastIndex = m.index! + m[0].length;
            }
        }
        value = matches.map(v => parseJcrValue(v[0], typeHint));
    } else {
        value = parseJcrValue(str, typeHint);
    }
    typeHint = typeHint && (typeHint + (isArray ? '[]' : ''));
    return { value, typeHint };
}

export function jcrToLocalName(name: string) {
    return name.replace(/^[\d-.]|[^\w-.:]|_(x[0-9a-fA-F]{4})/g, (v, a) => a ? '_x005f_' + a : '_x' + v.charCodeAt(0).toString(16) + '_');
}

export function localNameToJcr(name: string) {
    return name.replace(/_x([0-9a-fA-F]{4})_/g, (v, a) => String.fromCharCode(parseInt(a, 16)));
}

export function parseJcrContentXML(content: string) {
    let { [PROP.jcrRoot]: root } = xml.parse(content, { ignoreAttributes: false });
    let props: Record<string, any> = {};
    let process = (root: Record<string, any>, props: Record<string, any>) => {
        for (let i in root) {
            if (i.startsWith('@_')) {
                if (/^@_xmlns($|:)/.test(i)) {
                    continue;
                }
                let { value, typeHint } = unserializeJcrValue(decodeXML(root[i]) as string);
                if (typeHint) {
                    props[':' + i.slice(2)] = typeHint;
                }
                props[i.slice(2)] = value;
            } else if (Array.isArray(root[i])) {
                throw new Error('Child nodes must have unique names');
            } else {
                let name = localNameToJcr(i);
                props[name] = {};
                process(root[i], props[name]);
            }
        }
    };
    process(root, props);
    return props;
}

export function convertToJcrContentXML(properties: Record<string, any>) {
    let xmlns: Record<string, string> = {};
    let addNamespace = function (i: any) {
        let ns = typeof i === 'string' && /^([\w_]+):/.test(i) && RegExp.$1;
        if (ns && !xmlns[ns] && ns in XMLNS) {
            xmlns[ns] = `xmlns:${ns}="${XMLNS[ns as keyof typeof XMLNS]}"`;
        }
    };
    let process = (name: string, properties: Record<string, any>): string => {
        let localName = jcrToLocalName(name);
        let arr = ['<', localName];
        let childStart = arr.length;
        for (let i in properties) {
            if (i[0] !== ':') {
                let value = properties[i];
                if (isChildNode(properties, i)) {
                    arr.push(process(i, value));
                } else if (!internalProps.includes(i)) {
                    arr.splice(childStart, 0, ' ', i, '="', encodeXML(serializeJcrValue(value)), '"');
                    childStart += 5;
                    makeArray(value).forEach(addNamespace);
                }
                addNamespace(i);
            }
        }
        if (childStart === arr.length) {
            arr.push('/>');
        } else {
            arr.splice(childStart, 0, '>');
            arr.push('</', localName, '>');
        }
        return arr.join('');
    };
    let xml = process(PROP.jcrRoot, properties);
    return '<?xml version="1.0" encoding="UTF-8"?>' + xml.replace(/[ >]/, ` ${Object.values(xmlns).join(' ')}$&`);
}

export function jcrToFileSystem(path: string) {
    return path.replace(/([\w]+):/g, '_$1_');
}

export function fileSystemToJcr(path: string) {
    return path.replace(/_([\w]+)_/g, '$1:');
}

export async function executeQuery(host: string | Uri, query: QueryBuilder.QueryProps): Promise<Record<string, any>[]> {
    let { hits } = await client.fetchJSON(makeUri(host, '/bin/querybuilder.json', new QueryBuilder(query).toString()));
    return hits;
}

export async function existJcrNode(jcrPath: Uri) {
    return undefined !== await canFail(client.fetch(makeUri(jcrPath, `${CRX_ROOT}${jcrPath.path}.json`), { method: 'HEAD' }));
}

export async function fetchJcrNode(jcrPath: Uri, mode = FetchMode.Normal, depth = -1): Promise<Record<string, any>> {
    if (!(mode & FETCH_RECURSIVE)) {
        depth = (mode & FETCH_FILTER_CHILDREN) >> 1;
    }
    let data = await client.fetchJSON(makeUri(jcrPath, `${CRX_ROOT}${jcrPath.path}${depth < 0 ? '' : '.' + depth}.json`));
    if (mode & FETCH_FILTER) {
        let cleanData = (data: Record<string, any>, keepChildren?: boolean | number, recursive?: boolean | number) => {
            keepChildren = !!keepChildren;
            for (let i in data) {
                if (isChildNode(data, i) !== keepChildren) {
                    delete data[i];
                } else if (keepChildren && recursive) {
                    cleanData(data[i], true, true);
                }
            }
        };
        cleanData(data, mode & FETCH_FILTER_CHILDREN, mode & FETCH_RECURSIVE);
    }
    return data;
}

export async function fetchJcrProperties(jcrPath: Uri) {
    return fetchJcrNode(jcrPath, FetchMode.Property);
}

export async function fetchJcrChildNodes(jcrPath: Uri) {
    return fetchJcrNode(jcrPath, FetchMode.Children);
}

export async function saveJcrFile(jcrPath: Uri, data: string | Buffer | Uint8Array, mimeType?: string) {
    let formData = new FormData();
    formData.append('*@TypeHint', NODE_TYPE.ntFile);
    formData.append('*', Buffer.from(data), {
        filename: basename(jcrPath.path),
        contentType: mimeType || mimetypes.contentType(basename(jcrPath.path)) || 'application/octet-stream'
    });
    try {
        const res = await client.post(Uri.joinPath(jcrPath, '..'), formData);
        assert(res.changes.length);
        writeMessage(`repo: Updated ${jcrPath.toString(true)}`);
    } catch (err: any) {
        throw new OperationError(`Unable to update ${jcrPath.toString(true)}: ${err?.message}`);
    }
}

export interface SaveOptions {
    ignoreProps?: string[];
    deleteProps?: boolean;
    deleteChildren?: boolean;
}

export async function saveJcrProperties(jcrPath: Uri, properties: Record<string, any>, options: SaveOptions = {}) {
    const ignoredProps = [
        ...internalProps,
        ...(options.ignoreProps || [])
    ];
    const changes = [];
    const processNode = async (jcrPath: Uri, properties: Record<string, any>, order: number | false) => {
        let currentData: Record<string, any>;
        try {
            currentData = await fetchJcrNode(jcrPath);
        } catch (err) {
            if (!(err instanceof FetchError) || err.response.statusCode !== 404) {
                throw err;
            }
            currentData = {};
        }
        properties = { ...properties };
        ignoredProps.forEach(v => delete currentData[v]);
        ignoredProps.forEach(v => delete properties[v]);

        let childProps: Record<string, any> = {};
        let childrenToDelete: string[] = [];
        let formData = new FormData();
        for (let i in currentData) {
            if (!(i in properties)) {
                if (i[0] === ':') {
                    properties[i] = currentData[i];
                } else if (isChildNode(currentData, i)) {
                    if (options.deleteChildren) {
                        childrenToDelete.push(i);
                    }
                } else if (options.deleteProps) {
                    // only delete missing properties when jcr:primaryType property exists
                    // to cater placeholder tag in .content.xml
                    if (properties[PROP.jcrPrimaryType]) {
                        formData.append(i + '@Delete', '');
                    }
                }
            }
        }
        for (let i in properties) {
            if (i[0] !== ':') {
                let value = properties[i];
                if (Array.isArray(value)) {
                    if (value.length === currentData[i]?.length && value.every((v, j) => v === currentData[i][j])) {
                        continue;
                    }
                    if (!value.length && currentData[i]?.length) {
                        formData.append(i + '@Patch', 'true');
                        currentData[i].forEach((v: any) => {
                            formData.append(i, '-' + formatJcrValue(v));
                        });
                    } else {
                        value.forEach((v: any) => {
                            formData.append(i, formatJcrValue(v));
                        });
                    }
                } else if (!getJcrValueType(value)) {
                    childProps[i] = properties[i];
                } else {
                    value = formatJcrValue(value);
                    if (value === formatJcrValue(currentData[i])) {
                        continue;
                    }
                    formData.append(i, value);
                }
                let typeHint = properties[':' + i] || getJcrValueType(value);
                if (typeHint) {
                    formData.append(i + '@TypeHint', typeHint);
                }
            }
        }
        if (order !== false) {
            formData.append(':order', String(order));
        }
        if (formData.getLengthSync()) {
            const res = await client.post(jcrPath, formData);
            changes.push(...res.changes);
        }
        if (childrenToDelete[0]) {
            await Promise.all(childrenToDelete.map(v => deleteJcrNode(Uri.joinPath(jcrPath, v))));
        }
        if (Object.keys(childProps)[0]) {
            let keys = Object.keys(childProps);
            let reorder = Object.keys(currentData).filter(v => childProps[v]).some((v, i) => keys[i] !== v);
            for (let i = 0, len = keys.length; i < len; i++) {
                await processNode(Uri.joinPath(jcrPath, keys[i]), childProps[keys[i]], reorder && i);
            }
        }
    };
    try {
        await processNode(jcrPath, properties, false);
        if (changes.length) {
            writeMessage(`repo: Updated ${jcrPath.toString(true)}`);
        }
    } catch (err: any) {
        throw new OperationError(`Unable to update ${jcrPath.toString(true)}: ${err?.message}`);
    }
}

export async function deleteJcrNode(jcrPath: Uri) {
    try {
        const res = await client.post(jcrPath, { ':operation': 'delete' });
        assert(res.changes.length);
        writeMessage(`repo: Deleted ${jcrPath.toString(true)}`);
    } catch (err: any) {
        throw new OperationError(`Unable to delete ${jcrPath.toString(true)}: ${err?.message}`);
    }
}

export async function moveJcrNode(src: Uri, dst: Uri) {
    if (src.scheme !== dst.scheme || src.authority !== dst.authority) {
        throw new OperationError('Destination is on different server than source');
    }
    await client.post(makeUri(src, CRX_ROOT), { ':diff': `>${src.path} : ${dst.path}` });
    writeMessage(`repo: Moved ${src.path} to ${dst.path}`);
}

export async function exportJcrContent(jcrPath: Uri, destPath: Uri) {
    let host = getHostFromUrl(jcrPath);
    let packageName = 'export';
    let packageGroup = 'misonou.aemexplorer';
    let packageVersion = new Date().toISOString().replace(/\W/g, '');
    let packageFullName = `${packageGroup}/${packageName}-${packageVersion}.zip`;

    let tmpdir = mkdtemp('export-' + Math.random());
    await fs.createDirectory(tmpdir);
    await createPackageMetaInf(tmpdir, jcrPath.path, packageGroup, packageName, packageVersion);

    try {
        const zipfile = await createZip(tmpdir.fsPath);
        const pkgInfo = await uploadPackage(host, packageFullName, zipfile);
        await managePackage(host, packageFullName, 'build');

        const buffer = await client.fetch(pkgInfo.uri);
        const resolveEOL = getEOLResolver(destPath);
        await unzip(buffer, async (entry) => {
            if (!entry.path.startsWith(`jcr_root${jcrPath.path}/`)) {
                return entry.autodrain();
            }
            const relpath = entry.path.replace('jcr_root/', '');
            const abspath = Uri.joinPath(destPath, relpath);
            if (entry.type === 'File') {
                let buffer = await entry.buffer();
                let mode = await resolveEOL(relpath);
                if (mode === 'lf' || mode === 'crlf') {
                    buffer = Buffer.from(convertEOL(buffer.toString(), mode));
                }
                await fs.writeFile(abspath, buffer);
                writeMessage(`repo: Exported file to ${abspath.toString(true)}`);
            } else {
                await fs.createDirectory(abspath);
            }
        });
    } finally {
        canFail(managePackage(host, packageFullName, 'delete'));
        canFail(fs.delete(tmpdir, { recursive: true }));
    }
}

export interface PublishOptions {
    subtree?: boolean;
    includeNewItems?: boolean;
    includeUnmodifiedItems?: boolean;
    includeDeactivatedItems?: boolean;
}

export async function publishJcrContent(jcrPath: Uri, options?: PublishOptions): Promise<{ path: string, activate: boolean }[]> {
    if (options?.subtree) {
        let uri = makeUri(jcrPath, '/libs/replication/treeactivation.html');
        let params = {
            path: jcrPath.path,
            reactivate: !options.includeNewItems,
            onlymodified: !options.includeUnmodifiedItems,
            ignoredeactivated: !options.includeDeactivatedItems
        };
        let { body } = await client.post(uri, { ...params, cmd: 'dryrun' });
        let items = [];
        for (let [, action, path] of body.matchAll(/<div class="action (activate|ignore)"(?:[^<]|<(?!br))+"path">(\/(?:\S| (?!<| \[))+)/g)) {
            items.push({ path, activate: action === 'activate' });
        }
        client.post(uri, { ...params, cmd: 'activate' });
        return items;
    } else {
        await client.post(makeUri(jcrPath, '/bin/replicate.json'), {
            cmd: 'activate',
            path: jcrPath.path
        });
        return [{ path: jcrPath.path, activate: true }];
    }
}

export async function unpublishJcrContent(jcrPath: Uri) {
    return await client.post(makeUri(jcrPath, '/bin/replicate.json'), { path: jcrPath.path, cmd: 'deactivate' });
}
