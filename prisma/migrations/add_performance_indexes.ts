import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const prisma = new PrismaClient();

const indexStatements = [
  {
    table: 'students',
    name: 'students_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS students_created_at_idx ON students (created_at);',
  },
  {
    table: 'students',
    name: 'students_status_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS students_status_created_at_idx ON students (status, created_at);',
  },
  {
    table: 'students',
    name: 'students_institution_id_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS students_institution_id_created_at_idx ON students (institution_id, created_at);',
  },
  {
    table: 'security_events',
    name: 'security_events_user_id_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS security_events_user_id_created_at_idx ON security_events (user_id, created_at);',
  },
  {
    table: 'questions',
    name: 'questions_subject_id_chapter_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS questions_subject_id_chapter_id_idx ON questions (subject_id, chapter_id);',
  },
  {
    table: 'questions',
    name: 'questions_status_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS questions_status_created_at_idx ON questions (status, created_at);',
  },
  {
    table: 'exam_sections',
    name: 'exam_sections_subject_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS exam_sections_subject_id_idx ON exam_sections (subject_id);',
  },
  {
    table: 'attempts',
    name: 'attempts_student_id_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS attempts_student_id_created_at_idx ON attempts (student_id, created_at);',
  },
  {
    table: 'attempts',
    name: 'attempts_student_id_status_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS attempts_student_id_status_id_idx ON attempts (student_id, status_id);',
  },
  {
    table: 'exam_schedules',
    name: 'exam_schedules_exam_id_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS exam_schedules_exam_id_status_idx ON exam_schedules (exam_id, status);',
  },
  {
    table: 'candidate_ranks',
    name: 'candidate_ranks_student_id_rank_type_idx',
    sql: 'CREATE INDEX IF NOT EXISTS candidate_ranks_student_id_rank_type_idx ON candidate_ranks (student_id, rank_type);',
  },
  {
    table: 'bills',
    name: 'bills_institution_id_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS bills_institution_id_status_idx ON bills (institution_id, status);',
  },
  {
    table: 'bills',
    name: 'bills_status_created_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS bills_status_created_at_idx ON bills (status, created_at);',
  },
  {
    table: 'orders',
    name: 'orders_user_id_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_user_id_status_idx ON orders (user_id, status);',
  },
  {
    table: 'orders',
    name: 'orders_student_id_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_student_id_status_idx ON orders (student_id, status);',
  },
  {
    table: 'orders',
    name: 'orders_exam_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_exam_id_idx ON orders (exam_id);',
  },
  {
    table: 'payment_transactions',
    name: 'payment_transactions_student_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS payment_transactions_student_id_idx ON payment_transactions (student_id);',
  },
  {
    table: 'payment_transactions',
    name: 'payment_transactions_user_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS payment_transactions_user_id_idx ON payment_transactions (user_id);',
  },
  {
    table: 'exam_analysis_reports',
    name: 'exam_analysis_reports_student_id_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS exam_analysis_reports_student_id_status_idx ON exam_analysis_reports (student_id, status);',
  },
  {
    table: 'exam_analysis_reports',
    name: 'exam_analysis_reports_student_id_exam_id_idx',
    sql: 'CREATE INDEX IF NOT EXISTS exam_analysis_reports_student_id_exam_id_idx ON exam_analysis_reports (student_id, exam_id);',
  },
];

async function applyIndexes() {
  console.log('Applying database performance indexes...');
  await prisma.$connect();

  for (const idx of indexStatements) {
    const startTime = Date.now();
    try {
      await prisma.$executeRawUnsafe(idx.sql);
      const duration = Date.now() - startTime;
      console.log(`✓ [${idx.table}] ${idx.name} applied (${duration}ms)`);
    } catch (err: any) {
      console.error(`✗ [${idx.table}] ${idx.name} failed:`, err.message);
    }
  }

  console.log('\nAll performance indexes verified and active in PostgreSQL.');
  await prisma.$disconnect();
}

applyIndexes().catch((err) => {
  console.error('Fatal error applying indexes:', err);
  process.exit(1);
});
