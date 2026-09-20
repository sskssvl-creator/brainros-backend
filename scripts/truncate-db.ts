import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

import * as fs from 'fs';

// Explicitly load .env.production with override: true
const envPath = path.resolve(__dirname, '../.env.production');
const envConfig = dotenv.parse(fs.readFileSync(envPath));
const databaseUrl = envConfig.DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('❌ Error: DATABASE_URL is not defined in .env.production');
  process.exit(1);
}

// Mask connection string for safe logging
const maskedUrl = databaseUrl.replace(/:([^:@]+)@/, ':****@');
console.log('════════════════════════════════════════════════════════════════');
console.log('🗑️  DATABASE TRUNCATE UTILITY');
console.log('════════════════════════════════════════════════════════════════');
console.log(`Target Database: ${maskedUrl}\n`);

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

async function truncateAllTables() {
  try {
    console.log('🔍 Fetching all tables in public schema...');
    
    // Query table names in public schema, excluding prisma migrations table
    const tablenames = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
        AND tablename != '_prisma_migrations';
    `;

    if (!tablenames || tablenames.length === 0) {
      console.log('ℹ️ No user tables found to truncate.');
      return;
    }

    console.log(`Found ${tablenames.length} tables to truncate:`);
    const formattedNames = tablenames.map((t) => `"${t.tablename}"`).join(', ');

    console.log('\n⏳ Truncating tables with CASCADE...');
    
    // Truncate all tables in a single statement with CASCADE to handle foreign keys
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${formattedNames} RESTART IDENTITY CASCADE;`);

    console.log('✅ Successfully truncated all tables!\n');
    console.log('Summary of truncated tables:');
    tablenames.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.tablename}`);
    });
    console.log('\n✨ Database reset complete! All table data cleared.');
  } catch (error) {
    console.error('❌ Error during truncation:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

truncateAllTables();
