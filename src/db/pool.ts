// Legacy export: most code should import `postgresPool` / `mysqlPool` directly.
// We keep this to avoid churn in places that still expect `pool`.
import { postgresPool } from './postgresPool.js';

export const pool = postgresPool;
