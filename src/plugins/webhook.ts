import { invoke } from '@tauri-apps/api/core';
import { NowPlayingInfo, ZenithPlugin } from './types';

export const WEBHOOK_URL_KEY = 'zenith_webhook_url';

export function getWebhookUrl(): string {
  try {
    return localStorage.getItem(WEBHOOK_URL_KEY) || '';
  } catch (err) {
    console.debug('webhook getWebhookUrl', err);
  }
  return '';
}

export function setWebhookUrl(url: string) {
  try {
    if (url.trim()) localStorage.setItem(WEBHOOK_URL_KEY, url.trim());
    else localStorage.removeItem(WEBHOOK_URL_KEY);
  } catch (err) {
    console.debug('webhook setWebhookUrl', err);
  }
}

async function postWebhook(info: NowPlayingInfo) {
  const url = getWebhookUrl();
  if (!url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn('[webhook] invalid URL');
    return;
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const httpsOk = parsed.protocol === 'https:';
  const localHttp = parsed.protocol === 'http:' && loopback;
  if (!httpsOk && !localHttp) return;
  try {
    await invoke<number>('post_webhook', {
      url: parsed.toString(),
      body: JSON.stringify({
        event: 'track_change',
        title: info.title,
        artist: info.artist,
        id: info.id,
        position: info.position,
        duration: info.duration,
        isPlaying: info.isPlaying,
        coverUrl: info.coverUrl,
        timestamp: Date.now(),
      }),
    });
  } catch (e) {
    console.warn('[webhook] post failed', e);
  }
}

export const webhookPlugin: ZenithPlugin = {
  id: 'webhook',
  name: 'Webhook / Stream Deck',
  category: 'control',
  description:
    'POST JSON to a URL on every track change - works with Stream Deck, Home Assistant, n8n.',
  defaultEnabled: false,
  onTrackChange(info) {
    if (info) postWebhook(info);
  },
};
