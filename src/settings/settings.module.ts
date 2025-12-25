import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Config } from '../config.entity';
import { SettingsService } from '../settings.service';
import { SettingsController } from '../settings.controller';

@Module({
    imports: [TypeOrmModule.forFeature([Config])],
    controllers: [SettingsController],
    providers: [SettingsService],
    exports: [SettingsService],
})
export class SettingsModule { }
