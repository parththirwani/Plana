import { config } from "dotenv";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

config({ path: new URL("./.env", import.meta.url).pathname });

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

export const prisma = new PrismaClient({
  adapter,
});

// Type-only escape hatches so consumers (apps/backend) can pin honest
// Prisma enum/Json boundaries at compile time WITHOUT importing the runtime
// client module (test suites mock this module with a bare { prisma } object —
// nothing may value-import these namespaces from here).
export type { Prisma, $Enums } from "./generated/prisma/client";