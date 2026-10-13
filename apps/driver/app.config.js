const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const appConfig = require('./app.json').expo;

// The Firebase file is supplied later. Without it the build still works and push stays off.
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ?? './.private/google-services.json';
const hasGoogleServices = existsSync(resolve(__dirname, googleServicesFile));

module.exports = {
  ...appConfig,
  android: {
    ...appConfig.android,
    ...(hasGoogleServices ? { googleServicesFile } : {}),
  },
};
