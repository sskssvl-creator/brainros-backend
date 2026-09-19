import { SeedContext, SeederResult } from './types';
import {
  InstitutionType,
  InstitutionStatus,
  BatchStatus,
  BatchStudentStatus,
  BulkUploadStatus,
  ApprovalRequestStatus,
} from '@prisma/client';

export async function seedInstitutions(ctx: SeedContext): Promise<SeederResult> {
  const start = Date.now();
  const created: Record<string, number> = {};
  const reused: Record<string, number> = {};

  const inc = (type: string, isNew: boolean) => {
    if (isNew) created[type] = (created[type] || 0) + 1;
    else reused[type] = (reused[type] || 0) + 1;
  };

  const { prisma } = ctx;
  const superAdmin = ctx.users.get('superadmin@brainros.test')!;

  const institutionsData = [
    {
      name: 'Allen Career Institute - Kota',
      code: 'INST_ALLEN',
      type: InstitutionType.COACHING,
      status: InstitutionStatus.ACTIVE,
      email: 'allen.kota@brainros.test',
      phone: '+917442757575',
      address: 'CP Tower 1, Road No. 1, IPIA',
      city: 'Kota',
      state: 'Rajasthan',
      adminEmail: 'inst.allen@brainros.test',
      batches: [
        { name: 'NEET-2026-Achiever-A', target: 'NEET', classLevel: 'CLASS_12' },
        { name: 'JEE-2026-Leader-A', target: 'JEE_MAIN', classLevel: 'CLASS_12' },
      ],
    },
    {
      name: 'Aakash Educational Services - Delhi HQ',
      code: 'INST_AAKASH',
      type: InstitutionType.COACHING,
      status: InstitutionStatus.ACTIVE,
      email: 'aakash.delhi@brainros.test',
      phone: '+911147623456',
      address: 'Aakash Tower, 8 Pusa Road',
      city: 'New Delhi',
      state: 'Delhi',
      adminEmail: 'inst.aakash@brainros.test',
      batches: [
        { name: 'NEET-2026-Medical-Alpha', target: 'NEET', classLevel: 'CLASS_12' },
        { name: 'NEET-2027-Foundation-Alpha', target: 'NEET', classLevel: 'CLASS_11' },
      ],
    },
    {
      name: 'Resonance Eduventures - Kota',
      code: 'INST_RESONANCE',
      type: InstitutionType.COACHING,
      status: InstitutionStatus.ACTIVE,
      email: 'resonance.kota@brainros.test',
      phone: '+917442777777',
      address: 'CG Tower, A-46 & 52, IPIA',
      city: 'Kota',
      state: 'Rajasthan',
      adminEmail: 'inst.resonance@brainros.test',
      batches: [
        { name: 'JEE-2026-Pinnacle-Batch', target: 'JEE_ADVANCED', classLevel: 'DROPPER' },
      ],
    },
    {
      name: 'FIITJEE - Hyderabad Centre',
      code: 'INST_FIITJEE',
      type: InstitutionType.COACHING,
      status: InstitutionStatus.ACTIVE,
      email: 'fiitjee.hyd@brainros.test',
      phone: '+914066778899',
      address: 'FIITJEE House, Saifabad',
      city: 'Hyderabad',
      state: 'Telangana',
      adminEmail: 'inst.fiitjee@brainros.test',
      batches: [
        { name: 'JEE-2026-Supreme-Batch', target: 'JEE_MAIN', classLevel: 'CLASS_12' },
      ],
    },
  ];

  const studentList = Array.from(ctx.students.values());
  let studentAllocationIdx = 0;

  for (const instData of institutionsData) {
    let institution = await prisma.institution.findUnique({ where: { code: instData.code } });
    if (!institution) {
      institution = await prisma.institution.create({
        data: {
          name: instData.name,
          code: instData.code,
          type: instData.type,
          status: instData.status,
          email: instData.email,
          phone: instData.phone,
          address: instData.address,
          city: instData.city,
          state: instData.state,
          createdById: superAdmin.id,
        },
      });
      inc('institutions', true);
    } else {
      inc('institutions', false);
    }
    ctx.institutions.set(instData.code, institution);

    // Link Institution Admin
    const adminUser = ctx.users.get(instData.adminEmail);
    if (adminUser) {
      const existingAdmin = await prisma.institutionAdmin.findFirst({
        where: { institutionId: institution.id, userId: adminUser.id },
      });
      if (existingAdmin) {
        await prisma.institutionAdmin.update({
          where: { id: existingAdmin.id },
          data: { isActive: true },
        });
        inc('institution_admins', false);
      } else {
        await prisma.institutionAdmin.create({
          data: {
            institutionId: institution.id,
            userId: adminUser.id,
            role: 'ADMIN',
            isActive: true,
          },
        });
        inc('institution_admins', true);
      }
    }

    // Create Batches
    for (const bData of instData.batches) {
      const targetObj = ctx.examTargets.get(bData.target) || ctx.examTargets.get('NEET');
      let batch = await prisma.institutionBatch.findFirst({
        where: {
          institutionId: institution.id,
          name: bData.name,
        },
      });

      if (!batch) {
        batch = await prisma.institutionBatch.create({
          data: {
            institutionId: institution.id,
            name: bData.name,
            academicYear: '2026-2027',
            classLevel: bData.classLevel,
            examTargetId: targetObj?.id,
            status: BatchStatus.ACTIVE,
            startDate: new Date('2026-04-01'),
            endDate: new Date('2027-03-31'),
            createdById: superAdmin.id,
          },
        });
        inc('institution_batches', true);
      } else {
        inc('institution_batches', false);
      }
      ctx.batches.set(`${instData.code}:${bData.name}`, batch);

      // Assign 5 students to this batch
      for (let i = 0; i < 5; i++) {
        if (studentAllocationIdx < studentList.length) {
          const student = studentList[studentAllocationIdx++];
          const existingBs = await prisma.batchStudent.findFirst({
            where: { batchId: batch.id, studentId: student.id },
          });
          if (existingBs) {
            await prisma.batchStudent.update({
              where: { id: existingBs.id },
              data: { status: BatchStudentStatus.ACTIVE },
            });
            inc('batch_students', false);
          } else {
            await prisma.batchStudent.create({
              data: {
                batchId: batch.id,
                studentId: student.id,
                status: BatchStudentStatus.ACTIVE,
                joinedAt: new Date('2026-04-15'),
              },
            });
            inc('batch_students', true);
          }
        }
      }

      // Add a realistic BulkUpload record for this batch
      const bulkUpload = await prisma.bulkUpload.create({
        data: {
          institutionId: institution.id,
          batchId: batch.id,
          fileName: `${bData.name}_students_roster.xlsx`,
          fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileSize: 45280,
          rowCount: 25,
          validRowCount: 24,
          invalidRowCount: 1,
          duplicateRowCount: 0,
          newStudentCount: 20,
          existingStudentCount: 4,
          activatedCount: 24,
          status: BulkUploadStatus.APPROVED,
          uploadedById: adminUser ? adminUser.id : superAdmin.id,
          processedAt: new Date(),
          submittedAt: new Date(),
          approvedAt: new Date(),
          approvedById: superAdmin.id,
        },
      });
      inc('bulk_uploads', true);

      // Add sample rows
      await prisma.bulkUploadRow.create({
        data: {
          uploadId: bulkUpload.id,
          rowNumber: 1,
          rawData: { name: 'Aarav Sharma', phone: '9876543210', email: 'aarav@example.com' },
          validationStatus: 'VALID',
          deduplicationStatus: 'UNIQUE',
          activationStatus: 'ACTIVATED',
        },
      });
      inc('bulk_upload_rows', true);
    }
  }

  return {
    seederName: 'InstitutionsSeeder',
    createdCounts: created,
    reusedCounts: reused,
    timeMs: Date.now() - start,
  };
}
