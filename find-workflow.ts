import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { N8nService } from './src/n8n/n8n.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const n8nService = app.get(N8nService);

    try {
        // Fetch the specific problematic workflow
        const details = await n8nService.getWorkflow('lVduKyAoWUfOiNLi');
        console.log('=== CURRENT WORKFLOW STATE ===');
        console.log(JSON.stringify(details, null, 2));

        // Specifically check each node
        console.log('\n=== NODE ANALYSIS ===');
        for (const node of details.nodes) {
            console.log(`\nNode: ${node.name}`);
            console.log(`  - ID: ${node.id} (Valid UUID: ${/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.id)})`);
            console.log(`  - Type: ${node.type}`);
            console.log(`  - TypeVersion: ${node.typeVersion}`);
            console.log(`  - Has Credentials: ${!!node.credentials}`);
            if (node.credentials) {
                console.log(`  - Credentials: ${JSON.stringify(node.credentials)}`);
            }
        }
    } catch (error: any) {
        console.error('Error:', error.message);
    } finally {
        await app.close();
    }
}

bootstrap();
