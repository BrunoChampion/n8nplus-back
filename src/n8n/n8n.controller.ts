import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { N8nService } from './n8n.service';

@Controller('n8n')
export class N8nController {
    constructor(private readonly n8nService: N8nService) { }

    @Get('workflows')
    async getWorkflows() {
        return this.n8nService.getWorkflows();
    }

    @Get('workflows/:id')
    async getWorkflow(@Param('id') id: string) {
        return this.n8nService.getWorkflow(id);
    }

    @Post('workflows')
    async createWorkflow(@Body() workflow: any) {
        return this.n8nService.createWorkflow(workflow);
    }
}
