import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb, runMigrations } from './db/client.js';
import { recoverInterruptedAnalyses } from './services/agent.js';
import { startPrTracker, stopPrTracker } from './services/pr-tracker.js';
import { recoverInterruptedRuns } from './services/runs.js';

runMigrations();
const app = await buildApp();

const interrupted = recoverInterruptedRuns();
recoverInterruptedAnalyses();
if (interrupted) app.log.warn(`Marked ${interrupted} interrupted run(s) as failed`);

startPrTracker((msg) => app.log.info(msg));

await app.listen({ port: config.port, host: config.host });
app.log.info(`Shipyard API on http://${config.host}:${config.port} · data in ${config.dataDir}`);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  stopPrTracker();
  await app.close();
  closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
