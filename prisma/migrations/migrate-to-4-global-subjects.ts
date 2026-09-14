import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrate() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🔄 MIGRATING DATA TO GLOBAL 4-SUBJECT ARCHITECTURE');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Step 1: Alter subjects table to make exam_target_id nullable and create exam_target_subjects table
  console.log('1. Ensuring exam_target_subjects table exists and subjects table is prepared...');
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE subjects ALTER COLUMN exam_target_id DROP NOT NULL;`);
  } catch (e) {
    // Might already be nullable or dropped
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS exam_target_subjects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      exam_target_id UUID NOT NULL REFERENCES exam_targets(id) ON DELETE CASCADE,
      subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      display_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_exam_target_subject UNIQUE (exam_target_id, subject_id)
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_exam_target_subjects_target ON exam_target_subjects(exam_target_id)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_exam_target_subjects_subject ON exam_target_subjects(subject_id)
  `);

  // Step 2: Ensure the 4 canonical global subjects exist
  console.log('2. Ensuring 4 Global Subjects exist (Physics, Chemistry, Mathematics, Biology)...');
  const canonicalSubjectsDef = [
    { name: 'Physics', code: 'PHY', displayOrder: 1 },
    { name: 'Chemistry', code: 'CHEM', displayOrder: 2 },
    { name: 'Mathematics', code: 'MATH', displayOrder: 3 },
    { name: 'Biology', code: 'BIO', displayOrder: 4 },
  ];

  const canonicalSubjectMap = new Map<string, string>(); // name -> id

  for (const def of canonicalSubjectsDef) {
    const existing = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id, name FROM subjects WHERE LOWER(name) = LOWER($1) LIMIT 1
    `, def.name);

    let subId: string;
    if (!existing || existing.length === 0) {
      const inserted = await prisma.$queryRawUnsafe<any[]>(`
        INSERT INTO subjects (id, name, code, display_order, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, true, NOW(), NOW())
        RETURNING id, name
      `, def.name, def.code, def.displayOrder);
      subId = inserted[0].id;
      console.log(`  + Created canonical subject: ${def.name} (${subId})`);
    } else {
      subId = existing[0].id;
      await prisma.$executeRawUnsafe(`
        UPDATE subjects SET code = $1, display_order = $2, is_active = true, updated_at = NOW() WHERE id = $3::uuid
      `, def.code, def.displayOrder, subId);
      console.log(`  ✓ Reused canonical subject: ${def.name} (${subId})`);
    }
    canonicalSubjectMap.set(def.name, subId);
  }

  const physicsId = canonicalSubjectMap.get('Physics')!;
  const chemistryId = canonicalSubjectMap.get('Chemistry')!;
  const mathId = canonicalSubjectMap.get('Mathematics')!;
  const biologyId = canonicalSubjectMap.get('Biology')!;

  // Function to classify any legacy subject name into one of the 4 canonical subject IDs
  function getCanonicalSubjectId(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('physics')) return physicsId;
    if (lower.includes('chemistry')) return chemistryId;
    if (lower.includes('math')) return mathId;
    if (lower.includes('bio') || lower.includes('botany') || lower.includes('zoology')) return biologyId;
    return physicsId;
  }

  // Step 3: Fetch all existing subjects
  const allSubjects = await prisma.subject.findMany();
  console.log(`3. Found ${allSubjects.length} subjects in database. Mapping to 4 global subjects...`);

  const legacyToCanonicalMap = new Map<string, string>(); // legacy subject id -> canonical subject id
  for (const sub of allSubjects) {
    const canonicalId = getCanonicalSubjectId(sub.name);
    legacyToCanonicalMap.set(sub.id, canonicalId);
  }

  // Step 4: Migrate Chapters and merge duplicate chapters under canonical subjects
  console.log('4. Migrating & De-duplicating Chapters...');
  const allChapters = await prisma.chapter.findMany({
    orderBy: { createdAt: 'asc' },
  });
  console.log(`  Found ${allChapters.length} chapters.`);

  let chaptersMerged = 0;
  let chaptersMigrated = 0;

  for (const ch of allChapters) {
    const targetSubjectId = legacyToCanonicalMap.get(ch.subjectId) || physicsId;
    const cleanName = ch.name.trim();

    // Check if an existing chapter with this name already belongs to targetSubjectId
    const existingCanonicalChapter = await prisma.chapter.findFirst({
      where: {
        subjectId: targetSubjectId,
        name: { equals: cleanName, mode: 'insensitive' },
      },
    });

    if (existingCanonicalChapter && existingCanonicalChapter.id !== ch.id) {
      // Duplicate chapter - merge into existingCanonicalChapter
      const canonicalChapterId = existingCanonicalChapter.id;

      // 1. Re-point questions directly belonging to chapter
      await prisma.question.updateMany({
        where: { chapterId: ch.id },
        data: { chapterId: canonicalChapterId, subjectId: targetSubjectId },
      });

      // 2. Merge topics belonging to this duplicate chapter
      const duplicateTopics = await prisma.topic.findMany({ where: { chapterId: ch.id } });
      for (const t of duplicateTopics) {
        const canonicalTopic = await prisma.topic.findFirst({
          where: { chapterId: canonicalChapterId, name: { equals: t.name.trim(), mode: 'insensitive' } },
        });

        if (canonicalTopic && canonicalTopic.id !== t.id) {
          // Re-point questions referencing this duplicate topic
          await prisma.question.updateMany({
            where: { topicId: t.id },
            data: { topicId: canonicalTopic.id },
          });

          // Merge subtopics
          const duplicateSubTopics = await prisma.subTopic.findMany({ where: { topicId: t.id } });
          for (const st of duplicateSubTopics) {
            const canonicalSubTopic = await prisma.subTopic.findFirst({
              where: { topicId: canonicalTopic.id, name: { equals: st.name.trim(), mode: 'insensitive' } },
            });
            if (canonicalSubTopic && canonicalSubTopic.id !== st.id) {
              await prisma.question.updateMany({
                where: { subTopicId: st.id },
                data: { subTopicId: canonicalSubTopic.id },
              });
              await prisma.subTopic.delete({ where: { id: st.id } });
            } else {
              await prisma.subTopic.update({
                where: { id: st.id },
                data: { topicId: canonicalTopic.id },
              });
            }
          }

          // Delete duplicate topic
          await prisma.topic.delete({ where: { id: t.id } });
        } else {
          // Move topic to canonical chapter
          await prisma.topic.update({
            where: { id: t.id },
            data: { chapterId: canonicalChapterId },
          });
        }
      }

      // 3. Re-point chapterResults
      await prisma.chapterResult.updateMany({
        where: { chapterId: ch.id },
        data: { chapterId: canonicalChapterId },
      });

      // 4. Delete the duplicate chapter
      await prisma.chapter.delete({ where: { id: ch.id } });
      chaptersMerged++;
    } else {
      // Update this chapter to point to targetSubjectId
      await prisma.chapter.update({
        where: { id: ch.id },
        data: { subjectId: targetSubjectId, name: cleanName },
      });
      chaptersMigrated++;
    }
  }
  console.log(`  ✓ Chapters migrated: ${chaptersMigrated}, Duplicates merged & cleaned: ${chaptersMerged}`);

  // Step 5: Update remaining Questions pointing to legacy subjects
  console.log('5. Updating Question subject IDs...');
  for (const [legacyId, canonicalId] of legacyToCanonicalMap.entries()) {
    if (legacyId !== canonicalId) {
      await prisma.question.updateMany({
        where: { subjectId: legacyId },
        data: { subjectId: canonicalId },
      });
    }
  }

  // Step 6: Update ExamSection subject IDs
  console.log('6. Updating ExamSection subject IDs...');
  for (const [legacyId, canonicalId] of legacyToCanonicalMap.entries()) {
    if (legacyId !== canonicalId) {
      await prisma.examSection.updateMany({
        where: { subjectId: legacyId },
        data: { subjectId: canonicalId },
      });
    }
  }

  // Step 7: Update SubjectResult subject IDs
  console.log('7. Updating SubjectResult subject IDs...');
  const allSubjectResults = await prisma.subjectResult.findMany();
  for (const sr of allSubjectResults) {
    const canonicalId = legacyToCanonicalMap.get(sr.subjectId) || physicsId;
    if (sr.subjectId !== canonicalId) {
      const existing = await prisma.subjectResult.findFirst({
        where: { resultId: sr.resultId, subjectId: canonicalId },
      });
      if (existing && existing.id !== sr.id) {
        await prisma.subjectResult.delete({ where: { id: sr.id } });
      } else {
        await prisma.subjectResult.update({
          where: { id: sr.id },
          data: { subjectId: canonicalId },
        });
      }
    }
  }

  // Step 8: Delete obsolete duplicate subject records
  console.log('8. Removing obsolete duplicate subject records...');
  const canonicalIds = Array.from(canonicalSubjectMap.values());
  const deletedSubjects = await prisma.subject.deleteMany({
    where: {
      id: { notIn: canonicalIds },
    },
  });
  console.log(`  ✓ Removed ${deletedSubjects.count} obsolete subject records.`);

  // Step 9: Populate ExamTargetSubject mapping
  console.log('9. Populating ExamTargetSubject mappings for all targets...');
  const targets = await prisma.examTarget.findMany();

  for (const target of targets) {
    const tUpper = target.name.toUpperCase();
    const subjectsToMap: Array<{ id: string; order: number }> = [];

    if (tUpper === 'JEE' || tUpper === 'JEE_MAIN' || tUpper === 'JEE ADVANCED') {
      // JEE: Physics, Chemistry, Mathematics
      subjectsToMap.push({ id: physicsId, order: 1 });
      subjectsToMap.push({ id: chemistryId, order: 2 });
      subjectsToMap.push({ id: mathId, order: 3 });
    } else if (tUpper === 'NEET' || tUpper === 'NEET UG' || tUpper === 'NEET_UG') {
      // NEET: Physics, Chemistry, Biology
      subjectsToMap.push({ id: physicsId, order: 1 });
      subjectsToMap.push({ id: chemistryId, order: 2 });
      subjectsToMap.push({ id: biologyId, order: 3 });
    } else if (tUpper === 'CET' || tUpper.includes('CET')) {
      // CET / State CET: Physics, Chemistry, Mathematics, Biology
      subjectsToMap.push({ id: physicsId, order: 1 });
      subjectsToMap.push({ id: chemistryId, order: 2 });
      subjectsToMap.push({ id: mathId, order: 3 });
      subjectsToMap.push({ id: biologyId, order: 4 });
    } else {
      // General / Combo targets (e.g. NEET and JEE, CAT, etc.)
      if (tUpper.includes('JEE') || tUpper.includes('CAT') || tUpper.includes('MATH')) {
        subjectsToMap.push({ id: mathId, order: 3 });
      }
      if (tUpper.includes('NEET') || tUpper.includes('BIO')) {
        subjectsToMap.push({ id: biologyId, order: 4 });
      }
      subjectsToMap.unshift({ id: chemistryId, order: 2 });
      subjectsToMap.unshift({ id: physicsId, order: 1 });
    }

    // Insert into exam_target_subjects
    for (const sub of subjectsToMap) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO exam_target_subjects (id, exam_target_id, subject_id, display_order, created_at)
        VALUES (gen_random_uuid(), '${target.id}'::uuid, '${sub.id}'::uuid, ${sub.order}, NOW())
        ON CONFLICT (exam_target_id, subject_id) DO NOTHING;
      `);
    }
    console.log(`  ✓ Mapped ${subjectsToMap.length} subjects to Target '${target.name}'`);
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('✅ DATA MIGRATION TO 4 GLOBAL SUBJECTS COMPLETED SUCCESSFULLY');
  console.log('════════════════════════════════════════════════════════════════\n');
}

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
