const { withAndroidManifest } = require('@expo/config-plugins');

// Android 11+ hides other apps from `Linking.canOpenURL` unless the manifest says which URL schemes the app asks
// about. These are the schemes of the navigation apps the driver app can hand a stop to
// (src/domain/navigation.ts: NAV_SCHEMES). Names of packages are not listed on purpose: a scheme keeps working when
// an app changes its package.
const SCHEMES = ['tmap', 'kakaomap', 'nmap', 'google.navigation'];

function hasScheme(queries, scheme) {
  return (queries.intent ?? []).some((intent) =>
    (intent.data ?? []).some((data) => data.$?.['android:scheme'] === scheme));
}

module.exports = function withNavigationQueries(config) {
  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest.queries = manifest.queries ?? [{}];
    const queries = manifest.queries[0];
    queries.intent = queries.intent ?? [];
    for (const scheme of SCHEMES) {
      if (hasScheme(queries, scheme)) continue;
      queries.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        data: [{ $: { 'android:scheme': scheme } }],
      });
    }
    return result;
  });
};
