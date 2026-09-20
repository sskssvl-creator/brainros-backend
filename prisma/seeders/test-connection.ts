/**
 * Quick database connection test script.
 * Run with: npx ts-node prisma/test-connection.ts
 * Uses DATABASE_URL from .env (local) or set NODE_ENV=production to use .env.production
 */

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load the appropriate env file
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });

const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

async function testConnection() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  DATABASE CONNECTION TEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Mask credentials in the URL for safe logging
  const rawUrl = process.env.DATABASE_URL || '';
  try {
    const url = new URL(rawUrl);
    console.log(`  Target : ${url.protocol}//${url.host}${url.pathname}`);
    console.log(`  Pooler : ${url.host.includes('-pooler') ? '✅ YES (pooled endpoint)' : '⚠️  NO  (direct endpoint — consider using pooler for production)'}`);
  } catch {
    console.log('  ⚠️  DATABASE_URL is not set or malformed');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const start = Date.now();

  try {
    console.log('⏳ Connecting...');
    await prisma.$connect();
    const elapsed = Date.now() - start;
    console.log(`✅ Connected in ${elapsed}ms\n`);

    // Run a simple query to verify the DB is queryable
    console.log('⏳ Running test query...');
    const result = await prisma.$queryRaw<[{ now: Date }]>`SELECT NOW() as now`;
    console.log(`✅ Query OK — DB server time: ${result[0].now.toISOString()}\n`);

    // Count a few core tables to confirm schema is migrated
    console.log('⏳ Checking core tables...');
    const [users, exams] = await Promise.all([
      prisma.user.count(),
      prisma.exam.count(),
    ]);
    console.log(`  users : ${users} rows`);
    console.log(`  exams : ${exams} rows`);
    console.log('\n✅ All checks passed — database is healthy!\n');
  } catch (err: any) {
    const elapsed = Date.now() - start;
    console.error(`\n❌ Connection FAILED after ${elapsed}ms`);
    console.error(`   Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

testConnection();
