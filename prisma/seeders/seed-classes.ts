import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

// Load .env.production if present, otherwise fallback to .env
const prodEnvPath = path.resolve(__dirname, '../../.env.production');
const devEnvPath = path.resolve(__dirname, '../../.env');

if (fs.existsSync(prodEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
}

const prisma = new PrismaClient();

const CLASSES = [
  {
    name: 'Class 11',
    description: 'Standard 11 / 1st PUC / Higher Secondary Year 1',
  },
  {
    name: 'Class 12',
    description: 'Standard 12 / 2nd PUC / Higher Secondary Year 2',
  },
  {
    name: 'Dropper',
    description: 'Repeater / Dropper batch preparing for competitive entrance exams',
  },
];

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('📚 SEEDING STUDENT CLASSES');
  console.log('════════════════════════════════════════════════════════════════\n');

  for (const item of CLASSES) {
    const seededClass = await prisma.studentClass.upsert({
      where: { name: item.name },
      update: {
        description: item.description,
      },
      create: {
        name: item.name,
        description: item.description,
      },
    });

    console.log(`  ✓ Class ready: ${seededClass.name} (ID: ${seededClass.id})`);
  }

  console.log('\n✨ All student classes seeded successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding student classes:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
