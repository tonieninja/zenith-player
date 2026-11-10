import { useLyricsExtras } from '../lyrics/extras';

/** Tekst bez czasów: przewijany, z romanizacją i tłumaczeniem pod linią, jak tekst zsynchronizowany. */
export function PlainLyrics({
  text,
  translateTo,
  className,
}: {
  text: string;
  translateTo: string;
  className: string;
}) {
  const lines = text.split('\n');
  const extras = useLyricsExtras(lines, translateTo);
  if (!extras.length) return <div className={className}>{text}</div>;
  return (
    <div className={className}>
      {lines.map((line, i) => {
        const { roman, trans } = extras[i] ?? {};
        return (
          <div key={i} className="plain-lyrics-line">
            {line || ' '}
            {roman && <span className="plain-lyrics-sub plain-lyrics-roman">{roman}</span>}
            {trans && <span className="plain-lyrics-sub plain-lyrics-trans">{trans}</span>}
          </div>
        );
      })}
    </div>
  );
}
