import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { SettingsService } from '../settings.service';

@Injectable()
export class N8nService {
    private readonly logger = new Logger(N8nService.name);
    private axiosInstance: AxiosInstance;

    constructor(
        private configService: ConfigService,
        private settingsService: SettingsService,
    ) {
        this.updateInstance();
    }

    async updateInstance(baseUrl?: string, apiKey?: string) {
        const dbUrl = await this.settingsService.get('N8N_BASE_URL');
        const dbKey = await this.settingsService.get('N8N_API_KEY');

        let url = baseUrl || dbUrl || this.configService.get<string>('N8N_BASE_URL');
        const key = apiKey || dbKey || this.configService.get<string>('N8N_API_KEY');

        if (!url || !key) {
            this.logger.warn('n8n connection details not fully set');
            return;
        }

        // Normalize URL: remove trailing slashes
        url = url.replace(/\/+$/, '');

        this.axiosInstance = axios.create({
            baseURL: `${url}/api/v1`,
            headers: {
                'X-N8N-API-KEY': key,
            },
        });
    }

    async getWorkflows(params: any = {}) {
        try {
            const response = await this.axiosInstance.get('/workflows', { params });
            // n8n returns { data: [...] } for the list
            return response.data.data || response.data;
        } catch (error) {
            this.logger.error(`Failed to get workflows: ${error.message}`);
            throw error;
        }
    }

    async getWorkflow(id: string) {
        try {
            const response = await this.axiosInstance.get(`/workflows/${id}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to get workflow ${id}: ${error.message}`);
            throw error;
        }
    }

    async createWorkflow(workflow: any) {
        try {
            this.logger.log(`Creating workflow with name: ${workflow.name}`);
            const payload = {
                ...workflow,
                settings: workflow.settings || {},
                nodes: workflow.nodes || [],
                connections: workflow.connections || {},
            };
            const response = await this.axiosInstance.post('/workflows', payload);
            return response.data;
        } catch (error) {
            if (error.response) {
                this.logger.error(`Failed to create workflow: ${error.message}. Response data: ${JSON.stringify(error.response.data)}`);
            } else {
                this.logger.error(`Failed to create workflow: ${error.message}`);
            }
            throw error;
        }
    }

    // Helper to check if a string is a valid UUID
    private isValidUUID(str: string): boolean {
        if (!str) return false;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(str);
    }

    // Generate a simple UUID v4
    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async updateWorkflow(id: string, updates: any) {
        try {
            // STEP 1: Fetch the CURRENT workflow to get real node IDs and credentials
            const currentWorkflow = await this.getWorkflow(id);
            this.logger.debug(`Fetched current workflow ${id} for smart merge`);

            // STEP 2: Strip read-only fields from updates
            const {
                id: _id,
                active: _active,
                createdAt: _createdAt,
                updatedAt: _updatedAt,
                staticData: _staticData,
                shared: _shared,
                tags: _tags,
                ...cleanUpdates
            } = updates;

            // STEP 3: Smart merge nodes - preserve real IDs and credentials, fix fake IDs
            let mergedNodes = currentWorkflow.nodes;
            if (cleanUpdates.nodes && Array.isArray(cleanUpdates.nodes)) {
                mergedNodes = cleanUpdates.nodes.map((agentNode: any) => {
                    // Find matching node in current workflow by name
                    const originalNode = currentWorkflow.nodes.find(
                        (n: any) => n.name === agentNode.name
                    );

                    if (originalNode) {
                        // Check if original has a valid UUID, if not generate one
                        let nodeId = originalNode.id;
                        if (!this.isValidUUID(nodeId)) {
                            nodeId = this.generateUUID();
                            this.logger.warn(`Node "${originalNode.name}" had invalid ID, generated new: ${nodeId}`);
                        }

                        // Merge: preserve/fix ID, keep credentials, apply parameter updates
                        return {
                            ...originalNode,
                            id: nodeId,
                            parameters: {
                                ...originalNode.parameters,
                                ...(agentNode.parameters || {}),
                            },
                            position: agentNode.position || originalNode.position,
                            type: agentNode.type || originalNode.type,
                            typeVersion: agentNode.typeVersion || originalNode.typeVersion,
                        };
                    }
                    // New node from agent - ensure it has a valid UUID
                    if (!this.isValidUUID(agentNode.id)) {
                        const newId = this.generateUUID();
                        this.logger.warn(`New node "${agentNode.name}" had invalid ID "${agentNode.id}", generated: ${newId}`);
                        agentNode.id = newId;
                    }
                    return agentNode;
                });
            }

            // STEP 4: Build final payload
            const payload = {
                name: cleanUpdates.name || currentWorkflow.name,
                nodes: mergedNodes,
                connections: cleanUpdates.connections || currentWorkflow.connections,
                settings: cleanUpdates.settings || currentWorkflow.settings || {},
            };

            this.logger.debug(`updateWorkflow MERGED payload for ${id}: ${JSON.stringify(payload, null, 2)}`);

            const response = await this.axiosInstance.put(`/workflows/${id}`, payload);
            this.logger.log(`Successfully updated workflow ${id} with smart merge`);
            return response.data;
        } catch (error) {
            if (error.response) {
                this.logger.error(`Failed to update workflow ${id}: ${error.message}. Response data: ${JSON.stringify(error.response.data)}`);
            } else {
                this.logger.error(`Failed to update workflow ${id}: ${error.message}`);
            }
            throw error;
        }
    }

    async deleteWorkflow(id: string) {
        try {
            const response = await this.axiosInstance.delete(`/workflows/${id}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to delete workflow ${id}: ${error.message}`);
            throw error;
        }
    }

    async activateWorkflow(id: string) {
        try {
            const response = await this.axiosInstance.post(`/workflows/${id}/activate`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to activate workflow ${id}: ${error.message}`);
            throw error;
        }
    }

    async deactivateWorkflow(id: string) {
        try {
            const response = await this.axiosInstance.post(`/workflows/${id}/deactivate`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to deactivate workflow ${id}: ${error.message}`);
            throw error;
        }
    }

    async executeWorkflow(id: string, data: any = {}) {
        try {
            const response = await this.axiosInstance.post(`/workflows/${id}/execute`, data);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to execute workflow ${id}: ${error.message}`);
            throw error;
        }
    }

    async listExecutions(params: any = {}) {
        try {
            const response = await this.axiosInstance.get('/executions', { params });
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to list executions: ${error.message}`);
            throw error;
        }
    }

    async getExecution(id: string) {
        try {
            const response = await this.axiosInstance.get(`/executions/${id}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to get execution ${id}: ${error.message}`);
            throw error;
        }
    }

    async retryExecution(id: string, options: any = {}) {
        try {
            const response = await this.axiosInstance.post(`/executions/${id}/retry`, options);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to retry execution ${id}: ${error.message}`);
            throw error;
        }
    }

    async createCredential(data: any) {
        try {
            const response = await this.axiosInstance.post('/credentials', data);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to create credential: ${error.message}`);
            throw error;
        }
    }

    async listVariables(params: any = {}) {
        try {
            const response = await this.axiosInstance.get('/variables', { params });
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to list variables: ${error.message}`);
            throw error;
        }
    }

    async createVariable(data: any) {
        try {
            const response = await this.axiosInstance.post('/variables', data);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to create variable: ${error.message}`);
            throw error;
        }
    }

    async updateVariable(id: string, data: any) {
        try {
            const response = await this.axiosInstance.put(`/variables/${id}`, data);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to update variable ${id}: ${error.message}`);
            throw error;
        }
    }

    async deleteVariable(id: string) {
        try {
            const response = await this.axiosInstance.delete(`/variables/${id}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Failed to delete variable ${id}: ${error.message}`);
            throw error;
        }
    }

}
