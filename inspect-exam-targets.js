const { PrismaClient } = require('./node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- EXAM TARGETS IN DB ---');
  const targets = await prisma.examTarget.findMany();
  console.log(targets);

  console.log('\n--- SCHEDULED EXAMS AND THEIR EXAM TARGETS ---');
  const exams = await prisma.exam.findMany({
    select: {
      id: true,
      title: true,
      examTargetId: true,
      examTarget: true,
      status: { select: { name: true } },
      schedules: {
        select: {
          id: true,
          status: true,
          startTime: true,
          endTime: true,
        }
      }
    }
  });
  console.log(JSON.stringify(exams, null, 2));

  console.log('\n--- SAMPLE STUDENTS AND THEIR EXAM TARGETS ---');
  const students = await prisma.student.findMany({
    take: 10,
    select: {
      id: true,
      userId: true,
      studentId: true,
      studentCode: true,
      jee: true,
      neet: true,
      cet: true,
      examTargetId: true,
      examTarget: true,
      studentExamTargets: {
        include: { examTarget: true }
      },
      user: {
        select: { email: true, phone: true }
      }
    }
  });
  console.log(JSON.stringify(students, null, 2));

  await prisma.$disconnect();
}

main().catch(console.error);
