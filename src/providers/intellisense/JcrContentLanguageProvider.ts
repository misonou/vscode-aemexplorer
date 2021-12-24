import { GlobPattern, MarkdownString } from "vscode";
import { PROP, VALUE_TYPE } from "../../core/constants";
import { serializeJcrValue, unserializeJcrValue } from "../../core/repo";
import BaseProvider from "./BaseProvider";
import { CompletionState, CompletionType, PropertyCompletionItemProps } from "./CompletionHandler";
import JSONCompletionHandler from "./JSONCompletionHandler";
import XMLCompletionHandler from "./XMLCompletionHandler";
import { getNodeProperties, getNodeTypeNames, getSlingResourceProperties, NamedPropertyDefinition } from "./schema";
import { suggestPaths, suggestResourceTypes, suggestTags } from "./suggestions";

function formatPropertyType(property: NamedPropertyDefinition) {
    if (property.valueConstraints) {
        return property.valueConstraints.map(v => `"${v}"`).join(' | ');
    }
    return property.requiredType + (property.multiple ? '[]' : '');
}

class JcrContentXMLCompletionHandler extends XMLCompletionHandler {
    protected serializeValue(value: any) {
        return serializeJcrValue(value);
    }

    protected unserializeValue(value: string, matches?: RegExpMatchArray[]) {
        return unserializeJcrValue(value, matches).value;
    }
}

export default class JcrContentLanguageProvider extends BaseProvider {
    protected static readonly triggerCharacters = ['\n', '"', ' ', ',', '[', '/'];

    constructor(patterns: GlobPattern[]) {
        super(patterns, JcrContentXMLCompletionHandler, JSONCompletionHandler);
    }

    protected async resolveHoverContents(state: CompletionState) {
        if (state.completionType === CompletionType.Property) {
            let properties = await this.getNamedProperties(state);
            let prop = properties[state.currentProperty!];
            let arr: MarkdownString[] = [];
            arr[0] = new MarkdownString();
            arr[0].appendCodeblock(`"${prop?.name || state.currentProperty}": ${prop ? formatPropertyType(prop) : 'unknown'}`, 'typescript');
            if (prop?.description) {
                arr.push(new MarkdownString(prop.description));
            }
            return arr;
        }
    }

    protected async resolvePropertyCompletions(state: CompletionState) {
        let properties = await this.getNamedProperties(state);
        return Object.keys(properties).map(v => {
            let prop = properties[v];
            return <PropertyCompletionItemProps>{
                name: v,
                documentation: prop.description,
                sortText: v.includes(':') ? v : 'zzz:' + v,
                defaultValue: prop.defaultValues !== undefined ? prop.defaultValues : prop.multiple ? [] : undefined
            };
        });
    }

    protected async resolveValueCompletions(state: CompletionState) {
        switch (state.currentProperty) {
            case PROP.jcrPrimaryType:
                return getNodeTypeNames(v => !v.isAbstract && !v.isMixin);
            case PROP.jcrMixinTypes:
                return getNodeTypeNames(v => v.isMixin);
            case PROP.cqAllowedTemplates:
            case PROP.cqContextHubPath:
            case PROP.cqContextHubSegmentsPath:
            case PROP.cqTemplate:
                return suggestPaths(state);
            case PROP.cqTags:
                return suggestTags(state);
            case PROP.slingResourceType:
            case PROP.slingResourceSuperType:
                return suggestResourceTypes(state);
        }
        let properties = await this.getNamedProperties(state);
        let prop = properties[state.currentProperty!];
        if (prop?.requiredType === VALUE_TYPE.boolean) {
            return [true, false];
        }
        if (prop?.valueConstraints?.length) {
            return prop.valueConstraints;
        }
    }

    private async getNamedProperties(state: CompletionState) {
        let primaryType = state.properties[PROP.jcrPrimaryType];
        let mixinTypes = state.properties[PROP.jcrMixinTypes];
        let resourceType = state.properties[PROP.slingResourceType];
        let baseProps = getNodeProperties(primaryType);
        if (resourceType || mixinTypes) {
            baseProps = { ...baseProps };
            for (let v of (mixinTypes || [])) {
                Object.assign(baseProps, getNodeProperties(v));
            }
            return Object.assign(baseProps, await getSlingResourceProperties(resourceType));
        }
        return baseProps;
    }
}
