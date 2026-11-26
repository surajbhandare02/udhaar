import { client } from '../db.js';

async function run() {
  console.log('--- Database Query Latency Benchmark ---');

  const pingStart = performance.now();
  await client.execute('SELECT 1 as ping');
  const pingTime = performance.now() - pingStart;
  console.log(`Single Ping Roundtrip: ${pingTime.toFixed(2)} ms`);

  // Sequential Queries (current /api/summary implementation)
  const seqStart = performance.now();
  await client.execute('SELECT id, name, balance FROM accounts ORDER BY id');
  await client.execute(`
    SELECT
      SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
      SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income
    FROM transactions
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `);
  await client.execute('SELECT COALESCE(SUM(net_balance), 0) AS total FROM people WHERE net_balance > 0');
  const seqTime = performance.now() - seqStart;
  console.log(`Sequential 3 Queries (/api/summary current): ${seqTime.toFixed(2)} ms`);

  // Parallel Queries (Promise.all)
  const parStart = performance.now();
  await Promise.all([
    client.execute('SELECT id, name, balance FROM accounts ORDER BY id'),
    client.execute(`
      SELECT
        SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
        SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income
      FROM transactions
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `),
    client.execute('SELECT COALESCE(SUM(net_balance), 0) AS total FROM people WHERE net_balance > 0')
  ]);
  const parTime = performance.now() - parStart;
  console.log(`Parallel 3 Queries (Promise.all): ${parTime.toFixed(2)} ms`);

  // Batch query (single HTTP roundtrip to Turso via client.batch)
  const batchStart = performance.now();
  await client.batch([
    'SELECT id, name, balance FROM accounts ORDER BY id',
    `SELECT
      SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
      SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income
    FROM transactions
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
    'SELECT COALESCE(SUM(net_balance), 0) AS total FROM people WHERE net_balance > 0'
  ], 'read');
  const batchTime = performance.now() - batchStart;
  console.log(`Single HTTP Batch Pipeline (client.batch): ${batchTime.toFixed(2)} ms`);
}

run().catch(console.error);
