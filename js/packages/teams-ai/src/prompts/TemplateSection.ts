import { Message, PromptFunctions, RenderedPromptSection } from "./types";
import { PromptSectionBase } from "./PromptSectionBase";
import { Utilities } from "../Utilities";
import { TurnContext } from 'botbuilder';
import { TurnState } from '../TurnState';
import { Tokenizer } from "../ai";

/**
 * A template section that will be rendered as a message.
 * @remarks
 * This section type is used to render a template as a message. The template can contain
 * parameters that will be replaced with values from memory or call functions to generate
 * dynamic content.
 *
 * Template syntax:
 * - `{{$memoryKey}}` - Renders the value of the specified memory key.
 * - `{{functionName}}` - Calls the specified function and renders the result.
 * - `{{functionName arg1 arg2 ...}}` - Calls the specified function with the provided list of arguments.
 *
 * Function arguments are optional and separated by spaces. They can be quoted using `'`, `"`, or `\`` delimiters.
 */
export class TemplateSection<TState extends TurnState = TurnState> extends PromptSectionBase<TState> {
    private _parts: PartRenderer<TState>[] = [];

    public readonly template: string;
    public readonly role: string;

    /**
     * Creates a new 'TemplateSection' instance.
     * @param template Template to use for this section.
     * @param role Message role to use for this section.
     * @param tokens Optional. Sizing strategy for this section. Defaults to `auto`.
     * @param required Optional. Indicates if this section is required. Defaults to `true`.
     * @param separator Optional. Separator to use between sections when rendering as text. Defaults to `\n`.
     * @param textPrefix Optional. Prefix to use for text output. Defaults to `undefined`.
     */
    public constructor(template: string, role: string, tokens: number = -1, required: boolean = true, separator: string = '\n', textPrefix?: string) {
        super(tokens, required, separator, textPrefix);
        this.template = template;
        this.role = role;
        this.parseTemplate();
    }

    public async renderAsMessages(context: TurnContext, state: TState, functions: PromptFunctions<TState>, tokenizer: Tokenizer, maxTokens: number): Promise<RenderedPromptSection<Message[]>> {
        // Render parts in parallel
        const renderedParts = await Promise.all(this._parts.map((part) => part(context, state, functions, tokenizer, maxTokens)));

        // Join all parts
        const text = renderedParts.join('');
        const length = tokenizer.encode(text).length;

        // Return output
        const messages: Message<string>[] = length > 0 ? [{ role: this.role, content: text }] : [];
        return this.returnMessages(messages, length, tokenizer, maxTokens);
    }

    private parseTemplate(): void {
        // Parse template
        let part = '';
        let state = ParseState.inText;
        let stringDelim = '';
        for (let i = 0; i < this.template.length; i++) {
            const char = this.template[i];
            switch (state) {
                case ParseState.inText:
                    if (char === '{' && this.template[i + 1] === '{') {
                        if (part.length > 0) {
                            this._parts.push(this.createTextRenderer(part));
                            part = '';
                        }

                        state = ParseState.inParameter;
                        i++;
                    } else {
                        part += char;
                    }
                    break;
                case ParseState.inParameter:
                    if (char === '}' && this.template[i + 1] === '}') {
                        if (part.length > 0) {
                            if (part[0] === '$') {
                                this._parts.push(this.createVariableRenderer(part.substring(1)));
                            } else {
                                this._parts.push(this.createFunctionRenderer(part));
                            }
                            part = '';
                        }

                        state = ParseState.inText;
                        i++;
                    } else if (["'", '"', '`'].includes(char)) {
                        stringDelim = char;
                        state = ParseState.inString;
                        part += char;
                    } else {
                        part += char;
                    }
                    break;
                case ParseState.inString:
                    part += char;
                    if (char === stringDelim) {
                        state = ParseState.inParameter;
                    }
                    break;
            }
        }

        // Ensure we ended in the correct state
        if (state !== ParseState.inText) {
            throw new Error(`Invalid template: ${this.template}`);
        }

        // Add final part
        if (part.length > 0) {
            this._parts.push(this.createTextRenderer(part));
        }
    }

    private createTextRenderer(text: string): PartRenderer<TState> {
        return (context: TurnContext, state: TState, functions: PromptFunctions<TState>, tokenizer: Tokenizer, maxTokens: number): Promise<string> => {
            return Promise.resolve(text);
        };
    }

    private createVariableRenderer(name: string): PartRenderer<TState> {
        return (context: TurnContext, state: TState, functions: PromptFunctions<TState>, tokenizer: Tokenizer, maxTokens: number): Promise<string> => {
            const value = state.getValue(name);
            return Promise.resolve(Utilities.toString(tokenizer, value));
        };
    }

    private createFunctionRenderer(param: string): PartRenderer<TState> {
        let name = '';
        let args: string[] = [];
        function savePart() {
            if (part.length > 0) {
                if (!name) {
                    name = part;
                } else {
                    args.push(part);
                }
                part = '';
            }
        }

        // Parse function name and args
        let part = '';
        let state = ParseState.inText;
        let stringDelim = '';
        for (let i = 0; i < param.length; i++) {
            const char = param[i];
            switch (state) {
                case ParseState.inText:
                    if (["'", '"', '`'].includes(char)) {
                        savePart();
                        stringDelim = char;
                        state = ParseState.inString;
                    } else if (char == ' ') {
                        savePart();
                    } else {
                        part += char;
                    }
                    break;
                case ParseState.inString:
                    if (char === stringDelim) {
                        savePart();
                        state = ParseState.inText;
                    } else {
                        part += char;
                    }
                    break;
            }
        }

        // Add final part
        savePart();

        // Return renderer
        return async (context: TurnContext, state: TState, functions: PromptFunctions<TState>, tokenizer: Tokenizer, maxTokens: number): Promise<string> => {
            const value = await functions.invokeFunction(name, context, state, tokenizer, args);
            return Utilities.toString(tokenizer, value);
        };
    }
}

type PartRenderer<TState extends TurnState> = (context: TurnContext, state: TState, functions: PromptFunctions<TState>, tokenizer: Tokenizer, maxTokens: number) => Promise<string>;

enum ParseState {
    inText,
    inParameter,
    inString
}