import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Props = {
  connected: string;
  waiting: string;
  noDiscord: string;
  badId: string;
  rejected: string;
};

export function discordStatusText(raw: string, t: Props): { text: string; ok: boolean } {
  if (raw.startsWith('connected:')) {
    const who = raw.slice('connected:'.length).trim();
    return { text: t.connected.replace('{name}', who || 'Discord'), ok: true };
  }
  if (raw === 'no-discord') return { text: t.noDiscord, ok: false };
  if (raw === 'invalid-app-id') return { text: t.badId, ok: false };
  if (raw.startsWith('rejected:')) {
    return { text: `${t.rejected} (${raw.slice('rejected:'.length)})`, ok: false };
  }
  return { text: t.waiting, ok: false };
}

export function DiscordStatus(props: Props) {
  const [raw, setRaw] = useState('');

  useEffect(() => {
    let alive = true;
    const read = () =>
      void invoke<string>('discord_status')
        .then((s) => alive && setRaw(s))
        .catch(() => undefined);
    read();
    const id = window.setInterval(read, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const { text, ok } = discordStatusText(raw, props);
  return (
    <span className={`plugin-desc discord-status${ok ? ' ok' : ''}`} role="status">
      {text}
    </span>
  );
}
