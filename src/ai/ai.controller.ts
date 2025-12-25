import { Controller, Post, Body, Sse, MessageEvent, Res, Logger } from '@nestjs/common';
import { AiAgentService, AgentStatus } from './ai.service';
import { Observable, map, filter } from 'rxjs';
import { Response } from 'express';

@Controller('ai')
export class AiController {
    private readonly logger = new Logger(AiController.name);
    
    constructor(private readonly aiAgentService: AiAgentService) { }

    @Post('chat')
    async chat(@Body() body: { message: string, history?: any[] }) {
        const response = await this.aiAgentService.runAgent(body.message, body.history);
        return { response };
    }

    @Post('chat/stream')
    async chatStream(
        @Body() body: { message: string, history?: any[] },
        @Res() res: Response
    ) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.flushHeaders();

        let tokenCount = 0;
        let totalChars = 0;

        try {
            await this.aiAgentService.runAgentStreaming(
                body.message, 
                body.history || [],
                (token: string) => {
                    tokenCount++;
                    totalChars += token.length;
                    this.logger.log(`[STREAM TOKEN #${tokenCount}] Sending ${token.length} chars: "${token.substring(0, 50)}${token.length > 50 ? '...' : ''}"`);
                    res.write(`data: ${JSON.stringify({ token })}\n\n`);
                }
            );
            this.logger.log(`[STREAM COMPLETE] Sent ${tokenCount} tokens, ${totalChars} total chars`);
            res.write('data: [DONE]\n\n');
        } catch (error) {
            this.logger.error(`[STREAM ERROR] ${error.message}`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        } finally {
            res.end();
        }
    }

    @Sse('status')
    status(): Observable<MessageEvent> {
        return this.aiAgentService.statusSubject.pipe(
            map((status: AgentStatus) => ({
                data: status,
            } as MessageEvent))
        );
    }
}
