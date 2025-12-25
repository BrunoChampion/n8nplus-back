import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { N8nService } from '../n8n/n8n.service';
import { NodeIndexService } from './node-index.service';
import { SettingsService } from '../settings.service';
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { Subject } from 'rxjs';

export interface AgentStatus {
    type: 'thinking' | 'tool_call' | 'tool_result' | 'responding' | 'complete' | 'error';
    message: string;
    toolName?: string;
    toolArgs?: any;
    timestamp: number;
}

@Injectable()
export class AiAgentService {
    private readonly logger = new Logger(AiAgentService.name);
    private model: ChatGoogleGenerativeAI;
    
    // Subject to emit status updates
    public statusSubject = new Subject<AgentStatus>();
    
    // Track consecutive workflow validation failures to prevent infinite loops
    private workflowValidationFailures = 0;
    private readonly MAX_VALIDATION_FAILURES = 3;

    constructor(
        private configService: ConfigService,
        private n8nService: N8nService,
        private nodeIndexService: NodeIndexService,
        private settingsService: SettingsService,
    ) {
        this.initModel();
    }

    private emitStatus(status: Omit<AgentStatus, 'timestamp'>) {
        const fullStatus: AgentStatus = { ...status, timestamp: Date.now() };
        this.statusSubject.next(fullStatus);
        
        // Also log to console
        const logPrefix = `[${status.type.toUpperCase()}]`;
        if (status.toolName) {
            this.logger.log(`${logPrefix} ${status.message} - Tool: ${status.toolName}`);
            if (status.toolArgs) {
                this.logger.debug(`Tool args: ${JSON.stringify(status.toolArgs, null, 2)}`);
            }
        } else {
            this.logger.log(`${logPrefix} ${status.message}`);
        }
    }

    private async initModel() {
        const dbApiKey = await this.settingsService.get('GEMINI_API_KEY');
        const dbModel = await this.settingsService.get('MODEL_NAME');

        const apiKey = dbApiKey || this.configService.get<string>('GEMINI_API_KEY');
        const modelName = dbModel || this.configService.get<string>('MODEL_NAME', 'gemini-2.0-flash');

        if (!apiKey) {
            this.logger.warn('GEMINI_API_KEY is not set');
            return;
        }

        this.model = new ChatGoogleGenerativeAI({
            apiKey: apiKey,
            model: modelName,
            temperature: 0.3, // Lower temperature for more reliable tool calling
            maxRetries: 2,
        });
    }

    async runAgent(input: string, chatHistory: any[] = []) {
        await this.initModel();

        const tools = this.createTools();
        const wrappedTools = this.wrapToolsWithStatus(tools);
        const toolNode = new ToolNode(wrappedTools);
        const modelWithTools = this.model.bindTools(wrappedTools);

        // Node to call the model
        const callModel = async (state: typeof MessagesAnnotation.State) => {
            this.emitStatus({
                type: 'thinking',
                message: 'AI is analyzing and planning next steps...',
            });
            
            const response = await modelWithTools.invoke(state.messages);
            
            // Check if it's making tool calls or responding
            const toolCalls = (response as any).tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                const toolNames = toolCalls.map((tc: any) => tc.name).join(', ');
                this.emitStatus({
                    type: 'thinking',
                    message: `Deciding to use tools: ${toolNames}`,
                });
            } else {
                this.emitStatus({
                    type: 'responding',
                    message: 'Generating response...',
                });
            }
            
            return { messages: [response] };
        };

        // Conditional function to decide whether to continue or end
        const shouldContinue = (state: typeof MessagesAnnotation.State) => {
            const lastMessage = state.messages[state.messages.length - 1];
            if (lastMessage && (lastMessage as any).tool_calls?.length > 0) {
                return "tools";
            }
            return END;
        };

        // Build the graph
        const workflow = new StateGraph(MessagesAnnotation)
            .addNode("agent", callModel)
            .addNode("tools", toolNode)
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue)
            .addEdge("tools", "agent");

        const app = workflow.compile();

        try {
            this.emitStatus({
                type: 'thinking',
                message: 'Starting to process your request...',
            });
            
            const systemMessage = new SystemMessage(this.getSystemPrompt());

            const messages: BaseMessage[] = [
                systemMessage,
                ...chatHistory.map(m => m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)),
                new HumanMessage(input)
            ];

            this.logger.log(`Processing message: "${input.substring(0, 100)}${input.length > 100 ? '...' : ''}"`);
            
            const result = await app.invoke({ messages }, { recursionLimit: 50 });
            const lastMessage = result.messages[result.messages.length - 1];
            
            // Log the response for debugging
            const responseContent = lastMessage.content;
            const responsePreview = typeof responseContent === 'string' 
                ? responseContent.substring(0, 200) 
                : JSON.stringify(responseContent).substring(0, 200);
            this.logger.log(`Response preview: "${responsePreview}${responsePreview.length >= 200 ? '...' : ''}"`);
            
            this.emitStatus({
                type: 'complete',
                message: 'Response ready',
            });
            
            return lastMessage.content;
        } catch (error) {
            this.emitStatus({
                type: 'error',
                message: `Error: ${error.message}`,
            });
            this.logger.error(`Agent execution failed: ${error.message}`);
            throw error;
        }
    }

    async runAgentStreaming(input: string, chatHistory: any[] = [], onToken: (token: string) => void) {
        await this.initModel();

        const tools = this.createTools();
        const wrappedTools = this.wrapToolsWithStatus(tools);
        const toolNode = new ToolNode(wrappedTools);
        const modelWithTools = this.model.bindTools(wrappedTools);

        // Track if we've shown the initial thinking message
        let hasShownInitialThinking = false;

        const callModel = async (state: typeof MessagesAnnotation.State) => {
            // Only emit 'thinking' status on the FIRST call, ignore subsequent ones
            if (!hasShownInitialThinking) {
                hasShownInitialThinking = true;
                this.emitStatus({
                    type: 'thinking',
                    message: 'AI is analyzing your request...',
                });
            }
            // Don't emit any more thinking statuses - let tool events take over
            
            const response = await modelWithTools.invoke(state.messages);
            return { messages: [response] };
        };

        const shouldContinue = (state: typeof MessagesAnnotation.State) => {
            const lastMessage = state.messages[state.messages.length - 1];
            if (lastMessage && (lastMessage as any).tool_calls?.length > 0) {
                return "tools";
            }
            return END;
        };

        const workflow = new StateGraph(MessagesAnnotation)
            .addNode("agent", callModel)
            .addNode("tools", toolNode)
            .addEdge(START, "agent")
            .addConditionalEdges("agent", shouldContinue)
            .addEdge("tools", "agent");

        const app = workflow.compile();

        try {
            // Initial status will be emitted by callModel on first invocation
            const systemMessage = new SystemMessage(this.getSystemPrompt());

            const messages: BaseMessage[] = [
                systemMessage,
                ...chatHistory.map(m => m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)),
                new HumanMessage(input)
            ];
            
            // Track the initial message count so we can skip old messages in fallback
            const initialMessageCount = messages.length;

            this.logger.log(`Processing message (streaming): "${input.substring(0, 100)}${input.length > 100 ? '...' : ''}"`);
            this.logger.log(`Initial message count (for fallback): ${initialMessageCount}`);
            
            let finalResponse = '';
            let toolCallCount = 0;
            let hasStartedGenerating = false;
            
            // Track tool calls and results for forced response generation
            const toolCallSummaries: string[] = [];
            
            // Use streamEvents to get token-by-token streaming
            const eventStream = app.streamEvents(
                { messages },
                { version: 'v2', recursionLimit: 50 }
            );

            for await (const event of eventStream) {
                // Debug: Log all event types we're receiving
                if (!['on_chat_model_stream', 'on_chain_start', 'on_chain_end'].includes(event.event)) {
                    this.logger.debug(`[EVENT] ${event.event} - name: ${event.name}`);
                }
                
                // Handle tool start events
                if (event.event === 'on_tool_start') {
                    toolCallCount++;
                    const toolName = event.name || 'unknown';
                    const toolInput = event.data?.input;
                    this.logger.log(`[TOOL START #${toolCallCount}] ${toolName}`);
                    if (toolInput) {
                        this.logger.debug(`Tool input: ${JSON.stringify(toolInput).substring(0, 200)}`);
                    }
                    
                    // Create user-friendly message based on tool name
                    let friendlyMessage = `Using ${toolName}`;
                    if (toolName === 'search_nodes') {
                        friendlyMessage = `Searching for nodes: "${toolInput?.query || ''}"`;
                    } else if (toolName === 'get_node_details') {
                        friendlyMessage = `Getting details for: ${toolInput?.nodeType || ''}`;
                    } else if (toolName === 'get_node_parameters') {
                        friendlyMessage = `Fetching parameters for: ${toolInput?.nodeType || ''}`;
                    } else if (toolName === 'create_workflow') {
                        friendlyMessage = `Creating workflow: "${toolInput?.name || ''}"`;
                    } else if (toolName === 'update_workflow') {
                        friendlyMessage = `Updating workflow...`;
                    } else if (toolName === 'list_workflows') {
                        friendlyMessage = `Listing workflows...`;
                    } else if (toolName === 'get_workflow') {
                        friendlyMessage = `Fetching workflow details...`;
                    }
                    
                    this.emitStatus({
                        type: 'tool_call',
                        message: friendlyMessage,
                        toolName: toolName,
                        toolArgs: toolInput,
                    });
                }
                
                // Handle tool end events - capture summaries for forced response
                if (event.event === 'on_tool_end') {
                    const toolName = event.name || 'unknown';
                    const output = event.data?.output;
                    const outputPreview = typeof output === 'string' 
                        ? output.substring(0, 150) 
                        : JSON.stringify(output).substring(0, 150);
                    this.logger.log(`[TOOL END] ${toolName} - Output: ${outputPreview}...`);
                    
                    // Capture tool result summary for potential forced response
                    let resultSummary = '';
                    if (output?.kwargs?.content) {
                        const content = output.kwargs.content;
                        if (typeof content === 'string') {
                            // For workflow creation, capture the result
                            if (content.includes('Workflow created successfully')) {
                                resultSummary = content.substring(0, 500);
                            } else if (content.includes('ERROR:')) {
                                resultSummary = `${toolName} failed: ${content.substring(0, 200)}`;
                            } else {
                                resultSummary = `${toolName} completed`;
                            }
                        }
                    }
                    if (resultSummary) {
                        toolCallSummaries.push(resultSummary);
                    }
                }
                
                // Stream tokens from the LLM
                if (event.event === 'on_chat_model_stream') {
                    const chunk = event.data?.chunk;
                    
                    // Log what we're receiving for debugging
                    if (chunk) {
                        this.logger.debug(`[STREAM CHUNK] content type: ${typeof chunk.content}, has content: ${!!chunk.content}`);
                    }
                    
                    if (chunk?.content) {
                        // Show "generating response" on first token of final response
                        if (!hasStartedGenerating && toolCallCount > 0) {
                            hasStartedGenerating = true;
                            this.emitStatus({
                                type: 'responding',
                                message: 'Generating response...',
                            });
                        }
                        
                        if (typeof chunk.content === 'string' && chunk.content.length > 0) {
                            onToken(chunk.content);
                            finalResponse += chunk.content;
                        } else if (Array.isArray(chunk.content)) {
                            for (const part of chunk.content) {
                                if (typeof part === 'string' && part.length > 0) {
                                    onToken(part);
                                    finalResponse += part;
                                } else if (part?.text && part.text.length > 0) {
                                    onToken(part.text);
                                    finalResponse += part.text;
                                } else if (part?.type === 'text' && part?.text) {
                                    onToken(part.text);
                                    finalResponse += part.text;
                                }
                            }
                        }
                    }
                }
                
                // Also capture on_llm_stream events (alternative streaming format)
                if (event.event === 'on_llm_stream') {
                    const chunk = event.data?.chunk;
                    if (chunk?.text) {
                        if (!hasStartedGenerating && toolCallCount > 0) {
                            hasStartedGenerating = true;
                            this.emitStatus({
                                type: 'responding',
                                message: 'Generating response...',
                            });
                        }
                        onToken(chunk.text);
                        finalResponse += chunk.text;
                    }
                }
                
                // Capture the final message content from on_chat_model_end if streaming didn't work
                if (event.event === 'on_chat_model_end') {
                    this.logger.debug(`Model response completed`);
                    
                    const output = event.data?.output;
                    
                    // Log detailed output structure for debugging
                    this.logger.debug(`[on_chat_model_end] output keys: ${output ? Object.keys(output).join(', ') : 'null'}`);
                    this.logger.debug(`[on_chat_model_end] has content: ${!!output?.content}, content type: ${typeof output?.content}`);
                    this.logger.debug(`[on_chat_model_end] has tool_calls: ${!!output?.tool_calls}, tool_calls length: ${output?.tool_calls?.length || 0}`);
                    
                    // Log the actual content for debugging
                    if (output?.content) {
                        if (typeof output.content === 'object') {
                            this.logger.debug(`[on_chat_model_end] content object: ${JSON.stringify(output.content).substring(0, 500)}`);
                        }
                    }
                    
                    if (output?.content) {
                        let content = '';
                        if (typeof output.content === 'string') {
                            content = output.content;
                        } else if (Array.isArray(output.content)) {
                            for (const part of output.content) {
                                if (typeof part === 'string') {
                                    content += part;
                                } else if (part?.text) {
                                    content += part.text;
                                } else if (part?.type === 'text' && part?.text) {
                                    content += part.text;
                                }
                            }
                        } else if (typeof output.content === 'object' && output.content !== null) {
                            // Handle object content - might be {text: "..."} or similar
                            if (output.content.text) {
                                content = output.content.text;
                            }
                        }
                        
                        this.logger.debug(`[on_chat_model_end] extracted content length: ${content.length}`);
                        
                        // Capture if there's actual text content (not just tool calls)
                        // Also capture even if there are tool calls, as long as there's text too
                        if (content.length > 0 && (!output.tool_calls || output.tool_calls.length === 0)) {
                            this.logger.log(`[FALLBACK] Capturing response (${content.length} chars) from on_chat_model_end`);
                            
                            if (!hasStartedGenerating) {
                                hasStartedGenerating = true;
                                this.emitStatus({
                                    type: 'responding',
                                    message: 'Generating response...',
                                });
                            }
                            
                            // Append to final response (don't replace, in case we got partial content before)
                            if (finalResponse === '') {
                                onToken(content);
                                finalResponse = content;
                            }
                        }
                    }
                }
                
                // Also try to capture from on_chain_end for LangGraph
                if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
                    this.logger.log(`[LANGGRAPH] Workflow completed. Total tool calls: ${toolCallCount}`);
                    
                    // Try to extract final response from chain output
                    const output = event.data?.output;
                    if (output?.messages && finalResponse === '') {
                        // Find the last AI message that is NEW (not from initial chat history)
                        const allMessages = output.messages;
                        this.logger.log(`[LANGGRAPH FALLBACK] Total messages: ${allMessages.length}, initial: ${initialMessageCount}`);
                        
                        // Only search messages AFTER the initial input messages
                        for (let i = allMessages.length - 1; i >= initialMessageCount; i--) {
                            const msg = allMessages[i];
                            // Check if it's an AI message with content
                            if (msg?.content && (msg?.type === 'ai' || msg?.constructor?.name === 'AIMessage' || msg?.lc_id?.includes('AIMessage'))) {
                                let content = '';
                                if (typeof msg.content === 'string') {
                                    content = msg.content;
                                } else if (Array.isArray(msg.content)) {
                                    for (const part of msg.content) {
                                        if (typeof part === 'string') content += part;
                                        else if (part?.text) content += part.text;
                                    }
                                } else if (typeof msg.content === 'object' && msg.content !== null) {
                                    // Handle object content
                                    if (msg.content.text) content = msg.content.text;
                                }
                                
                                this.logger.log(`[LANGGRAPH FALLBACK] Checking msg ${i}: content length ${content.length}, tool_calls: ${msg.tool_calls?.length || 0}`);
                                
                                // Only use if it has actual content and isn't just tool calls
                                if (content.length > 0 && (!msg.tool_calls || msg.tool_calls.length === 0)) {
                                    this.logger.log(`[LANGGRAPH FALLBACK] Found final AI response in messages (${content.length} chars)`);
                                    this.logger.log(`[LANGGRAPH FALLBACK] Content preview: "${content.substring(0, 100)}..."`);
                                    this.emitStatus({
                                        type: 'responding',
                                        message: 'Generating response...',
                                    });
                                    this.logger.log(`[LANGGRAPH FALLBACK] Calling onToken now...`);
                                    onToken(content);
                                    this.logger.log(`[LANGGRAPH FALLBACK] onToken called successfully`);
                                    finalResponse = content;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            
            this.logger.log(`[STREAMING COMPLETE] Total tool calls made: ${toolCallCount}`);
            this.logger.log(`[STREAMING COMPLETE] Final response length: ${finalResponse.length}`);
            
            if (finalResponse.length === 0 && toolCallCount > 0) {
                this.logger.warn('[WARNING] Model completed tool calls but did not produce a final text response. Forcing a summary response...');
                this.logger.log(`[TOOL SUMMARIES] ${toolCallSummaries.length} summaries collected`);
                
                // Force the model to generate a response by making a direct call
                try {
                    this.emitStatus({
                        type: 'responding',
                        message: 'Generating summary...',
                    });
                    
                    // Build context from tool summaries
                    const summaryContext = toolCallSummaries.length > 0 
                        ? `\n\nTool results:\n${toolCallSummaries.join('\n')}`
                        : '';
                    
                    const forceResponsePrompt = new HumanMessage(
                        `The user asked: "${input.substring(0, 500)}"\n\n` +
                        `You made ${toolCallCount} tool calls to help answer this.${summaryContext}\n\n` +
                        "Now provide a helpful text response to the user summarizing what you found or did. " +
                        "If you created a workflow, mention it. If you searched for nodes, summarize the key findings. " +
                        "Be concise but informative."
                    );
                    
                    // Make a direct call without tools to force text output
                    const forcedResponse = await this.model.invoke([
                        new SystemMessage("You are an n8n workflow assistant. Summarize what was accomplished based on the tool calls. Be helpful and concise."),
                        forceResponsePrompt
                    ]);
                    
                    let forcedContent = '';
                    if (typeof forcedResponse.content === 'string') {
                        forcedContent = forcedResponse.content;
                    } else if (Array.isArray(forcedResponse.content)) {
                        for (const part of forcedResponse.content) {
                            if (typeof part === 'string') forcedContent += part;
                            else if (part?.text) forcedContent += part.text;
                        }
                    }
                    
                    if (forcedContent.length > 0) {
                        this.logger.log(`[FORCED RESPONSE] Got ${forcedContent.length} chars`);
                        onToken(forcedContent);
                        finalResponse = forcedContent;
                    } else {
                        // Still no response, use fallback
                        const fallbackMessage = "I completed researching your request but encountered an issue generating a summary. The tool calls were successful - please check the workflow list or try asking again.";
                        onToken(fallbackMessage);
                        finalResponse = fallbackMessage;
                    }
                } catch (forceError) {
                    this.logger.error(`[FORCED RESPONSE ERROR] ${forceError.message}`);
                    const fallbackMessage = "I completed processing your request but had trouble generating a summary. Please check if any workflows were created or try asking again.";
                    onToken(fallbackMessage);
                    finalResponse = fallbackMessage;
                }
            } else if (finalResponse.length === 0) {
                this.logger.warn('[WARNING] No response content was streamed and no tool calls were made!');
                
                // Provide a fallback message to the user
                const fallbackMessage = "I apologize, but I wasn't able to generate a response. Could you please try asking again?";
                onToken(fallbackMessage);
                finalResponse = fallbackMessage;
            }
            
            if (toolCallCount === 0) {
                this.logger.warn('[WARNING] No tool calls were made during this request!');
            }
            
            this.emitStatus({
                type: 'complete',
                message: 'Response ready',
            });
            
            return finalResponse;
        } catch (error) {
            this.emitStatus({
                type: 'error',
                message: `Error: ${error.message}`,
            });
            this.logger.error(`Agent streaming execution failed: ${error.message}`);
            throw error;
        }
    }

    private createTools() {
        return [
            // ==========================================
            // NODE DISCOVERY & INFORMATION TOOLS
            // ==========================================
            new DynamicStructuredTool({
                name: "search_nodes",
                description: `Search for n8n nodes by name, description, or common aliases. 
Returns a compact list with: type (exact identifier needed for workflows), displayName, description, and credential requirements.
ALWAYS use this first to find the correct node type before creating workflows.
Examples: search for "gmail", "http", "slack", "webhook", "schedule", "database"`,
                schema: z.object({
                    query: z.string().describe("Search term (node name, alias, or description keyword)"),
                    limit: z.number().optional().describe("Max results (default: 5)")
                }),
                func: async ({ query, limit }) => {
                    const results = await this.nodeIndexService.searchNodes(query, limit || 5);
                    if (results.length === 0) {
                        return `No nodes found matching "${query}". Try a different search term.`;
                    }
                    return JSON.stringify(results, null, 2);
                },
            }),

            new DynamicStructuredTool({
                name: "get_node_details",
                description: `Get detailed information about a specific node type including:
- All available resources and operations
- Required and optional parameters with their types
- Credential requirements
- Parameter options and defaults
Use this BEFORE creating or updating a node to understand its exact configuration.`,
                schema: z.object({
                    nodeType: z.string().describe("The exact node type (e.g., 'n8n-nodes-base.gmail') or common name (e.g., 'gmail')")
                }),
                func: async ({ nodeType }) => {
                    const details = await this.nodeIndexService.getNodeDetails(nodeType);
                    if (!details) {
                        return `Node "${nodeType}" not found. Use search_nodes to find the correct type.`;
                    }
                    
                    const response: any = {
                        type: details.type,
                        displayName: details.displayName,
                        version: details.version,
                        isTrigger: details.isTrigger,
                    };
                    
                    if (details.credentials.length > 0) {
                        response.credentials = details.credentials;
                        response.credentialNote = "⚠️ This node requires credentials. After creating the workflow, the user must configure credentials in the n8n UI.";
                    }
                    
                    if (details.resources && details.resources.length > 0) {
                        response.resources = details.resources;
                    }
                    
                    if (details.parameters && details.parameters.length > 0) {
                        response.parameters = details.parameters.slice(0, 20);
                    }
                    
                    return JSON.stringify(response, null, 2);
                },
            }),

            new DynamicStructuredTool({
                name: "get_node_parameters",
                description: `Get the specific parameters needed for a node's resource/operation combination.
Use this when you need to know exactly what fields to fill in for a specific action.
For example: Gmail node with resource='message' and operation='send' needs: sendTo, subject, message, etc.`,
                schema: z.object({
                    nodeType: z.string().describe("The exact node type (e.g., 'n8n-nodes-base.gmail')"),
                    resource: z.string().optional().describe("The resource (e.g., 'message', 'channel')"),
                    operation: z.string().optional().describe("The operation (e.g., 'send', 'get', 'create')")
                }),
                func: async ({ nodeType, resource, operation }) => {
                    const details = await this.nodeIndexService.getNodeDetails(nodeType);
                    if (!details) {
                        return `Node "${nodeType}" not found.`;
                    }
                    
                    let relevantParams = details.parameters || [];
                    
                    if (resource || operation) {
                        relevantParams = relevantParams.filter(p => {
                            if (!p.showFor) return true;
                            if (resource && p.showFor.resource && !p.showFor.resource.includes(resource)) return false;
                            if (operation && p.showFor.operation && !p.showFor.operation.includes(operation)) return false;
                            return true;
                        });
                    }
                    
                    const response = {
                        nodeType: details.type,
                        resource,
                        operation,
                        parameters: relevantParams.map(p => ({
                            name: p.name,
                            displayName: p.displayName,
                            type: p.type,
                            required: p.required,
                            default: p.default,
                            description: p.description,
                            options: p.options?.slice(0, 10)
                        }))
                    };
                    
                    return JSON.stringify(response, null, 2);
                },
            }),

            new DynamicStructuredTool({
                name: "get_node_output_schema",
                description: `Get the JSON schema of what a node operation returns.
Use this when you need to understand the output format to connect it to other nodes or use expressions.`,
                schema: z.object({
                    nodeType: z.string().describe("The exact node type"),
                    resource: z.string().optional().describe("The resource"),
                    operation: z.string().optional().describe("The operation")
                }),
                func: async ({ nodeType, resource, operation }) => {
                    const schema = await this.nodeIndexService.getNodeOperationSchema(nodeType, resource, operation);
                    if (!schema) {
                        return `No output schema available for ${nodeType} ${resource || ''} ${operation || ''}. The output format depends on the external service's response.`;
                    }
                    return JSON.stringify(schema, null, 2);
                },
            }),

            new DynamicStructuredTool({
                name: "list_trigger_nodes",
                description: "Get all available trigger nodes that can start workflows (webhooks, schedules, app triggers, etc.)",
                schema: z.object({}),
                func: async () => {
                    const triggers = await this.nodeIndexService.getTriggerNodes();
                    return JSON.stringify(triggers.slice(0, 30), null, 2);
                },
            }),

            // ==========================================
            // WORKFLOW MANAGEMENT TOOLS
            // ==========================================
            new DynamicStructuredTool({
                name: "list_workflows",
                description: "List all workflows in the user's n8n instance with optional filters.",
                schema: z.object({
                    active: z.boolean().optional().describe("Filter by active status"),
                    name: z.string().optional().describe("Filter by name (partial match)"),
                }),
                func: async (params) => {
                    const workflows = await this.n8nService.getWorkflows(params);
                    return JSON.stringify(workflows.map(w => ({ id: w.id, name: w.name, active: w.active })));
                },
            }),

            new DynamicStructuredTool({
                name: "get_workflow",
                description: `Get the complete JSON structure of a specific workflow (nodes, connections, settings).
ALWAYS call this before updating a workflow to get current node IDs and credentials.`,
                schema: z.object({
                    workflowId: z.string().describe("The ID of the workflow to fetch"),
                }),
                func: async ({ workflowId }) => {
                    const workflow = await this.n8nService.getWorkflow(workflowId);
                    return JSON.stringify(workflow);
                },
            }),

            new DynamicStructuredTool({
                name: "create_workflow",
                description: `Create a new n8n workflow. ALL nodes MUST be connected!

CRITICAL - Connection Requirements:
1. Standard nodes use "main" connections
2. LangChain nodes use special types:
   - Text Splitter → Document Loader: use "ai_textSplitter"
   - Document Loader → Vector Store: use "ai_document"  
   - Embeddings → Vector Store: use "ai_embedding"
   - Memory → AI Agent: use "ai_memory"
   - Tools → AI Agent: use "ai_tool"

Connection format:
{
  "SourceNodeName": {
    "main": [[{ "node": "TargetNode", "type": "main", "index": 0 }]]
  },
  "Embeddings": {
    "ai_embedding": [[{ "node": "VectorStore", "type": "ai_embedding", "index": 0 }]]
  }
}

Node structure requirements:
- type: exact node type (e.g., "n8n-nodes-base.gmail")
- typeVersion: version number
- name: display name
- position: [x, y] coordinates
- parameters: configuration object`,
                schema: z.object({
                    name: z.string().describe("The name of the new workflow"),
                    nodes: z.array(z.any()).describe("Array of n8n node objects"),
                    connections: z.any().describe("Connections object - EVERY node must be connected in sequence!"),
                    settings: z.any().optional().describe("Workflow settings (default: {})"),
                }),
                func: async ({ name, nodes, connections, settings }) => {
                    // === DETAILED LOGGING ===
                    this.logger.log(`[CREATE_WORKFLOW] Starting validation for: "${name}"`);
                    this.logger.log(`[CREATE_WORKFLOW] Nodes (${nodes.length}): ${nodes.map(n => n.name).join(', ')}`);
                    this.logger.log(`[CREATE_WORKFLOW] Connections received: ${JSON.stringify(connections, null, 2)}`);
                    
                    // Validate node types
                    for (const node of nodes) {
                        if (!node.type || !node.type.includes('.')) {
                            return `Error: Node "${node.name || 'unknown'}" has invalid type "${node.type}". Use search_nodes to find the correct type (e.g., "n8n-nodes-base.gmail").`;
                        }
                    }
                    
                    // === BUILD CONNECTION MAPS ===
                    const nodeNames = nodes.map(n => n.name);
                    const nodeTypes = new Map(nodes.map(n => [n.name, n.type]));
                    const connectedAsSource = new Set<string>();
                    const connectedAsTarget = new Set<string>();
                    const connectionDetails: string[] = [];
                    
                    // Helper to normalize strings (strip extra quotes the AI might add)
                    // Handles: 'name', "name", \"name\", "'name'", etc.
                    const normalizeString = (str: string): string => {
                        if (!str || typeof str !== 'string') return str;
                        // Remove leading/trailing quotes (single, double, or escaped)
                        let result = str.trim();
                        // Remove escaped quotes at start/end: \"name\" -> name
                        result = result.replace(/^\\"|"$/g, '');
                        result = result.replace(/^"|"$/g, '');
                        result = result.replace(/^'|'$/g, '');
                        return result.trim();
                    };
                    
                    // Deep normalize the entire connections object
                    const deepNormalizeConnections = (obj: any): any => {
                        if (!obj || typeof obj !== 'object') return obj;
                        
                        if (Array.isArray(obj)) {
                            return obj.map(item => deepNormalizeConnections(item));
                        }
                        
                        const normalized: Record<string, any> = {};
                        for (const [key, value] of Object.entries(obj)) {
                            const normalizedKey = normalizeString(key);
                            
                            if (typeof value === 'string') {
                                normalized[normalizedKey] = normalizeString(value);
                            } else if (typeof value === 'object' && value !== null) {
                                normalized[normalizedKey] = deepNormalizeConnections(value);
                            } else {
                                normalized[normalizedKey] = value;
                            }
                        }
                        return normalized;
                    };
                    
                    // Pre-normalize the entire connections object
                    const normalizedConnections = deepNormalizeConnections(connections || {});
                    this.logger.log(`[CREATE_WORKFLOW] Normalized connections: ${JSON.stringify(normalizedConnections, null, 2)}`);
                    
                    // Parse all connections from normalized version
                    for (const [sourceName, sourceConnections] of Object.entries(normalizedConnections)) {
                        connectedAsSource.add(sourceName);
                        for (const [connType, outputs] of Object.entries(sourceConnections as any)) {
                            if (Array.isArray(outputs)) {
                                for (const outputGroup of outputs) {
                                    if (Array.isArray(outputGroup)) {
                                        for (const conn of outputGroup) {
                                            if (conn?.node) {
                                                connectedAsTarget.add(conn.node);
                                                connectionDetails.push(`${sourceName} --[${connType}]--> ${conn.node}`);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    this.logger.log(`[CREATE_WORKFLOW] Parsed connections:\n${connectionDetails.join('\n')}`);
                    
                    // === IDENTIFY NODE CATEGORIES ===
                    const triggerNodes: string[] = [];
                    const endNodes: string[] = []; // Nodes that are valid endpoints (no outgoing required)
                    const regularNodes: string[] = [];
                    const langchainSubNodes: string[] = []; // LangChain nodes that connect via ai_* (not main)
                    
                    for (const node of nodes) {
                        const nodeType = node.type || '';
                        const nodeName = node.name;
                        
                        if (nodeType.includes('Trigger') || nodeType.includes('trigger') || nodeType.includes('webhook')) {
                            triggerNodes.push(nodeName);
                        } else if (nodeType.includes('langchain')) {
                            // LangChain sub-nodes (embeddings, loaders, splitters) don't need "main" outgoing
                            // but they DO need ai_* outgoing connections
                            if (nodeType.includes('embeddings') || nodeType.includes('DataLoader') || nodeType.includes('textSplitter') || nodeType.includes('memory') || nodeType.includes('Tool')) {
                                langchainSubNodes.push(nodeName);
                            } else {
                                // Vector stores, agents, chains are regular nodes
                                regularNodes.push(nodeName);
                            }
                        } else {
                            regularNodes.push(nodeName);
                        }
                    }
                    
                    this.logger.log(`[CREATE_WORKFLOW] Triggers: ${triggerNodes.join(', ')}`);
                    this.logger.log(`[CREATE_WORKFLOW] Regular nodes: ${regularNodes.join(', ')}`);
                    this.logger.log(`[CREATE_WORKFLOW] LangChain sub-nodes: ${langchainSubNodes.join(', ')}`);
                    
                    // === VALIDATION ERRORS ===
                    const errors: string[] = [];
                    
                    // 1. Check that triggers have outgoing connections
                    for (const trigger of triggerNodes) {
                        if (!connectedAsSource.has(trigger)) {
                            errors.push(`Trigger "${trigger}" has no outgoing connection`);
                        }
                    }
                    
                    // 2. Check that regular nodes are connected (either as source or target)
                    // But more importantly: if a node is in the middle of the flow, it needs BOTH incoming AND outgoing
                    for (const nodeName of regularNodes) {
                        const hasIncoming = connectedAsTarget.has(nodeName);
                        const hasOutgoing = connectedAsSource.has(nodeName);
                        
                        if (!hasIncoming && !hasOutgoing) {
                            errors.push(`Node "${nodeName}" is completely disconnected (no incoming or outgoing connections)`);
                        } else if (!hasIncoming) {
                            // Check if this is maybe supposed to receive from a trigger
                            const couldBeFirstAfterTrigger = triggerNodes.some(t => {
                                const triggerConns = normalizedConnections?.[t];
                                if (!triggerConns) return false;
                                for (const outputs of Object.values(triggerConns)) {
                                    if (Array.isArray(outputs)) {
                                        for (const group of outputs as any[]) {
                                            if (Array.isArray(group)) {
                                                for (const conn of group) {
                                                    if (conn?.node === nodeName) return true;
                                                }
                                            }
                                        }
                                    }
                                }
                                return false;
                            });
                            
                            if (!couldBeFirstAfterTrigger) {
                                errors.push(`Node "${nodeName}" has no incoming connection (nothing connects TO it)`);
                            }
                        }
                        // Note: We don't require outgoing from EVERY node - the last node in chain won't have one
                    }
                    
                    // 3. Check LangChain sub-nodes have their special ai_* connections
                    for (const nodeName of langchainSubNodes) {
                        const nodeType = nodeTypes.get(nodeName) || '';
                        
                        if (!connectedAsSource.has(nodeName)) {
                            if (nodeType.includes('embeddings')) {
                                errors.push(`"${nodeName}" (Embeddings) needs ai_embedding connection to Vector Store`);
                            } else if (nodeType.includes('DataLoader') || nodeType.includes('documentDefault')) {
                                errors.push(`"${nodeName}" (Document Loader) needs ai_document connection to Vector Store`);
                            } else if (nodeType.includes('textSplitter')) {
                                errors.push(`"${nodeName}" (Text Splitter) needs ai_textSplitter connection to Document Loader`);
                            } else if (nodeType.includes('memory')) {
                                errors.push(`"${nodeName}" (Memory) needs ai_memory connection to AI Agent/Chain`);
                            }
                        }
                    }
                    
                    // 4. Validate flow continuity - check there's a path from trigger to at least one end
                    if (triggerNodes.length > 0 && errors.length === 0) {
                        const visited = new Set<string>();
                        const queue = [...triggerNodes];
                        
                        while (queue.length > 0) {
                            const current = queue.shift()!;
                            if (visited.has(current)) continue;
                            visited.add(current);
                            
                            const nodeConns = normalizedConnections?.[current];
                            if (nodeConns) {
                                for (const outputs of Object.values(nodeConns)) {
                                    if (Array.isArray(outputs)) {
                                        for (const group of outputs as any[]) {
                                            if (Array.isArray(group)) {
                                                for (const conn of group) {
                                                    if (conn?.node && !visited.has(conn.node)) {
                                                        queue.push(conn.node);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        const unreachableNodes = regularNodes.filter(n => !visited.has(n));
                        if (unreachableNodes.length > 0) {
                            errors.push(`These nodes are not reachable from the trigger: ${unreachableNodes.join(', ')}`);
                        }
                    }
                    
                    // === REJECT IF ERRORS ===
                    if (errors.length > 0) {
                        this.workflowValidationFailures++;
                        this.logger.error(`[CREATE_WORKFLOW] Validation failed (attempt ${this.workflowValidationFailures}/${this.MAX_VALIDATION_FAILURES}):\n${errors.join('\n')}`);
                        
                        // If we've failed too many times, give up and tell the user
                        if (this.workflowValidationFailures >= this.MAX_VALIDATION_FAILURES) {
                            this.workflowValidationFailures = 0; // Reset for next request
                            return `FATAL ERROR: Unable to create a valid workflow after ${this.MAX_VALIDATION_FAILURES} attempts.\n\n` +
                                `The following connection issues could not be resolved:\n${errors.map(e => `❌ ${e}`).join('\n')}\n\n` +
                                `Please tell the user that you are having difficulty creating this workflow and suggest they:\n` +
                                `1. Try a simpler workflow first\n` +
                                `2. Be more specific about the nodes they want\n` +
                                `3. Check if the requested nodes are compatible with each other`;
                        }
                        
                        return `ERROR: Workflow has connection problems!\n\n${errors.map(e => `❌ ${e}`).join('\n')}\n\n` +
                            `You MUST fix these connections. Every node needs to be connected in sequence.\n\n` +
                            `Connection format for regular nodes:\n` +
                            `"SourceNode": { "main": [[{ "node": "TargetNode", "type": "main", "index": 0 }]] }\n\n` +
                            `Connection format for LangChain nodes:\n` +
                            `"Embeddings": { "ai_embedding": [[{ "node": "VectorStore", "type": "ai_embedding", "index": 0 }]] }\n` +
                            `"DataLoader": { "ai_document": [[{ "node": "VectorStore", "type": "ai_document", "index": 0 }]] }\n` +
                            `"TextSplitter": { "ai_textSplitter": [[{ "node": "DataLoader", "type": "ai_textSplitter", "index": 0 }]] }`;
                    }
                    
                    // Reset failure counter on success
                    this.workflowValidationFailures = 0;
                    
                    // === CREATE WORKFLOW ===
                    this.logger.log(`[CREATE_WORKFLOW] Validation passed, creating workflow...`);
                    this.logger.log(`[CREATE_WORKFLOW] Normalized connections: ${JSON.stringify(normalizedConnections, null, 2)}`);
                    
                    const result = await this.n8nService.createWorkflow({ name, nodes, connections: normalizedConnections, settings });
                    const baseUrl = await this.settingsService.get('N8N_BASE_URL') || this.configService.get('N8N_BASE_URL');
                    
                    const nodesNeedingCreds: string[] = [];
                    for (const node of nodes) {
                        const details = await this.nodeIndexService.getNodeDetails(node.type);
                        if (details && details.credentials.length > 0) {
                            nodesNeedingCreds.push(`${node.name} (${details.credentials.map(c => c.name).join(' or ')})`);
                        }
                    }
                    
                    let response = `✅ Workflow created successfully!\n- ID: ${result.id}\n- URL: ${baseUrl}/workflow/${result.id}`;
                    
                    if (nodesNeedingCreds.length > 0) {
                        response += `\n\n⚠️ CREDENTIALS REQUIRED:\nThe following nodes need credentials configured in the n8n UI:\n${nodesNeedingCreds.map(n => `• ${n}`).join('\n')}\n\nInstructions for user: Open the workflow in n8n, click on each node listed above, and select or create the appropriate credentials.`;
                    }
                    
                    return response;
                },
            }),

            new DynamicStructuredTool({
                name: "update_workflow",
                description: `Update an existing workflow.
CRITICAL STEPS:
1. ALWAYS call 'get_workflow' first to get the current state
2. Preserve ALL existing node properties (id, credentials, position, etc.)
3. Only modify what needs to change
4. Send the COMPLETE workflow object back`,
                schema: z.object({
                    workflowId: z.string().describe("The ID of the workflow to update"),
                    updates: z.any().describe("The COMPLETE updated workflow object with name, nodes, connections, and settings"),
                }),
                func: async ({ workflowId, updates }) => {
                    await this.n8nService.updateWorkflow(workflowId, updates);
                    return `Workflow ${workflowId} updated successfully.`;
                },
            }),

            new DynamicStructuredTool({
                name: "delete_workflow",
                description: "Delete a workflow by ID.",
                schema: z.object({
                    workflowId: z.string().describe("The ID of the workflow to delete"),
                }),
                func: async ({ workflowId }) => {
                    await this.n8nService.deleteWorkflow(workflowId);
                    return `Workflow ${workflowId} deleted successfully.`;
                },
            }),

            new DynamicStructuredTool({
                name: "execute_workflow",
                description: "Trigger a manual execution of a workflow.",
                schema: z.object({
                    workflowId: z.string().describe("The ID of the workflow to execute"),
                    data: z.any().optional().describe("Input data for execution"),
                }),
                func: async ({ workflowId, data }) => {
                    const result = await this.n8nService.executeWorkflow(workflowId, data);
                    return `Workflow ${workflowId} execution started. Execution ID: ${result.executionId || 'unknown'}.`;
                },
            }),

            new DynamicStructuredTool({
                name: "activate_workflow",
                description: "Enable a workflow so it runs automatically based on its triggers.",
                schema: z.object({
                    workflowId: z.string().describe("The ID of the workflow to activate"),
                }),
                func: async ({ workflowId }) => {
                    await this.n8nService.activateWorkflow(workflowId);
                    return `Workflow ${workflowId} activated successfully.`;
                },
            }),

            new DynamicStructuredTool({
                name: "deactivate_workflow",
                description: "Disable a workflow.",
                schema: z.object({
                    workflowId: z.string().describe("The ID of the workflow to deactivate"),
                }),
                func: async ({ workflowId }) => {
                    await this.n8nService.deactivateWorkflow(workflowId);
                    return `Workflow ${workflowId} deactivated successfully.`;
                },
            }),

            // ==========================================
            // EXECUTION & MONITORING TOOLS
            // ==========================================
            new DynamicStructuredTool({
                name: "list_executions",
                description: "List recent workflow executions with optional filters.",
                schema: z.object({
                    workflowId: z.string().optional().describe("Filter by workflow ID"),
                    status: z.enum(['success', 'error', 'running', 'waiting', 'canceled']).optional().describe("Filter by status"),
                    limit: z.number().optional().describe("Limit results"),
                }),
                func: async (params) => {
                    const executions = await this.n8nService.listExecutions(params);
                    return JSON.stringify(executions);
                },
            }),

            new DynamicStructuredTool({
                name: "get_execution",
                description: "Get details for a specific execution including node outputs.",
                schema: z.object({
                    executionId: z.string().describe("The ID of the execution"),
                }),
                func: async ({ executionId }) => {
                    const execution = await this.n8nService.getExecution(executionId);
                    return JSON.stringify(execution);
                },
            }),

            new DynamicStructuredTool({
                name: "retry_execution",
                description: "Retry a failed execution.",
                schema: z.object({
                    executionId: z.string().describe("The ID of the execution to retry"),
                }),
                func: async ({ executionId }) => {
                    await this.n8nService.retryExecution(executionId, { loadWorkflow: true });
                    return `Execution ${executionId} retry triggered.`;
                },
            }),

            // ==========================================
            // VARIABLE MANAGEMENT
            // ==========================================
            new DynamicStructuredTool({
                name: "manage_variable",
                description: "Create, update, or delete environment variables in n8n.",
                schema: z.object({
                    action: z.enum(['create', 'update', 'delete']),
                    id: z.string().optional().describe("Variable ID (required for update/delete)"),
                    name: z.string().optional().describe("Variable name"),
                    value: z.string().optional().describe("Variable value"),
                }),
                func: async ({ action, id, name, value }) => {
                    if (action === 'create') {
                        const result = await this.n8nService.createVariable({ name, value });
                        return `Variable created successfully with ID: ${result.id}`;
                    } else if (action === 'update') {
                        if (!id) return "Variable ID is required for update.";
                        await this.n8nService.updateVariable(id, { name, value });
                        return `Variable ${id} updated successfully.`;
                    } else if (action === 'delete') {
                        if (!id) return "Variable ID is required for delete.";
                        await this.n8nService.deleteVariable(id);
                        return `Variable ${id} deleted successfully.`;
                    }
                    return "Invalid action";
                },
            }),
        ];
    }

    private wrapToolsWithStatus(tools: any[]) {
        return tools.map(tool => {
            const originalFunc = tool.func;
            tool.func = async (args: any) => {
                this.emitStatus({
                    type: 'tool_call',
                    message: `Calling tool: ${tool.name}`,
                    toolName: tool.name,
                    toolArgs: args,
                });
                
                const startTime = Date.now();
                try {
                    const result = await originalFunc(args);
                    const duration = Date.now() - startTime;
                    
                    this.emitStatus({
                        type: 'tool_result',
                        message: `Tool ${tool.name} completed in ${duration}ms`,
                        toolName: tool.name,
                    });
                    
                    return result;
                } catch (error) {
                    this.emitStatus({
                        type: 'error',
                        message: `Tool ${tool.name} failed: ${error.message}`,
                        toolName: tool.name,
                    });
                    throw error;
                }
            };
            return tool;
        });
    }

    private getSystemPrompt(): string {
        return `You are an expert n8n workflow automation engineer. Your PRIMARY JOB is to CREATE WORKFLOWS when asked.

## 🚨 CRITICAL: YOU MUST CREATE WORKFLOWS

When a user asks you to create a workflow, you MUST:
1. Research nodes BRIEFLY (2-3 search_nodes calls max)
2. Get essential details (get_node_details for key nodes only)
3. **IMMEDIATELY call 'create_workflow' to build it**

⚠️ FAILURE MODE TO AVOID: Do NOT spend excessive time researching. After 3-5 tool calls, you MUST call create_workflow.

## 🔗 CRITICAL: ALL NODES MUST BE CONNECTED

Every workflow MUST have proper connections. NEVER create disconnected nodes!

### Standard Node Connections (main → main)
⚠️ IMPORTANT: Do NOT add extra quotes around keys! Use plain strings like "Trigger", NOT "\\"Trigger\\"" or "'Trigger'"

\`\`\`json
{
  "Trigger": {
    "main": [[{ "node": "Next Node", "type": "main", "index": 0 }]]
  },
  "Next Node": {
    "main": [[{ "node": "Final Node", "type": "main", "index": 0 }]]
  }
}
\`\`\`

### 🔴 LANGCHAIN NODE CONNECTIONS - MANDATORY!

LangChain/AI nodes (embeddings, vector stores, document loaders, text splitters) use SPECIAL connection types.
You MUST include these connections or the workflow will NOT work!

**Connection Types for LangChain nodes:**
- Text Splitter → Document Loader: use "ai_textSplitter" 
- Document Loader → Vector Store: use "ai_document"
- Embeddings → Vector Store: use "ai_embedding"
- Regular nodes → Vector Store: use "main"

**COMPLETE RAG Pipeline Connections Example:**
\`\`\`json
{
  "Manual Trigger": {
    "main": [[{ "node": "Google Drive List", "type": "main", "index": 0 }]]
  },
  "Google Drive List": {
    "main": [[{ "node": "Split In Batches", "type": "main", "index": 0 }]]
  },
  "Split In Batches": {
    "main": [[{ "node": "Google Drive Download", "type": "main", "index": 0 }]]
  },
  "Google Drive Download": {
    "main": [[{ "node": "Pinecone Insert", "type": "main", "index": 0 }]]
  },
  "Recursive Character Text Splitter": {
    "ai_textSplitter": [[{ "node": "Default Data Loader", "type": "ai_textSplitter", "index": 0 }]]
  },
  "Default Data Loader": {
    "ai_document": [[{ "node": "Pinecone Insert", "type": "ai_document", "index": 0 }]]
  },
  "Embeddings OpenAI": {
    "ai_embedding": [[{ "node": "Pinecone Insert", "type": "ai_embedding", "index": 0 }]]
  }
}
\`\`\`

⚠️ WITHOUT these ai_* connections, the LangChain nodes will appear disconnected!

## NODE STRUCTURE

\`\`\`json
{
  "type": "n8n-nodes-base.exactNodeType",
  "typeVersion": 1,
  "name": "Descriptive Name",
  "position": [250, 300],
  "parameters": {}
}
\`\`\`

## LANGCHAIN NODE TYPES

For RAG/AI pipelines, use these exact types:
- Embeddings: @n8n/n8n-nodes-langchain.embeddingsOpenAi
- Vector Store Insert: @n8n/n8n-nodes-langchain.vectorStorePinecone (for insert/load)
- Document Loader: @n8n/n8n-nodes-langchain.documentDefaultDataLoader
- Text Splitter: @n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter

## COMMON NODE TYPES

- Triggers: n8n-nodes-base.manualTrigger, n8n-nodes-base.scheduleTrigger, n8n-nodes-base.webhook
- Google: n8n-nodes-base.googleDrive, n8n-nodes-base.googleSheets
- Database: n8n-nodes-base.postgres
- Logic: n8n-nodes-base.if, n8n-nodes-base.switch, n8n-nodes-base.splitInBatches

## CREDENTIALS NOTE

⚠️ Credentials CANNOT be set via API. After creating the workflow, tell the user which nodes need credentials configured in n8n UI.

## 💬 CRITICAL: ALWAYS PROVIDE A FINAL TEXT RESPONSE

After completing your tool calls (creating workflows, searching nodes, etc.), you MUST:
1. **ALWAYS write a text response** explaining what you did
2. If you created a workflow, tell the user:
   - What workflow was created (name, link)
   - What nodes are included
   - Which nodes need credentials configured
3. If you searched for nodes, summarize the results
4. NEVER end with just tool calls - the user needs your text explanation!

REMEMBER: CREATE THE WORKFLOW with ALL CONNECTIONS! No disconnected nodes! And ALWAYS respond with text explaining what you did.`;
    }
}
