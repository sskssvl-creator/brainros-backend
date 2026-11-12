const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

async function main() {
  console.log("=== EMPIRICAL VERIFICATION: STUDENT MULTI-TARGET EXAM ACCESS ===");

  const neetExam = await prisma.exam.findFirst({
    where: { id: 'd466b5a3-8347-4567-97e8-473c7f3fffa5' },
    include: { examTarget: true }
  });
  console.log(`Exam under test: "${neetExam.title}" -> Target: ${neetExam.examTarget.name} (${neetExam.examTargetId})`);

  const lang = await prisma.preferredLanguage.findFirst({ where: { isActive: true } });

  const students = await prisma.student.findMany({
    include: {
      user: {
        include: { userRoles: { include: { role: true } } }
      },
      examTarget: true,
      studentExamTargets: { include: { examTarget: true } }
    }
  });

  for (const s of students) {
    const roles = s.user.userRoles.map(ur => ur.role.name);
    const token = jwt.sign(
      {
        sub: s.user.id,
        userId: s.user.id,
        studentId: s.id,
        email: s.user.email,
        roles: roles.length > 0 ? roles : ['STUDENT'],
        type: 'access',
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const client = axios.create({
      baseURL: 'http://127.0.0.1:3000',
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`\n--------------------------------------------------------------`);
    console.log(`Student: ${s.user.name} (${s.user.email})`);
    console.log(`  Registered Target: ${s.examTarget?.name}`);
    console.log(`  Constituent Targets: ${s.studentExamTargets.map(t => t.examTarget?.name).join(', ')}`);
    console.log(`  Flags: jee=${s.jee}, neet=${s.neet}, cet=${s.cet}`);

    // Test 1: GET /students/me/exams
    try {
      const res = await client.get('/students/me/exams');
      const exams = res.data.data;
      const seenTitles = exams.map(e => `"${e.title}" (${e.examTarget})`);
      const hasNeetExam = exams.some(e => e.id === neetExam.id);

      console.log(`  Visible Exams (${exams.length}):`);
      seenTitles.forEach(t => console.log(`    - ${t}`));

      const isEligibleForNeet = s.neet || s.studentExamTargets.some(t => t.examTarget?.name === 'NEET');
      if (isEligibleForNeet) {
        if (hasNeetExam) {
          console.log(`  [PASS] Student targets NEET and SEES NEET Grand Mock Test!`);
        } else {
          console.error(`  [FAIL] Student targets NEET but DOES NOT see NEET Grand Mock Test!`);
        }
      } else {
        if (!hasNeetExam) {
          console.log(`  [PASS] Student targets ONLY JEE/CET and DOES NOT see NEET Grand Mock Test! (Strict target isolation verified)`);
        } else {
          console.error(`  [FAIL] Student targets ONLY JEE/CET but SEES NEET Grand Mock Test!`);
        }
      }
    } catch (err) {
      console.error(`  GET /students/me/exams failed:`, err.response?.data || err.message);
    }

    // Test 2: Access validation / Attempt Start
    try {
      const resStart = await client.post('/attempts/start', {
        examId: neetExam.id,
        languageId: lang.id
      });
      console.log(`  POST /attempts/start for NEET Exam: SUCCESS -> Attempt ID: ${resStart.data?.data?.id}`);
    } catch (err) {
      const errCode = err.response?.data?.code || err.response?.data?.message || err.message;
      console.log(`  POST /attempts/start for NEET Exam: BLOCKED (${err.response?.status}) -> ${JSON.stringify(errCode)}`);
    }
  }

  console.log(`\n==============================================================`);
  console.log(`Empirical verification complete.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());

