import * as vscode from "vscode";
import { OpenDialogOptions, QuickPickItem, QuickPickOptions, Uri } from "vscode";
import QueryBuilder from "aem-querybuilder";
import { NODE_TYPE, PROP, PROP2 } from "../core/constants";
import { executeQuery } from "../core/repo";
import { getAllowedPageTemplates } from "../core/wcm";
import { basename, makeUri, matchString } from "../util";

type QuickPickTResult<T, P extends boolean | undefined> = (P extends true ? T[] : T);
type QuickPickJcrNodeItem = QuickPickItem & { value: string, nodeType: string };

let defaultUri: Uri = Uri.file(process.env.USERPROFILE || process.env.HOME!);

export async function showOpenDialog(options?: OpenDialogOptions) {
    let picked = await vscode.window.showOpenDialog({ defaultUri, ...options });
    if (picked) {
        defaultUri = Uri.joinPath(picked[0], '..');
    }
    return picked;
}

export async function showQuickPickMany(items: string[], options: Omit<QuickPickOptions, 'canPickMany'> & { picked: string[] }) {
    let choices: QuickPickItem[] = items.map(v => {
        return { label: v, picked: options.picked.includes(v) };
    });
    return (await vscode.window.showQuickPick(choices, { ...options, canPickMany: true }))?.map(v => v.label);
}

export interface QuickPickTOptions<T, V, P extends boolean | undefined> extends QuickPickOptions {
    canPickMany: P;
    isPicked?: P extends true ? (obj: T) => boolean : never;
    getIcon?: (obj: T) => string | undefined;
    getLabel: (obj: T) => string;
    getDescription?: (obj: T) => string;
    getDetail?: (obj: T) => string;
    mapResult: (obj: T) => V;
}

export async function showQuickPickT<T, V, P extends boolean | undefined>(items: T[], options: QuickPickTOptions<T, V, P>): Promise<QuickPickTResult<V, P> | undefined> {
    let choices = items.map(v => {
        let icon = options.getIcon?.(v);
        let label = options.getLabel(v);
        let description = options.getDescription?.(v);
        let detail = options.getDetail?.(v);
        return {
            value: v,
            label: (icon ? `$(${icon}) ` : '') + label,
            sortText: label.toLowerCase(),
            description: label !== description ? description : '',
            detail: detail,
            picked: false
        };
    });
    choices.sort((a, b) => a.sortText.localeCompare(b.sortText));
    if (options.canPickMany && options.isPicked) {
        for (let item of choices) {
            item.picked = options.isPicked(item.value);
        }
        choices.sort((a, b) => +b.picked - +a.picked);
        return (await vscode.window.showQuickPick(choices, { ...options, canPickMany: true }))?.map(v => options.mapResult(v.value)) as QuickPickTResult<V, P>;
    } else {
        let result = await vscode.window.showQuickPick(choices, options);
        return result && options.mapResult(result.value) as QuickPickTResult<V, P>;
    }
}

export interface QuickPickAuthorizableOptions {
    canPickUsers?: boolean;
    canPickGroups?: boolean;
    canPickMany?: boolean;
    exclude?: string[];
    picked?: string[];
    returnType?: 'authorizableId' | 'uuid';
}

export async function showQuickPickAuthorizable<P extends boolean | undefined>(host: string | Uri, options: QuickPickAuthorizableOptions & { canPickMany: P }) {
    let picked = options.picked || [];
    let exclude = options.exclude || [];
    let arr = await executeQuery(host, {
        type: [options.canPickUsers !== false && NODE_TYPE.repUser, options.canPickGroups !== false && NODE_TYPE.repGroup].filter(v => v) as string[],
        where: {
            [PROP.repAuthorizableId]: { ne: exclude },
            [PROP.jcrUUID]: { ne: exclude }
        },
        select: [PROP.repAuthorizableId, PROP.jcrUUID, PROP.jcrPrimaryType, 'profile/givenName'],
        orderBy: PROP.repAuthorizableId
    });
    let items = arr.map(v => {
        return {
            type: v[PROP.jcrPrimaryType] === NODE_TYPE.repGroup ? 'group' : 'user',
            uuid: v[PROP.jcrUUID],
            authorizableId: v[PROP.repAuthorizableId],
            givenName: v.profile?.givenName
        };
    });
    return showQuickPickT(items, {
        canPickMany: options.canPickMany,
        matchOnDescription: true,
        isPicked: v => picked.includes(v.authorizableId) || picked.includes(v.uuid),
        getIcon: v => v.type === 'user' ? 'person' : 'organization',
        getLabel: v => v.givenName || v.authorizableId,
        getDescription: v => v.authorizableId,
        mapResult: v => v[options.returnType || 'authorizableId'] as string
    });
}

export async function showQuickPickPageTemplate(jcrPath: Uri, options?: QuickPickOptions) {
    let templates = await getAllowedPageTemplates(jcrPath);
    return showQuickPickT(templates, {
        ...options,
        canPickMany: false,
        matchOnDescription: true,
        matchOnDetail: true,
        getLabel: v => v.title,
        getDescription: v => v.description || '',
        getDetail: v => v.path,
        mapResult: v => v.path
    });
}

export interface QuickPickJcrNodeOptions extends Pick<QuickPickOptions, 'title' | 'placeHolder'> {
    nodeTypes?: string[]
}

export async function showQuickPickJcrNode(initialPath: Uri, options?: QuickPickJcrNodeOptions) {
    return new Promise<Uri | undefined>(resolve => {
        const picker = vscode.window.createQuickPick<QuickPickJcrNodeItem>();
        const nodeTypes = options?.nodeTypes || [NODE_TYPE.slingFolder];
        const updatePickerItems = async (basePath: string) => {
            let items = await executeQuery(initialPath, {
                path: QueryBuilder.scope.children(basePath),
                type: [NODE_TYPE.slingFolder, ...nodeTypes],
                select: [PROP.jcrTitle, PROP.jcrPrimaryType, PROP.jcrPath, PROP2.jcrContent.jcrTitle],
                orderBy: ['path']
            });
            picker.items = [
                {
                    label: '',
                    nodeType: '',
                    value: basePath,
                    alwaysShow: true
                },
                ...items.map<QuickPickJcrNodeItem>(v => {
                    return {
                        label: v[PROP.jcrContent]?.[PROP.jcrTitle] || v[PROP.jcrTitle] || basename(v[PROP.jcrPath]),
                        detail: v[PROP.jcrPath],
                        value: v[PROP.jcrPath],
                        nodeType: v[PROP.jcrPrimaryType],
                        alwaysShow: true
                    };
                })
            ];
            picker.activeItems = [picker.items[0]];
        };
        picker.onDidChangeValue(value => {
            let basePath = value.slice(0, value.lastIndexOf('/'));
            if (basePath !== picker.items[0].value) {
                updatePickerItems(basePath);
            } else {
                let match = picker.items.filter(v => v.value === value)[0];
                if (match && match !== picker.activeItems[0]) {
                    picker.activeItems = [match];
                }
            }
        });
        picker.onDidChangeActive(items => {
            if (items[0] && items[0] !== picker.items[0]) {
                picker.value = items[0].value;
            }
        });
        picker.onDidAccept(() => {
            if (picker.activeItems[0] !== picker.items[0] && matchString(picker.activeItems[0].nodeType, ...nodeTypes)) {
                resolve(makeUri(initialPath, picker.value.replace(/\/$/, '')));
                picker.dispose();
            }
        });
        picker.onDidHide(() => {
            return resolve(undefined);
        });
        picker.title = options?.title;
        picker.placeholder = options?.placeHolder;
        picker.matchOnDetail = true;
        picker.ignoreFocusOut = true;
        picker.value = initialPath.path + '/';
        updatePickerItems(initialPath.path);
        picker.show();
    });
}
