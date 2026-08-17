import './config/forceIpv4.js'; // side-effect: must run before any network call
import { startScheduler } from './scheduler/scheduler.js';

/**
 * Last-resort process guards.
 *
 * Node terminates on an unhandled promise rejection by default (v15+). For a long-lived
 * scheduler that is the wrong trade: one bad async callback anywhere silently kills every
 * remaining schedule — content generation, the Postgres keep-alive, GSC sync — and the
 * container restart that follows just waits for the next cron tick to fail the same way.
 *
 * These handlers log loudly and keep the process alive so the *other* schedules keep
 * running. They are a safety net, not a substitute for per-task try/catch: every
 * scheduled task wraps its own work, so anything reaching here is a genuine bug worth
 * reading in the logs.
 */
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(`[${new Date().toISOString()}] ⚠️  UNHANDLED REJECTION (scheduler kept alive):`, reason);
});

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error(`[${new Date().toISOString()}] ⚠️  UNCAUGHT EXCEPTION (scheduler kept alive):`, err);
});

startScheduler();
