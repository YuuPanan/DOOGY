import { ConfigContext, ExpoConfig } from 'expo/config';
export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = process.env.APP_VARIANT ?? 'production', preview = ['development', 'preview'].includes(variant);
  for (const name of ['EXPO_PUBLIC_CN_API_URL', 'EXPO_PUBLIC_GLOBAL_API_URL', 'EXPO_PUBLIC_API_URL']) {
    const raw = process.env[name]; if (!raw) continue;
    const url = new URL(raw);
    if ((!preview && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error(`${name} 必须为无附加路径的服务器根地址，正式包仅允许 HTTPS`);
  }
  if (!preview && process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP === '1') throw new Error('正式包不能启用本地 HTTP');
  return {
    ...config, name: preview ? 'DOOGY 内测' : 'DOOGY', slug: 'doogy-mobile', version: '0.1.3', orientation: 'portrait', userInterfaceStyle: 'light',
    ios: { ...config.ios, supportsTablet: false, bundleIdentifier: preview ? 'com.doogy.mobile.preview' : 'com.doogy.mobile',
      infoPlist: { NSAppTransportSecurity: preview ? { NSAllowsLocalNetworking: true } : {} } },
    android: { ...config.android, versionCode: 4, package: preview ? 'com.doogy.mobile.preview' : 'com.doogy.mobile',
      blockedPermissions: ['android.permission.CAMERA', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_BACKGROUND_LOCATION'] },
    plugins: [ ['expo-dev-client', { addGeneratedScheme: preview }], 'expo-secure-store', 'expo-sharing', ['expo-image-picker', { photosPermission: '选择宠物头像时访问你选定的照片', cameraPermission: false, microphonePermission: '仅在你主动录制宠物声音时使用麦克风' }],
      ['expo-audio', { microphonePermission: '仅在你主动录制宠物声音时使用麦克风，离开页面或进入后台即停止', recordAudioAndroid: true, enableBackgroundRecording: false, enableBackgroundPlayback: false }],
      ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: false }], ['./plugins/withLocalNetwork.cjs', { enabled: preview }] ],
    extra: { variant, hardware: 'not_configured' },
  };
};
