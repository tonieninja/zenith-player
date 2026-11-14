import { useEffect, useState } from 'react';
import { readDuckMeter, type DuckMeter as Meter } from '../../plugins/duckOnVoice';

const SCALE = 0.2;
// pierwiastek rozciąga dół skali, bo tam leżą wszystkie sensowne progi mowy
const pos = (v: number) => `${Math.sqrt(Math.min(Math.max(v, 0), SCALE) / SCALE) * 100}%`;

type Props = {
  threshold: number;
  label: string;
  idle: string;
  listening: string;
  ducking: string;
};

export function DuckMeter({ threshold, label, idle, listening, ducking }: Props) {
  const [meter, setMeter] = useState<Meter | null>(null);

  useEffect(() => {
    let alive = true;
    const id = window.setInterval(() => {
      void readDuckMeter().then((m) => alive && setMeter(m));
    }, 100);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const level = meter?.level ?? 0;
  return (
    <div className="duck-meter">
      <div
        className="duck-meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={SCALE}
        aria-valuenow={level}
      >
        <div
          className={`duck-meter-fill${meter?.ducking ? ' ducking' : ''}`}
          style={{ width: pos(level) }}
        />
        <div className="duck-meter-mark release" style={{ left: pos(threshold * 0.6) }} />
        <div className="duck-meter-mark" style={{ left: pos(threshold) }} />
      </div>
      <span className={`plugin-desc${meter?.ducking ? ' duck-meter-on' : ''}`}>
        {!meter ? idle : meter.ducking ? ducking : listening}
      </span>
    </div>
  );
}
