use crate::player::Client::{self, *};

pub const GUEST_JS: &[Client] = &[WebEmbedded, TvSamsung, Tv];
pub const SIGNED_IN: &[Client] = &[WebEmbedded, TvSamsung, Tv, Web];
pub const WITH_POT: &[Client] = &[WebMusic, Mweb, WebSafari];

pub const RECOVERY: &[&[Client]] = &[
    &[Visionos],
    &[WebEmbedded, TvSamsung],
    &[Tv, TvDowngraded],
    SIGNED_IN,
];

pub const LAST_RESORT: &[Client] = &[
    Visionos,
    TvSamsung,
    Tv,
    WebEmbedded,
    Mweb,
    WebSafari,
    WebMusic,
    TvDowngraded,
];

pub fn name(c: Client) -> &'static str {
    match c {
        Visionos => "visionos",
        TvSamsung => "tv_samsung",
        Tv => "tv",
        TvDowngraded => "tv_downgraded",
        WebEmbedded => "web_embedded",
        WebSafari => "web_safari",
        Web => "web",
        Mweb => "mweb",
        WebMusic => "web_music",
    }
}

pub fn by_name(s: &str) -> Option<Client> {
    LAST_RESORT
        .iter()
        .chain([Web].iter())
        .copied()
        .find(|c| name(*c) == s.trim())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Guest(&'static [Client]),
    SignedIn(&'static [Client]),
}

pub fn escalation(signed_in: bool, pot_ready: bool) -> Vec<Step> {
    let mut v = Vec::new();
    if pot_ready {
        if signed_in {
            v.push(Step::SignedIn(WITH_POT));
        }
        v.push(Step::Guest(WITH_POT));
    }
    v.push(Step::Guest(GUEST_JS));
    if signed_in {
        v.push(Step::SignedIn(SIGNED_IN));
    }
    v.push(Step::Guest(LAST_RESORT));
    v
}

pub fn retry_delays_ms() -> &'static [u64] {
    &[0, 900, 2500]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_choice_needs_no_js_and_no_po_token() {
        assert_eq!(RECOVERY[0], &[Visionos]);
        assert_eq!(LAST_RESORT[0], Visionos);
        let s = crate::player::spec(Visionos);
        assert!(!s.needs_js && !s.needs_pot);
        assert!(!GUEST_JS.iter().any(|c| crate::player::spec(*c).needs_pot));
    }

    #[test]
    fn names_round_trip() {
        for c in LAST_RESORT.iter().chain([Web].iter()) {
            assert_eq!(by_name(name(*c)), Some(*c));
        }
        assert_eq!(by_name("android_vr"), None);
        assert_eq!(by_name(""), None);
    }

    #[test]
    fn escalation_uses_po_token_clients_only_when_minter_is_up() {
        let cold = escalation(false, false);
        assert!(!cold.contains(&Step::Guest(WITH_POT)));
        let hot = escalation(true, true);
        assert_eq!(hot[0], Step::SignedIn(WITH_POT));
        assert!(hot.contains(&Step::Guest(WITH_POT)));
        assert_eq!(escalation(false, true)[0], Step::Guest(WITH_POT));
        assert_eq!(*hot.last().unwrap(), Step::Guest(LAST_RESORT));
    }

    #[test]
    fn guest_never_gets_signed_in_steps() {
        assert!(!escalation(false, true)
            .iter()
            .any(|s| matches!(s, Step::SignedIn(_))));
    }

    #[test]
    fn recovery_ends_with_the_signed_in_set() {
        assert_eq!(*RECOVERY.last().unwrap(), SIGNED_IN);
        assert!(!SIGNED_IN.contains(&TvDowngraded));
    }
}
