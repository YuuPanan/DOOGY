import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Action, Button, Card, Facts, Field, Notice } from './index';

type Media = Record<string, any>;
type Draft = { uri: string; name: string; mimeType: string; size: number; capturedAt: string; key: string; attempted: boolean };
const MAX_BYTES = 20 * 1024 * 1024, RECORD_SECONDS = 59;
// A newly mounted recorder waits for the preceding page's native stop/session cleanup.
let recorderCleanup: Promise<void> = Promise.resolve();

export function MediaCapture({ petId, onSaved }: { petId: string; onSaved: (media: Media) => void | Promise<void> }) {
  const { api, user, pet, pets, households } = useApp();
  const target = pets.find(row => row.id === petId) ?? (pet?.id === petId ? pet : null);
  const role = households.find(row => row.id === target?.household_id)?.role;
  if (!['owner', 'caregiver'].includes(role ?? '')) return <Notice text="录音和上传需要当前宠物家庭的写权限。" />;
  return <CaptureBody key={`${api.baseUrl}:${user?.id}:${petId}:${role}`} petId={petId} onSaved={onSaved} />;
}

function CaptureBody({ petId, onSaved }: { petId: string; onSaved: (media: Media) => void | Promise<void> }) {
  const { api } = useApp(), focused = useIsFocused();
  const capabilities = useResource(() => api.get(`/pets/${petId}/media/capabilities`), [api, petId]);
  const [draft, setDraft] = useState<Draft | null>(null), [phase, setPhase] = useState('idle'), [error, setError] = useState(''), [saved, setSaved] = useState<Media | null>(null), [foreground, setForeground] = useState(AppState.currentState === 'active');
  const draftRef = useRef<Draft | null>(null), alive = useRef(true), active = useRef(AppState.currentState === 'active'), focus = useRef(focused), generation = useRef(0), busy = useRef(false);
  const owned = useRef(new Set<string>()), recording = useRef<{ capturedAt: string; generation: number; uri: string | null } | null>(null);
  const nativeDialog = useRef(false);
  const statusHandler = useRef<(status: { isFinished: boolean; hasError: boolean; error: string | null; url: string | null }) => void>(() => {});
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY, status => statusHandler.current(status));
  const recorderState = useAudioRecorderState(recorder, 250);
  focus.current = focused;
  const valid = (request: number) => alive.current && active.current && focus.current && generation.current === request;
  const updateDraft = (value: Draft | null) => { draftRef.current = value; if (alive.current) setDraft(value); };
  const rememberUri = () => { try { if (recorder.uri) owned.current.add(recorder.uri); } catch { /* The native hook can already be released during unmount. */ } };
  const clearFiles = (uris: Iterable<string> = owned.current) => {
    let failed = false;
    for (const uri of [...uris]) try { const file = new File(uri); if (file.exists) file.delete(); owned.current.delete(uri); } catch { failed = true; }
    if (failed && alive.current) setError('本机临时文件清理失败，请稍后重试取消草稿。');
  };
  const discard = () => {
    generation.current++; busy.current = false; recording.current = null; rememberUri(); updateDraft(null);
    if (alive.current) { setPhase('idle'); setError(''); }
    const cleanup = (async () => {
      try { await recorder.stop(); } catch { /* Already stopped/released recorders have no ongoing microphone capture. */ }
      rememberUri(); clearFiles();
      try { await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false, shouldPlayInBackground: false }); } catch { /* The recorder was also stopped directly. */ }
    })();
    recorderCleanup = Promise.allSettled([recorderCleanup, cleanup]).then(() => {});
    return cleanup;
  };
  const finish = async (url: string | null) => {
    const current = recording.current; if (!current) return;
    recording.current = null;
    const uri = url ?? current.uri; if (uri) owned.current.add(uri);
    if (!valid(current.generation)) { clearFiles(uri ? [uri] : []); return; }
    setPhase('stopping');
    try {
      if (!uri) throw new Error('录音未生成文件，请重新录制。');
      const file = new File(uri);
      if (!file.exists || !file.size) throw new Error('录音为空，请重新录制。');
      if (file.size > MAX_BYTES) throw new Error('录音超过 20 MiB，请重新录制更短片段。');
      await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false, shouldPlayInBackground: false });
      if (!valid(current.generation)) { clearFiles([uri]); return; }
      updateDraft({ uri, name: 'doogy-recording.m4a', mimeType: 'audio/mp4', size: file.size, capturedAt: current.capturedAt, key: Crypto.randomUUID(), attempted: false });
    } catch (failure) { if (valid(current.generation)) setError(failure instanceof Error ? failure.message : '录音保存失败'); clearFiles(uri ? [uri] : []); }
    finally { if (valid(current.generation)) setPhase('idle'); }
  };
  statusHandler.current = status => {
    if (status.hasError) { const current = recording.current; void discard(); if (current && alive.current) setError(status.error ?? '录音被系统中断，请重新录制。'); }
    else if (status.isFinished) void finish(status.url);
  };
  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener('change', state => { active.current = state === 'active'; setForeground(active.current); if (!active.current && !nativeDialog.current) void discard(); });
    return () => { alive.current = false; focus.current = false; subscription.remove(); void discard(); };
  }, [recorder]);
  useEffect(() => { if (!focused) void discard(); }, [focused]);
  const enabled = Platform.OS !== 'web' && capabilities.data?.upload_enabled === true && focused && foreground;
  const start = async () => {
    if (busy.current || draftRef.current || recording.current || !enabled) return;
    busy.current = true; setPhase('preparing'); setError(''); setSaved(null);
    const request = ++generation.current;
    try {
      await recorderCleanup;
      if (!valid(request)) return;
      nativeDialog.current = true;
      const permission = await requestRecordingPermissionsAsync(); nativeDialog.current = false;
      if (!valid(request)) return;
      if (!permission.granted) throw new Error('未获得麦克风权限。可在系统设置授权，或改为导入片段。');
      await setAudioModeAsync({ allowsRecording: true, allowsBackgroundRecording: false, shouldPlayInBackground: false });
      if (!valid(request)) return;
      const fileName = `doogy-media-${Crypto.randomUUID()}`;
      // SDK 58 documents these cache paths; track our exact filename before async native preparation.
      owned.current.add(new File(Paths.cache, Platform.OS === 'ios' ? 'ExpoAudio' : 'Audio', `${fileName}.m4a`).uri);
      await recorder.prepareToRecordAsync({ directory: 'cache', fileName }); rememberUri();
      if (!valid(request)) { await discard(); return; }
      recording.current = { capturedAt: new Date().toISOString(), generation: request, uri: recorder.uri };
      recorder.record({ forDuration: RECORD_SECONDS }); setPhase('recording');
    } catch (failure) { if (valid(request)) { await discard(); throw failure; } }
    finally { nativeDialog.current = false; if (generation.current === request) { busy.current = false; if (alive.current && !recording.current) setPhase('idle'); } }
  };
  const stop = async () => {
    if (!recording.current || busy.current) return;
    const request = generation.current;
    busy.current = true; setPhase('stopping');
    try { await recorder.stop(); await finish(recorder.uri); }
    catch (failure) { await discard(); if (alive.current) setError(failure instanceof Error ? failure.message : '停止录音失败，请重新录制。'); }
    finally { if (generation.current === request) busy.current = false; }
  };
  const pick = async () => {
    if (busy.current || draftRef.current || recording.current || !enabled) return;
    busy.current = true; setPhase('importing'); setError(''); setSaved(null);
    const request = ++generation.current, imported = new Set<string>();
    try {
      await recorderCleanup;
      if (!valid(request)) return;
      nativeDialog.current = true;
      const result = await DocumentPicker.getDocumentAsync({ type: ['audio/*', 'video/mp4'], copyToCacheDirectory: true, multiple: false });
      nativeDialog.current = false;
      if (result.canceled) return;
      const asset = result.assets[0], source = new File(asset.uri);
      // This picker invocation requested its own cache copy; never remove a provider's original file.
      if (asset.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, '')}/`)) { owned.current.add(asset.uri); imported.add(asset.uri); }
      const currentScope = () => alive.current && focus.current && generation.current === request;
      if (!currentScope()) { clearFiles(imported); return; }
      const extension = asset.name.split('.').pop()?.toLowerCase();
      if (!extension || !['m4a', 'mp3', 'wav', 'mp4'].includes(extension)) throw new Error('请选择 M4A、MP3、WAV 或 MP4 文件。');
      if ((asset.size ?? source.size) > MAX_BYTES) throw new Error('片段超过 20 MiB，请先裁剪或压缩。');
      const directory = new Directory(Paths.cache, 'doogy-media-capture'); directory.create({ idempotent: true });
      const file = new File(directory, `${Crypto.randomUUID()}.${extension}`); owned.current.add(file.uri); imported.add(file.uri); await source.copy(file);
      if (!currentScope()) { clearFiles(imported); return; }
      if (!file.size || file.size > MAX_BYTES) throw new Error('片段为空或超过 20 MiB，请重新选择。');
      updateDraft({ uri: file.uri, name: asset.name.slice(-200), mimeType: asset.mimeType ?? 'application/octet-stream', size: file.size, capturedAt: '', key: Crypto.randomUUID(), attempted: false });
    } catch (failure) { clearFiles(imported); if (valid(request)) throw failure; }
    finally { nativeDialog.current = false; if (generation.current === request) { busy.current = false; if (alive.current) setPhase('idle'); } }
  };
  const upload = async () => {
    const file = draftRef.current;
    if (!file || busy.current || !enabled) return;
    const capturedAt = file.capturedAt.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt)))
      throw new Error('请填写片段实际采集开始时间，包含日期、时间和时区。');
    const request = generation.current;
    busy.current = true; setPhase('uploading'); setError(''); updateDraft({ ...file, capturedAt, attempted: true });
    try {
      const media = await api.upload(`/pets/${petId}/media`, { uri: file.uri, name: file.name, mimeType: file.mimeType }, file.key, { fields: { captured_at: capturedAt } });
      if (!valid(request)) return;
      if (!media.id || media.pet_id !== petId) throw new Error('上传结果与当前宠物不匹配，请重新读取媒体列表。');
      clearFiles(); updateDraft(null); setSaved(media); await onSaved(media);
    } finally { if (generation.current === request) { busy.current = false; if (alive.current) setPhase('idle'); } }
  };
  return <Card title="录音或导入片段"><Notice text="仅前台录音，约 59 秒自动停止，为编码尾部留出余量。文件不超过 20 MiB、片段不超过 60 秒；服务器按真实编码与时长校验。上传不会自动发起解释或联系他人。" />
    <Notice text={capabilities.error} tone="error" />{capabilities.data && !capabilities.data.upload_enabled && <Notice text={capabilities.data.reason === 'READ_ONLY' ? '当前仅可读取媒体，不能上传。' : '服务器媒体校验工具尚未配置，暂不能录音或上传。'} />}
    {Platform.OS === 'web' && <Notice text="本组件的 M4A 前台录音和文件暂存请在原生 App 使用。" />}
    <Button title="重新检查上传可用性" onPress={capabilities.refresh} disabled={capabilities.loading} />
    <Action title="请求麦克风权限并开始录音" disabled={!enabled || phase !== 'idle' || !!draft} run={start} />
    {(phase === 'recording' || phase === 'stopping') && <><Notice text={`${phase === 'recording' ? '正在录音' : '正在完成录音'}：${Math.floor(recorderState.durationMillis / 1000)} 秒。离页或进入后台将停止并丢弃本机草稿。`} /><Action title="停止录音，保留待上传草稿" disabled={phase !== 'recording'} run={stop} /></>}
    <Action title="从本机导入音频或 MP4" disabled={!enabled || phase !== 'idle' || !!draft} run={pick} />
    <Notice text={error} tone="error" />
    {draft && <><Facts value={{ 文件名: draft.name, 字节数: draft.size, 状态: '待上传；尚未进行服务端编码校验' }} /><Field label="片段实际采集开始时间 ISO（含时区）" value={draft.capturedAt} editable={!draft.attempted && phase !== 'uploading'} onChangeText={capturedAt => updateDraft({ ...draft, capturedAt })} placeholder="2026-11-24T10:00:00+08:00" />
      <Notice text={draft.attempted ? '已固定本次采集时间与幂等键，重试沿用同一请求。需要更改时间时请取消后重新导入。' : '录音自动记录开始时间；导入片段请按实际采集开始时间填写，不把导入时刻当作采集时刻。'} />
      <Action title={draft.attempted ? '重试上传同一草稿' : '确认上传此片段'} run={upload} disabled={!enabled || phase !== 'idle'} /></>}
    {(draft || phase !== 'idle' || error) && <Button title="取消并清理本机草稿" onPress={discard} />}
    {saved && <Notice text={`片段已保存（${saved.filename ?? saved.id}），可在媒体列表选择后播放或显式创建解释。`} />}
    <Notice text="切宠、离页、退出或进入后台会清本机草稿；已发出的上传可能已经由服务器受理，可到媒体列表核对。" />
  </Card>;
}
