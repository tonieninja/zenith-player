// słownik kuromoji ma 17 MB, więc idzie z CDN przy pierwszej japońskiej piosence zamiast do instalatora
const JA_DICT = 'https://cdn.jsdelivr.net/npm/@sglkc/kuromoji@1.1.0/dict/';

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const HAN_RUN = /[㐀-䶿一-鿿豈-﫿]+/g;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const CYRILLIC = /[Ѐ-ӿ]/;

const CYR: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  ђ: 'đ',
  е: 'e',
  ё: 'yo',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'ć',
  у: 'u',
  ў: 'w',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  џ: 'dž',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export function romanizeCyrillic(text: string): string {
  return [...text]
    .map((ch) => {
      const low = ch.toLowerCase();
      const out = CYR[low];
      if (out === undefined) return ch;
      return ch === low || !out ? out : out[0].toUpperCase() + out.slice(1);
    })
    .join('');
}

type Converter = { convert(text: string, opts: Record<string, string>): Promise<string> };
let kuroshiro: Promise<Converter> | null = null;

function japanese(): Promise<Converter> {
  kuroshiro ??= (async () => {
    const [{ default: Kuroshiro }, { default: Analyzer }] = await Promise.all([
      import('@sglkc/kuroshiro'),
      import('@sglkc/kuroshiro-analyzer-kuromoji'),
    ]);
    const k = new Kuroshiro();
    await k.init(new Analyzer({ dictPath: JA_DICT }));
    return k as Converter;
  })().catch((e) => {
    // bez tego jedna nieudana próba (offline) blokowałaby japoński do restartu
    kuroshiro = null;
    throw e;
  });
  return kuroshiro;
}

const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s([,.!?」』)])/g, '$1')
    .trim();

/** Linia alfabetem łacińskim albo undefined, gdy nie ma czego romanizować. */
export async function romanizeLines(lines: string[]): Promise<(string | undefined)[]> {
  // kanji bez kany w japońskiej piosence to nadal japoński, nie chiński
  const ja = lines.some((l) => KANA.test(l));
  const needJa = ja && lines.some((l) => KANA.test(l) || HAN.test(l));
  const kuro = needJa ? await japanese() : null;
  const needKo = lines.some((l) => HANGUL.test(l));
  const needZh = !ja && lines.some((l) => HAN.test(l));
  const [ko, zh] = await Promise.all([
    needKo ? import('es-hangul') : null,
    needZh ? import('pinyin-pro') : null,
  ]);

  const out: (string | undefined)[] = [];
  for (const [i, line] of lines.entries()) {
    let r: string | undefined;
    if (kuro && (KANA.test(line) || HAN.test(line))) {
      r = await kuro.convert(line, { to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn' });
    } else if (ko && HANGUL.test(line)) {
      r = ko.romanize(line);
    } else if (zh && HAN.test(line)) {
      r = line.replace(HAN_RUN, (m) => ` ${zh.pinyin(m, { separator: ' ' })} `);
    } else if (CYRILLIC.test(line)) {
      r = romanizeCyrillic(line);
    }
    if (r === undefined) continue;
    const clean = tidy(r);
    if (clean && clean.toLowerCase() !== line.trim().toLowerCase()) out[i] = clean;
  }
  return out;
}
