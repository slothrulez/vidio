import { Pool, type PoolClient } from "pg";
import { StudioError } from "./types";

const singleton = globalThis as typeof globalThis & { vidioPool?: Pool };
export function database() {
  if (!process.env.DATABASE_URL)
    throw new StudioError("DATABASE", "PostgreSQL is not configured", 503);
  return (singleton.vidioPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 5000,
  }));
}
export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
