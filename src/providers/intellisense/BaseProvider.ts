import * as vscode from "vscode";
import { CompletionItemProvider, Disposable, GlobPattern, TextDocument, Position, CancellationToken, CompletionContext, HoverProvider, Hover, ProviderResult, MarkdownString } from "vscode";
import { writeMessage } from "../../util";
import { CompletionHandler, CompletionHandlerConstructor, CompletionState, CompletionType, PropertyCompletionItemProps, ValueCompletionItemProps } from "./CompletionHandler";

export default abstract class BaseProvider implements HoverProvider, CompletionItemProvider, Disposable {
    private readonly handlerClasses: CompletionHandlerConstructor[];
    private readonly disposables: Disposable[] = [];

    protected static triggerCharacters: readonly string[] = [];

    constructor(patterns: GlobPattern[], ...handlerClasses: CompletionHandlerConstructor[]) {
        this.handlerClasses = handlerClasses;
        for (let pattern of patterns) {
            this.disposables.push(
                vscode.languages.registerCompletionItemProvider({ pattern }, this, ...(this.constructor as typeof BaseProvider).triggerCharacters),
                vscode.languages.registerHoverProvider({ pattern }, this)
            );
        }
    }

    dispose() {
        this.disposables.forEach(v => v.dispose());
    }

    canHandle(document: TextDocument) {
        return true;
    }

    provideHover(document: TextDocument, position: Position, token: CancellationToken) {
        if (this.canHandle(document)) {
            return this.withHandler([document, position], async (handler) => {
                if (!token.isCancellationRequested && handler.hoverRange?.contains(position)) {
                    let contents = await this.resolveHoverContents(handler);
                    if (contents) {
                        return new Hover(contents, handler.hoverRange);
                    }
                }
            });
        }
    }

    provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext) {
        if (this.canHandle(document)) {
            return this.withHandler([document, position, context], async (handler) => {
                if (handler.shouldTriggerCompletion && !token.isCancellationRequested) {
                    switch (handler.completionType) {
                        case CompletionType.Property:
                            let properties = (await this.resolvePropertyCompletions(handler) || []).map(v => {
                                return typeof v !== 'object' ? { name: v } : v;
                            });
                            return properties.filter(v => !(v.name in handler.properties) || v.name === handler.currentProperty).map(v => handler.createPropertyCompletionItem(v));
                        case CompletionType.Value:
                            let currentProperty = handler.currentProperty!;
                            let currentValue = handler.properties[currentProperty];
                            let values = (await this.resolveValueCompletions(handler) || []).map(v => {
                                return typeof v !== 'object' ? { value: v } : v;
                            });
                            if (Array.isArray(currentValue) && !handler.currentValue) {
                                // remove candidates that already exists in the array
                                // when user is inputting a new element
                                values = values.filter(v => !currentValue.includes(v.value));
                            }
                            return values.map(v => handler.createValueCompletionItem(v));
                    }
                }
            });
        }
    }

    protected abstract resolveHoverContents(state: CompletionState): ProviderResult<MarkdownString | MarkdownString[]>;

    protected abstract resolvePropertyCompletions(state: CompletionState): ProviderResult<readonly (string | PropertyCompletionItemProps)[]>;

    protected abstract resolveValueCompletions(state: CompletionState): ProviderResult<readonly (string | number | boolean | ValueCompletionItemProps)[]>;

    private async withHandler<T>(args: Parameters<(typeof CompletionHandler)['create']>, callback: (handler: CompletionHandler) => Promise<T>) {
        try {
            let ctor = this.handlerClasses.find(v => v.canHandle(args[0]));
            return ctor && callback(await ctor.create(...args));
        } catch (err: any) {
            writeMessage(`[ERROR] Unable to invoke code completion: ${err?.message}`);
        }
    }
}
