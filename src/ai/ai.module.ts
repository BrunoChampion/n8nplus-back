import { Module } from '@nestjs/common';
import { AiAgentService } from './ai.service';
import { AiController } from './ai.controller';
import { CodeReviewService } from './code-review.service';
import { NodeIndexService } from './node-index.service';
import { N8nModule } from '../n8n/n8n.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [N8nModule, SettingsModule],
  controllers: [AiController],
  providers: [AiAgentService, CodeReviewService, NodeIndexService],
  exports: [AiAgentService, NodeIndexService],
})
export class AiModule { }
