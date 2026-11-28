import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fail } from './http';

export const MAX_MEDIA_SIZE = 20 * 1024 * 1024;
export const MAX_MEDIA_DURATION = 60;
const execute = promisify(execFile);
let validating = 0;
export function mediaTools() {
  const directory = resolve(process.env.MEDIA_TOOLS_DIRECTORY || resolve(__dirname, '../../.tools/media'));
  const executable = (name: string) => join(directory, name + (process.platform === 'win32' ? '.exe' : ''));
  return { ffprobe: executable('ffprobe'), ffmpeg: executable('ffmpeg') };
}
export function mediaValidationAvailable() { return Object.values(mediaTools()).every(file => existsSync(file)); }

export async function validateMedia(bytes: Buffer) {
  if (!mediaValidationAvailable()) fail(503, 'MEDIA_VALIDATOR_NOT_CONFIGURED', '服务端尚未安装媒体校验工具，文件未保存');
  if (validating >= 2) fail(429, 'MEDIA_VALIDATOR_BUSY', '媒体校验繁忙，请稍后重试');
  validating++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'doogy-media-'));
    const input = join(directory, 'input.media'); await writeFile(input, bytes, { flag: 'wx' });
    const tools = mediaTools(), restrictions = ['-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov'];
    const options = { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 };
    let probe: any;
    try {
      const result = await execute(tools.ffprobe, ['-v', 'error', ...restrictions, '-show_entries', 'format=duration,format_name:format_tags=major_brand:stream=codec_type,codec_name,duration,width,height,channels,sample_rate:stream_disposition=attached_pic', '-of', 'json', input], options);
      probe = JSON.parse(result.stdout);
    } catch { fail(400, 'INVALID_MEDIA_CONTENT', '无法读取实际媒体格式或时长，请选择完整的M4A/MP3/WAV/MP4文件'); }
    const streams = (probe.streams ?? []).filter((stream: any) => !stream.disposition?.attached_pic);
    const audio = streams.filter((stream: any) => stream.codec_type === 'audio'), video = streams.filter((stream: any) => stream.codec_type === 'video');
    if (!streams.length || audio.length > 1 || video.length > 1 || audio.length + video.length !== streams.length) fail(415, 'UNSUPPORTED_MEDIA_CODEC', '媒体只支持单音轨和单视频轨');
    const duration = Math.max(Number(probe.format?.duration) || 0, ...streams.map((stream: any) => Number(stream.duration) || 0));
    if (!Number.isFinite(duration) || duration <= 0) fail(400, 'INVALID_MEDIA_DURATION', '媒体实际时长无法确认');
    if (duration > MAX_MEDIA_DURATION) fail(413, 'MEDIA_TOO_LONG', '音视频实际时长最多60秒');
    const format = String(probe.format?.format_name ?? '').split(',');
    const brand = probe.format?.tags?.major_brand ?? null;
    const mp4 = format.includes('mov') && typeof brand === 'string' && /^(isom|iso[2-9]|mp4[12]|avc1|M4[AV] |dash|MSNV)$/.test(brand);
    let contentType: string;
    if (format.includes('wav') && !video.length && audio.length === 1 && /^pcm_(s16le|s24le|s32le|f32le|u8)$/.test(audio[0].codec_name)) contentType = 'audio/wav';
    else if (format.includes('mp3') && !video.length && audio.length === 1 && audio[0].codec_name === 'mp3') contentType = 'audio/mpeg';
    else if (mp4 && !video.length && audio.length === 1 && audio[0].codec_name === 'aac') contentType = 'audio/mp4';
    else if (mp4 && video.length === 1 && video[0].codec_name === 'h264' && audio.every((stream: any) => stream.codec_name === 'aac') && video[0].width > 0 && video[0].height > 0 && video[0].width <= 4096 && video[0].height <= 2160) contentType = 'video/mp4';
    else fail(415, 'UNSUPPORTED_MEDIA_CODEC', '支持WAV PCM、MP3、M4A AAC及MP4 H.264/AAC，其他编码请先转换');
    let decodedDuration = 0;
    try {
      const result = await execute(tools.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', ...restrictions, '-threads', '1', '-i', input, '-map', '0:a?', '-map', '0:v?', '-threads', '1', '-t', '61', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], options);
      decodedDuration = Math.max(0, ...Array.from(result.stdout.matchAll(/^out_time_us=(\d+)$/gm), match => Number(match[1]) / 1000000));
    } catch { fail(400, 'INVALID_MEDIA_CONTENT', '媒体实际解码失败或校验超时，文件未保存'); }
    if (decodedDuration <= 0) fail(400, 'INVALID_MEDIA_CONTENT', '媒体没有可解码的有效时段');
    const actualDuration = Math.max(duration, decodedDuration);
    if (actualDuration > MAX_MEDIA_DURATION) fail(413, 'MEDIA_TOO_LONG', '媒体解码后的实际时长超过60秒');
    return { content_type: contentType, duration_seconds: actualDuration, validation: {
      version: 'ffmpeg_decode_v1', decoded: true, container: probe.format.format_name, container_brand: brand,
      codecs: streams.map((stream: any) => stream.codec_name), actual_duration_seconds: actualDuration,
      captured_at_source: 'user_reported', model_analyzed: false,
    } };
  } finally {
    validating--;
    if (directory) { await unlink(join(directory, 'input.media')).catch(() => {}); await rmdir(directory).catch(() => {}); }
  }
}
