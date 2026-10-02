import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prodEnvPath = path.resolve(__dirname, '../.env.production');
const devEnvPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else if (fs.existsSync(prodEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(prodEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
}

const prisma = new PrismaClient();

const ATTEMPT_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'AUTO_SUBMITTED',
  'EVALUATING',
  'EVALUATED',
  'CANCELLED',
  'FAILED',
  'TERMINATED',
  'EXPIRED',
  'COMPLETED',
];

const EXAM_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
  'PUBLISHED',
  'COMPLETED',
  'CANCELLED',
  'ENDED',
  'ARCHIVED',
  'SCHEDULED',
];

async function main() {
  console.log('--- Starting System Data Seeding ---');

  for (const name of ATTEMPT_STATUSES) {
    await prisma.attemptStatus.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`✓ Seeded ${ATTEMPT_STATUSES.length} AttemptStatuses.`);

  for (const name of EXAM_STATUSES) {
    await prisma.examStatus.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`✓ Seeded ${EXAM_STATUSES.length} ExamStatuses.`);

  console.log('--- Seeding Completed Successfully ---');
}

main()
  .catch((e) => {
    console.error('Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
