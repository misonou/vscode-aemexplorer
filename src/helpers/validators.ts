import { Uri } from "vscode";
import { NODE_TYPE, PROP } from "../core/constants";
import { executeQuery, existJcrNode } from "../core/repo";

export function combine(...validators: ((value: string) => string | null | undefined | Thenable<string | null | undefined>)[]) {
    return async (value: string) => {
        for (let validator of validators) {
            let result = await validator(value);
            if (result) {
                return result;
            }
        }
    };
}

export function validateNonEmpty(value: string) {
    return value ? '' : 'Must not be empty string';
}

export function validateIDChar(value: string) {
    return /^[\w-]+$/.test(value) ? '' : 'Only alphanumeric, underscore (_) and hyphen (-) characters are allowed';
}

export function validateUniqueNodeName(dstPath: Uri) {
    return async function (value: string) {
        let result = await existJcrNode(Uri.joinPath(dstPath, value));
        return result ? `${dstPath.toString(true)}/${value} already exists` : '';
    };
}

export function validateUniqueAuthorizableId(host: Uri) {
    return async (value: string) => {
        let items = await executeQuery(host, {
            type: [NODE_TYPE.repUser, NODE_TYPE.repGroup],
            where: { [PROP.repAuthorizableId]: value }
        });
        return items.length ? `Authorizable ID ${value} already exists on ${host.scheme}://${host.authority}` : '';
    };
}
