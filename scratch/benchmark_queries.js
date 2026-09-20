const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runExplain(label, sql) {
  try {
    console.log(`\n========================================`);
    console.log(`QUERY: ${label}`);
    console.log(`SQL: ${sql}`);
    console.log(`========================================`);
    const result = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    for (const row of result) {
      console.log(row['QUERY PLAN']);
    }
  } catch (err) {
    console.error(`Error running EXPLAIN for ${label}:`, err.message);
  }
}

async function main() {
  try {
    await prisma.$connect();
    
    // Sample IDs from database
    const sampleStudent = await prisma.student.findFirst();
    const sampleExam = await prisma.exam.findFirst();
    const sampleUser = await prisma.user.findFirst();
    const sampleInstitution = await prisma.institution.findFirst();

    const studentId = sampleStudent ? sampleStudent.id : '00000000-0000-0000-0000-000000000000';
    const examId = sampleExam ? sampleExam.id : '00000000-0000-0000-0000-000000000000';
    const userId = sampleUser ? sampleUser.id : '00000000-0000-0000-0000-000000000000';
    const institutionId = sampleInstitution ? sampleInstitution.id : '00000000-0000-0000-0000-000000000000';

    await runExplain(
      '1. Student Attempt History (studentId + createdAt DESC)',
      `SELECT * FROM attempts WHERE student_id = '${studentId}'::uuid ORDER BY created_at DESC LIMIT 20`
    );

    await runExplain(
      '2. Student Attempt by Status (studentId + status_id)',
      `SELECT * FROM attempts WHERE student_id = '${studentId}'::uuid AND status_id = '00000000-0000-0000-0000-000000000000'::uuid`
    );

    await runExplain(
      '3. Admin Students List (institutionId + createdAt DESC)',
      `SELECT * FROM students WHERE institution_id = '${institutionId}'::uuid ORDER BY created_at DESC LIMIT 20`
    );

    await runExplain(
      '4. Active Students List (status + createdAt DESC)',
      `SELECT * FROM students WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 20`
    );

    await runExplain(
      '5. Billing / Invoices by Institution & Status',
      `SELECT * FROM bills WHERE institution_id = '${institutionId}'::uuid AND status = 'GENERATED' ORDER BY created_at DESC`
    );

    await runExplain(
      '6. Candidate Rank by Student & Rank Type',
      `SELECT * FROM candidate_ranks WHERE student_id = '${studentId}'::uuid AND rank_type = 'OVERALL'`
    );

    await runExplain(
      '7. Exam Schedule by Exam & Status',
      `SELECT * FROM exam_schedules WHERE exam_id = '${examId}'::uuid AND status = 'ACTIVE'`
    );

    await runExplain(
      '8. Payment Transactions by Student',
      `SELECT * FROM payment_transactions WHERE student_id = '${studentId}'::uuid`
    );

    await runExplain(
      '9. Exam Analysis Report by Student & Status',
      `SELECT * FROM exam_analysis_reports WHERE student_id = '${studentId}'::uuid AND status = 'PENDING'`
    );

    await runExplain(
      '10. Security Events by User & CreatedAt',
      `SELECT * FROM security_events WHERE user_id = '${userId}'::uuid ORDER BY created_at DESC LIMIT 20`
    );

  } finally {
    await prisma.$disconnect();
  }
}

main();
