import { CompletionItem, DocumentSymbol, Position, Range, SnippetString, SymbolKind, TextDocument } from "vscode";
import { executeCommand, parseJSON } from "../../util";
import { CompletionHandler, CompletionType, CompletionItemOptions } from "./CompletionHandler";

export default class JSONCompletionHandler extends CompletionHandler {
    private static readonly TRIGGER_PROP = ['"', ' '];
    private static readonly TRIGGER_VALUE = ['"', '/', '.'];

    static canHandle(document: TextDocument) {
        return document.languageId === 'json' || document.languageId === 'jsonc';
    }

    protected async initialize(document: TextDocument, position: Position) {
        let symbols = await executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
        let symbolPath = this.getContainingSymbols(symbols, position);
        let properties = this.createObject(document, symbolPath.find(v => v.kind === SymbolKind.Object)?.children || symbols);
        let completionType = CompletionType.Property;
        let currentProperty, currentValue, currentValueRange;

        let [sym] = symbolPath;
        if (!sym || sym.kind === SymbolKind.Object) {
            // check if cursor is right after a property key that is without value
            // grep the property name by regex as there is no symbol generated
            let line = document.lineAt(position.line).text.slice(0, position.character);
            let current = /"([^"]+)"\s*:\s*$/.test(line) && RegExp.$1;
            if (current && !(current in properties)) {
                currentProperty = current;
                completionType = CompletionType.Value;
            }
        } else if (!sym.range.isEqual(sym.selectionRange) && sym.selectionRange.contains(position)) {
            // cursor is within the range of property key
            currentProperty = sym.name;
        } else {
            completionType = CompletionType.Value;
            if (sym.range.isEqual(sym.selectionRange)) {
                // array element when range is equal to selectionRange
                // since there is no property key
                currentProperty = symbolPath[1].name;
                currentValue = JSON.parse(document.getText(symbolPath.shift()!.range));
                currentValueRange = sym.range;
            } else {
                currentProperty = sym.name;
                currentValue = properties[currentProperty];
                currentValueRange = document.getWordRangeAtPosition(sym.range.end)!;
            }
            if (typeof currentValue === 'string') {
                currentValueRange = new Range(currentValueRange.start.translate(0, 1), currentValueRange.end.translate(0, -1));
            }
        }
        return {
            completionType: completionType,
            currentProperty: currentProperty,
            currentValue: currentValue,
            currentValueRange: currentValueRange,
            hoverRange: document.getWordRangeAtPosition(position),
            properties: properties,
            objectPath: symbolPath.slice(1).map(v => v.name)
        };
    }

    protected getInsertText(options: CompletionItemOptions) {
        if ('value' in options) {
            if (typeof options.value === 'string') {
                let str = new SnippetString();
                str.appendText(JSON.stringify(options.value).slice(0, -1));
                str.appendTabstop();
                str.appendText('"');
                return str;
            } else {
                return JSON.stringify(options.value);
            }
        } else {
            let { name, defaultValue } = options;
            let str = new SnippetString();
            str.appendText(`"${name}": `);
            if (defaultValue !== undefined) {
                if (Array.isArray(defaultValue)) {
                    this.appendArrayPlaceholders(str, defaultValue, JSON.stringify, '[', ', ', ']');
                } else if (typeof defaultValue === 'string') {
                    str.appendText('"');
                    str.appendPlaceholder(JSON.stringify(defaultValue).slice(1, -1));
                    str.appendText('"');
                } else {
                    str.appendPlaceholder(String(defaultValue));
                }
            }
            return str;
        }
    }

    protected getCompletionTriggerCharacters() {
        return this.completionType === CompletionType.Value ? JSONCompletionHandler.TRIGGER_VALUE : JSONCompletionHandler.TRIGGER_PROP;
    }

    protected onDidCreateCompletionItem(item: CompletionItem) {
        // JSON document provider includes double quote ('"') characters when matching words
        item.filterText = (typeof this.currentValue === 'string' || this.completionContext?.triggerCharacter === '"' ? '"' : '') + item.label.toString();
    }

    private getContainingSymbols(symbols: readonly DocumentSymbol[], position: Position) {
        let result = [];
        let arr = [...symbols];
        while (arr.length) {
            for (let symbol of arr.splice(0)) {
                if (symbol.range.contains(position)) {
                    result.unshift(symbol);
                    arr = [...symbol.children];
                    break;
                }
            }
        }
        return result;
    }

    private createObject(document: TextDocument, symbols: readonly DocumentSymbol[]) {
        let rawData = Object.fromEntries(symbols.map(v => [v.name, v]));
        let getValue = (sym: DocumentSymbol): any => {
            switch (sym.kind) {
                case SymbolKind.Object:
                    return this.createObject(document, sym.children);
                case SymbolKind.Array:
                    return sym.children.map(getValue);
                case SymbolKind.Boolean:
                    return (sym.detail || document.getText(sym.range)) === 'true';
                case SymbolKind.Number:
                    return +(sym.detail || document.getText(sym.range));
                case SymbolKind.String:
                    return sym.range.isEqual(sym.selectionRange) ? parseJSON(document.getText(sym.range)) : sym.detail;
                case SymbolKind.Null:
                    return null;
            }
        };
        return this.createLazyUnserializedObject(rawData, {}, getValue);
    }
}
