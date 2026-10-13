const { googleServicesPath } = require('./scripts/firebase-config.cjs');
const appConfig = require('./app.json').expo;

// No default file keeps the non-push development build available. An explicitly
// supplied file must exist and belong to this Android app before prebuild runs.
const googleServicesFile = googleServicesPath(
  __dirname,
  process.env.GOOGLE_SERVICES_JSON,
  appConfig.android.package,
);

module.exports = {
  ...appConfig,
  android: {
    ...appConfig.android,
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
};
