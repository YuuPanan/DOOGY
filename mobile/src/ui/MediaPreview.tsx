import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoSource, VideoView } from 'expo-video';
import { useApp } from '../state/AppContext';
import { Action, Button, Notice } from './index';

export function MediaPreview({ id, petId }: { id: string; petId: string }) {
  const { api, user } = useApp(), focused = useIsFocused();
  const [source, setSource] = useState<VideoSource>(null), [active, setActive] = useState(AppState.currentState === 'active');
  const sequence = useRef(0);
  const player = useVideoPlayer(source, instance => {
    instance.loop = false; instance.staysActiveInBackground = false; instance.showNowPlayingNotification = false;
    instance.allowsExternalPlayback = false;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const stop = useCallback(() => {
    sequence.current++;
    try { player.pause(); } catch { /* The hook may already have released the native player on unmount. */ }
    setSource(null);
  }, [player]);
  useEffect(() => { stop(); return stop; }, [api, user?.id, id, petId, stop]);
  useEffect(() => { if (!focused) stop(); }, [focused, stop]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { setActive(state === 'active'); if (state !== 'active') stop(); });
    return () => subscription.remove();
  }, [stop]);
  if (Platform.OS === 'web') return <Notice text="Web预览不通过播放器附加授权头，暂只提供上方的授权下载；请在原生Android包内验证播放。" />;
  return <>
    <Notice text="点击授权加载后，使用播放器内的播放/暂停控件。媒体只在当前页面前台播放，不写入磁盘缓存；退出页面或后台会清除来源。MP4、WAV等能否解码取决于本机系统，不能保证所有编解码格式。" />
    {focused && active && <Action title="重新授权并加载原生播放器" run={async () => {
      stop(); const request = sequence.current;
      const metadata = await api.get(`/media/${encodeURIComponent(id)}`);
      if (request !== sequence.current) return;
      if (metadata.id !== id || metadata.pet_id !== petId) throw new Error('媒体不属于当前宠物');
      if (!api.accessToken) throw new Error('登录已失效，请重新登录');
      setSource({ uri: api.url(`/media/${encodeURIComponent(id)}/content`), headers: { Authorization: `Bearer ${api.accessToken}` }, contentType: 'progressive', useCaching: false });
    }} />}
    {source && focused && active && <>
      <VideoView player={player} style={{ width: '100%', height: 230, backgroundColor: '#10241f', borderRadius: 12 }} nativeControls contentFit="contain" fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} startsPictureInPictureAutomatically={false} allowsVideoFrameAnalysis={false} />
      {status === 'error' && <Notice tone="error" text="媒体无法加载或解码。可能是权限/会话已改变或本机不支持该格式，请重新授权加载；也可使用授权下载。" />}
      <Button title="停止并清除播放来源" onPress={stop} />
    </>}
  </>;
}
