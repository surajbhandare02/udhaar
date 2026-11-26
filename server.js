import http from 'node:http';
import { config } from './src/config/index.js';
import { logger } from './src/utils/logger.js';
import { initSchema } from './src/database/schema.js';
import { handleRequest } from './src/routes/apiRouter.js';

// Initialize database schema & performance indexes
await initSchema();

const server = http.createServer(handleRequest);

server.listen(config.PORT, '0.0.0.0', () => {
  logger.info(`✅ Udhaar server running at http://0.0.0.0:${config.PORT}`);
});

// Graceful shutdown for cloud deployments (Render, Docker, Kubernetes)
function handleShutdown(signal) {
  logger.info(`Received ${signal}. Gracefully stopping HTTP server...`);
  server.close(() => {
    logger.info('HTTP server closed successfully.');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forceful shutdown after 5s timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export default server;
