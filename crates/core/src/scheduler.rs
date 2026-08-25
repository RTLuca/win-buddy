//! Scheduler dei promemoria (§ 7): il pezzo più delicato dell'app.
//!
//! Tre meccanismi che si coprono a vicenda: il tick lento ogni 30 secondi
//! (la rete di sicurezza), il timer mirato per le scadenze entro 60 secondi
//! (mai armare timer per scadenze lontane: non sopravvivono alla sospensione),
//! e il recupero — la stessa query del tick eseguita all'avvio, alla ripresa
//! e allo sblocco.

use crate::dnd::DndLevel;
use crate::model::Note;
use crate::store::Store;
use crate::Result;
use serde::{Deserialize, Serialize};

/// Cadenza del tick lento.
pub const TICK_MS: i64 = 30_000;
/// Finestra entro cui vale la pena armare un timer puntuale.
pub const ARM_WINDOW_MS: i64 = 60_000;
/// Oltre questa pila l'overlay mostra un riepilogo numerico (§ 7.3):
/// sfogliarne trenta uno per uno è peggio che non notificarli.
pub const MAX_STACK: usize = 10;
/// Divario tra due battiti del gap-check oltre il quale si assume una
/// sospensione: al risveglio va eseguito il recupero.
pub const RESUME_GAP_MS: i64 = 20_000;

/// Esito di un giro di tick.
#[derive(Debug, Clone)]
pub struct TickOutcome {
    /// Note appena passate a `fired` in questo giro, ordinate per scadenza.
    pub newly_fired: Vec<Note>,
    /// Se il prossimo `due_at` cade entro la finestra: fra quanti ms scatta.
    pub arm_timer_ms: Option<i64>,
}

/// Il tick lento (§ 7.1): marca `fired` tutto ciò che è scaduto e decide se
/// armare il timer mirato (§ 7.2). Idempotente: un promemoria già `fired`
/// non viene rimarcato.
pub fn tick(store: &Store, now: i64) -> Result<TickOutcome> {
    let due = store.due_notes(now)?;
    for n in &due {
        store.mark_fired(n.id, now)?;
    }
    let arm_timer_ms = store
        .next_due(now)?
        .map(|d| d - now)
        .filter(|delta| *delta <= ARM_WINDOW_MS)
        .map(|delta| delta.max(0));
    Ok(TickOutcome { newly_fired: due, arm_timer_ms })
}

/// Come presentare la pila dei promemoria scattati (§ 7.3, § 8.4, § 10.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Presentation {
    /// Niente da mostrare adesso. In DND nascosto le note restano accodate:
    /// lo scheduler non si ferma mai, perdere promemoria è l'unico errore
    /// imperdonabile per questa app.
    Nothing,
    /// In pila, una alla volta, ordinate per scadenza — non sei nuvolette
    /// contemporanee. L'animazione di avviso parte una volta sola.
    Stack { notes: Vec<Note> },
    /// Più di dieci scadute: riepilogo numerico e rimando al pannello.
    Summary { count: usize },
}

/// Decide la presentazione della pila corrente.
///
/// `focus_active`: durante una sessione di focus i promemoria non
/// interrompono (§ 8.4) — si accodano e arrivano all'inizio della pausa.
/// L'unica eccezione è una nota marcata urgente.
pub fn presentation(queue: &[Note], dnd: DndLevel, focus_active: bool) -> Presentation {
    if dnd == DndLevel::Hidden {
        return Presentation::Nothing;
    }
    let visible: Vec<Note> = if focus_active {
        queue.iter().filter(|n| n.urgent).cloned().collect()
    } else {
        queue.to_vec()
    };
    if visible.is_empty() {
        Presentation::Nothing
    } else if visible.len() > MAX_STACK {
        Presentation::Summary { count: visible.len() }
    } else {
        Presentation::Stack { notes: visible }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NoteState;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn tick_fires_due_and_is_idempotent() {
        let s = store();
        s.insert_note("a", Some(1_000), false, 0).unwrap();
        s.insert_note("b", Some(2_000), false, 0).unwrap();
        s.insert_note("senza scadenza", None, false, 0).unwrap();

        let out = tick(&s, 1_500).unwrap();
        assert_eq!(out.newly_fired.len(), 1);
        assert_eq!(out.newly_fired[0].body, "a");

        // secondo giro allo stesso istante: niente di nuovo
        let out = tick(&s, 1_500).unwrap();
        assert!(out.newly_fired.is_empty());

        let out = tick(&s, 2_000).unwrap();
        assert_eq!(out.newly_fired.len(), 1);
        assert_eq!(out.newly_fired[0].body, "b");
    }

    #[test]
    fn tick_arms_targeted_timer_only_within_window() {
        let s = store();
        s.insert_note("vicina", Some(100_000), false, 0).unwrap();
        // a 50s di distanza: dentro la finestra dei 60s
        let out = tick(&s, 50_000).unwrap();
        assert_eq!(out.arm_timer_ms, Some(50_000));
        // a 90s di distanza: mai armare timer per scadenze lontane
        let out = tick(&s, 10_000).unwrap();
        assert_eq!(out.arm_timer_ms, None);
    }

    #[test]
    fn recovery_is_the_same_query_as_the_tick() {
        // § 7.3: il recupero all'avvio usa la stessa strada del tick,
        // così rinvii e promemoria mai scattati passano dallo stesso codice.
        let s = store();
        s.insert_note("scaduta mentre era spento", Some(5_000), false, 0).unwrap();
        let out = tick(&s, 1_000_000).unwrap();
        assert_eq!(out.newly_fired.len(), 1);
        let n = s.get_note(out.newly_fired[0].id).unwrap().unwrap();
        assert_eq!(n.state, NoteState::Fired);
    }

    fn mk_notes(n: usize, urgent_first: bool) -> Vec<Note> {
        (0..n)
            .map(|i| Note {
                id: i as i64,
                body: format!("nota {i}"),
                created_at: 0,
                due_at: Some(i as i64),
                urgent: urgent_first && i == 0,
                state: NoteState::Fired,
                fired_at: Some(0),
                snooze_count: 0,
                completed_at: None,
            })
            .collect()
    }

    #[test]
    fn presentation_stack_summary_and_dnd() {
        let three = mk_notes(3, false);
        assert!(matches!(
            presentation(&three, DndLevel::Normal, false),
            Presentation::Stack { ref notes } if notes.len() == 3
        ));
        // in DND nascosto: accodate, mai perse
        assert_eq!(presentation(&three, DndLevel::Hidden, false), Presentation::Nothing);
        // oltre dieci: riepilogo
        let many = mk_notes(11, false);
        assert_eq!(
            presentation(&many, DndLevel::Normal, false),
            Presentation::Summary { count: 11 }
        );
        // vuota
        assert_eq!(presentation(&[], DndLevel::Normal, false), Presentation::Nothing);
    }

    #[test]
    fn focus_queues_all_but_urgent() {
        let mut notes = mk_notes(3, true); // la prima è urgente
        let p = presentation(&notes, DndLevel::Normal, true);
        match p {
            Presentation::Stack { notes } => {
                assert_eq!(notes.len(), 1);
                assert!(notes[0].urgent);
            }
            other => panic!("attesa Stack, avuto {other:?}"),
        }
        // nessuna urgente → niente durante il focus
        notes[0].urgent = false;
        assert_eq!(presentation(&notes, DndLevel::Normal, true), Presentation::Nothing);
        // la modalità discreta non blocca la presentazione (§ 10.3)
        assert!(matches!(
            presentation(&notes, DndLevel::Discreet, false),
            Presentation::Stack { .. }
        ));
    }
}
