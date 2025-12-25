/**
 * Build Node Index Script
 * 
 * This script scans the .n8n-nodes-cache directory and generates a compact
 * node-index.json file that the AI agent can use efficiently.
 * 
 * Run with: npx ts-node scripts/build-node-index.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// All node packages to scan
const PACKAGES_DIR = path.join(process.cwd(), '.n8n-nodes-cache', 'packages');
const NODE_PACKAGES = [
    { dir: 'nodes-base', prefix: 'n8n-nodes-base' },
    { dir: 'nodes-langchain', prefix: '@n8n/n8n-nodes-langchain' },
];
const OUTPUT_FILE = path.join(process.cwd(), '.n8n-nodes-cache', 'node-index.json');

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

interface NodeParameter {
    name: string;
    displayName: string;
    type: string;
    required?: boolean;
    default?: any;
    description?: string;
    options?: { name: string; value: string }[];
    showFor?: { resource?: string[]; operation?: string[] };
}

interface NodeCredential {
    name: string;
    required: boolean;
}

interface NodeIndexEntry {
    type: string;                    // e.g., "n8n-nodes-base.gmail"
    displayName: string;             // e.g., "Gmail"
    name: string;                    // e.g., "gmail"
    description: string;
    group: string[];                 // e.g., ["transform"] or ["trigger"]
    version: number;                 // Latest/default version
    credentials: NodeCredential[];
    resources?: NodeResource[];      // For nodes with resource/operation pattern
    mainParameters?: NodeParameter[]; // Key parameters for simple nodes
    isTrigger: boolean;
    codePath: string;                // Relative path to the node folder
    hasSchema: boolean;              // Whether __schema__ folder exists
    schemaVersion?: string;          // e.g., "v2.1.0"
}

interface NodeIndex {
    generatedAt: string;
    totalNodes: number;
    nodes: Record<string, NodeIndexEntry>;
    byCategory: Record<string, string[]>;
    triggerNodes: string[];
    aliases: Record<string, string>;  // Common names -> node types
}

function extractCredentialsFromContent(content: string): NodeCredential[] {
    const credentials: NodeCredential[] = [];
    
    // Pattern 1: credentials array with objects
    const credBlockMatch = content.match(/credentials:\s*\[([\s\S]*?)\],?\s*(?:webhooks|waitingNodeTooltip|properties|inputs|outputs)/);
    if (credBlockMatch) {
        const credBlock = credBlockMatch[1];
        // Match each credential object
        const credObjMatches = credBlock.matchAll(/\{\s*name:\s*['"]([^'"]+)['"][\s\S]*?required:\s*(true|false)?/g);
        for (const match of credObjMatches) {
            const name = match[1];
            const required = match[2] === 'true';
            if (!credentials.find(c => c.name === name)) {
                credentials.push({ name, required });
            }
        }
    }
    
    // Pattern 2: Simple credential references
    const simpleCredMatches = content.matchAll(/credentials:\s*\[\s*\{\s*name:\s*['"]([^'"]+)['"]/g);
    for (const match of simpleCredMatches) {
        if (!credentials.find(c => c.name === match[1])) {
            credentials.push({ name: match[1], required: true });
        }
    }
    
    return credentials;
}

function extractNodeInfo(nodeFilePath: string): Partial<NodeIndexEntry> | null {
    try {
        let content = fs.readFileSync(nodeFilePath, 'utf8');
        
        // For versioned nodes, also read the version-specific file
        const nodeDir = path.dirname(nodeFilePath);
        const versionDirs = fs.readdirSync(nodeDir).filter(f => {
            const fp = path.join(nodeDir, f);
            return fs.existsSync(fp) && fs.statSync(fp).isDirectory() && /^[vV]\d+/.test(f);
        }).sort().reverse();
        
        // Read latest version file for additional info
        if (versionDirs.length > 0) {
            const latestVersionDir = path.join(nodeDir, versionDirs[0]);
            const versionFiles = fs.readdirSync(latestVersionDir).filter(f => f.endsWith('.node.ts'));
            for (const vf of versionFiles) {
                content += '\n' + fs.readFileSync(path.join(latestVersionDir, vf), 'utf8');
            }
        }
        
        // Extract displayName
        const displayNameMatch = content.match(/displayName:\s*['"]([^'"]+)['"]/);
        const displayName = displayNameMatch?.[1] || '';
        
        // Extract name (the actual node identifier)
        const nameMatch = content.match(/\bname:\s*['"]([^'"]+)['"]/);
        const name = nameMatch?.[1] || '';
        
        // Extract description
        const descriptionMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
        const description = descriptionMatch?.[1] || '';
        
        // Extract group
        const groupMatch = content.match(/group:\s*\[([^\]]+)\]/);
        const group = groupMatch?.[1]?.split(',').map(g => g.trim().replace(/['"]/g, '')) || [];
        
        // Extract version (defaultVersion or version array)
        const defaultVersionMatch = content.match(/defaultVersion:\s*([\d.]+)/);
        const versionArrayMatch = content.match(/version:\s*\[([^\]]+)\]/);
        let version = 1;
        if (defaultVersionMatch) {
            version = parseFloat(defaultVersionMatch[1]);
        } else if (versionArrayMatch) {
            const versions = versionArrayMatch[1].split(',').map(v => parseFloat(v.trim()));
            version = Math.max(...versions);
        }
        
        // Extract credentials using improved method
        const credentials = extractCredentialsFromContent(content);
        
        // Check if it's a trigger node
        const isTrigger = group.includes('trigger') || 
                          name.toLowerCase().includes('trigger') ||
                          content.includes('ITriggerFunctions') ||
                          content.includes('IWebhookFunctions');
        
        // Extract resources (for nodes with resource/operation pattern)
        const resources: NodeResource[] = [];
        const resourceMatch = content.match(/displayName:\s*['"]Resource['"][\s\S]*?options:\s*\[([\s\S]*?)\],\s*default:/);
        if (resourceMatch) {
            const resourceBlock = resourceMatch[1];
            const resourceOptions = resourceBlock.matchAll(/\{\s*name:\s*['"]([^'"]+)['"],\s*value:\s*['"]([^'"]+)['"]/g);
            for (const opt of resourceOptions) {
                resources.push({
                    name: opt[1],
                    value: opt[2],
                    operations: []
                });
            }
        }
        
        // Extract operations per resource
        const operationMatches = content.matchAll(/displayName:\s*['"]Operation['"][\s\S]*?options:\s*\[([\s\S]*?)\],\s*default:/g);
        for (const opMatch of operationMatches) {
            const opBlock = opMatch[1];
            const operations = opBlock.matchAll(/\{\s*name:\s*['"]([^'"]+)['"],\s*value:\s*['"]([^'"]+)['"](?:,\s*action:\s*['"]([^'"]+)['"])?/g);
            for (const op of operations) {
                // Add to all resources or find the right one based on displayOptions
                if (resources.length > 0) {
                    resources.forEach(r => {
                        if (!r.operations.find(o => o.value === op[2])) {
                            r.operations.push({
                                name: op[1],
                                value: op[2],
                                description: op[3] || undefined
                            });
                        }
                    });
                }
            }
        }
        
        return {
            displayName,
            name,
            description,
            group,
            version,
            credentials,
            resources: resources.length > 0 ? resources : undefined,
            isTrigger
        };
    } catch (error) {
        console.error(`Error parsing ${nodeFilePath}:`, error.message);
        return null;
    }
}

function findMainNodeFile(nodeDir: string): string | null {
    const files = fs.readdirSync(nodeDir);
    
    // Priority order for finding the main node file
    // 1. Direct .node.ts file in root
    const rootNodeFile = files.find(f => f.endsWith('.node.ts') && !f.includes('Trigger'));
    if (rootNodeFile) {
        return path.join(nodeDir, rootNodeFile);
    }
    
    // 2. Check for versioned directories (V2, v2, etc.) - prefer latest
    const versionDirs = files.filter(f => {
        const fullPath = path.join(nodeDir, f);
        return fs.statSync(fullPath).isDirectory() && /^[vV]\d+/.test(f);
    }).sort((a, b) => {
        const numA = parseInt(a.replace(/[vV]/g, ''));
        const numB = parseInt(b.replace(/[vV]/g, ''));
        return numB - numA; // Descending order (latest first)
    });
    
    for (const vDir of versionDirs) {
        const vPath = path.join(nodeDir, vDir);
        const vFiles = fs.readdirSync(vPath);
        const vNodeFile = vFiles.find(f => f.endsWith('.node.ts'));
        if (vNodeFile) {
            return path.join(vPath, vNodeFile);
        }
    }
    
    // 3. Trigger node file
    const triggerFile = files.find(f => f.endsWith('.node.ts'));
    if (triggerFile) {
        return path.join(nodeDir, triggerFile);
    }
    
    return null;
}

function findSchemaInfo(nodeDir: string): { hasSchema: boolean; schemaVersion?: string } {
    const schemaDir = path.join(nodeDir, '__schema__');
    if (!fs.existsSync(schemaDir)) {
        return { hasSchema: false };
    }
    
    try {
        const versions = fs.readdirSync(schemaDir)
            .filter(f => fs.statSync(path.join(schemaDir, f)).isDirectory())
            .sort()
            .reverse();
        
        return {
            hasSchema: true,
            schemaVersion: versions[0] || undefined
        };
    } catch {
        return { hasSchema: false };
    }
}

function getNodeJsonInfo(nodeDir: string): { node?: string; alias?: string[] } {
    const files = fs.readdirSync(nodeDir);
    const jsonFile = files.find(f => f.endsWith('.node.json'));
    
    if (!jsonFile) return {};
    
    try {
        const content = JSON.parse(fs.readFileSync(path.join(nodeDir, jsonFile), 'utf8'));
        return {
            node: content.node,
            alias: content.alias
        };
    } catch {
        return {};
    }
}

function scanNodes(dir: string, relativePath: string = '', defaultPrefix: string = 'n8n-nodes-base'): NodeIndexEntry[] {
    const entries: NodeIndexEntry[] = [];
    
    if (!fs.existsSync(dir)) {
        console.error(`Directory not found: ${dir}`);
        return entries;
    }
    
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
        if (item.startsWith('.') || item === '__schema__' || item === 'test') continue;
        
        const fullPath = path.join(dir, item);
        const itemRelativePath = relativePath ? `${relativePath}/${item}` : item;
        
        if (!fs.statSync(fullPath).isDirectory()) continue;
        
        // Check if this directory contains a .node.ts file (leaf node)
        const hasNodeFile = fs.readdirSync(fullPath).some(f => f.endsWith('.node.ts'));
        
        if (hasNodeFile) {
            const mainFile = findMainNodeFile(fullPath);
            if (!mainFile) continue;
            
            const nodeInfo = extractNodeInfo(mainFile);
            if (!nodeInfo || !nodeInfo.name) continue;
            
            const schemaInfo = findSchemaInfo(fullPath);
            const jsonInfo = getNodeJsonInfo(fullPath);
            
            // Determine the node type - use the JSON info or construct from prefix
            const nodeType = jsonInfo.node || `${defaultPrefix}.${nodeInfo.name}`;
            
            entries.push({
                type: nodeType,
                displayName: nodeInfo.displayName || item,
                name: nodeInfo.name,
                description: nodeInfo.description || '',
                group: nodeInfo.group || [],
                version: nodeInfo.version || 1,
                credentials: nodeInfo.credentials || [],
                resources: nodeInfo.resources,
                isTrigger: nodeInfo.isTrigger || false,
                codePath: `${defaultPrefix}/${itemRelativePath}`,
                hasSchema: schemaInfo.hasSchema,
                schemaVersion: schemaInfo.schemaVersion
            });
            
            // Also scan for trigger nodes in the same directory
            const triggerFile = fs.readdirSync(fullPath).find(f => 
                f.includes('Trigger') && f.endsWith('.node.ts')
            );
            
            if (triggerFile && !mainFile.includes('Trigger')) {
                const triggerInfo = extractNodeInfo(path.join(fullPath, triggerFile));
                if (triggerInfo && triggerInfo.name) {
                    const triggerType = `${defaultPrefix}.${triggerInfo.name}`;
                    entries.push({
                        type: triggerType,
                        displayName: triggerInfo.displayName || `${item} Trigger`,
                        name: triggerInfo.name,
                        description: triggerInfo.description || '',
                        group: triggerInfo.group || ['trigger'],
                        version: triggerInfo.version || 1,
                        credentials: triggerInfo.credentials || [],
                        resources: triggerInfo.resources,
                        isTrigger: true,
                        codePath: `${defaultPrefix}/${itemRelativePath}`,
                        hasSchema: schemaInfo.hasSchema,
                        schemaVersion: schemaInfo.schemaVersion
                    });
                }
            }
        } else {
            // Recurse into subdirectories
            const subEntries = scanNodes(fullPath, itemRelativePath, defaultPrefix);
            entries.push(...subEntries);
        }
    }
    
    return entries;
}

function buildIndex(): NodeIndex {
    console.log('Scanning all node packages in:', PACKAGES_DIR);
    
    let allEntries: NodeIndexEntry[] = [];
    
    for (const pkg of NODE_PACKAGES) {
        const nodesDir = path.join(PACKAGES_DIR, pkg.dir, 'nodes');
        if (fs.existsSync(nodesDir)) {
            console.log(`  - Scanning ${pkg.dir}...`);
            const entries = scanNodes(nodesDir, '', pkg.prefix);
            console.log(`    Found ${entries.length} nodes`);
            allEntries = allEntries.concat(entries);
        } else {
            console.log(`  - Skipping ${pkg.dir} (not found)`);
        }
    }
    
    const index: NodeIndex = {
        generatedAt: new Date().toISOString(),
        totalNodes: allEntries.length,
        nodes: {},
        byCategory: {},
        triggerNodes: [],
        aliases: {}
    };
    
    for (const entry of allEntries) {
        index.nodes[entry.type] = entry;
        
        // Categorize by group
        for (const group of entry.group) {
            if (!index.byCategory[group]) {
                index.byCategory[group] = [];
            }
            index.byCategory[group].push(entry.type);
        }
        
        // Track trigger nodes
        if (entry.isTrigger) {
            index.triggerNodes.push(entry.type);
        }
        
        // Build aliases
        const lowerName = entry.name.toLowerCase();
        const lowerDisplay = entry.displayName.toLowerCase();
        
        index.aliases[lowerName] = entry.type;
        index.aliases[lowerDisplay] = entry.type;
        
        // Add common variations
        if (lowerName !== lowerDisplay) {
            // Add without spaces
            index.aliases[lowerDisplay.replace(/\s+/g, '')] = entry.type;
        }
    }
    
    // Add manual aliases for common queries
    const manualAliases: Record<string, string> = {
        'email': 'n8n-nodes-base.gmail',
        'mail': 'n8n-nodes-base.gmail',
        'http': 'n8n-nodes-base.httpRequest',
        'api': 'n8n-nodes-base.httpRequest',
        'rest': 'n8n-nodes-base.httpRequest',
        'webhook': 'n8n-nodes-base.webhook',
        'hook': 'n8n-nodes-base.webhook',
        'cron': 'n8n-nodes-base.cron',
        'schedule': 'n8n-nodes-base.scheduleTrigger',
        'timer': 'n8n-nodes-base.scheduleTrigger',
        'if': 'n8n-nodes-base.if',
        'condition': 'n8n-nodes-base.if',
        'switch': 'n8n-nodes-base.switch',
        'code': 'n8n-nodes-base.code',
        'javascript': 'n8n-nodes-base.code',
        'js': 'n8n-nodes-base.code',
        'python': 'n8n-nodes-base.code',
        'set': 'n8n-nodes-base.set',
        'merge': 'n8n-nodes-base.merge',
        'split': 'n8n-nodes-base.splitInBatches',
        'wait': 'n8n-nodes-base.wait',
        'delay': 'n8n-nodes-base.wait',
        'slack': 'n8n-nodes-base.slack',
        'discord': 'n8n-nodes-base.discord',
        'telegram': 'n8n-nodes-base.telegram',
        'sheets': 'n8n-nodes-base.googleSheets',
        'google sheets': 'n8n-nodes-base.googleSheets',
        'spreadsheet': 'n8n-nodes-base.googleSheets',
        'drive': 'n8n-nodes-base.googleDrive',
        'google drive': 'n8n-nodes-base.googleDrive',
        'notion': 'n8n-nodes-base.notion',
        'airtable': 'n8n-nodes-base.airtable',
        'postgres': 'n8n-nodes-base.postgres',
        'postgresql': 'n8n-nodes-base.postgres',
        'mysql': 'n8n-nodes-base.mySql',
        'database': 'n8n-nodes-base.postgres',
        'db': 'n8n-nodes-base.postgres',
        'openai': 'n8n-nodes-base.openAi',
        'gpt': 'n8n-nodes-base.openAi',
        'chatgpt': 'n8n-nodes-base.openAi',
        'stripe': 'n8n-nodes-base.stripe',
        'shopify': 'n8n-nodes-base.shopify',
        'hubspot': 'n8n-nodes-base.hubspot',
        'salesforce': 'n8n-nodes-base.salesforce',
        'jira': 'n8n-nodes-base.jira',
        'github': 'n8n-nodes-base.github',
        'gitlab': 'n8n-nodes-base.gitlab',
        'aws': 'n8n-nodes-base.awsS3',
        's3': 'n8n-nodes-base.awsS3',
        'ftp': 'n8n-nodes-base.ftp',
        'sftp': 'n8n-nodes-base.ftp',
        'ssh': 'n8n-nodes-base.ssh',
        'xml': 'n8n-nodes-base.xml',
        'json': 'n8n-nodes-base.code',
        'csv': 'n8n-nodes-base.spreadsheetFile',
        'excel': 'n8n-nodes-base.microsoftExcel',
        'pdf': 'n8n-nodes-base.readPdf',
        // AI/LangChain nodes aliases (from @n8n/nodes-langchain package)
        'ai': '@n8n/n8n-nodes-langchain.agent',
        'agent': '@n8n/n8n-nodes-langchain.agent',
        'llm': '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        'chat': '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        'anthropic': '@n8n/n8n-nodes-langchain.lmChatAnthropic',
        'claude': '@n8n/n8n-nodes-langchain.lmChatAnthropic',
        'gemini': '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
        'mistral': '@n8n/n8n-nodes-langchain.lmChatMistralCloud',
        'ollama': '@n8n/n8n-nodes-langchain.lmChatOllama',
        'embedding': '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
        'embeddings': '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
        'vector store': '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
        'vectorstore': '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
        'pinecone': '@n8n/n8n-nodes-langchain.vectorStorePinecone',
        'qdrant': '@n8n/n8n-nodes-langchain.vectorStoreQdrant',
        'supabase vector': '@n8n/n8n-nodes-langchain.vectorStoreSupabase',
        'memory': '@n8n/n8n-nodes-langchain.memoryBufferWindow',
        'chain': '@n8n/n8n-nodes-langchain.chainLlm',
        'retrieval': '@n8n/n8n-nodes-langchain.chainRetrievalQa',
        'rag': '@n8n/n8n-nodes-langchain.chainRetrievalQa',
        'text splitter': '@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter',
        'document loader': '@n8n/n8n-nodes-langchain.documentDefaultDataLoader',
        'tool': '@n8n/n8n-nodes-langchain.toolCode',
    };
    
    for (const [alias, nodeType] of Object.entries(manualAliases)) {
        if (index.nodes[nodeType]) {
            index.aliases[alias] = nodeType;
        }
    }
    
    return index;
}

// Run the build
console.log('Building node index...');
const index = buildIndex();

// Write to file
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index, null, 2), 'utf8');
console.log(`\nNode index built successfully!`);
console.log(`- Total nodes indexed: ${index.totalNodes}`);
console.log(`- Categories: ${Object.keys(index.byCategory).join(', ')}`);
console.log(`- Trigger nodes: ${index.triggerNodes.length}`);
console.log(`- Output: ${OUTPUT_FILE}`);
