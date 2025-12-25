import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('configs')
export class Config {
    @PrimaryColumn()
    key: string;

    @Column({ type: 'text' })
    value: string;

    @UpdateDateColumn()
    updatedAt: Date;
}
