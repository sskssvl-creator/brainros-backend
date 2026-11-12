const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("=== STARTING TARGET EXAMS DATA HEALING ===");

  // 1. Fetch canonical targets
  const allTargets = await prisma.examTarget.findMany();
  const targetMap = new Map();
  allTargets.forEach(t => targetMap.set(t.name.toUpperCase().trim(), t.id));

  console.log("Targets available:", Array.from(targetMap.keys()));

  // 2. Fix active exam d466b5a3-8347-4567-97e8-473c7f3fffa5
  const neetTargetId = targetMap.get('NEET');
  if (neetTargetId) {
    const updatedExam = await prisma.exam.update({
      where: { id: 'd466b5a3-8347-4567-97e8-473c7f3fffa5' },
      data: { examTargetId: neetTargetId },
      include: { examTarget: true }
    });
    console.log(`Updated Exam ${updatedExam.id} ("${updatedExam.title}") Target to -> ${updatedExam.examTarget.name} (${updatedExam.examTargetId})`);
  }

  // 3. Heal all students
  const students = await prisma.student.findMany({
    include: {
      user: { select: { email: true, name: true } },
      examTarget: true,
      studentExamTargets: { include: { examTarget: true } }
    }
  });

  for (const s of students) {
    const email = s.user?.email || '';
    let targetName = 'JEE';
    let jee = true;
    let neet = false;
    let cet = false;

    if (email === 'dhiraj@brainros.test') {
      // Dhiraj targets NEET + JEE
      targetName = 'NEET + JEE';
      jee = true;
      neet = true;
      cet = false;
    } else if (email === 'parthiv@brainros.test') {
      // Parthiv targets JEE + State CET
      targetName = 'JEE + State CET';
      jee = true;
      neet = false;
      cet = true;
    } else {
      // Nilesh and Students 4-8 target JEE
      targetName = 'JEE';
      jee = true;
      neet = false;
      cet = false;
    }

    const resolvedTargetId = targetMap.get(targetName.toUpperCase().trim()) || s.examTargetId;

    await prisma.student.update({
      where: { id: s.id },
      data: {
        examTargetId: resolvedTargetId,
        jee,
        neet,
        cet
      }
    });

    // Sync studentExamTargets junction table
    const constituentNames = [];
    if (jee) constituentNames.push('JEE');
    if (neet) constituentNames.push('NEET');
    if (cet) constituentNames.push('CET');

    // Ensure all constituent targets exist
    for (const cName of constituentNames) {
      const cId = targetMap.get(cName);
      if (cId) {
        await prisma.studentExamTarget.upsert({
          where: { studentId_examTargetId: { studentId: s.id, examTargetId: cId } },
          update: {},
          create: { studentId: s.id, examTargetId: cId, isPrimary: true }
        });
      }
    }

    // Remove any targets that shouldn't belong
    const allowedIds = constituentNames.map(n => targetMap.get(n)).filter(Boolean);
    await prisma.studentExamTarget.deleteMany({
      where: {
        studentId: s.id,
        examTargetId: { notIn: allowedIds }
      }
    });

    console.log(`Healed student ${s.user?.name} (${email}):`);
    console.log(`  -> Canonical Target: ${targetName} (${resolvedTargetId})`);
    console.log(`  -> Flags: jee=${jee}, neet=${neet}, cet=${cet}`);
    console.log(`  -> Constituent Targets: ${constituentNames.join(', ')}`);
  }

  console.log("=== HEALING COMPLETE ===");
}

main().catch(console.error).finally(() => prisma.$disconnect());

