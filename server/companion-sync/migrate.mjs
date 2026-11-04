import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' },
});

const migrationsDirectory = new URL('./migrations/', import.meta.url);
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companion_schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const names = (await readdir(migrationsDirectory))
    .filter(name => /^\\d{4}_[a-z0-9_-]+\\.sql$/i.test(name))
    .sort();

  if (!names.length) throw new Error('NO_COMPANION_MIGRATIONS_FOUND');

  for (const name of names) {
    const existing = await pool.query(
      'SELECT 1 FROM companion_schema_migrations WHERE name = $1',
      [name],
    );
    if (existing.rowCount) {
      process.stdout.write(`Already applied: ${name}\\n`);
      continue;
    }

    const sql = await readFile(join(new URL('.', migrationsDirectory).pathname, name), 'utf8');
    await pool.query(sql);
    await pool.query(
      'INSERT INTO companion_schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [name],
    );
    process.stdout.write(`Applied: ${name}\\n`);
  }

  process.stdout.write('Companion sync schema is up to date.\\n');
} finally {
  await pool.end();
}
