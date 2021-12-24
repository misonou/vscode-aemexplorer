import { Uri } from "vscode";
import FormData from "form-data";
import * as xml from "fast-xml-parser";
import { basename, encodeXML, fs, makeArray, makeUri, unzip, writeMessage } from "../util";
import client from "./client";
import { PATH } from "./constants";

const PACKMGR_PATH = '/crx/packmgr/service/.json';

interface PackageInfo {
    name: string;
    version: string;
    group: string;
}

export async function createPackageMetaInf(tmpDir: Uri, filter: string, packageGroup: string, packageName: string, packageVersion: string) {
    await fs.createDirectory(Uri.joinPath(tmpDir, 'META-INF/vault'));
    await fs.createDirectory(Uri.joinPath(tmpDir, 'jcr_root'));

    await fs.writeFile(Uri.joinPath(tmpDir, 'META-INF/vault/filter.xml'), Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<workspaceFilter version="1.0">
    <filter root="${encodeXML(filter)}"/>
</workspaceFilter>`));

    await fs.writeFile(Uri.joinPath(tmpDir, 'META-INF/vault/properties.xml'), Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
    <entry key="name">${encodeXML(packageName)}</entry>
    <entry key="version">${encodeXML(packageVersion)}</entry>
    <entry key="group">${encodeXML(packageGroup)}</entry>
</properties>`));
}

export async function readPackage(file: Uri) {
    let result: Partial<PackageInfo> = {};
    await unzip(await fs.readFile(file), async entry => {
        if (entry.path === 'META-INF/vault/properties.xml') {
            let content = (await entry.buffer()).toString();
            let root = xml.parse(content, { ignoreAttributes: false });
            for (let entry of makeArray(root.properties?.entry)) {
                switch (entry['@_key']) {
                    case 'name':
                    case 'version':
                    case 'group':
                        result[entry['@_key'] as keyof PackageInfo] = entry['#text'];
                }
            }
        }
        return entry.autodrain().promise();
    });
    if (!result.group || !result.name || !result.version) {
        throw new Error(`Invalid package: ${file.toString(true)}`);
    }
    return result as PackageInfo;
}

export async function uploadPackage(host: string, packageName: string, data: Buffer | Uint8Array, install?: boolean) {
    let formData = new FormData();
    formData.append('force', 'true');
    formData.append('package', data, {
        filename: basename(packageName),
        contentType: 'application/zip',
    });
    if (install) {
        formData.append('install', 'true');
    }
    let res = await client.post(makeUri(host, PACKMGR_PATH, { cmd: 'upload' }), formData);
    if (!res.success) {
        throw new Error(res.msg);
    }
    let uri = makeUri(host, res.path);
    writeMessage(`Package created at ${uri}`);
    return { uri };
}

export async function managePackage(host: string, packageName: string, command: 'install' | 'build' | 'delete') {
    let res = await client.post(makeUri(host, `${PACKMGR_PATH}${PATH.packages}/${packageName}`, { cmd: command }));
    if (!res.success) {
        throw new Error(res.msg);
    }
    writeMessage(`Successfully ${command} package ${packageName}`);
}
