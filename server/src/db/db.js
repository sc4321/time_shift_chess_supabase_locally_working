import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

export function nowMs() {
  return Date.now();
}

export function makeId(prefix = '') {
  // URL-safe-ish, fine for internal IDs.
  return `${prefix}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}