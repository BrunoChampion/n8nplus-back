import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class CodeReviewService {
    private readonly logger = new Logger(CodeReviewService.name);
    private readonly CACHE_DIR = path.join(process.cwd(), '.n8n-nodes-cache', 'packages', 'nodes-base', 'nodes');
    private readonly CACHE_FILE = path.join(process.cwd(), '.n8n-nodes-cache', 'nodes-list.json');
    private cachedNodes: string[] = [];

    /**
     * Lists all available nodes by recursively searching the local cache.
     */
    async listNodes(): Promise<string[]> {
        if (this.cachedNodes.length > 0) return this.cachedNodes;

        // Try load from disk cache first
        if (fs.existsSync(this.CACHE_FILE)) {
            try {
                this.cachedNodes = JSON.parse(fs.readFileSync(this.CACHE_FILE, 'utf8'));
                if (this.cachedNodes.length > 0) return this.cachedNodes;
            } catch (e) {
                this.logger.warn('Failed to parse nodes disk cache, re-scanning...');
            }
        }

        if (!fs.existsSync(this.CACHE_DIR)) {
            this.logger.error(`Cache directory not found: ${this.CACHE_DIR}`);
            return [];
        }

        try {
            this.logger.log('Scanning local node cache...');
            this.cachedNodes = this.findNodesInDir(this.CACHE_DIR);

            // Save to disk cache
            try {
                fs.writeFileSync(this.CACHE_FILE, JSON.stringify(this.cachedNodes), 'utf8');
            } catch (e) {
                this.logger.warn(`Failed to save nodes disk cache: ${e.message}`);
            }

            return this.cachedNodes;
        } catch (error) {
            this.logger.error(`Failed to scan local nodes: ${error.message}`);
            return [];
        }
    }

    private findNodesInDir(dir: string): string[] {
        let results: string[] = [];
        const items = fs.readdirSync(dir);

        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                // Ignore hidden directories like .git
                if (item.startsWith('.')) continue;

                const subNodes = this.findNodesInDir(fullPath);
                if (subNodes.length > 0) {
                    results = results.concat(subNodes);
                }

                // If it's a leaf node directory (contains a .node.ts file), add it
                if (fs.readdirSync(fullPath).some(f => f.endsWith('.node.ts'))) {
                    // Get relative path from CACHE_DIR
                    results.push(path.relative(this.CACHE_DIR, fullPath));
                }
            }
        }
        return Array.from(new Set(results));
    }

    /**
     * Fetches the source code of an n8n node from the local cache.
     */
    async getNodeCode(nodePath: string): Promise<string> {
        try {
            const fullPath = path.join(this.CACHE_DIR, nodePath);
            if (!fs.existsSync(fullPath)) {
                // If it's a directory, try to find the main .node.ts file
                if (fs.statSync(fullPath).isDirectory()) {
                    const files = fs.readdirSync(fullPath);
                    const nodeFile = files.find(f => f.endsWith('.node.ts'));
                    if (nodeFile) {
                        return fs.readFileSync(path.join(fullPath, nodeFile), 'utf8');
                    }
                }
                throw new Error('File or directory not found');
            }

            if (fs.statSync(fullPath).isFile()) {
                return fs.readFileSync(fullPath, 'utf8');
            } else {
                // It's a directory, find the .node.ts file
                const files = fs.readdirSync(fullPath);
                const nodeFile = files.find(f => f.endsWith('.node.ts'));
                if (nodeFile) {
                    return fs.readFileSync(path.join(fullPath, nodeFile), 'utf8');
                }
                throw new Error('No .node.ts file found in directory');
            }
        } catch (error) {
            this.logger.error(`Failed to read node code from ${nodePath}: ${error.message}`);
            throw new Error(`Node code not found for ${nodePath}`);
        }
    }

    /**
     * Finds the probable path for a node.
     */
    async findNodePath(query: string): Promise<string> {
        const nodes = await this.listNodes();
        const lowerQuery = query.toLowerCase();

        // Try to find an exact or close match in the relative paths
        const match = nodes.find(n =>
            n.toLowerCase() === lowerQuery ||
            `n8n-nodes-base.${n.toLowerCase().replace(/[\\/]/g, '.')}` === lowerQuery ||
            n.split(/[\\/]/).pop()?.toLowerCase() === lowerQuery.replace('n8n-nodes-base.', '')
        );

        if (match) {
            return match;
        }

        // Search for partial matches in the paths
        const partialMatch = nodes.find(n => n.toLowerCase().includes(lowerQuery));
        if (partialMatch) {
            return partialMatch;
        }

        throw new Error(`Could not find node path locally for query: ${query}`);
    }
}
