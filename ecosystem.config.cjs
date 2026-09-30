module.exports = {
  apps: [{
    name: 'flocking-main',
    script: 'server/colyseus.mjs',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    time: true,
    wait_ready: true,
    env_production: { NODE_ENV: 'production' },
  }],
};
