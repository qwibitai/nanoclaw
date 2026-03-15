module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: 'dist/index.js',
      cwd: 'C:/Users/jarvi/OpenClawV1/nanoclaw',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
