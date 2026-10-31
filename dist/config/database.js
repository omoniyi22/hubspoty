"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.connectDatabase = connectDatabase;
exports.isDatabaseHealthy = isDatabaseHealthy;
// src/config/database.ts
const client_1 = require("@prisma/client");
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma ?? new client_1.PrismaClient();
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.prisma = exports.prisma;
/**
 * Connects to the database and logs the result.
 * Returns true if connected, false if it failed.
 */
async function connectDatabase() {
    console.log('⏳ Connecting to database...');
    try {
        await exports.prisma.$connect();
        // Run a real query to confirm the connection actually works
        await exports.prisma.$queryRaw `SELECT 1`;
        console.log('✅ Database connected successfully');
        return true;
    }
    catch (error) {
        console.error('❌ Database connection failed');
        console.error(`   Reason: ${error?.message || error}`);
        console.error('   Check DATABASE_URL in your .env and make sure PostgreSQL is running.');
        return false;
    }
}
/**
 * Quick check used by the /health route.
 */
async function isDatabaseHealthy() {
    try {
        await exports.prisma.$queryRaw `SELECT 1`;
        return true;
    }
    catch {
        return false;
    }
}
// Close the connection cleanly when the process stops
const shutdown = async () => {
    await exports.prisma.$disconnect();
    console.log('🔌 Database disconnected');
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
//# sourceMappingURL=database.js.map