/**
 * Database client export facade.
 * Re-exports singleton connection and schema initialization for backward compatibility.
 */
export * from './src/database/connection.js';
export { initSchema as initDB } from './src/database/schema.js';
