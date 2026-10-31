// src/config/database.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Connects to the database and logs the result.
 * Returns true if connected, false if it failed.
 */
export async function connectDatabase(): Promise<boolean> {
  console.log('⏳ Connecting to database...');
  try {
    await prisma.$connect();
    // Run a real query to confirm the connection actually works
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connected successfully');
    return true;
  } catch (error: any) {
    console.error('❌ Database connection failed');
    console.error(`   Reason: ${error?.message || error}`);
    console.error('   Check DATABASE_URL in your .env and make sure PostgreSQL is running.');
    return false;
  }
}

/**
 * Quick check used by the /health route.
 */
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// Close the connection cleanly when the process stops
const shutdown = async () => {
  await prisma.$disconnect();
  console.log('🔌 Database disconnected');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);