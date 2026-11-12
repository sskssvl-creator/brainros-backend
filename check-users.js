const { PrismaClient } = require('./node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    include: {
      student: {
        include: {
          examTarget: true,
          studentExamTargets: { include: { examTarget: true } }
        }
      },
      userRoles: { include: { role: true } }
    }
  });

  console.log(`Total Users in DB: ${users.length}`);
  for (const u of users) {
    const roles = u.userRoles.map(ur => ur.role.name).join(', ');
    console.log(`- User ${u.email || u.phone} (${roles}): studentId=${u.student?.id || 'NO_STUDENT_PROFILE'}`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);

