/** onboarding + tour flags, versioned so we can bump it later */
export const ONBOARDING_VERSION = 1;
export const LEGAL_ACK_VERSION = 1;

const DONE_KEY = 'zenith_onboarding_done';
const TOUR_KEY = 'zenith_feature_tour_done';
const LEGAL_KEY = 'zenith_legal_ack';

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === String(ONBOARDING_VERSION);
  } catch {
    return false;
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(DONE_KEY, String(ONBOARDING_VERSION));
  } catch {}
}

export function isLegalAcked(): boolean {
  try {
    return localStorage.getItem(LEGAL_KEY) === String(LEGAL_ACK_VERSION);
  } catch {
    return false;
  }
}

export function markLegalAcked(): void {
  try {
    localStorage.setItem(LEGAL_KEY, String(LEGAL_ACK_VERSION));
  } catch {}
}

export function isFeatureTourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === '1';
  } catch {
    return false;
  }
}

export function markFeatureTourDone(): void {
  try {
    localStorage.setItem(TOUR_KEY, '1');
  } catch {}
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(DONE_KEY);
    localStorage.removeItem(TOUR_KEY);
  } catch {}
}
