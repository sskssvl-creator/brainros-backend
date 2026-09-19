import { PrismaClient } from '@prisma/client';
import { SeedContext, SeederResult } from './seeders/types';
import { seedMasterData } from './seeders/01-master-data.seeder';
import { seedUsersAndRoles } from './seeders/02-users-and-roles.seeder';
import { seedInstitutions } from './seeders/03-institutions.seeder';
import { seedAcademicQuestions } from './seeders/04-academic-questions.seeder';
import { seedExamsAndBlueprints } from './seeders/05-exams-and-blueprints.seeder';
import { seedSchedulesAndAttempts } from './seeders/06-schedules-and-attempts.seeder';
import { seedResultsAndAnalytics } from './seeders/07-results-and-analytics.seeder';
import { seedNotificationsAndAudit } from './seeders/08-notifications-and-audit.seeder';
import { seedOrdersAndRevenue } from './seeders/09-orders-and-revenue.seeder';

const prisma = new PrismaClient();

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🚀 BRAINROS EXAM MANAGEMENT SYSTEM — DETERMINISTIC SEED PIPELINE');
  console.log('════════════════════════════════════════════════════════════════\n');

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== 'true') {
    console.error('❌ SAFETY ABORT: Seeding is disabled in production environment. To allow, run with ALLOW_PRODUCTION_SEED=true');
    process.exit(1);
  }

  const ctx: SeedContext = {
    prisma,
    roles: new Map(),
    permissions: new Map(),
    classes: new Map(),
    languages: new Map(),
    examTargets: new Map(),
    difficulties: new Map(),
    questionTypes: new Map(),
    examStatuses: new Map(),
    attemptStatuses: new Map(),
    states: new Map(),
    districts: new Map(),
    users: new Map(),
    students: new Map(),
    institutions: new Map(),
    batches: new Map(),
    subjects: new Map(),
    chapters: new Map(),
    topics: new Map(),
    subTopics: new Map(),
    questions: new Map(),
    questionOptions: new Map(),
    exams: new Map(),
    examSections: new Map(),
    examQuestions: new Map(),
    examVersions: new Map(),
    examSchedules: new Map(),
    attempts: new Map(),
    results: new Map(),
  };

  const seeders = [
    { step: 1, name: 'Master Data & Reference Enums', fn: seedMasterData },
    { step: 2, name: 'Users, Roles & Student Profiles', fn: seedUsersAndRoles },
    { step: 3, name: 'Institutions, Batches & Memberships', fn: seedInstitutions },
    { step: 4, name: 'Academic Hierarchy & Question Bank', fn: seedAcademicQuestions },
    { step: 5, name: 'Exams, Blueprints & Version Snapshots', fn: seedExamsAndBlueprints },
    { step: 6, name: 'Schedules, Lifecycle & Student Attempts', fn: seedSchedulesAndAttempts },
    { step: 7, name: 'Results, Analytics, Rankings & Predictions', fn: seedResultsAndAnalytics },
    { step: 8, name: 'Notifications, Reports, Audits & Feature Gates', fn: seedNotificationsAndAudit },
    { step: 9, name: 'Orders, Payments, Revenue & Sales Pipeline', fn: seedOrdersAndRevenue },
  ];

  const results: SeederResult[] = [];
  const totalStart = Date.now();

  for (const s of seeders) {
    console.log(`[${s.step}/${seeders.length}] Running ${s.name}...`);
    try {
      const res = await s.fn(ctx);
      results.push(res);
      console.log(`  ✓ Completed in ${res.timeMs}ms`);
    } catch (err) {
      console.error(`\n❌ Error in ${s.name}:`, err);
      throw err;
    }
  }

  const totalTime = Date.now() - totalStart;

  // Aggregate stats
  const totalCreated: Record<string, number> = {};
  const totalReused: Record<string, number> = {};

  for (const r of results) {
    for (const [k, v] of Object.entries(r.createdCounts)) {
      totalCreated[k] = (totalCreated[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(r.reusedCounts)) {
      totalReused[k] = (totalReused[k] || 0) + v;
    }
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('📊 DUMMY DATA SEEDING SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');

  const allKeys = Array.from(
    new Set([...Object.keys(totalCreated), ...Object.keys(totalReused)]),
  ).sort();

  console.log(
    'ENTITY'.padEnd(32) +
      'CREATED'.padStart(10) +
      'REUSED'.padStart(10) +
      'TOTAL'.padStart(10),
  );
  console.log('─'.repeat(62));

  for (const key of allKeys) {
    const c = totalCreated[key] || 0;
    const r = totalReused[key] || 0;
    console.log(
      key.padEnd(32) +
        String(c).padStart(10) +
        String(r).padStart(10) +
        String(c + r).padStart(10),
    );
  }

  console.log('─'.repeat(62));
  console.log(`✨ All seeders executed successfully in ${(totalTime / 1000).toFixed(2)}s ✅\n`);
}

main()
  .catch((e) => {
    console.error('Fatal seed failure:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
