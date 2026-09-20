import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';

const envConfig = dotenv.parse(fs.readFileSync('.env.production'));
for (const k in envConfig) {
  process.env[k] = envConfig[k];
}

const prisma = new PrismaClient({
  datasources: { db: { url: envConfig.DATABASE_URL } },
});

async function main() {
  const instRole = await prisma.role.findFirst({
    where: { name: 'INSTITUTION_ADMIN' },
  });
  if (!instRole) {
    throw new Error('INSTITUTION_ADMIN role not found');
  }

  const schools = await prisma.institution.findMany();
  console.log(`Found ${schools.length} institutions to sync...`);

  for (const school of schools) {
    let rawPhone = (school.phone || '').trim();
    if (rawPhone && !rawPhone.startsWith('+')) {
      const digits = rawPhone.replace(/\D/g, '');
      if (digits.length === 10) {
        rawPhone = `+91${digits}`;
      } else if (digits.length === 12 && digits.startsWith('91')) {
        rawPhone = `+${digits}`;
      }
    }

    if (!rawPhone) continue;

    const tenDigit = rawPhone.replace(/^\+91/, '');
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: rawPhone },
          { mobileNumber: rawPhone },
          { phone: tenDigit },
          { mobileNumber: tenDigit },
          ...(school.email ? [{ email: school.email.trim().toLowerCase() }] : []),
        ],
      },
    });

    if (!user) {
      const tempPassword = await bcrypt.hash(`brainros_${rawPhone.slice(-6)}`, 10);
      user = await prisma.user.create({
        data: {
          phone: rawPhone,
          mobileNumber: rawPhone,
          email: school.email?.trim().toLowerCase() || null,
          name: `${school.name} Admin`,
          passwordHash: tempPassword,
          status: 'ACTIVE',
          isActive: true,
          isVerified: true,
        },
      });
      console.log(`Created user for ${school.name}: ${rawPhone}`);
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          status: 'ACTIVE',
          isActive: true,
          isVerified: true,
        },
      });
      console.log(`Updated user for ${school.name}: ${rawPhone} to ACTIVE`);
    }

    await prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: user.id,
          roleId: instRole.id,
        },
      },
      update: {},
      create: {
        userId: user.id,
        roleId: instRole.id,
      },
    });

    const existingAdmin = await prisma.institutionAdmin.findFirst({
      where: {
        institutionId: school.id,
        userId: user.id,
      },
    });

    if (!existingAdmin) {
      await prisma.institutionAdmin.create({
        data: {
          institutionId: school.id,
          userId: user.id,
          role: 'ADMIN',
          isActive: true,
        },
      });
    } else if (!existingAdmin.isActive) {
      await prisma.institutionAdmin.update({
        where: { id: existingAdmin.id },
        data: { isActive: true },
      });
    }

    console.log(`Linked ${school.name} -> Admin User: ${user.phone}`);
  }

  console.log('✅ All institutions synced with active admin users!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
