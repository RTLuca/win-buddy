//! Logica di dominio di win-buddy.
//!
//! Regola non negoziabile della specifica (§ 5): tutta la logica sta qui.
//! Il renderer riceve stati già decisi e li mostra. Questo crate non dipende
//! da Tauri né da alcuna API di piattaforma: compila e si testa ovunque.

pub mod dnd;
pub mod events;
pub mod model;
pub mod parse;
pub mod pomodoro;
pub mod scheduler;
pub mod store;

pub use dnd::{DndLevel, SurfacePolicy};
pub use model::{Note, NoteState, PomodoroSession, SessionKind, SessionOutcome};
pub use store::Store;

#[derive(thiserror::Error, Debug)]
pub enum CoreError {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("stato non valido: {0}")]
    InvalidState(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
