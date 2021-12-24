import { GlobPattern, MarkdownString, TextDocument } from "vscode";
import { OsgiConfigAttribute, resolveOsgiConfigSchema } from "../../core/osgi";
import BaseProvider from "./BaseProvider";
import { CompletionState, CompletionType, PropertyCompletionItemProps } from "./CompletionHandler";
import JSONCompletionHandler from "./JSONCompletionHandler";
import OsgiConfigCompletionHandler from "./OsgiConfigCompletionHandler";
import { getNodeTypeNames } from "./schema";
import { suggestPaths, suggestResourceTypes } from "./suggestions";

const hoverTexts = new Map<OsgiConfigAttribute, MarkdownString[]>();

function formatPropertyType(property: OsgiConfigAttribute) {
    let valueType = property.type === 'Boolean' || property.type === 'String' ? property.type.toLowerCase() : 'number';
    if (property.cardinality !== 'required') {
        valueType = valueType + '[]';
    }
    return valueType;
}

export default class OsgiConfigLanguageProvider extends BaseProvider {
    protected static readonly triggerCharacters = ['"', '\n', '=', ' ', ',', '[', '/'];

    constructor(patterns: GlobPattern[]) {
        super(patterns, OsgiConfigCompletionHandler, JSONCompletionHandler);
    }

    canHandle(document: TextDocument) {
        return !!resolveOsgiConfigSchema(document.uri);
    }

    protected resolveHoverContents(state: CompletionState) {
        if (state.completionType === CompletionType.Property) {
            const schema = resolveOsgiConfigSchema(state.document.uri)!;
            const property = schema.attributes[state.currentProperty!];
            if (property) {
                if (!hoverTexts.has(property)) {
                    let str1 = new MarkdownString();
                    str1.appendCodeblock(`"${property.id}": ${formatPropertyType(property)}`, 'javascript');
                    let str2 = new MarkdownString(property.name + '\n\n' + (property.description || ''));
                    let str3 = new MarkdownString();
                    str3.appendCodeblock(`import ${property.schema.id}`, 'java');
                    let str4 = new MarkdownString();
                    str4.appendMarkdown(property.schema.name + '\n\n');
                    if (property.schema.description) {
                        str4.appendMarkdown(property.schema.description + '\n\n');
                    }
                    str4.appendMarkdown('*@bundle* &mdash; `' + property.schema.bundleName + '`' + '\n\n');
                    hoverTexts.set(property, [str1, str2, str3, str4]);
                }
                return hoverTexts.get(property)!;
            }
        }
    }

    protected resolvePropertyCompletions(state: CompletionState) {
        let schema = resolveOsgiConfigSchema(state.document.uri)!;
        return Object.keys(schema.attributes).map(v => {
            let prop = schema.attributes[v];
            return <PropertyCompletionItemProps>{
                name: v,
                detail: v,
                documentation: prop.description,
                defaultValue: prop.default !== undefined ? prop.default : prop.cardinality !== 'required' ? [] : undefined
            };
        });
    }

    protected resolveValueCompletions(state: CompletionState) {
        switch (state.currentProperty) {
            case 'sling.servlet.resourceTypes':
                return suggestResourceTypes(state);
            case 'sling.servlet.paths':
                return suggestPaths(state);
        }
        let schema = resolveOsgiConfigSchema(state.document.uri)!;
        let prop = schema.attributes[state.currentProperty!];
        switch (prop?.hint) {
            case 'nodeType':
                return getNodeTypeNames();
            case 'resourceType':
                return suggestResourceTypes(state);
            case 'path':
                return suggestPaths(state);
        }
        if (prop?.type === 'Boolean') {
            return [true, false];
        }
        if (Array.isArray(prop?.options)) {
            return prop.options.map(v => v.value);
        }
    }
}
