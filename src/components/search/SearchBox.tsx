import {
  Fragment,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react';
import { History, Search, X } from 'lucide-react';
import {
  getSearchSuggestions,
  type SearchSuggestion,
  type SearchSuggestions,
  type Track,
} from '../../api/youtube';
import type { Language } from '../../i18n';
import { coverAttrs } from '../../utils/covers';
import {
  addSearchHistory,
  loadSearchHistory,
  removeSearchHistory,
} from '../../utils/searchHistory';
import { trackTypeLabel } from '../../utils/tracks';
import { pushToast } from '../Toast';
import './Search.css';

export const MAX_SEARCH_LENGTH = 200;
const SUGGEST_DELAY_MS = 120;
const LIST_ID = 'search-suggest-list';

export type SearchBoxHandle = { setText: (text: string) => void };

type Row =
  | { kind: 'recent'; query: string }
  | { kind: 'text'; query: string; runs: SearchSuggestion['runs'] }
  | { kind: 'item'; item: Track };

/** Pole wyszukiwania z podpowiedziami; tekst żyje tutaj, więc pisanie nie renderuje całej aplikacji. */
export const SearchBox = memo(function SearchBox({
  lang,
  t,
  inputRef,
  handleRef,
  onSearch,
  onPick,
}: {
  lang: Language;
  t: Record<string, string>;
  inputRef: RefObject<HTMLInputElement | null>;
  handleRef: Ref<SearchBoxHandle>;
  onSearch: (query: string) => void;
  onPick: (item: Track) => void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState(loadSearchHistory);
  const [hints, setHints] = useState<SearchSuggestions | null>(null);
  const q = text.trim();

  useImperativeHandle(
    handleRef,
    () => ({
      setText: (value: string) => {
        setText(value);
        setOpen(false);
        setActive(-1);
      },
    }),
    []
  );

  useEffect(() => {
    if (!q) return;
    let live = true;
    // każdy znak przestawia licznik, a odpowiedź na starsze zapytanie trafia już do zamkniętego efektu
    const timer = window.setTimeout(() => {
      getSearchSuggestions(q, lang).then(
        (data) => {
          if (live) setHints(data);
        },
        () => undefined
      );
    }, SUGGEST_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, lang]);

  const rows = useMemo<Row[]>(() => {
    if (!q) return recent.map((query) => ({ kind: 'recent', query }));
    if (!hints) return [];
    return [
      ...hints.texts.map((s): Row => ({ kind: 'text', query: s.query, runs: s.runs })),
      ...hints.items.map((item): Row => ({ kind: 'item', item })),
    ];
  }, [q, recent, hints]);
  const shown = open && rows.length > 0;
  const current = shown ? rows[active] : undefined;

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const submit = (raw: string) => {
    const query = raw.trim().slice(0, MAX_SEARCH_LENGTH).trim();
    if (!query) return;
    setText(query);
    close();
    setRecent(addSearchHistory(query));
    onSearch(query);
  };

  const choose = (row: Row) => {
    if (row.kind !== 'item') return submit(row.query);
    close();
    onPick(row.item);
  };

  const removeRecent = (query: string) => {
    const left = removeSearchHistory(query);
    setRecent(left);
    setActive((a) => Math.min(a, left.length - 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      const n = rows.length;
      const from = shown ? active : -1;
      // -1 to samo pole: po ostatniej pozycji strzałka wraca do wpisanego tekstu, jak w YouTube Music
      setActive(
        e.key === 'ArrowDown' ? ((from + 2) % (n + 1)) - 1 : ((from + n + 1) % (n + 1)) - 1
      );
      setOpen(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) choose(current);
      else submit(text);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (shown) close();
      else if (text) setText('');
      else e.currentTarget.blur();
    } else if (e.key === 'Tab' && !e.shiftKey && current && current.kind !== 'item') {
      // Tab przepisuje podświetloną podpowiedź do pola bez szukania, żeby dało się ją dopisać
      e.preventDefault();
      setText(current.query);
      setActive(-1);
    } else if (e.key === 'Delete' && current?.kind === 'recent') {
      e.preventDefault();
      removeRecent(current.query);
    }
  };

  const textItems = hints && q ? hints.texts.length : 0;

  return (
    <div className="titlebar-search no-window-drag" data-tour="search">
      <Search size={15} className="search-icon" />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={shown}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={current ? `${LIST_ID}-${active}` : undefined}
        placeholder={t.searchPlaceholder}
        aria-label={t.searchPlaceholder}
        className="search-input"
        value={text}
        maxLength={MAX_SEARCH_LENGTH}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          if (v.length >= MAX_SEARCH_LENGTH && text.length < MAX_SEARCH_LENGTH) {
            pushToast(t.searchTooLong, 'info');
          }
          setText(v.slice(0, MAX_SEARCH_LENGTH));
          setOpen(true);
          setActive(-1);
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (pasted.length + text.length > MAX_SEARCH_LENGTH) {
            pushToast(t.searchTooLong, 'info');
          }
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={close}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <div
          id={LIST_ID}
          role="listbox"
          aria-label={q ? t.searchSuggestions : t.recentSearches}
          className="search-suggest"
          // klik w listę nie może zabrać fokusu polu, bo blur zamknąłby ją przed kliknięciem
          onMouseDown={(e) => e.preventDefault()}
        >
          {rows.map((row, i) => (
            <Fragment key={i}>
              {i > 0 && i === textItems && <div className="search-suggest-sep" aria-hidden />}
              <div
                id={`${LIST_ID}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`search-suggest-row${i === active ? ' active' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(row)}
              >
                {row.kind === 'item' ? (
                  <>
                    <img
                      alt=""
                      className={`search-suggest-cover${row.item.type === 'artist' || row.item.type === 'profile' ? ' round' : ''}`}
                      loading="lazy"
                      decoding="async"
                      {...coverAttrs(row.item, 'thumb')}
                    />
                    <span className="search-suggest-meta">
                      <span className="search-suggest-title">{row.item.title}</span>
                      <span className="search-suggest-sub">
                        {[trackTypeLabel(row.item.type, t), row.item.artist]
                          .filter(Boolean)
                          .join(' • ')}
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    {row.kind === 'recent' ? (
                      <History size={18} aria-hidden />
                    ) : (
                      <Search size={18} aria-hidden />
                    )}
                    <span className="search-suggest-text">
                      {row.kind === 'recent'
                        ? row.query
                        : row.runs.map((r, j) => (r.bold ? <b key={j}>{r.text}</b> : r.text))}
                    </span>
                    {row.kind === 'recent' && (
                      <button
                        type="button"
                        tabIndex={-1}
                        className="search-suggest-remove"
                        aria-label={t.searchRemoveRecent}
                        title={t.searchRemoveRecent}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRecent(row.query);
                        }}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
});
