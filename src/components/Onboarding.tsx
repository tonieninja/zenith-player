import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  Compass,
  Headphones,
  Home,
  Library,
  LogIn,
  Music2,
  Puzzle,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import type { Language } from '../i18n';
import { translations } from '../i18n';
import {
  isFeatureTourDone,
  isLegalAcked,
  isOnboardingDone,
  markFeatureTourDone,
  markLegalAcked,
  markOnboardingDone,
} from '../utils/onboarding';

type WelcomeIcon = 'sparkles' | 'home' | 'music' | 'puzzle' | 'library';

const WELCOME_ICONS: Record<WelcomeIcon, typeof Sparkles> = {
  sparkles: Sparkles,
  home: Home,
  music: Music2,
  puzzle: Puzzle,
  library: Library,
};

const WELCOME_STEPS: { icon: WelcomeIcon; titleKey: string; descKey: string }[] = [
  { icon: 'sparkles', titleKey: 'onbWelcomeTitle', descKey: 'onbWelcomeDesc' },
  { icon: 'home', titleKey: 'onbBrowseTitle', descKey: 'onbBrowseDesc' },
  { icon: 'music', titleKey: 'onbPlayerTitle', descKey: 'onbPlayerDesc' },
  { icon: 'puzzle', titleKey: 'onbPluginsTitle', descKey: 'onbPluginsDesc' },
  { icon: 'library', titleKey: 'onbLibraryTitle', descKey: 'onbLibraryDesc' },
];

const TOUR_TARGETS = [
  { id: 'search', titleKey: 'tourSearchTitle', descKey: 'tourSearchDesc' },
  { id: 'home', titleKey: 'tourHomeTitle', descKey: 'tourHomeDesc' },
  { id: 'library', titleKey: 'tourLibraryTitle', descKey: 'tourLibraryDesc' },
  { id: 'plugins', titleKey: 'tourPluginsTitle', descKey: 'tourPluginsDesc' },
  { id: 'login', titleKey: 'tourLoginTitle', descKey: 'tourLoginDesc' },
] as const;

type TourTargetId = (typeof TOUR_TARGETS)[number]['id'];

type Rect = { top: number; left: number; width: number; height: number };

function measureTourTarget(id: TourTargetId): Rect | null {
  const el = document.querySelector(`[data-tour="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const pad = 8;
  return {
    top: Math.max(8, r.top - pad),
    left: Math.max(8, r.left - pad),
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  };
}

type OnboardingProps = {
  lang: Language;
  open: boolean;
  onClose: () => void;
  onSignIn: () => void;
  libAuthed: boolean | null;
};

export function Onboarding({ lang, open, onClose, onSignIn, libAuthed }: OnboardingProps) {
  const t = translations[lang];
  const [phase, setPhase] = useState<'legal' | 'welcome' | 'tour'>(
    isLegalAcked() ? 'welcome' : 'legal'
  );
  const [step, setStep] = useState(0);
  const [tourRect, setTourRect] = useState<Rect | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [legalChecked, setLegalChecked] = useState(false);

  useEffect(() => {
    if (!open) {
      setLeaving(false);
      return;
    }
    setPhase(isLegalAcked() ? 'welcome' : 'legal');
    setStep(0);
    setLegalChecked(false);
  }, [open]);

  const finish = useCallback(() => {
    markLegalAcked();
    markOnboardingDone();
    markFeatureTourDone();
    setLeaving(true);
    window.setTimeout(() => onClose(), 280);
  }, [onClose]);

  const startTour = useCallback(() => {
    markLegalAcked();
    markOnboardingDone();
    setPhase('tour');
    setStep(0);
  }, []);

  const skipTour = useCallback(() => {
    if (!isLegalAcked()) return;
    markOnboardingDone();
    markFeatureTourDone();
    setLeaving(true);
    window.setTimeout(() => onClose(), 280);
  }, [onClose]);

  const acceptLegal = useCallback(() => {
    if (!legalChecked) return;
    markLegalAcked();
    if (isOnboardingDone()) {
      setLeaving(true);
      window.setTimeout(() => onClose(), 280);
      return;
    }
    setPhase('welcome');
    setStep(0);
  }, [legalChecked, onClose]);

  useLayoutEffect(() => {
    if (!open || phase !== 'tour') return;
    const target = TOUR_TARGETS[step]?.id;
    if (!target) return;

    const update = () => setTourRect(measureTourTarget(target));
    update();
    const iv = window.setInterval(update, 400);
    window.addEventListener('resize', update);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('resize', update);
    };
  }, [open, phase, step]);

  if (!open) return null;

  if (phase === 'legal') {
    return (
      <div
        className={`onboarding-root ${leaving ? 'leaving' : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="onboarding-backdrop" />
        <div className="onboarding-card">
          <div className="onboarding-hero-icon" aria-hidden>
            <Shield size={42} strokeWidth={1.4} />
          </div>
          <h2 className="onboarding-title">{t.onbLegalTitle}</h2>
          <p className="onboarding-desc">{t.onbLegalDesc}</p>
          <label className="onboarding-legal-check">
            <input
              type="checkbox"
              checked={legalChecked}
              onChange={(e) => setLegalChecked(e.target.checked)}
            />
            <span>{t.onbLegalCheck}</span>
          </label>
          <div className="onboarding-actions">
            <button
              type="button"
              className="onboarding-btn primary"
              disabled={!legalChecked}
              onClick={acceptLegal}
            >
              {t.onbLegalContinue}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'welcome') {
    const current = WELCOME_STEPS[step];
    const Icon = WELCOME_ICONS[current.icon];
    const isLast = step === WELCOME_STEPS.length - 1;

    return (
      <div
        className={`onboarding-root ${leaving ? 'leaving' : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="onboarding-backdrop" />
        <div className="onboarding-card">
          <button type="button" className="onboarding-skip" onClick={skipTour}>
            {t.onbSkip}
          </button>
          <div className="onboarding-hero-icon" aria-hidden>
            <Icon size={42} strokeWidth={1.4} />
          </div>
          <h2 className="onboarding-title">{t[current.titleKey as keyof typeof t]}</h2>
          <p className="onboarding-desc">{t[current.descKey as keyof typeof t]}</p>
          <div className="onboarding-dots">
            {WELCOME_STEPS.map((_, i) => (
              <span key={i} className={`onboarding-dot ${i === step ? 'active' : ''}`} />
            ))}
          </div>
          <div className="onboarding-actions">
            {step > 0 && (
              <button
                type="button"
                className="onboarding-btn ghost"
                onClick={() => setStep((s) => s - 1)}
              >
                {t.onbBack}
              </button>
            )}
            {!isLast ? (
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={() => setStep((s) => s + 1)}
              >
                {t.onbNext}
              </button>
            ) : (
              <>
                {!libAuthed && (
                  <button
                    type="button"
                    className="onboarding-btn primary"
                    onClick={() => {
                      onSignIn();
                      startTour();
                    }}
                  >
                    <LogIn size={18} />
                    {t.onbSignInCta}
                  </button>
                )}
                <button type="button" className="onboarding-btn secondary" onClick={startTour}>
                  <Compass size={18} />
                  {t.onbTourCta}
                </button>
                <button type="button" className="onboarding-btn ghost" onClick={skipTour}>
                  {t.onbExploreCta}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const tourStep = TOUR_TARGETS[step];
  const tourLast = step >= TOUR_TARGETS.length - 1;
  const cardStyle: { top?: number; left?: number; bottom?: number } = {};
  if (tourRect) {
    const below = tourRect.top + tourRect.height + 16;
    if (below + 220 < window.innerHeight) {
      cardStyle.top = below;
      cardStyle.left = Math.min(tourRect.left, window.innerWidth - 340);
    } else {
      cardStyle.bottom = window.innerHeight - tourRect.top + 16;
      cardStyle.left = Math.min(tourRect.left, window.innerWidth - 340);
    }
  }

  return (
    <div className={`onboarding-root tour-mode ${leaving ? 'leaving' : ''}`} role="dialog">
      <div
        className="onboarding-spotlight-hole"
        style={
          tourRect
            ? {
                top: tourRect.top,
                left: tourRect.left,
                width: tourRect.width,
                height: tourRect.height,
              }
            : undefined
        }
      />
      <div className="onboarding-tour-card" style={cardStyle}>
        <div className="onboarding-tour-header">
          <Headphones size={20} />
          <span>{t.onbTourLabel}</span>
          <button
            type="button"
            className="onboarding-tour-close"
            onClick={finish}
            aria-label={t.onbSkip}
          >
            <X size={18} />
          </button>
        </div>
        <h3 className="onboarding-tour-title">{t[tourStep.titleKey as keyof typeof t]}</h3>
        <p className="onboarding-tour-desc">{t[tourStep.descKey as keyof typeof t]}</p>
        <div className="onboarding-dots compact">
          {TOUR_TARGETS.map((_, i) => (
            <span key={i} className={`onboarding-dot ${i === step ? 'active' : ''}`} />
          ))}
        </div>
        <div className="onboarding-actions">
          {step > 0 && (
            <button
              type="button"
              className="onboarding-btn ghost"
              onClick={() => setStep((s) => s - 1)}
            >
              {t.onbBack}
            </button>
          )}
          {!tourLast ? (
            <button
              type="button"
              className="onboarding-btn primary"
              onClick={() => setStep((s) => s + 1)}
            >
              {t.onbNext}
            </button>
          ) : (
            <button type="button" className="onboarding-btn primary" onClick={finish}>
              {t.onbDone}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** first launch after splash */
export function shouldShowOnboarding(): boolean {
  return !isLegalAcked() || !isOnboardingDone();
}

/** replay the tour from settings if you want */
export function shouldShowFeatureTourOnly(): boolean {
  return isOnboardingDone() && !isFeatureTourDone();
}
