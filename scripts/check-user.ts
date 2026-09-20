import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

const envConfig = dotenv.parse(fs.readFileSync('.env.production'));
for (const k in envConfig) {
  process.env[k] = envConfig[k];
}

const prisma = new PrismaClient({
  datasources: { db: { url: envConfig.DATABASE_URL } },
});

async function main() {
  const phone = '9820011223';
  const inst = await prisma.institution.findMany({
    where: {
      OR: [
        { phone: { contains: phone } },
        { code: 'MIS-DEL-201' },
      ],
    },
  });
  console.log('Institutions matching:', JSON.stringify(inst, null, 2));

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { phone: { contains: phone } },
        { mobileNumber: { contains: phone } },
      ],
    },
    include: {
      userRoles: { include: { role: true } },
      institutionAdmins: true,
    },
  });
  console.log('Users matching:', JSON.stringify(users, null, 2));

  const uploads = await prisma.bulkUpload.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { rows: true },
  });
  console.log('Recent bulk uploads:', JSON.stringify(uploads.map(u => ({ id: u.id, type: u.uploadType, status: u.status, rowsCount: u.rows.length })), null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
