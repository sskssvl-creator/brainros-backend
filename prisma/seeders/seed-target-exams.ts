import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

// Load .env.production if present, otherwise fallback to .env
const prodEnvPath = path.resolve(__dirname, '../../.env.production');
const devEnvPath = path.resolve(__dirname, '../../.env');

if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else if (fs.existsSync(prodEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
}

const prisma = new PrismaClient();

const TARGET_EXAMS = [
  {
    name: 'JEE',
    description: 'Joint Entrance Examination (Engineering)',
  },
  {
    name: 'CET',
    description: 'Common Entrance Test (State Level)',
  },
  {
    name: 'NEET',
    description: 'National Eligibility cum Entrance Test (Medical)',
  },
  {
    name: 'NEET + JEE',
    description: 'Combined preparation for NEET (Medical) and JEE (Engineering)',
  },
  {
    name: 'NEET + State CET',
    description: 'Combined preparation for NEET and State CET',
  },
  {
    name: 'JEE + State CET',
    description: 'Combined preparation for JEE (National) and State CET',
  },
  {
    name: 'JEE + NEET + State CET',
    description: 'Comprehensive combo covering JEE, NEET, and State CET exams',
  },
  {
    name: 'NEET and JEE',
    description: 'Combined preparation for NEET (Medical) and JEE (Engineering)',
  },
  {
    name: 'NEET and State CET',
    description: 'Combined preparation for NEET and State CET',
  },
  {
    name: 'JEE and State CET',
    description: 'Combined preparation for JEE (National) and State CET',
  },
  {
    name: 'JEE, NEET and State CET',
    description: 'Comprehensive combo covering JEE, NEET, and State CET exams',
  },
];

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🎯 SEEDING TARGET EXAMS');
  console.log('════════════════════════════════════════════════════════════════\n');

  for (const target of TARGET_EXAMS) {
    const upserted = await prisma.examTarget.upsert({
      where: { name: target.name },
      update: {
        description: target.description,
      },
      create: {
        name: target.name,
        description: target.description,
      },
    });

    console.log(`  ✓ Target Exam ready: ${upserted.name} (ID: ${upserted.id})`);
  }

  const allTargets = await prisma.examTarget.findMany({ orderBy: { name: 'asc' } });
  console.log(`\n✨ Total Target Exams in Database: ${allTargets.length}`);
  allTargets.forEach((t, index) => {
    console.log(`  ${index + 1}. ${t.name}`);
  });
  console.log('\n✨ All target exams seeded successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding target exams:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
