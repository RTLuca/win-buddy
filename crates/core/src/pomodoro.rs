//! Macchina a stati Pomodoro.
//!
//! Il core decide tutte le transizioni; shell e renderer consumano snapshot ed
//! eventi senza replicare regole. Ogni comando mutabile usa optimistic
//! concurrency e incrementa `transition_revision` esattamente una volta.

use crate::model::{PomodoroSession, SessionKind, SessionOutcome, SessionPhase, StartSession};
use crate::store::{SessionAdjustment, Store};
use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};

/// Oltre questa distanza dalla deadline non si presenta una celebrazione
/// tardiva: la sessione resta correggibile e richiede revisione umana.
pub const LATE_NOTIFY_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PomodoroConfig {
    pub focus_min: i64,
    pub short_min: i64,
    pub long_min: i64,
    pub long_every: i64,
    pub stale_sec: i64,
}

impl PomodoroConfig {
    pub fn load(store: &Store) -> Self {
        Self {
            focus_min: store.setting_i64("pomodoro.focus_min", 25),
            short_min: store.setting_i64("pomodoro.short_min", 5),
            long_min: store.setting_i64("pomodoro.long_min", 20),
            long_every: store.setting_i64("pomodoro.long_every", 4),
            stale_sec: store.setting_i64("pomodoro.stale_sec", 120),
        }
    }

    pub fn duration_ms(&self, kind: SessionKind) -> i64 {
        let minutes = match kind {
            SessionKind::Focus => self.focus_min,
            SessionKind::ShortBreak => self.short_min,
            SessionKind::LongBreak => self.long_min,
        };
        minutes * 60_000
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Prewarning,
    ReadyToClose,
    ReturnPrompt,
    RecoveryNeeded,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prewarning => "prewarning",
            Self::ReadyToClose => "ready_to_close",
            Self::ReturnPrompt => "return_prompt",
            Self::RecoveryNeeded => "recovery_needed",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "prewarning" => Some(Self::Prewarning),
            "ready_to_close" => Some(Self::ReadyToClose),
            "return_prompt" => Some(Self::ReturnPrompt),
            "recovery_needed" => Some(Self::RecoveryNeeded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PomodoroEvent {
    pub id: i64,
    pub session_id: i64,
    pub kind: EventKind,
    pub transition_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Recovery {
    Resumed(PomodoroSession),
    ReadyToClose(PomodoroSession),
    NeedsReview(PomodoroSession),
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionResult {
    pub session: PomodoroSession,
    pub effective_focus_ms: i64,
    pub events: Vec<PomodoroEvent>,
}

fn invalid_transition() -> CoreError {
    CoreError::InvalidState("transizione non consentita".into())
}

fn get_session(store: &Store, id: i64) -> Result<PomodoroSession> {
    store
        .get_session(id)?
        .ok_or_else(|| CoreError::InvalidState("sessione non trovata".into()))
}

fn command_session(store: &Store, id: i64, expected_revision: i64) -> Result<PomodoroSession> {
    let session = get_session(store, id)?;
    if session.transition_revision != expected_revision {
        return Err(CoreError::InvalidState("sessione già aggiornata".into()));
    }
    Ok(session)
}

fn transition_result(
    store: &Store,
    session: PomodoroSession,
    now: i64,
    events: Vec<PomodoroEvent>,
) -> Result<TransitionResult> {
    Ok(TransitionResult {
        effective_focus_ms: store.effective_focus_ms(session.id, now)?.max(0),
        session,
        events,
    })
}

/// La sessione aperta resta attiva anche oltre la deadline: un focus viene
/// chiuso soltanto da una decisione esplicita dell'utente.
pub fn active_session(store: &Store, _now: i64) -> Result<Option<PomodoroSession>> {
    store.open_session()
}

pub fn focus_active(store: &Store, now: i64) -> Result<bool> {
    Ok(active_session(store, now)?.is_some_and(|session| session.kind == SessionKind::Focus))
}

pub fn start(store: &Store, request: StartSession, now: i64) -> Result<TransitionResult> {
    if request.kind != SessionKind::Focus || request.planned_duration_ms <= 0 {
        return Err(invalid_transition());
    }
    let session = store.start_focus(request, now)?;
    transition_result(store, session, now, vec![])
}

pub fn pause(
    store: &Store,
    id: i64,
    expected_revision: i64,
    now: i64,
    reason: Option<&str>,
) -> Result<TransitionResult> {
    let current = command_session(store, id, expected_revision)?;
    if current.kind != SessionKind::Focus || current.phase != SessionPhase::Running {
        return Err(invalid_transition());
    }
    if now >= current.deadline_at {
        let (session, durable_event) = store.set_phase_with_presentation_event(
            id,
            SessionPhase::ReadyToClose,
            expected_revision,
            now,
            EventKind::ReadyToClose,
        )?;
        let events = vec![durable_event];
        return transition_result(store, session, now, events);
    }
    let session = store.pause_session(id, expected_revision, now, reason)?;
    transition_result(store, session, now, vec![])
}

pub fn resume(
    store: &Store,
    id: i64,
    expected_revision: i64,
    now: i64,
) -> Result<TransitionResult> {
    let current = command_session(store, id, expected_revision)?;
    if current.kind != SessionKind::Focus || current.phase != SessionPhase::Paused {
        return Err(invalid_transition());
    }
    let remaining = current.paused_remaining_ms.ok_or_else(invalid_transition)?;
    let deadline = now
        .checked_add(remaining)
        .ok_or_else(|| CoreError::InvalidState("durata sessione non valida".into()))?;
    let session = store.resume_session(id, expected_revision, now, deadline)?;
    transition_result(store, session, now, vec![])
}

pub fn adjust_duration(
    store: &Store,
    id: i64,
    expected_revision: i64,
    delta_ms: i64,
    now: i64,
) -> Result<TransitionResult> {
    let current = command_session(store, id, expected_revision)?;
    if matches!(current.phase, SessionPhase::Overtime | SessionPhase::Closed) {
        return Err(invalid_transition());
    }
    let shifted = current
        .deadline_at
        .checked_add(delta_ms)
        .ok_or_else(|| CoreError::InvalidState("durata sessione non valida".into()))?;
    let deadline = shifted.max(now);
    let phase = if deadline == now {
        SessionPhase::ReadyToClose
    } else if current.phase == SessionPhase::ReadyToClose {
        SessionPhase::Running
    } else {
        current.phase
    };
    let paused_remaining_ms = if phase == SessionPhase::Paused {
        let remaining = current.paused_remaining_ms.ok_or_else(invalid_transition)?;
        Some(remaining.saturating_add(delta_ms).max(0))
    } else {
        None
    };
    let leaves_pause = current.phase == SessionPhase::Paused && phase != SessionPhase::Paused;
    let event_kind = (phase == SessionPhase::ReadyToClose).then_some(EventKind::ReadyToClose);
    let (session, durable_event) = store.adjust_session(
        id,
        expected_revision,
        SessionAdjustment {
            phase,
            deadline_at: deadline,
            paused_remaining_ms,
            adjusted_at: now,
            close_open_pause: leaves_pause,
            presentation_event: event_kind,
        },
    )?;
    let events = durable_event.into_iter().collect();
    transition_result(store, session, now, events)
}

pub fn start_overtime(
    store: &Store,
    id: i64,
    expected_revision: i64,
    now: i64,
) -> Result<TransitionResult> {
    let current = command_session(store, id, expected_revision)?;
    if current.kind != SessionKind::Focus || current.phase != SessionPhase::ReadyToClose {
        return Err(invalid_transition());
    }
    let session = store.set_phase(id, SessionPhase::Overtime, expected_revision, now)?;
    transition_result(store, session, now, vec![])
}

pub fn finish(
    store: &Store,
    id: i64,
    expected_revision: i64,
    outcome: SessionOutcome,
    interruption_reason: Option<&str>,
    now: i64,
) -> Result<TransitionResult> {
    let current = command_session(store, id, expected_revision)?;
    if !matches!(
        current.phase,
        SessionPhase::Running
            | SessionPhase::Paused
            | SessionPhase::ReadyToClose
            | SessionPhase::Overtime
    ) || (outcome != SessionOutcome::Interrupted && interruption_reason.is_some())
    {
        return Err(invalid_transition());
    }
    let session = store.finish_session(id, expected_revision, outcome, interruption_reason, now)?;
    let effective_at = session.resolved_at.unwrap_or(now);
    transition_result(store, session, effective_at, vec![])
}

pub fn start_break(
    store: &Store,
    kind: SessionKind,
    duration_ms: i64,
    now: i64,
) -> Result<TransitionResult> {
    if !kind.is_break() || duration_ms <= 0 {
        return Err(invalid_transition());
    }
    let session = store.start_focus(
        StartSession {
            kind,
            preset_id: None,
            intention: String::new(),
            category: None,
            planned_duration_ms: duration_ms,
            estimated_ms: None,
            next_step: None,
        },
        now,
    )?;
    transition_result(store, session, now, vec![])
}

pub fn skip_break(
    store: &Store,
    id: i64,
    expected_revision: i64,
    now: i64,
) -> Result<TransitionResult> {
    let current = command_session(store, id, expected_revision)?;
    if !current.kind.is_break()
        || !matches!(
            current.phase,
            SessionPhase::Running | SessionPhase::ReadyToClose
        )
    {
        return Err(invalid_transition());
    }
    let session =
        store.finish_session(id, expected_revision, SessionOutcome::Partial, None, now)?;
    transition_result(store, session, now, vec![])
}

/// La pausa proposta è lunga ogni `long_every` focus completati nella giornata
/// civile indicata dal chiamante. Nessun contatore incrementale viene salvato.
pub fn proposed_break(store: &Store, day_start: i64, cfg: &PomodoroConfig) -> Result<SessionKind> {
    let completed = store.completed_focus_since(day_start)?;
    Ok(
        if cfg.long_every > 0 && completed > 0 && completed % cfg.long_every == 0 {
            SessionKind::LongBreak
        } else {
            SessionKind::ShortBreak
        },
    )
}

/// Conferma il prompt durevole del focus e avvia la pausa proposta. Chiusura,
/// ack e insert della pausa condividono il transaction boundary dello store.
pub fn accept_proposed_break(
    store: &Store,
    event_id: i64,
    now: i64,
    day_start: i64,
    cfg: &PomodoroConfig,
) -> Result<()> {
    let completed_after_current = store
        .completed_focus_since(day_start)?
        .checked_add(1)
        .ok_or_else(|| CoreError::InvalidState("conteggio focus non valido".into()))?;
    let kind = if cfg.long_every > 0 && completed_after_current % cfg.long_every == 0 {
        SessionKind::LongBreak
    } else {
        SessionKind::ShortBreak
    };
    let request = StartSession {
        kind,
        preset_id: None,
        intention: String::new(),
        category: None,
        planned_duration_ms: cfg.duration_ms(kind),
        estimated_ms: None,
        next_step: None,
    };
    store.finish_ready_focus_from_presentation(event_id, Some(request), now)
}

/// Conferma il prompt durevole del focus senza aprire una pausa.
pub fn skip_proposed_break(store: &Store, event_id: i64, now: i64) -> Result<()> {
    store.finish_ready_focus_from_presentation(event_id, None, now)
}

/// Applica solo transizioni determinate dall'orologio. Stato ed evento outbox
/// vengono confermati nella stessa transazione.
pub fn tick(store: &Store, now: i64) -> Result<Vec<PomodoroEvent>> {
    let Some(current) = store.open_session()? else {
        return Ok(vec![]);
    };
    if current.deadline_at > now {
        return Ok(vec![]);
    }
    match (current.kind, current.phase) {
        (SessionKind::Focus, SessionPhase::Running) => {
            let (_session, event) = store.set_phase_with_presentation_event(
                current.id,
                SessionPhase::ReadyToClose,
                current.transition_revision,
                now,
                EventKind::ReadyToClose,
            )?;
            Ok(vec![event])
        }
        (kind, SessionPhase::Running) if kind.is_break() => {
            let (_session, event) = store.finish_session_with_presentation_event(
                current.id,
                current.transition_revision,
                SessionOutcome::Completed,
                None,
                now,
                EventKind::ReturnPrompt,
            )?;
            Ok(vec![event])
        }
        _ => Ok(vec![]),
    }
}

/// Recupera deterministicamente la sessione aperta. I gap lunghi non
/// inventano esiti; gli eventi prodotti vengono sempre affidati all'outbox.
pub fn resolve_open(
    store: &Store,
    now: i64,
    last_alive: i64,
    _day_start: i64,
    cfg: &PomodoroConfig,
) -> Result<Recovery> {
    let Some(current) = store.open_session()? else {
        return Ok(Recovery::Nothing);
    };
    let gap_ms = now.saturating_sub(last_alive).max(0);
    let stale_ms = cfg.stale_sec.saturating_mul(1_000);
    let is_stale = gap_ms > stale_ms;

    if current.kind == SessionKind::Focus
        && current.phase == SessionPhase::Running
        && now >= current.deadline_at
    {
        let lateness = now.saturating_sub(current.deadline_at);
        let kind = if is_stale || lateness >= LATE_NOTIFY_MS {
            EventKind::RecoveryNeeded
        } else {
            EventKind::ReadyToClose
        };
        let (session, _event) = store.set_phase_with_presentation_event(
            current.id,
            SessionPhase::ReadyToClose,
            current.transition_revision,
            now,
            kind,
        )?;
        return Ok(Recovery::ReadyToClose(session));
    }

    if current.kind.is_break()
        && current.phase == SessionPhase::Running
        && now >= current.deadline_at
    {
        let lateness = now.saturating_sub(current.deadline_at);
        if is_stale || lateness >= LATE_NOTIFY_MS {
            let (session, _event) = store.set_phase_with_presentation_event(
                current.id,
                SessionPhase::ReadyToClose,
                current.transition_revision,
                now,
                EventKind::RecoveryNeeded,
            )?;
            return Ok(Recovery::NeedsReview(session));
        }
        let (_session, _event) = store.finish_session_with_presentation_event(
            current.id,
            current.transition_revision,
            SessionOutcome::Completed,
            None,
            now,
            EventKind::ReturnPrompt,
        )?;
        return Ok(Recovery::Nothing);
    }

    if current.kind == SessionKind::Focus && current.phase == SessionPhase::ReadyToClose {
        return Ok(Recovery::ReadyToClose(current));
    }

    if is_stale {
        if current.kind.is_break() && current.phase == SessionPhase::Running {
            let (session, _event) = store.set_phase_with_presentation_event(
                current.id,
                SessionPhase::ReadyToClose,
                current.transition_revision,
                now,
                EventKind::RecoveryNeeded,
            )?;
            return Ok(Recovery::NeedsReview(session));
        }
        let _event = store.enqueue_current_presentation_event(
            current.id,
            current.transition_revision,
            EventKind::RecoveryNeeded,
            now,
        )?;
        return Ok(Recovery::NeedsReview(current));
    }

    if current.phase == SessionPhase::ReadyToClose {
        Ok(Recovery::ReadyToClose(current))
    } else {
        Ok(Recovery::Resumed(current))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn setup() -> Store {
        Store::open_in_memory().unwrap()
    }

    fn request(duration_ms: i64) -> StartSession {
        StartSession::focus(1, "Spec", duration_ms)
    }

    #[test]
    fn deadline_requires_explicit_close_or_overtime() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;
        let out = tick(&s, 25 * MIN).unwrap();
        assert_eq!(out[0].kind, EventKind::ReadyToClose);
        assert_eq!(
            s.get_session(active.id).unwrap().unwrap().phase,
            SessionPhase::ReadyToClose
        );
        assert_eq!(s.get_session(active.id).unwrap().unwrap().outcome, None);
        assert_eq!(s.completed_focus_since(0).unwrap(), 0);

        start_overtime(&s, active.id, 1, 25 * MIN).unwrap();
        let closed = finish(&s, active.id, 2, SessionOutcome::Completed, None, 32 * MIN).unwrap();
        assert_eq!(closed.effective_focus_ms, 32 * MIN);
        assert_eq!(s.completed_focus_since(0).unwrap(), 1);
    }

    #[test]
    fn accepting_ready_focus_event_atomically_starts_the_proposed_break() {
        let s = setup();
        let focus = start(&s, request(MIN), 0).unwrap().session;
        let event = tick(&s, MIN).unwrap().remove(0);

        accept_proposed_break(&s, event.id, MIN + 1, 0, &PomodoroConfig::load(&s)).unwrap();

        assert_eq!(
            s.get_session(focus.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        assert_eq!(
            s.open_session().unwrap().unwrap().kind,
            SessionKind::ShortBreak
        );
        assert!(s.pending_presentation_events().unwrap().is_empty());
    }

    #[test]
    fn skipping_ready_focus_event_closes_and_consumes_it_without_a_break() {
        let s = setup();
        let focus = start(&s, request(MIN), 0).unwrap().session;
        let event = tick(&s, MIN).unwrap().remove(0);

        skip_proposed_break(&s, event.id, MIN + 1).unwrap();

        assert_eq!(
            s.get_session(focus.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        assert!(s.open_session().unwrap().is_none());
        assert!(s.pending_presentation_events().unwrap().is_empty());
    }

    #[test]
    fn pause_resume_preserves_remaining_time() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;
        pause(&s, active.id, 0, 10 * MIN, None).unwrap();
        let resumed = resume(&s, active.id, 1, 20 * MIN).unwrap();
        assert_eq!(resumed.session.deadline_at, 35 * MIN);
    }

    #[test]
    fn pause_at_deadline_marks_ready_without_opening_pause() {
        let s = setup();
        let active = start(&s, request(MIN), 0).unwrap().session;

        let ready = pause(&s, active.id, 0, MIN, None).unwrap();

        assert_eq!(ready.session.phase, SessionPhase::ReadyToClose);
        assert_eq!(ready.session.transition_revision, 1);
        assert_eq!(ready.events.len(), 1);
        assert_eq!(ready.events[0].kind, EventKind::ReadyToClose);
        let closed = finish(&s, active.id, 1, SessionOutcome::Completed, None, 2 * MIN).unwrap();
        assert_eq!(closed.effective_focus_ms, 2 * MIN);
    }

    #[test]
    fn pause_at_deadline_returns_the_durable_outbox_event() {
        let s = setup();
        let active = start(&s, request(MIN), 0).unwrap().session;

        let ready = pause(&s, active.id, 0, MIN, None).unwrap();
        let pending = s.pending_presentation_events().unwrap();

        assert!(ready.events[0].id > 0);
        assert_eq!(ready.events, pending);
    }

    #[test]
    fn break_deadline_closes_break_and_emits_return_prompt() {
        let s = setup();
        let focus = start(&s, request(MIN), 0).unwrap().session;
        finish(&s, focus.id, 0, SessionOutcome::Completed, None, MIN).unwrap();
        let break_session = start_break(&s, SessionKind::ShortBreak, 5 * MIN, MIN)
            .unwrap()
            .session;
        let events = tick(&s, 6 * MIN).unwrap();
        assert_eq!(
            s.get_session(break_session.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        assert!(events
            .iter()
            .any(|event| event.kind == EventKind::ReturnPrompt));
    }

    #[test]
    fn natural_break_deadline_persists_return_prompt_with_its_stable_id() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::ShortBreak, MIN, 0)
            .unwrap()
            .session;

        let events = tick(&s, MIN).unwrap();
        let pending = s.pending_presentation_events().unwrap();

        assert_eq!(
            s.get_session(break_session.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        assert!(events[0].id > 0);
        assert_eq!(events, pending);
    }

    #[test]
    fn stale_commands_do_not_mutate_the_session() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;
        let err = pause(&s, active.id, 1, 10 * MIN, None).unwrap_err();

        assert!(matches!(
            err,
            CoreError::InvalidState(ref message) if message == "sessione già aggiornata"
        ));
        let current = s.get_session(active.id).unwrap().unwrap();
        assert_eq!(current.phase, SessionPhase::Running);
        assert_eq!(current.transition_revision, 0);
    }

    #[test]
    fn stale_resume_leaves_pause_open_for_valid_retry() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;
        pause(&s, active.id, 0, 10 * MIN, None).unwrap();

        resume(&s, active.id, 0, 20 * MIN).unwrap_err();
        let resumed = resume(&s, active.id, 1, 20 * MIN).unwrap();

        assert_eq!(resumed.session.deadline_at, 35 * MIN);
        assert_eq!(resumed.session.transition_revision, 2);
    }

    #[test]
    fn finish_stale_revision_rolls_back_pause_close() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;
        pause(&s, active.id, 0, 10 * MIN, Some("coffee")).unwrap();

        finish(
            &s,
            active.id,
            0,
            SessionOutcome::Interrupted,
            Some("meeting"),
            15 * MIN,
        )
        .unwrap_err();
        let closed = finish(
            &s,
            active.id,
            1,
            SessionOutcome::Interrupted,
            Some("meeting"),
            20 * MIN,
        )
        .unwrap();

        assert_eq!(closed.effective_focus_ms, 10 * MIN);
        assert_eq!(
            closed.session.interruption_reason.as_deref(),
            Some("meeting")
        );
    }

    #[test]
    fn finish_before_pause_start_clamps_to_pause_start_without_inflation() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 10 * MIN).unwrap().session;
        pause(&s, active.id, 0, 15 * MIN, None).unwrap();

        let closed = finish(
            &s,
            active.id,
            1,
            SessionOutcome::Interrupted,
            None,
            14 * MIN,
        )
        .unwrap();

        assert_eq!(closed.session.resolved_at, Some(15 * MIN));
        assert_eq!(closed.effective_focus_ms, 5 * MIN);
    }

    #[test]
    fn finish_before_session_start_clamps_resolution_to_session_start() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 10 * MIN).unwrap().session;

        let closed = finish(&s, active.id, 0, SessionOutcome::Interrupted, None, 5 * MIN).unwrap();

        assert_eq!(closed.session.resolved_at, Some(10 * MIN));
        assert_eq!(closed.effective_focus_ms, 0);
    }

    #[test]
    fn finish_cannot_precede_an_already_closed_pause() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 10 * MIN).unwrap().session;
        pause(&s, active.id, 0, 12 * MIN, None).unwrap();
        resume(&s, active.id, 1, 16 * MIN).unwrap();

        let closed = finish(
            &s,
            active.id,
            2,
            SessionOutcome::Interrupted,
            None,
            11 * MIN,
        )
        .unwrap();

        assert_eq!(closed.session.resolved_at, Some(16 * MIN));
        assert_eq!(closed.effective_focus_ms, 2 * MIN);
    }

    #[test]
    fn signed_adjust_clamps_to_now_and_is_stale_safe() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;

        let adjusted = adjust_duration(&s, active.id, 0, -30 * MIN, 10 * MIN).unwrap();
        assert_eq!(adjusted.session.deadline_at, 10 * MIN);
        assert_eq!(adjusted.session.phase, SessionPhase::ReadyToClose);
        let err = adjust_duration(&s, active.id, 0, MIN, 10 * MIN).unwrap_err();
        assert!(matches!(
            err,
            CoreError::InvalidState(ref message) if message == "sessione già aggiornata"
        ));
        assert_eq!(
            s.get_session(active.id).unwrap().unwrap().deadline_at,
            10 * MIN
        );
    }

    #[test]
    fn overtime_cannot_be_adjusted_back_into_running() {
        let s = setup();
        let active = start(&s, request(MIN), 0).unwrap().session;
        tick(&s, MIN).unwrap();
        start_overtime(&s, active.id, 1, MIN).unwrap();

        let err = adjust_duration(&s, active.id, 2, MIN, 2 * MIN).unwrap_err();

        assert!(matches!(err, CoreError::InvalidState(_)));
        let current = s.get_session(active.id).unwrap().unwrap();
        assert_eq!(current.phase, SessionPhase::Overtime);
        assert_eq!(current.transition_revision, 2);
    }

    #[test]
    fn adjust_to_ready_closes_an_open_pause_at_adjustment_time() {
        let s = setup();
        let active = start(&s, request(25 * MIN), 0).unwrap().session;
        pause(&s, active.id, 0, 10 * MIN, None).unwrap();
        adjust_duration(&s, active.id, 1, -30 * MIN, 20 * MIN).unwrap();

        let closed = finish(&s, active.id, 2, SessionOutcome::Completed, None, 25 * MIN).unwrap();

        assert_eq!(closed.effective_focus_ms, 15 * MIN);
    }

    #[test]
    fn break_duration_can_be_adjusted_but_break_cannot_be_paused() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::LongBreak, 20 * MIN, 0)
            .unwrap()
            .session;

        let adjusted = adjust_duration(&s, break_session.id, 0, -5 * MIN, MIN).unwrap();
        assert_eq!(adjusted.session.deadline_at, 15 * MIN);
        assert!(pause(&s, break_session.id, 1, 2 * MIN, None).is_err());
    }

    #[test]
    fn explicit_break_adjustment_to_now_stays_ready_without_an_outcome() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::ShortBreak, 5 * MIN, 0)
            .unwrap()
            .session;

        let adjusted = adjust_duration(&s, break_session.id, 0, -10 * MIN, 2 * MIN).unwrap();
        let pending = s.pending_presentation_events().unwrap();

        assert_eq!(adjusted.session.phase, SessionPhase::ReadyToClose);
        assert_eq!(adjusted.session.outcome, None);
        assert_eq!(adjusted.events, pending);
        assert!(adjusted.events[0].id > 0);
        assert!(tick(&s, 3 * MIN).unwrap().is_empty());
    }

    #[test]
    fn finish_reason_is_only_valid_for_interrupted_outcome() {
        let s = setup();
        let active = start(&s, request(MIN), 0).unwrap().session;

        let err = finish(
            &s,
            active.id,
            0,
            SessionOutcome::Completed,
            Some("not applicable"),
            MIN,
        )
        .unwrap_err();

        assert!(matches!(err, CoreError::InvalidState(_)));
        assert_eq!(s.get_session(active.id).unwrap().unwrap().outcome, None);
    }

    #[test]
    fn skip_break_records_partial_outcome() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::ShortBreak, 5 * MIN, 0)
            .unwrap()
            .session;

        let skipped = skip_break(&s, break_session.id, 0, 2 * MIN).unwrap();

        assert_eq!(skipped.session.outcome, Some(SessionOutcome::Partial));
        assert_eq!(skipped.session.phase, SessionPhase::Closed);
    }

    #[test]
    fn invalid_transitions_are_rejected() {
        let s = setup();
        let active = start(&s, request(MIN), 0).unwrap().session;
        assert!(resume(&s, active.id, 0, 1).is_err());
        assert!(start_overtime(&s, active.id, 0, MIN).is_err());
        assert!(start_break(&s, SessionKind::Focus, MIN, 0).is_err());

        let mut invalid_start = request(MIN);
        invalid_start.kind = SessionKind::ShortBreak;
        assert!(start(&setup(), invalid_start, 0).is_err());
    }

    #[test]
    fn tick_only_transitions_a_focus_deadline_once() {
        let s = setup();
        start(&s, request(MIN), 0).unwrap();

        assert_eq!(tick(&s, MIN).unwrap().len(), 1);
        assert!(tick(&s, MIN + 1).unwrap().is_empty());
    }

    #[test]
    fn ready_event_is_durable_and_not_duplicated() {
        let s = setup();
        start(&s, request(MIN), 0).unwrap();

        tick(&s, MIN).unwrap();
        tick(&s, MIN + 5_000).unwrap();

        let events = s.pending_presentation_events().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == EventKind::ReadyToClose)
                .count(),
            1
        );
    }

    #[test]
    fn long_break_every_n_uses_completed_focuses_and_day_boundary() {
        let s = setup();
        let cfg = PomodoroConfig::load(&s);
        for index in 0..4 {
            let now = index * 2 * MIN;
            let focus = start(&s, request(MIN), now).unwrap().session;
            finish(&s, focus.id, 0, SessionOutcome::Completed, None, now + MIN).unwrap();
        }
        assert_eq!(proposed_break(&s, 0, &cfg).unwrap(), SessionKind::LongBreak);
        assert_eq!(
            proposed_break(&s, 24 * 60 * MIN, &cfg).unwrap(),
            SessionKind::ShortBreak
        );
    }

    #[test]
    fn short_recovery_gap_preserves_running_session() {
        let short = setup();
        let short_focus = start(&short, request(25 * MIN), 0).unwrap().session;
        let recovered =
            resolve_open(&short, 10 * MIN, 9 * MIN, 0, &PomodoroConfig::load(&short)).unwrap();
        assert!(matches!(recovered, Recovery::Resumed(_)));
        assert_eq!(
            short.get_session(short_focus.id).unwrap().unwrap().phase,
            SessionPhase::Running
        );
    }

    #[test]
    fn long_recovery_gap_requests_review_without_inventing_outcome() {
        let long = setup();
        let long_focus = start(&long, request(25 * MIN), 0).unwrap().session;
        let recovered =
            resolve_open(&long, 20 * MIN, 5 * MIN, 0, &PomodoroConfig::load(&long)).unwrap();
        assert!(matches!(recovered, Recovery::NeedsReview(_)));
        assert_eq!(
            long.pending_presentation_events().unwrap()[0].kind,
            EventKind::RecoveryNeeded
        );
        assert_eq!(
            long.get_session(long_focus.id).unwrap().unwrap().outcome,
            None
        );
    }

    #[test]
    fn long_gap_marks_running_session_for_review() {
        let s = setup();
        start(&s, request(25 * MIN), 0).unwrap();

        let recovered = resolve_open(&s, 20 * MIN, 5 * MIN, 0, &PomodoroConfig::load(&s)).unwrap();

        assert!(matches!(recovered, Recovery::NeedsReview(_)));
    }

    #[test]
    fn stale_expired_break_stays_reviewable_after_followup_tick() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::ShortBreak, 5 * MIN, 0)
            .unwrap()
            .session;

        let recovered = resolve_open(&s, 20 * MIN, 0, 0, &PomodoroConfig::load(&s)).unwrap();
        let after_recovery = s.get_session(break_session.id).unwrap().unwrap();
        let tick_events = tick(&s, 20 * MIN).unwrap();
        let after_tick = s.get_session(break_session.id).unwrap().unwrap();

        assert!(matches!(recovered, Recovery::NeedsReview(_)));
        assert_eq!(
            s.pending_presentation_events().unwrap()[0].kind,
            EventKind::RecoveryNeeded
        );
        assert_eq!(after_recovery.phase, SessionPhase::ReadyToClose);
        assert_eq!(after_recovery.outcome, None);
        assert!(tick_events
            .iter()
            .all(|event| event.kind != EventKind::ReturnPrompt));
        assert_eq!(after_tick.phase, SessionPhase::ReadyToClose);
        assert_eq!(after_tick.outcome, None);
    }

    #[test]
    fn stale_break_before_deadline_stays_reviewable_after_followup_tick() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::ShortBreak, 25 * MIN, 0)
            .unwrap()
            .session;

        let recovered = resolve_open(&s, 20 * MIN, 5 * MIN, 0, &PomodoroConfig::load(&s)).unwrap();
        let after_recovery = s.get_session(break_session.id).unwrap().unwrap();
        let tick_events = tick(&s, 25 * MIN).unwrap();
        let after_tick = s.get_session(break_session.id).unwrap().unwrap();

        assert!(matches!(recovered, Recovery::NeedsReview(_)));
        assert_eq!(
            s.pending_presentation_events().unwrap()[0].kind,
            EventKind::RecoveryNeeded
        );
        assert_eq!(after_recovery.phase, SessionPhase::ReadyToClose);
        assert_eq!(after_recovery.outcome, None);
        assert!(tick_events.is_empty());
        assert_eq!(after_tick.phase, SessionPhase::ReadyToClose);
        assert_eq!(after_tick.outcome, None);
    }

    #[test]
    fn recent_break_recovery_returns_nothing_after_closing_the_break() {
        let s = setup();
        let break_session = start_break(&s, SessionKind::ShortBreak, 5 * MIN, 0)
            .unwrap()
            .session;

        let recovered =
            resolve_open(&s, 6 * MIN, 6 * MIN - 1_000, 0, &PomodoroConfig::load(&s)).unwrap();

        assert!(matches!(recovered, Recovery::Nothing));
        assert_eq!(
            s.get_session(break_session.id).unwrap().unwrap().outcome,
            Some(SessionOutcome::Completed)
        );
        assert_eq!(
            s.pending_presentation_events().unwrap()[0].kind,
            EventKind::ReturnPrompt
        );
    }

    #[test]
    fn recently_ended_focus_recovers_as_ready_to_close() {
        let recent = setup();
        let recent_focus = start(&recent, request(25 * MIN), 0).unwrap().session;
        let recovered = resolve_open(
            &recent,
            28 * MIN,
            28 * MIN - 1_000,
            0,
            &PomodoroConfig::load(&recent),
        )
        .unwrap();
        assert!(matches!(recovered, Recovery::ReadyToClose(_)));
        assert_eq!(
            recent.pending_presentation_events().unwrap()[0].kind,
            EventKind::ReadyToClose
        );
        assert_eq!(
            recent.get_session(recent_focus.id).unwrap().unwrap().phase,
            SessionPhase::ReadyToClose
        );
    }

    #[test]
    fn focus_ended_long_ago_requires_review_without_counting_completion() {
        let late = setup();
        let late_focus = start(&late, request(25 * MIN), 0).unwrap().session;
        let recovered = resolve_open(
            &late,
            24 * 60 * MIN,
            24 * 60 * MIN - 1_000,
            0,
            &PomodoroConfig::load(&late),
        )
        .unwrap();
        assert!(matches!(recovered, Recovery::ReadyToClose(_)));
        assert_eq!(
            late.pending_presentation_events().unwrap()[0].kind,
            EventKind::RecoveryNeeded
        );
        assert_eq!(
            late.get_session(late_focus.id).unwrap().unwrap().phase,
            SessionPhase::ReadyToClose
        );
        assert_eq!(late.completed_focus_since(0).unwrap(), 0);
    }

    #[test]
    fn already_ready_focus_recovers_as_ready_even_after_a_long_gap() {
        let s = setup();
        let focus = start(&s, request(MIN), 0).unwrap().session;
        tick(&s, MIN).unwrap();

        let recovered = resolve_open(&s, 20 * MIN, MIN, 0, &PomodoroConfig::load(&s)).unwrap();

        assert!(matches!(recovered, Recovery::ReadyToClose(_)));
        let stored = s.get_session(focus.id).unwrap().unwrap();
        assert_eq!(stored.phase, SessionPhase::ReadyToClose);
        assert_eq!(stored.outcome, None);
    }
}
