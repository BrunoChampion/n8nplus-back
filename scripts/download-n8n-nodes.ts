/**
 * Download All n8n Node Packages Script
 * 
 * This script downloads all n8n node packages from the official repository
 * to ensure the AI agent has access to ALL available nodes.
 * 
 * Run with: npx ts-node scripts/download-n8n-nodes.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execSync } from 'child_process';

const CACHE_DIR = path.join(process.cwd(), '.n8n-nodes-cache');
const N8N_REPO = 'n8n-io/n8n';
const BRANCH = 'master';

// All packages that contain nodes
const NODE_PACKAGES = [
    'packages/nodes-base',           // Main nodes (Gmail, Slack, HTTP, etc.)
    'packages/@n8n/nodes-langchain', // AI/LangChain nodes (OpenAI, Anthropic, etc.)
];

async function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Follow redirect
                https.get(response.headers.location!, (redirectResponse) => {
                    redirectResponse.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                }).on('error', reject);
            } else {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }
        }).on('error', reject);
    });
}

async function downloadWithGit(): Promise<void> {
    console.log('Downloading n8n repository using sparse checkout...\n');
    
    // Check if git is available
    try {
        execSync('git --version', { stdio: 'pipe' });
    } catch {
        console.error('Git is not installed. Please install Git and try again.');
        process.exit(1);
    }
    
    const tempDir = path.join(CACHE_DIR, '.temp-clone');
    
    // Clean up existing temp directory
    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    try {
        // Initialize sparse checkout
        console.log('1. Initializing sparse checkout...');
        fs.mkdirSync(tempDir, { recursive: true });
        
        execSync(`git clone --filter=blob:none --no-checkout --depth 1 https://github.com/${N8N_REPO}.git "${tempDir}"`, {
            stdio: 'inherit'
        });
        
        process.chdir(tempDir);
        
        console.log('\n2. Setting up sparse checkout patterns...');
        execSync('git sparse-checkout init --cone', { stdio: 'inherit' });
        
        // Only checkout the node packages we need
        const patterns = NODE_PACKAGES.join(' ');
        execSync(`git sparse-checkout set ${patterns}`, { stdio: 'inherit' });
        
        console.log('\n3. Checking out files...');
        execSync('git checkout', { stdio: 'inherit' });
        
        // Copy to cache directory
        console.log('\n4. Copying to cache directory...');
        
        for (const pkg of NODE_PACKAGES) {
            const srcPath = path.join(tempDir, pkg);
            const pkgName = pkg.replace('packages/', '').replace('@n8n/', '');
            const destPath = path.join(CACHE_DIR, 'packages', pkgName);
            
            if (fs.existsSync(srcPath)) {
                // Ensure destination exists
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                
                // Copy recursively
                copyRecursive(srcPath, destPath);
                console.log(`   ✓ Copied ${pkg}`);
            } else {
                console.log(`   ⚠ Package not found: ${pkg}`);
            }
        }
        
        // Clean up temp directory
        process.chdir(CACHE_DIR);
        fs.rmSync(tempDir, { recursive: true, force: true });
        
        console.log('\n✅ Download complete!');
        
    } catch (error) {
        console.error('Error during download:', error.message);
        // Clean up on error
        try {
            process.chdir(CACHE_DIR);
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch {}
        throw error;
    }
}

function copyRecursive(src: string, dest: string): void {
    if (fs.statSync(src).isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        const items = fs.readdirSync(src);
        for (const item of items) {
            // Skip unnecessary directories
            if (['.git', 'node_modules', 'dist', 'coverage', '.turbo'].includes(item)) continue;
            copyRecursive(path.join(src, item), path.join(dest, item));
        }
    } else {
        fs.copyFileSync(src, dest);
    }
}

async function countNodes(): Promise<{ total: number; byPackage: Record<string, number> }> {
    const byPackage: Record<string, number> = {};
    let total = 0;
    
    const packagesDir = path.join(CACHE_DIR, 'packages');
    if (!fs.existsSync(packagesDir)) {
        return { total: 0, byPackage };
    }
    
    const packages = fs.readdirSync(packagesDir);
    
    for (const pkg of packages) {
        const nodesDir = path.join(packagesDir, pkg, 'nodes');
        if (!fs.existsSync(nodesDir)) continue;
        
        const countInDir = (dir: string): number => {
            let count = 0;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    count += countInDir(fullPath);
                } else if (item.endsWith('.node.ts')) {
                    count++;
                }
            }
            return count;
        };
        
        const count = countInDir(nodesDir);
        byPackage[pkg] = count;
        total += count;
    }
    
    return { total, byPackage };
}

async function main() {
    console.log('='.repeat(60));
    console.log('n8n Node Packages Downloader');
    console.log('='.repeat(60));
    console.log(`\nTarget directory: ${CACHE_DIR}`);
    console.log(`Packages to download: ${NODE_PACKAGES.length}`);
    console.log(NODE_PACKAGES.map(p => `  - ${p}`).join('\n'));
    console.log('');
    
    // Create cache directory
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    
    // Check current state
    const beforeCount = await countNodes();
    console.log(`Current node count: ${beforeCount.total}`);
    if (Object.keys(beforeCount.byPackage).length > 0) {
        for (const [pkg, count] of Object.entries(beforeCount.byPackage)) {
            console.log(`  - ${pkg}: ${count} nodes`);
        }
    }
    console.log('');
    
    // Download
    await downloadWithGit();
    
    // Count after download
    const afterCount = await countNodes();
    console.log(`\nFinal node count: ${afterCount.total}`);
    for (const [pkg, count] of Object.entries(afterCount.byPackage)) {
        console.log(`  - ${pkg}: ${count} nodes`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('Next step: Run "npm run build:node-index" to rebuild the index');
    console.log('='.repeat(60));
}

main().catch(console.error);
