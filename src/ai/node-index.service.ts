import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Interfaces for the node index structure
 */
interface NodeOperation {
    name: string;
    value: string;
    description?: string;
}

interface NodeResource {
    name: string;
    value: string;
    operations: NodeOperation[];
}

interface NodeCredential {
    name: string;
    required: boolean;
}

interface NodeIndexEntry {
    type: string;
    displayName: string;
    name: string;
    description: string;
    group: string[];
    version: number;
    credentials: NodeCredential[];
    resources?: NodeResource[];
    mainParameters?: any[];
    isTrigger: boolean;
    codePath: string;
    hasSchema: boolean;
    schemaVersion?: string;
}

interface NodeIndex {
    generatedAt: string;
    totalNodes: number;
    nodes: Record<string, NodeIndexEntry>;
    byCategory: Record<string, string[]>;
    triggerNodes: string[];
    aliases: Record<string, string>;
}

/**
 * Compact node info returned by search
 */
export interface NodeSearchResult {
    type: string;
    displayName: string;
    description: string;
    isTrigger: boolean;
    requiresCredentials: boolean;
    credentialTypes: string[];
}

/**
 * Detailed node info for building workflows
 */
export interface NodeDetails {
    type: string;
    displayName: string;
    name: string;
    description: string;
    version: number;
    credentials: NodeCredential[];
    resources?: NodeResource[];
    isTrigger: boolean;
    parameters?: NodeParameter[];
}

export interface NodeParameter {
    name: string;
    displayName: string;
    type: string;
    required: boolean;
    default?: any;
    description?: string;
    options?: { name: string; value: string; description?: string }[];
    showFor?: { resource?: string[]; operation?: string[] };
}

/**
 * Schema info for node operations
 */
export interface NodeOperationSchema {
    resource: string;
    operation: string;
    inputSchema?: any;
    outputSchema?: any;
}

@Injectable()
export class NodeIndexService implements OnModuleInit {
    private readonly logger = new Logger(NodeIndexService.name);
    private readonly PACKAGES_DIR = path.join(process.cwd(), '.n8n-nodes-cache', 'packages');
    private readonly INDEX_FILE = path.join(process.cwd(), '.n8n-nodes-cache', 'node-index.json');
    
    // Map of package prefixes to their directory names
    private readonly PACKAGE_MAP: Record<string, string> = {
        'n8n-nodes-base': 'nodes-base',
        '@n8n/n8n-nodes-langchain': 'nodes-langchain',
    };

    /**
     * Parse codePath to extract package prefix and relative path
     * Handles both "n8n-nodes-base/Google/Gmail" and "@n8n/n8n-nodes-langchain/vector_store/..."
     */
    private parseCodePath(codePath: string): { prefix: string; relativePath: string; packageDir: string } {
        // Check if it starts with a known scoped package (@n8n/...)
        for (const prefix of Object.keys(this.PACKAGE_MAP)) {
            if (codePath.startsWith(prefix + '/')) {
                return {
                    prefix,
                    relativePath: codePath.slice(prefix.length + 1),
                    packageDir: this.PACKAGE_MAP[prefix],
                };
            }
        }
        // Fallback: assume first segment is the prefix
        const firstSlash = codePath.indexOf('/');
        if (firstSlash === -1) {
            return { prefix: codePath, relativePath: '', packageDir: 'nodes-base' };
        }
        const prefix = codePath.slice(0, firstSlash);
        return {
            prefix,
            relativePath: codePath.slice(firstSlash + 1),
            packageDir: this.PACKAGE_MAP[prefix] || 'nodes-base',
        };
    }
    
    private nodeIndex: NodeIndex | null = null;

    async onModuleInit() {
        await this.loadIndex();
    }

    /**
     * Load the pre-built node index from disk
     */
    private async loadIndex(): Promise<void> {
        try {
            if (fs.existsSync(this.INDEX_FILE)) {
                const content = fs.readFileSync(this.INDEX_FILE, 'utf8');
                this.nodeIndex = JSON.parse(content);
                this.logger.log(`Node index loaded: ${this.nodeIndex?.totalNodes} nodes`);
            } else {
                this.logger.warn('Node index not found. Run "npm run build:node-index" to generate it.');
                // Fallback: build a minimal index on the fly
                await this.buildMinimalIndex();
            }
        } catch (error) {
            this.logger.error(`Failed to load node index: ${error.message}`);
        }
    }
    
    /**
     * Get the nodes directory for a given node type
     */
    private getNodesDir(nodeType: string): string {
        // Extract the package prefix from the node type
        for (const [prefix, dir] of Object.entries(this.PACKAGE_MAP)) {
            if (nodeType.startsWith(prefix)) {
                return path.join(this.PACKAGES_DIR, dir, 'nodes');
            }
        }
        // Default to nodes-base
        return path.join(this.PACKAGES_DIR, 'nodes-base', 'nodes');
    }

    /**
     * Build a minimal index if the pre-built one doesn't exist
     */
    private async buildMinimalIndex(): Promise<void> {
        this.nodeIndex = {
            generatedAt: new Date().toISOString(),
            totalNodes: 0,
            nodes: {},
            byCategory: {},
            triggerNodes: [],
            aliases: {}
        };
        
        // Quick scan for node folders across all packages
        if (!fs.existsSync(this.PACKAGES_DIR)) return;
        
        const packageDirs = fs.readdirSync(this.PACKAGES_DIR).filter(d => {
            const fullPath = path.join(this.PACKAGES_DIR, d);
            return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'nodes'));
        });
        
        for (const packageDir of packageDirs) {
            const nodesDir = path.join(this.PACKAGES_DIR, packageDir, 'nodes');
            const prefix = Object.entries(this.PACKAGE_MAP).find(([_, dir]) => dir === packageDir)?.[0] || `n8n-nodes-${packageDir}`;
            
            const scanDir = (dir: string, relPath: string = '') => {
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    if (item.startsWith('.') || item === '__schema__' || item === 'test') continue;
                    const fullPath = path.join(dir, item);
                    if (!fs.statSync(fullPath).isDirectory()) continue;
                    
                    const hasNodeFile = fs.readdirSync(fullPath).some(f => f.endsWith('.node.ts'));
                    if (hasNodeFile) {
                        // Try to get basic info from .node.json
                        const jsonFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.node.json'));
                        if (jsonFiles.length > 0) {
                            try {
                                const jsonContent = JSON.parse(fs.readFileSync(path.join(fullPath, jsonFiles[0]), 'utf8'));
                                const nodeType = jsonContent.node || `${prefix}.${item.toLowerCase()}`;
                                const codePath = `${prefix}/${relPath ? relPath + '/' : ''}${item}`;
                                this.nodeIndex!.nodes[nodeType] = {
                                    type: nodeType,
                                    displayName: item,
                                    name: item.toLowerCase(),
                                    description: '',
                                    group: [],
                                    version: 1,
                                    credentials: [],
                                    isTrigger: item.includes('Trigger'),
                                    codePath,
                                    hasSchema: fs.existsSync(path.join(fullPath, '__schema__')),
                                };
                                this.nodeIndex!.aliases[item.toLowerCase()] = nodeType;
                            } catch {}
                        }
                    } else {
                        scanDir(fullPath, relPath ? `${relPath}/${item}` : item);
                    }
                }
            };
            
            scanDir(nodesDir);
        }
        
        this.nodeIndex.totalNodes = Object.keys(this.nodeIndex.nodes).length;
        this.logger.log(`Built minimal index with ${this.nodeIndex.totalNodes} nodes`);
    }

    /**
     * Search for nodes by query (name, description, alias)
     * Returns compact results to minimize token usage
     */
    async searchNodes(query: string, limit: number = 10): Promise<NodeSearchResult[]> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return [];

        const lowerQuery = query.toLowerCase().trim();
        const results: { entry: NodeIndexEntry; score: number }[] = [];

        // Check aliases first for exact matches
        if (this.nodeIndex.aliases[lowerQuery]) {
            const nodeType = this.nodeIndex.aliases[lowerQuery];
            const entry = this.nodeIndex.nodes[nodeType];
            if (entry) {
                results.push({ entry, score: 100 });
            }
        }

        // Search through all nodes
        for (const [type, entry] of Object.entries(this.nodeIndex.nodes)) {
            // Skip if already added via alias
            if (results.find(r => r.entry.type === type)) continue;

            let score = 0;

            // Exact matches
            if (entry.name.toLowerCase() === lowerQuery) score += 90;
            if (entry.displayName.toLowerCase() === lowerQuery) score += 90;

            // Partial matches
            if (entry.name.toLowerCase().includes(lowerQuery)) score += 50;
            if (entry.displayName.toLowerCase().includes(lowerQuery)) score += 50;
            if (entry.description.toLowerCase().includes(lowerQuery)) score += 20;

            // Type match
            if (type.toLowerCase().includes(lowerQuery)) score += 40;

            if (score > 0) {
                results.push({ entry, score });
            }
        }

        // Sort by score and limit
        results.sort((a, b) => b.score - a.score);
        
        return results.slice(0, limit).map(r => ({
            type: r.entry.type,
            displayName: r.entry.displayName,
            description: r.entry.description,
            isTrigger: r.entry.isTrigger,
            requiresCredentials: r.entry.credentials.length > 0,
            credentialTypes: r.entry.credentials.map(c => c.name)
        }));
    }

    /**
     * Get detailed info for a specific node type
     * Used when the AI needs to actually build/configure a node
     */
    async getNodeDetails(nodeType: string): Promise<NodeDetails | null> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return null;

        // Try direct lookup
        let entry = this.nodeIndex.nodes[nodeType];
        
        // Try alias lookup
        if (!entry && this.nodeIndex.aliases[nodeType.toLowerCase()]) {
            entry = this.nodeIndex.nodes[this.nodeIndex.aliases[nodeType.toLowerCase()]];
        }

        if (!entry) return null;

        // Get parameters from the source code
        const parameters = await this.extractNodeParameters(entry.type, entry.codePath);

        return {
            type: entry.type,
            displayName: entry.displayName,
            name: entry.name,
            description: entry.description,
            version: entry.version,
            credentials: entry.credentials,
            resources: entry.resources,
            isTrigger: entry.isTrigger,
            parameters
        };
    }

    /**
     * Extract parameters from node source code
     */
    private async extractNodeParameters(nodeType: string, codePath: string): Promise<NodeParameter[]> {
        const parameters: NodeParameter[] = [];
        
        // Use helper to parse codePath correctly
        const { relativePath, packageDir } = this.parseCodePath(codePath);
        const fullPath = path.join(this.PACKAGES_DIR, packageDir, 'nodes', relativePath);

        try {
            if (!fs.existsSync(fullPath)) {
                this.logger.debug(`Node path not found: ${fullPath}`);
                return parameters;
            }
            
            // Find the main node file or description file
            let descriptionContent = '';
            
            const files = fs.readdirSync(fullPath);
            
            // Look for Description files first (they contain parameter definitions)
            const descFiles = files.filter(f => f.includes('Description') && f.endsWith('.ts'));
            for (const descFile of descFiles) {
                descriptionContent += fs.readFileSync(path.join(fullPath, descFile), 'utf8');
            }
            
            // Also check versioned folders
            const versionDirs = files.filter(f => {
                const fp = path.join(fullPath, f);
                return fs.statSync(fp).isDirectory() && /^[vV]\d+/.test(f);
            }).sort().reverse();
            
            if (versionDirs.length > 0) {
                const latestDir = path.join(fullPath, versionDirs[0]);
                const vFiles = fs.readdirSync(latestDir);
                for (const vf of vFiles.filter(f => f.includes('Description') && f.endsWith('.ts'))) {
                    descriptionContent += fs.readFileSync(path.join(latestDir, vf), 'utf8');
                }
            }

            // Parse parameters from the content
            const paramMatches = descriptionContent.matchAll(/\{\s*displayName:\s*['"]([^'"]+)['"],\s*name:\s*['"]([^'"]+)['"],\s*type:\s*['"]([^'"]+)['"]/g);
            
            for (const match of paramMatches) {
                const [_, displayName, name, type] = match;
                
                // Skip internal parameters
                if (['resource', 'operation', 'authentication'].includes(name)) continue;
                
                // Extract more info about this parameter
                const paramBlock = this.extractParamBlock(descriptionContent, name);
                
                parameters.push({
                    name,
                    displayName,
                    type,
                    required: paramBlock?.required ?? false,
                    default: paramBlock?.default,
                    description: paramBlock?.description,
                    options: paramBlock?.options,
                    showFor: paramBlock?.showFor
                });
            }
        } catch (error) {
            this.logger.debug(`Could not extract parameters for ${codePath}: ${error.message}`);
        }

        // Deduplicate by name
        const seen = new Set<string>();
        return parameters.filter(p => {
            if (seen.has(p.name)) return false;
            seen.add(p.name);
            return true;
        });
    }

    /**
     * Extract details about a specific parameter
     */
    private extractParamBlock(content: string, paramName: string): Partial<NodeParameter> | null {
        try {
            // Find the parameter block
            const regex = new RegExp(`name:\\s*['"]${paramName}['"][\\s\\S]*?(?=\\{\\s*displayName:|$)`, 'g');
            const match = content.match(regex);
            if (!match) return null;

            const block = match[0];
            
            const result: Partial<NodeParameter> = {};

            // Extract required
            const requiredMatch = block.match(/required:\s*(true|false)/);
            if (requiredMatch) result.required = requiredMatch[1] === 'true';

            // Extract default
            const defaultMatch = block.match(/default:\s*(['"]([^'"]*)['""]|(\d+)|(\w+))/);
            if (defaultMatch) result.default = defaultMatch[2] || defaultMatch[3] || defaultMatch[4];

            // Extract description
            const descMatch = block.match(/description:\s*['"]([^'"]+)['"]/);
            if (descMatch) result.description = descMatch[1];

            // Extract options
            const optionsMatch = block.match(/options:\s*\[([\s\S]*?)\]/);
            if (optionsMatch) {
                const options: { name: string; value: string }[] = [];
                const optMatches = optionsMatch[1].matchAll(/name:\s*['"]([^'"]+)['"],\s*value:\s*['"]([^'"]+)['"]/g);
                for (const opt of optMatches) {
                    options.push({ name: opt[1], value: opt[2] });
                }
                if (options.length > 0) result.options = options;
            }

            // Extract displayOptions (showFor)
            const displayOptionsMatch = block.match(/displayOptions:\s*\{[\s\S]*?show:\s*\{([\s\S]*?)\}/);
            if (displayOptionsMatch) {
                const showFor: { resource?: string[]; operation?: string[] } = {};
                
                const resourceMatch = displayOptionsMatch[1].match(/resource:\s*\[([^\]]+)\]/);
                if (resourceMatch) {
                    showFor.resource = resourceMatch[1].match(/['"]([^'"]+)['"]/g)?.map(s => s.replace(/['"]/g, ''));
                }
                
                const operationMatch = displayOptionsMatch[1].match(/operation:\s*\[([^\]]+)\]/);
                if (operationMatch) {
                    showFor.operation = operationMatch[1].match(/['"]([^'"]+)['"]/g)?.map(s => s.replace(/['"]/g, ''));
                }
                
                if (showFor.resource || showFor.operation) {
                    result.showFor = showFor;
                }
            }

            return result;
        } catch {
            return null;
        }
    }

    /**
     * Get the output schema for a specific node operation
     * Uses the __schema__ folder if available
     */
    async getNodeOperationSchema(nodeType: string, resource?: string, operation?: string): Promise<NodeOperationSchema | null> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return null;

        const entry = this.nodeIndex.nodes[nodeType] || 
                      this.nodeIndex.nodes[this.nodeIndex.aliases[nodeType.toLowerCase()]];
        
        if (!entry || !entry.hasSchema || !entry.schemaVersion) return null;

        // Use helper to parse codePath correctly
        const { relativePath, packageDir } = this.parseCodePath(entry.codePath);
        const schemaDir = path.join(this.PACKAGES_DIR, packageDir, 'nodes', relativePath, '__schema__', entry.schemaVersion);
        
        if (!fs.existsSync(schemaDir)) return null;

        try {
            let schemaPath: string | null = null;
            
            if (resource && operation) {
                // Look for resource/operation.json
                const resourceDir = path.join(schemaDir, resource);
                if (fs.existsSync(resourceDir)) {
                    const opFile = path.join(resourceDir, `${operation}.json`);
                    if (fs.existsSync(opFile)) {
                        schemaPath = opFile;
                    }
                }
            } else if (operation) {
                // Look directly for operation.json
                const opFile = path.join(schemaDir, `${operation}.json`);
                if (fs.existsSync(opFile)) {
                    schemaPath = opFile;
                }
            }

            if (schemaPath) {
                const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
                return {
                    resource: resource || '',
                    operation: operation || '',
                    outputSchema: schema
                };
            }
        } catch (error) {
            this.logger.debug(`Could not load schema for ${nodeType}: ${error.message}`);
        }

        return null;
    }

    /**
     * Get all available resources and operations for a node
     */
    async getNodeResourcesAndOperations(nodeType: string): Promise<NodeResource[] | null> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return null;

        const entry = this.nodeIndex.nodes[nodeType] || 
                      this.nodeIndex.nodes[this.nodeIndex.aliases[nodeType.toLowerCase()]];
        
        if (!entry) return null;

        // If we already have resources in the index, return them
        if (entry.resources && entry.resources.length > 0) {
            return entry.resources;
        }

        // Otherwise try to extract from schema folder
        if (entry.hasSchema && entry.schemaVersion) {
            // Use helper to parse codePath correctly
            const { relativePath, packageDir } = this.parseCodePath(entry.codePath);
            const schemaDir = path.join(this.PACKAGES_DIR, packageDir, 'nodes', relativePath, '__schema__', entry.schemaVersion);
            
            if (fs.existsSync(schemaDir)) {
                const resources: NodeResource[] = [];
                const items = fs.readdirSync(schemaDir);
                
                for (const item of items) {
                    const itemPath = path.join(schemaDir, item);
                    if (fs.statSync(itemPath).isDirectory()) {
                        const operations = fs.readdirSync(itemPath)
                            .filter(f => f.endsWith('.json'))
                            .map(f => ({
                                name: f.replace('.json', ''),
                                value: f.replace('.json', '')
                            }));
                        
                        if (operations.length > 0) {
                            resources.push({
                                name: item.charAt(0).toUpperCase() + item.slice(1),
                                value: item,
                                operations
                            });
                        }
                    }
                }
                
                return resources.length > 0 ? resources : null;
            }
        }

        return null;
    }
    /**
     * Get a list of all trigger nodes
     */
    async getTriggerNodes(): Promise<NodeSearchResult[]> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return [];

        return this.nodeIndex.triggerNodes.map(type => {
            const entry = this.nodeIndex!.nodes[type];
            return {
                type: entry.type,
                displayName: entry.displayName,
                description: entry.description,
                isTrigger: true,
                requiresCredentials: entry.credentials.length > 0,
                credentialTypes: entry.credentials.map(c => c.name)
            };
        });
    }

    /**
     * Get nodes by category
     */
    async getNodesByCategory(category: string): Promise<NodeSearchResult[]> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return [];

        const nodeTypes = this.nodeIndex.byCategory[category] || [];
        
        return nodeTypes.map(type => {
            const entry = this.nodeIndex!.nodes[type];
            return {
                type: entry.type,
                displayName: entry.displayName,
                description: entry.description,
                isTrigger: entry.isTrigger,
                requiresCredentials: entry.credentials.length > 0,
                credentialTypes: entry.credentials.map(c => c.name)
            };
        });
    }

    /**
     * Get credential info for setting up a node
     */
    async getNodeCredentialInfo(nodeType: string): Promise<{ credentials: NodeCredential[], instructions: string } | null> {
        if (!this.nodeIndex) await this.loadIndex();
        if (!this.nodeIndex) return null;

        const entry = this.nodeIndex.nodes[nodeType] || 
                      this.nodeIndex.nodes[this.nodeIndex.aliases[nodeType.toLowerCase()]];
        
        if (!entry) return null;

        const instructions = entry.credentials.length > 0
            ? `This node requires credentials. The user must configure the following credential type(s) in their n8n instance: ${entry.credentials.map(c => c.name).join(', ')}. After creating the workflow, instruct the user to: 1) Open the workflow in n8n UI, 2) Click on the ${entry.displayName} node, 3) Select or create the appropriate credentials.`
            : 'This node does not require credentials.';

        return {
            credentials: entry.credentials,
            instructions
        };
    }
}
