//! Macchina a stati del pomodoro (§ 8).
//!
//! ```text
//!         avvia
//!  idle ─────────▶ focus ──(ends_at)──▶ break_prompt
//!   ▲                │                        │
//!   │                │ interrompi             │ accetta
//!   │                ▼                        ▼
//!   └──────────── aborted                  break ──(ends_at)──▶ idle
//! ```
//!
//! Nessun contatore: lo stato si ricalcola sempre come `ends_at − now`.
//! Le funzioni sono pure rispetto all'orologio: `now` lo inietta il chiamante.

use crate::model::{PomodoroSession, SessionKind, SessionOutcome};
use crate::store::Store;
use crate::Result;
use serde::{Deserialize, Serialize};

/// Fine avvenuta da meno di questo → si notifica normalmente (§ 8.3);
/// da più tempo → invalidata in silenzio. Senza questa regola il buddy
/// annuncia una pausa alle quattro del mattino, e non lo apri più.
pub const LATE_NOTIFY_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PomodoroConfig {
    pub focus_min: i64,
    pub short_min: i64,
    pub long_min: i64,
    /// Ogni quante sessioni di focus la pausa proposta è lunga.
    pub long_every: i64,
    /// Divario di inattività oltre il quale una sessione è invalidata (§ 8.3).
    pub stale_sec: i64,
}

impl PomodoroConfig {
    pub fn load(store: &Store) -> Self {
        PomodoroConfig {
            focus_min: store.setting_i64("pomodoro.focus_min", 25),
            short_min: store.setting_i64("pomodoro.short_min", 5),
            long_min: store.setting_i64("pomodoro.long_min", 20),
            long_every: store.setting_i64("pomodoro.long_every", 4),
            stale_sec: store.setting_i64("pomodoro.stale_sec", 120),
        }
    }

    pub fn duration_ms(&self, kind: SessionKind) -> i64 {
        let min = match kind {
            SessionKind::Focus => self.focus_min,
            SessionKind::ShortBreak => self.short_min,
            SessionKind::LongBreak => self.long_min,
        };
        min * 60_000
    }
}

/// Cosa è successo alla macchina a stati: la shell li traduce in eventi
/// verso l'overlay (stati, nuvolette) e in toast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PomodoroEvent {
    /// Un focus è arrivato in fondo: si propone la pausa (breve o lunga).
    FocusCompleted {
        session: PomodoroSession,
        proposed_break: SessionKind,
    },
    /// Una pausa è finita: si torna a idle.
    BreakCompleted { session: PomodoroSession },
    /// Ripresa dopo una sospensione breve: la sessione continua (§ 8.3).
    Resumed { session: PomodoroSession },
    /// Invalidata in silenzio: la creatura non annuncia nulla (§ 8.3).
    Invalidated { session: PomodoroSession },
}

/// La sessione attiva adesso, se ce n'è una non ancora scaduta.
pub fn active_session(store: &Store, now: i64) -> Result<Option<PomodoroSession>> {
    Ok(store
        .open_sessions()?
        .into_iter()
        .find(|s| now < s.ends_at))
}

/// C'è un focus in corso? (Decide se i promemoria si accodano, § 8.4.)
pub fn focus_active(store: &Store, now: i64) -> Result<bool> {
    Ok(active_session(store, now)?
        .map(|s| s.kind == SessionKind::Focus)
        .unwrap_or(false))
}

/// Avvia una sessione. Se ce n'è una aperta viene interrotta: avviarne
/// un'altra è il modo esplicito dell'utente di dire che quella vecchia
/// non conta più.
pub fn start(
    store: &Store,
    kind: SessionKind,
    label: Option<&str>,
    now: i64,
    cfg: &PomodoroConfig,
) -> Result<PomodoroSession> {
    for open in store.open_sessions()? {
        store.resolve_session(
            open.id,
            open.transition_revision,
            SessionOutcome::Aborted,
            now,
        )?;
    }
    store.start_session(kind, now, now + cfg.duration_ms(kind), label)
}

/// Interrompe la sessione in corso, se c'è.
pub fn abort(store: &Store, now: i64) -> Result<Option<PomodoroSession>> {
    let open = store.open_sessions()?;
    let current = open.into_iter().next();
    if let Some(s) = &current {
        store.resolve_session(
            s.id,
            s.transition_revision,
            SessionOutcome::Aborted,
            now,
        )?;
    }
    Ok(current)
}

/// La pausa da proporre dopo un focus: lunga ogni `long_every` sessioni
/// completate nella giornata civile locale. `day_start` è la mezzanotte
/// locale in epoch ms, calcolata dal chiamante.
pub fn proposed_break(store: &Store, day_start: i64, cfg: &PomodoroConfig) -> Result<SessionKind> {
    let done = store.completed_focus_since(day_start)?;
    Ok(if cfg.long_every > 0 && done > 0 && done % cfg.long_every == 0 {
        SessionKind::LongBreak
    } else {
        SessionKind::ShortBreak
    })
}

/// Tick a macchina viva: risolve le sessioni arrivate a `ends_at`.
pub fn tick(store: &Store, now: i64, day_start: i64, cfg: &PomodoroConfig) -> Result<Vec<PomodoroEvent>> {
    let mut events = Vec::new();
    for s in store.open_sessions()? {
        if now < s.ends_at {
            continue;
        }
        store.resolve_session(
            s.id,
            s.transition_revision,
            SessionOutcome::Completed,
            now,
        )?;
        let session = store.get_session(s.id)?.expect("appena risolta");
        if s.kind == SessionKind::Focus {
            let proposed = proposed_break(store, day_start, cfg)?;
            events.push(PomodoroEvent::FocusCompleted { session, proposed_break: proposed });
        } else {
            events.push(PomodoroEvent::BreakCompleted { session });
        }
    }
    Ok(events)
}

/// Risoluzione all'avvio o alla ripresa (§ 8.3). `last_alive` è l'ultimo
/// istante in cui l'app era certamente viva (l'ultimo battito registrato).
///
/// - `now < ends_at` e divario sotto soglia → la sessione riprende;
/// - divario sopra soglia → invalidata, la creatura non annuncia nulla;
/// - `now ≥ ends_at` ma da meno di 5 minuti → si notifica normalmente;
/// - più tempo → invalidata in silenzio.
pub fn resolve_open(
    store: &Store,
    now: i64,
    last_alive: i64,
    day_start: i64,
    cfg: &PomodoroConfig,
) -> Result<Vec<PomodoroEvent>> {
    let gap_ms = (now - last_alive).max(0);
    let stale_ms = cfg.stale_sec * 1_000;
    let mut events = Vec::new();

    for s in store.open_sessions()? {
        if now < s.ends_at {
            if gap_ms <= stale_ms {
                events.push(PomodoroEvent::Resumed { session: s });
            } else {
                store.resolve_session(
                    s.id,
                    s.transition_revision,
                    SessionOutcome::Invalidated,
                    now,
                )?;
                let session = store.get_session(s.id)?.expect("appena risolta");
                events.push(PomodoroEvent::Invalidated { session });
            }
        } else if now - s.ends_at < LATE_NOTIFY_MS {
            store.resolve_session(
                s.id,
                s.transition_revision,
                SessionOutcome::Completed,
                now,
            )?;
            let session = store.get_session(s.id)?.expect("appena risolta");
            if s.kind == SessionKind::Focus {
                let proposed = proposed_break(store, day_start, cfg)?;
                events.push(PomodoroEvent::FocusCompleted { session, proposed_break: proposed });
            } else {
                events.push(PomodoroEvent::BreakCompleted { session });
            }
        } else {
            store.resolve_session(
                s.id,
                s.transition_revision,
                SessionOutcome::Invalidated,
                now,
            )?;
            let session = store.get_session(s.id)?.expect("appena risolta");
            events.push(PomodoroEvent::Invalidated { session });
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn setup() -> (Store, PomodoroConfig) {
        let s = Store::open_in_memory().unwrap();
        let cfg = PomodoroConfig::load(&s);
        (s, cfg)
    }

    #[test]
    fn config_loads_defaults_from_settings() {
        let (_, cfg) = setup();
        assert_eq!(cfg.focus_min, 25);
        assert_eq!(cfg.long_every, 4);
        assert_eq!(cfg.stale_sec, 120);
    }

    #[test]
    fn focus_runs_to_completion_and_proposes_short_break() {
        let (s, cfg) = setup();
        let t0 = 1_000_000;
        start(&s, SessionKind::Focus, Some("spec"), t0, &cfg).unwrap();
        assert!(focus_active(&s, t0 + MIN).unwrap());

        // prima della fine: nessun evento
        assert!(tick(&s, t0 + 24 * MIN, 0, &cfg).unwrap().is_empty());

        let ev = tick(&s, t0 + 25 * MIN, 0, &cfg).unwrap();
        assert_eq!(ev.len(), 1);
        match &ev[0] {
            PomodoroEvent::FocusCompleted { session, proposed_break } => {
                assert_eq!(session.outcome, Some(SessionOutcome::Completed));
                assert_eq!(*proposed_break, SessionKind::ShortBreak);
            }
            other => panic!("atteso FocusCompleted, avuto {other:?}"),
        }
        assert!(!focus_active(&s, t0 + 26 * MIN).unwrap());
    }

    #[test]
    fn every_fourth_focus_proposes_long_break() {
        let (s, cfg) = setup();
        let day = 0;
        let mut t = 1_000;
        for i in 1..=4 {
            start(&s, SessionKind::Focus, None, t, &cfg).unwrap();
            let ev = tick(&s, t + 25 * MIN, day, &cfg).unwrap();
            let expected = if i == 4 { SessionKind::LongBreak } else { SessionKind::ShortBreak };
            match &ev[0] {
                PomodoroEvent::FocusCompleted { proposed_break, .. } => {
                    assert_eq!(*proposed_break, expected, "focus n. {i}");
                }
                other => panic!("{other:?}"),
            }
            t += 30 * MIN;
        }
        // il conteggio è per giornata civile: da domani si riparte
        let tomorrow_start = t + 24 * 60 * MIN;
        start(&s, SessionKind::Focus, None, tomorrow_start, &cfg).unwrap();
        let ev = tick(&s, tomorrow_start + 25 * MIN, tomorrow_start, &cfg).unwrap();
        match &ev[0] {
            PomodoroEvent::FocusCompleted { proposed_break, .. } => {
                assert_eq!(*proposed_break, SessionKind::ShortBreak);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn break_completion_returns_to_idle() {
        let (s, cfg) = setup();
        start(&s, SessionKind::ShortBreak, None, 0, &cfg).unwrap();
        let ev = tick(&s, 5 * MIN, 0, &cfg).unwrap();
        assert!(matches!(ev[0], PomodoroEvent::BreakCompleted { .. }));
        assert!(active_session(&s, 6 * MIN).unwrap().is_none());
    }

    #[test]
    fn starting_a_new_session_aborts_the_open_one() {
        let (s, cfg) = setup();
        let first = start(&s, SessionKind::Focus, None, 0, &cfg).unwrap();
        start(&s, SessionKind::Focus, None, 10 * MIN, &cfg).unwrap();
        let first = s.get_session(first.id).unwrap().unwrap();
        assert_eq!(first.outcome, Some(SessionOutcome::Aborted));
        assert_eq!(s.open_sessions().unwrap().len(), 1);
    }

    #[test]
    fn abort_resolves_current() {
        let (s, cfg) = setup();
        start(&s, SessionKind::Focus, None, 0, &cfg).unwrap();
        let aborted = abort(&s, MIN).unwrap().unwrap();
        assert_eq!(
            s.get_session(aborted.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Aborted)
        );
        assert!(abort(&s, 2 * MIN).unwrap().is_none());
    }

    // ------------------------------------------------ § 8.3, i quattro rami

    #[test]
    fn short_gap_resumes_the_session() {
        let (s, cfg) = setup();
        start(&s, SessionKind::Focus, None, 0, &cfg).unwrap();
        // sospeso per 60s (sotto la soglia dei 120), sessione non ancora finita
        let ev = resolve_open(&s, 10 * MIN, 10 * MIN - 60_000, 0, &cfg).unwrap();
        assert!(matches!(ev[0], PomodoroEvent::Resumed { .. }));
        assert!(focus_active(&s, 10 * MIN).unwrap());
    }

    #[test]
    fn long_gap_invalidates_silently() {
        let (s, cfg) = setup();
        start(&s, SessionKind::Focus, None, 0, &cfg).unwrap();
        // sospeso per 10 minuti, sessione non ancora finita
        let ev = resolve_open(&s, 15 * MIN, 5 * MIN, 0, &cfg).unwrap();
        match &ev[0] {
            PomodoroEvent::Invalidated { session } => {
                assert_eq!(session.outcome, Some(SessionOutcome::Invalidated));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn recently_ended_notifies_normally() {
        let (s, cfg) = setup();
        start(&s, SessionKind::Focus, None, 0, &cfg).unwrap();
        // riavvio 3 minuti dopo la fine naturale (25')
        let now = 28 * MIN;
        let ev = resolve_open(&s, now, now - 1_000, 0, &cfg).unwrap();
        match &ev[0] {
            PomodoroEvent::FocusCompleted { session, .. } => {
                assert_eq!(session.outcome, Some(SessionOutcome::Completed));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ended_long_ago_invalidates_silently() {
        let (s, cfg) = setup();
        start(&s, SessionKind::Focus, None, 0, &cfg).unwrap();
        // riavvio il giorno dopo: nessun annuncio alle quattro del mattino
        let now = 24 * 60 * MIN;
        let ev = resolve_open(&s, now, now - 1_000, 0, &cfg).unwrap();
        assert!(matches!(ev[0], PomodoroEvent::Invalidated { .. }));
        // e non conta nelle statistiche
        assert_eq!(s.completed_focus_since(0).unwrap(), 0);
    }
}
