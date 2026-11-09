import { romanizeLines } from './romanize';

self.onmessage = async (e: MessageEvent<{ id: number; lines: string[] }>) => {
  try {
    postMessage({ id: e.data.id, out: await romanizeLines(e.data.lines) });
  } catch (err) {
    postMessage({ id: e.data.id, err: String(err) });
  }
};
