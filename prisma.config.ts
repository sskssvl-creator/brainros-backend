import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { defineConfig } from 'prisma/config';

if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'production' && fs.existsSync('.env.production')) {
    dotenv.config({ path: '.env.production' });
  } else if (fs.existsSync('.env')) {
    dotenv.config({ path: '.env' });
  }
}

export const config = { seed: 'ts-node prisma/seed.ts' };

export default defineConfig({
  migrations: {
    seed: 'ts-node prisma/seed.ts',
  },
});

