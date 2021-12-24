import { CompletionContext, CompletionItem, CompletionItemKind, Position, ProviderResult, Range, SnippetString, TextDocument } from "vscode";

const freezedArray = Object.freeze([]);
const freezedObject = Object.freeze({});
const triggerSuggestCommand = Object.freeze({ command: 'editor.action.triggerSuggest', title: '' });

type CompletionItemProps = Omit<CompletionItem, 'label'>;

export type CompletionHandlerConstructor = typeof CompletionHandler;
export type PropertyCompletionItemProps = CompletionItemProps & PropertyCompletionProps;
export type ValueCompletionItemProps = CompletionItemProps & ValueCompletionProps;
export type CompletionItemOptions = PropertyCompletionProps | ValueCompletionProps;
export type InitializeResult = { -readonly [P in Exclude<keyof CompletionState, 'document' | 'position' | 'currentValueLeftText'>]?: CompletionState[P] };

export enum CompletionType {
    None,
    Property,
    Value
}

export interface CompletionState {
    readonly document: TextDocument;
    readonly position: Position;
    readonly completionType: CompletionType;
    readonly currentProperty?: string;
    readonly currentValue?: any;
    readonly currentValueRange?: Range;
    readonly currentValueLeftText?: string;
    readonly hoverRange?: Range;
    readonly properties: Readonly<Record<string, any>>;
    readonly objectPath: readonly string[];
}

interface PropertyCompletionProps {
    name: string;
    defaultValue?: any;
}

interface ValueCompletionProps {
    value: any;
}

export abstract class CompletionHandler implements CompletionState {
    readonly completionType: CompletionType = 0;
    readonly currentProperty?: string;
    readonly currentValue?: any;
    readonly currentValueRange?: Range;
    readonly hoverRange?: Range;
    readonly properties: Readonly<Record<string, any>> = freezedObject;
    readonly objectPath: readonly string[] = freezedArray;

    protected constructor(
        public readonly document: TextDocument,
        public readonly position: Position,
        public readonly completionContext?: CompletionContext
    ) { }

    static canHandle(document: TextDocument) {
        return false;
    }

    static async create(document: TextDocument, position: Position, completionContext?: CompletionContext) {
        let handler = new (this as any as new (...args: any) => CompletionHandler)(document, position, completionContext);
        let state = await handler.initialize(document, position);
        Object.assign(handler, state);
        return handler;
    }

    get currentValueLeftText() {
        return this.lazyInit('currentValueLeftText', () => {
            return this.currentValueRange && this.document.getText(new Range(this.currentValueRange.start, this.position));
        });
    }

    get shouldTriggerCompletion() {
        return this.lazyInit('shouldTriggerCompletion', () => {
            return !!this.completionType && (!this.completionContext?.triggerCharacter || this.getCompletionTriggerCharacters().includes(this.completionContext.triggerCharacter));
        });
    }

    createPropertyCompletionItem(options: PropertyCompletionItemProps) {
        let { name, defaultValue, ...props } = options;
        let item = new CompletionItem(options.name, CompletionItemKind.Property);
        item.insertText = this.getInsertText(options);
        item.preselect = name === this.currentProperty;
        item.command = triggerSuggestCommand;
        this.onDidCreateCompletionItem(Object.assign(item, props), CompletionType.Property);
        return item;
    }

    createValueCompletionItem(options: ValueCompletionItemProps) {
        let { value, ...props } = options;
        let item = new CompletionItem(String(options.value), CompletionItemKind.Value);
        item.insertText = this.getInsertText(options);
        item.preselect = value === this.currentValue;
        this.onDidCreateCompletionItem(Object.assign(item, props), CompletionType.Value);
        return item;
    }

    protected abstract initialize(document: TextDocument, position: Position): ProviderResult<InitializeResult>;

    protected abstract getInsertText(options: CompletionItemOptions): string | SnippetString | undefined;

    protected abstract getCompletionTriggerCharacters(): readonly string[];

    protected onDidCreateCompletionItem(item: CompletionItem, type: CompletionType) { }

    protected appendArrayPlaceholders(str: SnippetString, values: any[], formatter: (v: any) => string, start = '[', separator = ',', end = ']') {
        str.appendText(start);
        if (values.length) {
            let i = 0;
            for (let v of values) {
                if (i++) {
                    str.appendText(separator);
                }
                str.appendPlaceholder(formatter(v));
            }
        } else {
            str.appendTabstop();
        }
        str.appendText(end);
    }

    protected createLazyUnserializedObject<T, V>(rawData: Record<string, T>, parsedData: Record<string, V>, parser: (v: T) => V) {
        return new Proxy(parsedData, {
            ownKeys() {
                return Reflect.ownKeys(rawData);
            },
            has(target, p) {
                return Reflect.has(rawData, p);
            },
            get(target, p) {
                if (typeof p === 'string') {
                    if (!(p in target) && p in rawData) {
                        target[p] = parser(rawData[p]);
                    }
                    return target[p];
                }
            },
            set() {
                return false;
            },
            defineProperty() {
                return false;
            },
            deleteProperty() {
                return false;
            }
        });
    }

    private lazyInit<T>(prop: string, callback: () => T) {
        let value = callback();
        Object.defineProperty(this, prop, { value });
        return value;
    }
}
