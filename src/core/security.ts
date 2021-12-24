import { Uri } from "vscode";
import { makeUri } from "../util";
import client from "./client";
import { NODE_TYPE, PROP } from "./constants";
import { executeQuery, fetchJcrProperties } from "./repo";

export interface CreateUserOptions {
    userId: string;
    password: string;
    groups: string[];
}

export async function createUser(host: string | Uri, params: CreateUserOptions) {
    let result = await client.post(makeUri(host, '/libs/granite/security/post/authorizables'), {
        createUser: 'true',
        authorizableId: params.userId,
        membership: ['everyone', ...params.groups],
        'rep:password': params.password
    });
    return makeUri(host, /<div id="Path">([^>]+)<\/div>/.exec(result.body)?.[1] || '');
}

export async function createGroup(host: string | Uri, groupId: string) {
    let result = await client.post(makeUri(host, '/libs/granite/security/post/authorizables'), {
        createGroup: 'true',
        authorizableId: groupId
    });
    return makeUri(host, /<div id="Path">([^>]+)<\/div>/.exec(result.body)?.[1] || '');
}

export async function deleteAuthorizable(jcrPath: Uri) {
    await client.post(jcrPath, { deleteAuthorizable: 'true' });
}

export async function getMembership(jcrPath: Uri): Promise<string[]> {
    let { [PROP.jcrUUID]: uuid } = await fetchJcrProperties(jcrPath);
    let items = await executeQuery(jcrPath, {
        type: NODE_TYPE.repGroup,
        where: { [PROP.repMembers]: uuid },
        select: [PROP.repAuthorizableId]
    });
    return items.map(v => v[PROP.repAuthorizableId]);
}

export async function getGroupMembers(jcrPath: Uri): Promise<string[]> {
    let res = await fetchJcrProperties(jcrPath);
    let members = (res[PROP.repMembers] || []) as string[];
    if (!members.length) {
        return [];
    }
    let items = await executeQuery(jcrPath, {
        type: [NODE_TYPE.repUser, NODE_TYPE.repGroup],
        where: { [PROP.jcrUUID]: members },
        select: [PROP.repAuthorizableId]
    });
    return items.map(v => v[PROP.repAuthorizableId]);
}

export async function setMembership(jcrPath: Uri, authorizableIds: string[]) {
    await client.post(makeUri(jcrPath, `${jcrPath.path}.rw.html`), { membership: ['everyone', ...authorizableIds] });
}

export interface UpdateGroupMembersOptions {
    addMembers?: string[];
    removeMembers?: string[];
}

export async function updateGroupMembers(jcrPath: Uri, options: UpdateGroupMembersOptions) {
    await client.post(makeUri(jcrPath, `${jcrPath.path}.rw.html`), {
        addMembers: options.addMembers || [],
        removeMembers: options.removeMembers || []
    });
}
