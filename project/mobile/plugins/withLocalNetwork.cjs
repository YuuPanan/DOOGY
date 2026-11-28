const { withAndroidManifest } = require('expo/config-plugins');
module.exports = (config, { enabled }) => withAndroidManifest(config, result => {
  const application = result.modResults.manifest.application?.[0];
  if (application) application.$['android:usesCleartextTraffic'] = enabled ? 'true' : 'false';
  return result;
});
