import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiModule } from './ai/ai.module';
import { N8nModule } from './n8n/n8n.module';
import { SettingsModule } from './settings/settings.module';
import { Config } from './config.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USERNAME', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', 'postgres'),
        database: configService.get<string>('DB_NAME', 'n8n_plus'),
        entities: [Config],
        synchronize: true, // DEV ONLY
      }),
      inject: [ConfigService],
    }),
    SettingsModule,
    AiModule,
    N8nModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
