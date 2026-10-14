const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function validateGoogleServices(value, packageName) {
  if (!value || typeof value !== 'object' || value.type === 'service_account' || value.private_key) {
    throw new Error('Firebase Android config required. A service account key must not be packaged in the app.');
  }
  const client = value.client?.find((entry) => entry.client_info?.android_client_info?.package_name === packageName);
  if (!value.project_info?.project_id || !value.project_info?.project_number || !client?.client_info?.mobilesdk_app_id
    || !Array.isArray(client.api_key) || !client.api_key.some((key) => typeof key.current_key === 'string' && key.current_key)) {
    throw new Error(`Firebase Android config is incomplete or does not match ${packageName}.`);
  }
}

function googleServicesPath(directory, explicitPath, packageName) {
  const path = explicitPath ?? './.private/google-services.json';
  const absolutePath = resolve(directory, path);
  if (!existsSync(absolutePath)) {
    if (explicitPath) throw new Error('GOOGLE_SERVICES_JSON does not point to an existing Firebase Android config.');
    return undefined;
  }
  let value;
  try { value = JSON.parse(readFileSync(absolutePath, 'utf8')); }
  catch { throw new Error('Firebase Android config is not valid JSON.'); }
  validateGoogleServices(value, packageName);
  return absolutePath;
}

module.exports = { googleServicesPath, validateGoogleServices };
