module.exports = {
  apps: [{
    name: 'neoliberal-struggle',
    script: 'server/index.js',
    cwd: __dirname,
    watch: false,
    env_file: '.env',
    out_file: 'logs/out.log',
    error_file: 'logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 5000,
    max_restarts: 10,
  }],
};
