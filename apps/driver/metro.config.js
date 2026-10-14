const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Bound Metro transformation concurrency on the 8 GiB development machine.
config.maxWorkers = 2;

module.exports = config;
