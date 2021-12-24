import { Uri } from "vscode";
import { makeArray, makeUri } from "../util";
import client from "./client";
import { NODE_TYPE, PROP, PROP2 } from "./constants";
import { executeQuery, fetchJcrProperties } from "./repo";

export interface CreatePageOptions {
    label: string;
    title: string;
    template: string;
    parentPath: string;
}

export async function createPage(host: string | Uri, options: CreatePageOptions) {
    await client.post(makeUri(host, '/bin/wcmcommand'), {
        cmd: 'createPage',
        ...options
    });
    return Uri.joinPath(makeUri(host, options.parentPath), options.label);
}

export async function getAllowedPageTemplates(siteUri: Uri) {
    let { [PROP.cqAllowedTemplates]: allowedTemplates } = await fetchJcrProperties(Uri.joinPath(siteUri, 'jcr:content'));
    let items = await executeQuery(siteUri, {
        type: NODE_TYPE.cqTemplate,
        not: { excludePaths: makeArray(allowedTemplates) },
        where: { [PROP2.jcrContent.status]: 'enabled' },
        select: [PROP.jcrPath, PROP2.jcrContent.jcrTitle, PROP2.jcrContent.jcrDescription]
    });
    return items.map(v => {
        return {
            path: v[PROP.jcrPath] as string,
            title: v[PROP.jcrContent][PROP.jcrTitle] as string,
            description: v[PROP.jcrContent][PROP.jcrDescription] as string | undefined
        };
    });
}
