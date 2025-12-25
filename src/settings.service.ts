import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Config } from './config.entity';

@Injectable()
export class SettingsService {
    constructor(
        @InjectRepository(Config)
        private configRepository: Repository<Config>,
    ) { }

    async get(key: string): Promise<string | null> {
        const config = await this.configRepository.findOne({ where: { key } });
        return config ? config.value : null;
    }

    async set(key: string, value: string): Promise<void> {
        await this.configRepository.save({ key, value });
    }

    async getAll(): Promise<Record<string, string>> {
        const configs = await this.configRepository.find();
        return configs.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    }
}
