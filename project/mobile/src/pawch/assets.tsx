import React from 'react';
import { View, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';

// Original exported static assets only. Full-screen references never enter this registry.
export const pawchAssets = {
  'nav-today': { source: require('../../assets/pawch/common/nav-today.svg'), width: 24, height: 24, usage: 'runtime-candidate' },
  'nav-safety': { source: require('../../assets/pawch/common/nav-safety.svg'), width: 24, height: 24, usage: 'runtime-candidate' },
  'nav-understand': { source: require('../../assets/pawch/common/nav-understand.svg'), width: 24, height: 24, usage: 'runtime-candidate' },
  'nav-learn': { source: require('../../assets/pawch/common/nav-learn.svg'), width: 24, height: 24, usage: 'runtime-candidate' },
  'nav-ask-ai': { source: require('../../assets/pawch/common/nav-ask-ai.svg'), width: 24, height: 24, usage: 'runtime-candidate' },
  'pawch-wordmark': { source: require('../../assets/pawch/common/pawch-wordmark.svg'), width: 69, height: 19, usage: 'runtime-candidate' },
  'baku-avatar': { source: require('../../assets/pawch/demo/baku-avatar.svg'), width: 50, height: 50, usage: 'demo-only' },
  'baku-trail': { source: require('../../assets/pawch/illustrations/baku-trail.svg'), width: 340, height: 270, usage: 'runtime-candidate-static-illustration' },
  'pawch-collar': { source: require('../../assets/pawch/illustrations/pawch-collar.svg'), width: 256, height: 148, usage: 'runtime-candidate-static-illustration' },
  'trail-map-base': { source: require('../../assets/pawch/demo/trail-map-base.svg'), width: 342, height: 310, usage: 'demo-only' },
  'map-pin-safe': { source: require('../../assets/pawch/demo/map-pin-safe.svg'), width: 43, height: 43, usage: 'demo-static-pin' },
  'map-pin-alert': { source: require('../../assets/pawch/demo/map-pin-alert.svg'), width: 40, height: 40, usage: 'demo-static-pin' },
  'map-pin-home': { source: require('../../assets/pawch/demo/map-pin-home.svg'), width: 101, height: 27, usage: 'demo-static-pin' },
  'map-boundary': { source: require('../../assets/pawch/demo/map-boundary.svg'), width: 158, height: 158, usage: 'demo-static-radius' },
  'welcome-baku': { source: require('../../assets/pawch/illustrations/welcome-baku.svg'), width: 340, height: 270, usage: 'runtime-candidate-static-illustration' },
  'meet-your-dog-baku': { source: require('../../assets/pawch/illustrations/meet-your-dog-baku.svg'), width: 120, height: 95.2941, usage: 'runtime-candidate-static-illustration' },
  'pair-collar': { source: require('../../assets/pawch/illustrations/pair-collar.svg'), width: 256, height: 148, usage: 'runtime-candidate-static-illustration' },
  'connected-baku': { source: require('../../assets/pawch/illustrations/connected-baku.svg'), width: 280, height: 222.353, usage: 'runtime-candidate-static-illustration' },
  'login-baku': { source: require('../../assets/pawch/illustrations/login-baku.svg'), width: 100, height: 79.4118, usage: 'runtime-candidate-static-illustration' },
  'learn-baku': { source: require('../../assets/pawch/illustrations/learn-baku.svg'), width: 86, height: 66, usage: 'runtime-candidate-static-illustration' },
  'location-map': { source: require('../../assets/pawch/demo/location-map.svg'), width: 342, height: 310, usage: 'demo-only' },
  'live-status-map': { source: require('../../assets/pawch/demo/live-status-map.svg'), width: 342, height: 310, usage: 'demo-only' },
  'gps-accuracy-map': { source: require('../../assets/pawch/demo/gps-accuracy-map.svg'), width: 342, height: 310, usage: 'demo-only' },
  'home-boundary-map': { source: require('../../assets/pawch/demo/home-boundary-map.svg'), width: 342, height: 310, usage: 'demo-only' },
  'outside-zone-map': { source: require('../../assets/pawch/demo/outside-zone-map.svg'), width: 342, height: 310, usage: 'demo-only' },
  'track-baku-map': { source: require('../../assets/pawch/demo/track-baku-map.svg'), width: 342, height: 310, usage: 'demo-only' },
  'behavior-detail-waveform': { source: require('../../assets/pawch/demo/behavior-detail-waveform.svg'), width: 342, height: 140, usage: 'demo-only' },
  'record-bark-waveform': { source: require('../../assets/pawch/demo/record-bark-waveform.svg'), width: 342, height: 140, usage: 'demo-only' },
  'audio-recording-waveform': { source: require('../../assets/pawch/demo/audio-recording-waveform.svg'), width: 342, height: 140, usage: 'demo-only' },
  'video-preview': { source: require('../../assets/pawch/demo/video-preview.svg'), width: 342, height: 252, usage: 'demo-only' },
  'video-recording': { source: require('../../assets/pawch/demo/video-recording.svg'), width: 342, height: 252, usage: 'demo-only' },
  'video-review': { source: require('../../assets/pawch/demo/video-review.svg'), width: 342, height: 252, usage: 'demo-only' },
  'meal-camera-preview': { source: require('../../assets/pawch/demo/meal-camera-preview.svg'), width: 342, height: 238, usage: 'demo-only' },
  'meal-bowl': { source: require('../../assets/pawch/demo/meal-bowl.svg'), width: 170, height: 96, usage: 'demo-only' },
} as const;
export function Asset({ name, style }: { name: string; style?: StyleProp<ViewStyle> }) {
  const key = name.split('/').pop()!.replace(/\.svg$/, '') as keyof typeof pawchAssets;
  const asset = pawchAssets[key];
  if (!asset) throw new Error('Unknown Pawch static asset: ' + name);
  return <View style={[{ width: asset.width, height: asset.height, alignSelf: 'center' }, style]}><Image source={asset.source} style={{ width: asset.width, height: asset.height }} contentFit="contain" cachePolicy="memory" accessibilityLabel={key} /></View>;
}
