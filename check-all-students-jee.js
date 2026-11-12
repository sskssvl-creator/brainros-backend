const { PrismaClient } = require('./node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const students = await prisma.student.findMany({
    select: {
      id: true,
      userId: true,
      studentId: true,
      name: true,
      jee: true,
      neet: true,
      cet: true,
      examTargetId: true,
      examTarget: { select: { id: true, name: true } },
      studentExamTargets: {
        include: { examTarget: true }
      },
      user: {
        select: { email: true, phone: true }
      }
    }
  });

  console.log(`Total Students: ${students.length}`);
  for (const s of students) {
    const targets = [];
    if (s.examTarget?.name) targets.push(`Primary:${s.examTarget.name}`);
    s.studentExamTargets.forEach(st => targets.push(`Multi:${st.examTarget?.name}`));
    console.log(`- ${s.name || s.studentId} (${s.user?.email || s.user?.phone}): flags=[jee=${s.jee}, neet=${s.neet}, cet=${s.cet}], targets=[${targets.join(', ')}]`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);

