import { Controller, Get, Post, Body } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
    constructor(private readonly settingsService: SettingsService) { }

    @Get()
    async getAll() {
        return this.settingsService.getAll();
    }

    @Post()
    async update(@Body() body: Record<string, string>) {
        for (const [key, value] of Object.entries(body)) {
            await this.settingsService.set(key, value);
        }
        return { success: true };
    }
}
