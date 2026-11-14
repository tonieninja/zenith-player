import { createRoot } from 'react-dom/client';
import { LyricKaraokeText } from '../../src/components/LyricKaraokeText';
import '../../src/components/SyncedLyricsRail.css';

const w = window as unknown as { __pos: number };
w.__pos = 0;
createRoot(document.getElementById('root')!).render(
  <div className="synced-lyrics-rail" style={{ width: 340, ['--font-size' as string]: '28px' }}>
    <div className="lyric-row is-active" style={{ height: 'auto' }}>
      <LyricKaraokeText
        text="Wrapped karaoke line that needs two rows"
        active
        start={0}
        end={10}
        getProgress={() => w.__pos}
      />
    </div>
  </div>
);
