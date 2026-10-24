import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import * as schema from './schema.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const sqlite = new Database(config.dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export type Db = typeof db;

export function runMigrations(): void {
  migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
}

export function closeDb(): void {
  sqlite.close();
}
