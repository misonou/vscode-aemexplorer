import { CompletionItem, Position, Range, SnippetString, TextDocument } from "vscode";
import { decode as decodeXML } from "html-entities";
import { encodeXML } from "../../util";
import { containsOffset, getBoundaryOffset } from "./regExpUtil";
import { CompletionHandler, CompletionType, CompletionItemOptions } from "./CompletionHandler";

export default class XMLCompletionHandler extends CompletionHandler {
    private static readonly TRIGGER_PROP = ['\n', ' '];
    private static readonly TRIGGER_VALUE = ['"', '/', '.'];
    private static readonly TRIGGER_VALUE_ARR = ['"', '[', ',', '/', '.'];

    static canHandle(document: TextDocument) {
        return document.languageId === 'xml';
    }

    protected initialize(document: TextDocument, position: Position) {
        let content = document.getText();
        let offset = document.offsetAt(position);
        let tagOffset = content.lastIndexOf('<', offset) + 1;
        let tagText = content.substring(tagOffset, content.indexOf('>', offset));
        let parsedData: Record<string, any> = {};
        let rawData: Record<string, any> = {};
        let completionType = CompletionType.Property;
        let currentProperty: string | undefined;
        let currentValue, currentValueRange, hoverRange;

        for (let m of tagText.matchAll(/>|<\/?|([\w_:-]+)=(?:"([^"]*)")?/g)) {
            if (m[0][0] === '>' || m[0][0] === '<') {
                if (m.index! < offset - tagOffset) {
                    return;
                }
                break;
            }
            if (!m[1].startsWith('xmlns:')) {
                rawData[m[1]] = m[2] || '';
                if (containsOffset(m, offset - tagOffset)) {
                    let [startOffset, endOffset] = getBoundaryOffset(m);
                    let matches: RegExpMatchArray[] = [];
                    currentProperty = m[1];
                    currentValue = this.unserializeValue(decodeXML(rawData[currentProperty]), matches);
                    parsedData[currentProperty] = currentValue;

                    let valueOffset = tagOffset + startOffset + currentProperty.length + 2;
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
                            document.positionAt(tagOffset + endOffset - 1)
                        );
                    }
                    if (offset >= tagOffset + startOffset + currentProperty.length) {
                        completionType = CompletionType.Value;
                        hoverRange = currentValueRange;
                    } else {
                        hoverRange = new Range(
                            document.positionAt(tagOffset + startOffset),
                            document.positionAt(tagOffset + startOffset + currentProperty.length)
                        );
                    }
                }
            }
        }
        return {
            completionType: completionType,
            currentProperty: currentProperty,
            currentValue: currentValue,
            currentValueRange: currentValueRange,
            hoverRange: hoverRange,
            properties: this.createLazyUnserializedObject(rawData, parsedData, v => this.unserializeValue(decodeXML(v))),
            objectPath: this.getContainingElementNames(content, tagOffset)
        };
    }

    protected getInsertText(options: CompletionItemOptions) {
        if ('value' in options) {
            return encodeXML(this.serializeValue(options.value));
        } else {
            let { name, defaultValue } = options;
            let str = new SnippetString();
            str.appendText(`${name}=`);
            str.appendText('"');
            if (defaultValue !== undefined) {
                if (Array.isArray(defaultValue)) {
                    this.appendArrayPlaceholders(str, defaultValue, v => encodeXML(this.serializeValue(v)));
                } else {
                    str.appendPlaceholder(encodeXML(this.serializeValue(defaultValue)));
                }
            } else {
                str.appendTabstop();
            }
            str.appendText('"');
            return str;
        }
    }

    protected getCompletionTriggerCharacters() {
        if (this.completionType === CompletionType.Property) {
            return XMLCompletionHandler.TRIGGER_PROP;
        } else if (Array.isArray(this.properties[this.currentProperty!])) {
            return XMLCompletionHandler.TRIGGER_VALUE_ARR;
        } else {
            return XMLCompletionHandler.TRIGGER_VALUE;
        }
    }

    protected onDidCreateCompletionItem(item: CompletionItem, type: CompletionType) {
        if (type === CompletionType.Value) {
            item.range = this.currentValueRange;
        }
    }

    protected serializeValue(value: any) {
        return String(value);
    }

    protected unserializeValue(value: string, matches?: RegExpMatchArray[]): any {
        return value;
    }

    private getContainingElementNames(xml: string, offset: number) {
        let arr = [];
        for (let m of xml.matchAll(/<(?:\/?)([\w_:]+)|\/>/g)) {
            if ((m.index || 0) > offset) {
                break;
            }
            if (m[0][0] === '/' || m[0][1] === '/') {
                arr.shift();
            } else {
                arr.unshift(m[1]);
            }
        }
        return arr;
    }
}
