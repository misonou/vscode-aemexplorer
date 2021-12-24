import { CompletionItem, Position, Range, SnippetString, TextDocument } from "vscode";
import { formatOsgiConfigValue, OsgiConfigSchema, parseOsgiConfigValue, resolveOsgiConfigSchema } from "../../core/osgi";
import { containsOffset, getBoundaryOffset } from "./regExpUtil";
import { CompletionHandler, CompletionType, CompletionItemOptions } from "./CompletionHandler";

export default class OsgiConfigCompletionHandler extends CompletionHandler {
    private static readonly TRIGGER_PROP = ['\n'];
    private static readonly TRIGGER_VALUE = ['=', '"', '/', '.'];
    private static readonly TRIGGER_VALUE_ARR = ['=', '"', '[', ',', '/', '.'];

    private schema?: OsgiConfigSchema;

    static canHandle(document: TextDocument) {
        return document.languageId === 'ini';
    }

    protected initialize(document: TextDocument, position: Position) {
        if (document.lineAt(position).text.startsWith('#')) {
            return;
        }
        let offset = document.offsetAt(position);
        let parsedData: Record<string, any> = {};
        let rawData: Record<string, any> = {};
        let completionType = CompletionType.Property;
        let currentProperty: string | undefined;
        let currentValue, currentValueRange, hoverRange;

        for (let m of document.getText().matchAll(/([\w.]+)=((?:[^\r\n]|\\\r?\n)*)/g)) {
            rawData[m[1]] = m[2] || '';
            if (containsOffset(m, offset)) {
                let [startOffset, endOffset] = getBoundaryOffset(m);
                let matches: RegExpMatchArray[] = [];
                currentProperty = m[1];
                currentValue = parseOsgiConfigValue(rawData[currentProperty], matches);
                parsedData[currentProperty] = currentValue;

                let valueOffset = startOffset + currentProperty.length + 1;
                if (Array.isArray(currentValue)) {
                    let index = matches.findIndex(v => containsOffset(v, offset - valueOffset));
                    currentValue = currentValue[index];
                    if (index >= 0) {
                        let [startOffset, endOffset] = getBoundaryOffset(matches[index]);
                        currentValueRange = new Range(
                            document.positionAt(valueOffset + startOffset),
                            document.positionAt(valueOffset + endOffset)
                        );
                    }
                } else {
                    currentValueRange = new Range(
                        document.positionAt(valueOffset),
                        document.positionAt(endOffset)
                    );
                }
                if (offset >= startOffset + currentProperty.length) {
                    completionType = CompletionType.Value;
                    if (currentValueRange) {
                        hoverRange = currentValueRange;
                        currentValueRange = new Range(
                            currentValueRange.start.translate(0, document.getText(currentValueRange).indexOf('"') + 1),
                            currentValueRange.end.translate(0, -1)
                        );
                    }
                } else {
                    hoverRange = new Range(
                        document.positionAt(startOffset),
                        document.positionAt(startOffset + currentProperty.length),
                    );
                }
            }
        }
        return {
            completionType: completionType,
            currentProperty: currentProperty,
            currentValue: currentValue,
            currentValueRange: currentValueRange,
            hoverRange: hoverRange,
            properties: this.createLazyUnserializedObject(rawData, parsedData, parseOsgiConfigValue),
            schema: resolveOsgiConfigSchema(document.uri)
        };
    }

    protected getInsertText(options: CompletionItemOptions) {
        if ('value' in options) {
            let prop = this.schema!.attributes[this.currentProperty!];
            return formatOsgiConfigValue(options.value, prop.type);
        } else {
            let { name, defaultValue } = options;
            let prop = this.schema!.attributes[name];
            let str = new SnippetString();
            str.appendText(`${name}=`);
            if (defaultValue !== undefined) {
                if (Array.isArray(defaultValue)) {
                    this.appendArrayPlaceholders(str, defaultValue, v => formatOsgiConfigValue(v, prop.type));
                } else {
                    str.appendText(prop.type === 'String' ? '"' : formatOsgiConfigValue('', prop.type)[0] + '"');
                    str.appendPlaceholder(String(defaultValue));
                    str.appendText('"');
                }
            }
            return str;
        }
    }

    protected getCompletionTriggerCharacters() {
        if (this.completionType === CompletionType.Property) {
            return OsgiConfigCompletionHandler.TRIGGER_PROP;
        } else if (Array.isArray(this.properties[this.currentProperty!])) {
            return OsgiConfigCompletionHandler.TRIGGER_VALUE_ARR;
        } else {
            return OsgiConfigCompletionHandler.TRIGGER_VALUE;
        }
    }

    protected onDidCreateCompletionItem(item: CompletionItem, type: CompletionType) {
        if (type === CompletionType.Value) {
            item.range = this.hoverRange;
            item.filterText = item.insertText?.toString();
        }
    }
}
