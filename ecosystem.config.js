/**
 * PM2 Process Manager Configuration for Hostinger VPS / Cloud Deployment
 *
 * Usage:
 *   Build app:           npm run build
 *   Run migrations:      npm run prisma:migrate:deploy
 *   Start with PM2:      pm2 start ecosystem.config.js --env production
 *   Save PM2 state:      pm2 save && pm2 startup
 *   View real-time logs: pm2 logs brainros-backend
 *   Monitor metrics:     pm2 monit
 *   Graceful reload:     pm2 reload brainros-backend
 */

module.exports = {
  apps: [
    {
      name: 'brainros-backend',
      script: 'dist/main.js',
      // Cluster mode across available CPU cores for high concurrent HTTP/Bcrypt throughput
      instances: 'max',
      exec_mode: 'cluster',

      // Auto-restart on unexpected crashes
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,

      // Automatic memory leak protection (restarts process if it exceeds 600MB)
      max_memory_restart: '600M',

      // Never watch in production (avoids accidental restarts from log/upload writes)
      watch: false,

      // Allow graceful shutdown (SIGINT/SIGTERM handlers in main.ts) up to 5s before force killing
      kill_timeout: 5000,

      // Logging configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,

      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
      },
    },
  ],
};
