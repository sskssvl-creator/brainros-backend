import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

if (fs.existsSync('.env.production')) {
  dotenv.config({ path: '.env.production' });
} else {
  dotenv.config();
}

const prisma = new PrismaClient();

async function main() {
  console.log('Connecting to database and adding rich content columns...');

  const sqlStatements = [
    // 1. questions
    `ALTER TABLE questions ADD COLUMN IF NOT EXISTS question_content JSONB;`,
    `ALTER TABLE questions ADD COLUMN IF NOT EXISTS passage_content JSONB;`,
    `ALTER TABLE questions ADD COLUMN IF NOT EXISTS assertion_content JSONB;`,
    `ALTER TABLE questions ADD COLUMN IF NOT EXISTS reason_content JSONB;`,

    // 2. question_options
    `ALTER TABLE question_options ADD COLUMN IF NOT EXISTS option_content JSONB;`,

    // 3. question_translations
    `ALTER TABLE question_translations ADD COLUMN IF NOT EXISTS question_content JSONB;`,
    `ALTER TABLE question_translations ADD COLUMN IF NOT EXISTS passage_content JSONB;`,
    `ALTER TABLE question_translations ADD COLUMN IF NOT EXISTS assertion_content JSONB;`,
    `ALTER TABLE question_translations ADD COLUMN IF NOT EXISTS reason_content JSONB;`,

    // 4. question_option_translations
    `ALTER TABLE question_option_translations ADD COLUMN IF NOT EXISTS option_content JSONB;`,

    // 5. exam_version_questions
    `ALTER TABLE exam_version_questions ADD COLUMN IF NOT EXISTS question_content JSONB;`,
    `ALTER TABLE exam_version_questions ADD COLUMN IF NOT EXISTS passage_content JSONB;`,
    `ALTER TABLE exam_version_questions ADD COLUMN IF NOT EXISTS assertion_content JSONB;`,
    `ALTER TABLE exam_version_questions ADD COLUMN IF NOT EXISTS reason_content JSONB;`,

    // 6. exam_version_options
    `ALTER TABLE exam_version_options ADD COLUMN IF NOT EXISTS option_content JSONB;`,

    // 7. exam_version_translations
    `ALTER TABLE exam_version_translations ADD COLUMN IF NOT EXISTS question_content JSONB;`,
    `ALTER TABLE exam_version_translations ADD COLUMN IF NOT EXISTS passage_content JSONB;`,
    `ALTER TABLE exam_version_translations ADD COLUMN IF NOT EXISTS assertion_content JSONB;`,
    `ALTER TABLE exam_version_translations ADD COLUMN IF NOT EXISTS reason_content JSONB;`,

    // 8. exam_version_option_translations
    `ALTER TABLE exam_version_option_translations ADD COLUMN IF NOT EXISTS option_content JSONB;`,
  ];

  for (const sql of sqlStatements) {
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log(`Executed: ${sql}`);
    } catch (err: any) {
      console.warn(`Error running "${sql}":`, err.message);
    }
  }

  console.log('All rich content columns added successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
