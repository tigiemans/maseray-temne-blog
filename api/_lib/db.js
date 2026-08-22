import { neon } from "@neondatabase/serverless";

let sqlClient;

export function sql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }
  sqlClient ??= neon(process.env.DATABASE_URL);
  return sqlClient;
}
