//! Registro transazionale delle scorciatoie globali della shell.
//!
//! Il plugin conosce soltanto combinazioni di tasti. La mappa verso le
//! azioni resta qui, sostituibile senza closure obsolete e senza mai
//! deregistrare la scorciatoia DND fissa.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::commands::{self, FocusAction};
use crate::state::AppState;
use crate::surfaces;

const FIXED_DND: &str = "Ctrl+Alt+H";
const EVT_FINISH_INTENT: &str = "focus:finish-intent";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutAction {
    StartLast,
    PauseResume,
    Extend5,
    Capture,
    FinishChooser,
}

const DEFINITIONS: [(&str, &str, ShortcutAction); 5] = [
    (
        "shortcut.focus.start_last",
        "Ctrl+Alt+F",
        ShortcutAction::StartLast,
    ),
    (
        "shortcut.focus.pause_resume",
        "Ctrl+Alt+P",
        ShortcutAction::PauseResume,
    ),
    (
        "shortcut.focus.extend_5",
        "Ctrl+Alt+5",
        ShortcutAction::Extend5,
    ),
    (
        "shortcut.focus.capture",
        "Ctrl+Alt+Space",
        ShortcutAction::Capture,
    ),
    (
        "shortcut.focus.finish",
        "Ctrl+Alt+Enter",
        ShortcutAction::FinishChooser,
    ),
];

pub(crate) fn shortcut_defaults() -> [(&'static str, &'static str); 5] {
    DEFINITIONS.map(|(key, value, _)| (key, value))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShortcutBinding {
    shortcut: Shortcut,
    canonical: String,
    action: ShortcutAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShortcutPlan {
    bindings: Vec<ShortcutBinding>,
    values: HashMap<String, String>,
}

impl ShortcutPlan {
    fn empty() -> Self {
        Self {
            bindings: Vec::new(),
            values: DEFINITIONS
                .iter()
                .map(|(key, _, _)| ((*key).to_string(), String::new()))
                .collect(),
        }
    }

    fn parse(values: &HashMap<String, String>) -> Result<Self, String> {
        let dnd = FIXED_DND
            .parse::<Shortcut>()
            .map_err(|error| format!("scorciatoia DND non valida: {error}"))?;
        let mut ids = HashSet::new();
        let mut bindings = Vec::new();
        let mut normalized = HashMap::new();
        for (key, default, action) in DEFINITIONS {
            let raw = values
                .get(key)
                .map(String::as_str)
                .unwrap_or(default)
                .trim();
            if raw.is_empty() {
                normalized.insert(key.to_string(), String::new());
                continue;
            }
            let shortcut = raw
                .parse::<Shortcut>()
                .map_err(|error| format!("{key}: combinazione non valida ({error})"))?;
            if shortcut.id() == dnd.id() {
                return Err(format!("{key}: Ctrl+Alt+H è riservata alla modalità DND"));
            }
            let canonical = shortcut.into_string();
            if !ids.insert(shortcut.id()) {
                return Err(format!("{key}: combinazione duplicata ({canonical})"));
            }
            normalized.insert(key.to_string(), canonical.clone());
            bindings.push(ShortcutBinding {
                shortcut,
                canonical,
                action,
            });
        }
        Ok(Self {
            bindings,
            values: normalized,
        })
    }

    #[cfg(test)]
    fn binding(&self, action: ShortcutAction) -> Option<&ShortcutBinding> {
        self.bindings
            .iter()
            .find(|binding| binding.action == action)
    }

    fn binding_by_id(&self, id: u32) -> Option<&ShortcutBinding> {
        self.bindings
            .iter()
            .find(|binding| binding.shortcut.id() == id)
    }

    fn values(&self) -> HashMap<String, String> {
        self.values.clone()
    }
}

trait ShortcutRegistrar {
    fn register(&mut self, binding: &ShortcutBinding) -> Result<(), String>;
    fn unregister(&mut self, binding: &ShortcutBinding) -> Result<(), String>;
}

trait ShortcutPersistence {
    fn persist(&mut self, plan: &ShortcutPlan) -> Result<(), String>;
}

trait ShortcutActionMap {
    fn replace(&mut self, plan: &ShortcutPlan);
}

fn replace_os_bindings<R: ShortcutRegistrar>(
    previous: &ShortcutPlan,
    next: &ShortcutPlan,
    registrar: &mut R,
) -> Result<(), String> {
    let additions: Vec<_> = next
        .bindings
        .iter()
        .filter(|binding| previous.binding_by_id(binding.shortcut.id()).is_none())
        .collect();
    let obsolete: Vec<_> = previous
        .bindings
        .iter()
        .filter(|binding| next.binding_by_id(binding.shortcut.id()).is_none())
        .collect();

    let mut added = Vec::new();
    for binding in additions {
        if let Err(error) = registrar.register(binding) {
            for rollback in added.into_iter().rev() {
                let _ = registrar.unregister(rollback);
            }
            return Err(format!("{}: {error}", binding.canonical));
        }
        added.push(binding);
    }

    let mut removed = Vec::new();
    for binding in obsolete {
        if let Err(error) = registrar.unregister(binding) {
            for rollback in removed.into_iter().rev() {
                let _ = registrar.register(rollback);
            }
            for rollback in added.into_iter().rev() {
                let _ = registrar.unregister(rollback);
            }
            return Err(format!("{}: {error}", binding.canonical));
        }
        removed.push(binding);
    }
    Ok(())
}

fn activate_plan<R, P, A>(
    previous: &ShortcutPlan,
    next: &ShortcutPlan,
    registrar: &mut R,
    persistence: &mut P,
    active_map: &mut A,
) -> Result<(), String>
where
    R: ShortcutRegistrar,
    P: ShortcutPersistence,
    A: ShortcutActionMap,
{
    replace_os_bindings(previous, next, registrar)?;
    active_map.replace(next);
    if let Err(error) = persistence.persist(next) {
        let restore_error = replace_os_bindings(next, previous, registrar).err();
        active_map.replace(previous);
        let settings_error = persistence.persist(previous).err();
        let details = [restore_error, settings_error]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("; ");
        return Err(if details.is_empty() {
            format!("salvataggio scorciatoie fallito: {error}")
        } else {
            format!("salvataggio scorciatoie fallito: {error}; ripristino: {details}")
        });
    }
    Ok(())
}

#[derive(Default)]
struct FinishIntent(AtomicBool);

impl FinishIntent {
    fn request(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn take(&self) -> bool {
        self.0.swap(false, Ordering::AcqRel)
    }
}

pub(crate) struct ShortcutRuntime {
    active: Mutex<ShortcutPlan>,
    visible: Mutex<HashMap<String, String>>,
    update: Mutex<()>,
    finish_intent: FinishIntent,
}

impl Default for ShortcutRuntime {
    fn default() -> Self {
        Self {
            active: Mutex::new(ShortcutPlan::empty()),
            visible: Mutex::new(
                shortcut_defaults()
                    .into_iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
            ),
            update: Mutex::new(()),
            finish_intent: FinishIntent::default(),
        }
    }
}

struct PluginRegistrar<'a>(&'a AppHandle);

impl ShortcutRegistrar for PluginRegistrar<'_> {
    fn register(&mut self, binding: &ShortcutBinding) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(binding.shortcut)
            .map_err(|error| error.to_string())
    }

    fn unregister(&mut self, binding: &ShortcutBinding) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(binding.shortcut)
            .map_err(|error| error.to_string())
    }
}

struct StorePersistence<'a>(&'a AppHandle);

impl ShortcutPersistence for StorePersistence<'_> {
    fn persist(&mut self, plan: &ShortcutPlan) -> Result<(), String> {
        let pairs: Vec<_> = DEFINITIONS
            .iter()
            .map(|(key, _, _)| {
                (
                    *key,
                    plan.values
                        .get(*key)
                        .map(String::as_str)
                        .unwrap_or_default(),
                )
            })
            .collect();
        let state = self.0.state::<AppState>();
        let result = state
            .store
            .lock()
            .unwrap()
            .set_settings(&pairs)
            .map_err(|error| error.to_string());
        result
    }
}

struct RuntimeActionMap<'a>(&'a ShortcutRuntime);

impl ShortcutActionMap for RuntimeActionMap<'_> {
    fn replace(&mut self, plan: &ShortcutPlan) {
        *self.0.active.lock().unwrap() = plan.clone();
    }
}

pub(crate) fn setup(app: &AppHandle) {
    app.manage(ShortcutRuntime::default());

    match FIXED_DND
        .parse::<Shortcut>()
        .map_err(|error| error.to_string())
    {
        Ok(shortcut) => match app.global_shortcut().register(shortcut) {
            Ok(()) => log::info!("scorciatoia DND registrata (Ctrl+Alt+H)"),
            Err(error) => log::warn!("Ctrl+Alt+H non registrata: {error}"),
        },
        Err(error) => log::warn!("scorciatoia DND non valida: {error}"),
    }

    let values = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        shortcut_defaults()
            .into_iter()
            .map(|(key, default)| {
                let value = store
                    .setting(key)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| default.to_string());
                (key.to_string(), value)
            })
            .collect::<HashMap<_, _>>()
    };
    let runtime = app.state::<ShortcutRuntime>();
    *runtime.visible.lock().unwrap() = values.clone();
    match ShortcutPlan::parse(&values) {
        Ok(plan) => {
            let mut registrar = PluginRegistrar(app);
            match replace_os_bindings(&ShortcutPlan::empty(), &plan, &mut registrar) {
                Ok(()) => {
                    *runtime.active.lock().unwrap() = plan.clone();
                    *runtime.visible.lock().unwrap() = plan.values();
                    log::info!("scorciatoie Focus registrate");
                }
                Err(error) => log::warn!(
                    "scorciatoie Focus non attivate; resta disponibile il set sicuro vuoto: {error}"
                ),
            }
        }
        Err(error) => log::warn!(
            "impostazioni scorciatoie non valide; resta disponibile il set sicuro vuoto: {error}"
        ),
    }
}

pub(crate) fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    if FIXED_DND
        .parse::<Shortcut>()
        .is_ok_and(|fixed| fixed.id() == shortcut.id())
    {
        commands::toggle_dnd(app);
        return;
    }
    let Some(runtime) = app.try_state::<ShortcutRuntime>() else {
        return;
    };
    let action = runtime
        .active
        .lock()
        .unwrap()
        .binding_by_id(shortcut.id())
        .map(|binding| binding.action);
    let Some(action) = action else { return };
    dispatch_shortcut(app, action);
}

fn resolve_contextual_action(
    action: ShortcutAction,
    allowed: &[FocusAction],
) -> Option<FocusAction> {
    let candidate = match action {
        ShortcutAction::StartLast => FocusAction::StartLast,
        ShortcutAction::PauseResume if allowed.contains(&FocusAction::Pause) => FocusAction::Pause,
        ShortcutAction::PauseResume => FocusAction::Resume,
        ShortcutAction::Extend5 => FocusAction::Extend5,
        ShortcutAction::Capture | ShortcutAction::FinishChooser => return None,
    };
    allowed.contains(&candidate).then_some(candidate)
}

fn dispatch_shortcut(app: &AppHandle, action: ShortcutAction) {
    if action == ShortcutAction::Capture {
        surfaces::open_capture(app);
        return;
    }
    let status = match commands::focus_shell_status(app) {
        Ok(status) => status,
        Err(error) => {
            log::warn!("stato Focus non disponibile per la scorciatoia: {error:?}");
            return;
        }
    };
    if action == ShortcutAction::FinishChooser {
        if status.active_is_focus() && status.allowed_actions().contains(&FocusAction::Finish) {
            let runtime = app.state::<ShortcutRuntime>();
            runtime.finish_intent.request();
            surfaces::open_panel(app);
            let _ = app.emit(EVT_FINISH_INTENT, ());
        }
        return;
    }
    let Some(focus_action) = resolve_contextual_action(action, status.allowed_actions()) else {
        log::info!("scorciatoia Focus ignorata: azione non disponibile nello stato corrente");
        return;
    };
    if let Err(error) = commands::dispatch_focus_action(app, focus_action) {
        log::warn!("scorciatoia Focus rifiutata: {error:?}");
    }
}

#[tauri::command]
pub(crate) fn focus_shortcut_settings(app: AppHandle) -> Result<HashMap<String, String>, String> {
    Ok(app
        .state::<ShortcutRuntime>()
        .visible
        .lock()
        .unwrap()
        .clone())
}

#[tauri::command]
pub(crate) async fn focus_shortcut_settings_apply(
    app: AppHandle,
    settings: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let next = ShortcutPlan::parse(&settings)?;
    let runtime = app.state::<ShortcutRuntime>();
    let _update = runtime.update.lock().unwrap();
    let previous = runtime.active.lock().unwrap().clone();
    let mut registrar = PluginRegistrar(&app);
    let mut persistence = StorePersistence(&app);
    let mut active_map = RuntimeActionMap(&runtime);
    activate_plan(
        &previous,
        &next,
        &mut registrar,
        &mut persistence,
        &mut active_map,
    )?;
    let values = next.values();
    *runtime.visible.lock().unwrap() = values.clone();
    Ok(values)
}

#[tauri::command]
pub(crate) fn focus_finish_intent_take(app: AppHandle) -> bool {
    app.state::<ShortcutRuntime>().finish_intent.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn defaults() -> HashMap<String, String> {
        shortcut_defaults()
            .into_iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn parsing_canonicalizes_shortcuts_and_blank_disables_a_binding() {
        let mut values = defaults();
        values.insert(
            "shortcut.focus.start_last".into(),
            " control + ALT + f ".into(),
        );
        values.insert("shortcut.focus.capture".into(), "   ".into());

        let plan = ShortcutPlan::parse(&values).unwrap();

        assert_eq!(
            plan.binding(ShortcutAction::StartLast).unwrap().canonical,
            "control+alt+KeyF"
        );
        assert!(plan.binding(ShortcutAction::Capture).is_none());
    }

    #[test]
    fn canonical_duplicate_is_rejected_before_registration() {
        let mut values = defaults();
        values.insert("shortcut.focus.start_last".into(), "Ctrl+Alt+F".into());
        values.insert(
            "shortcut.focus.pause_resume".into(),
            "alt+control+KeyF".into(),
        );

        let error = ShortcutPlan::parse(&values).unwrap_err();

        assert!(error.contains("duplicata"));
    }

    #[derive(Default)]
    struct FakeRegistrar {
        registered: Vec<String>,
        unregistered: Vec<String>,
        fail_on_register: Option<String>,
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&mut self, binding: &ShortcutBinding) -> Result<(), String> {
            if self.fail_on_register.as_deref() == Some(binding.canonical.as_str()) {
                return Err("combinazione occupata".into());
            }
            self.registered.push(binding.canonical.clone());
            Ok(())
        }

        fn unregister(&mut self, binding: &ShortcutBinding) -> Result<(), String> {
            self.unregistered.push(binding.canonical.clone());
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakePersistence {
        writes: Vec<HashMap<String, String>>,
        fail_first: bool,
    }

    impl ShortcutPersistence for FakePersistence {
        fn persist(&mut self, plan: &ShortcutPlan) -> Result<(), String> {
            self.writes.push(plan.values());
            if self.fail_first {
                self.fail_first = false;
                return Err("database non disponibile".into());
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeActiveMap(Vec<ShortcutPlan>);

    impl ShortcutActionMap for FakeActiveMap {
        fn replace(&mut self, plan: &ShortcutPlan) {
            self.0.push(plan.clone());
        }
    }

    #[test]
    fn add_conflict_rolls_back_additions_and_preserves_the_old_set() {
        let old = ShortcutPlan::parse(&defaults()).unwrap();
        let mut next_values = defaults();
        next_values.insert("shortcut.focus.start_last".into(), "Ctrl+Alt+S".into());
        next_values.insert("shortcut.focus.extend_5".into(), "Ctrl+Alt+E".into());
        let next = ShortcutPlan::parse(&next_values).unwrap();
        let mut registrar = FakeRegistrar {
            fail_on_register: Some(
                next.binding(ShortcutAction::Extend5)
                    .unwrap()
                    .canonical
                    .clone(),
            ),
            ..Default::default()
        };
        let mut persistence = FakePersistence::default();
        let mut active = FakeActiveMap::default();

        let result = activate_plan(&old, &next, &mut registrar, &mut persistence, &mut active);

        assert!(result.is_err());
        assert_eq!(registrar.registered.len(), 1);
        assert_eq!(registrar.unregistered, registrar.registered);
        assert!(persistence.writes.is_empty());
        assert!(active.0.is_empty());
    }

    #[test]
    fn reused_keys_only_swap_the_action_map() {
        let old = ShortcutPlan::parse(&defaults()).unwrap();
        let mut swapped_values = defaults();
        swapped_values.insert("shortcut.focus.start_last".into(), "Ctrl+Alt+P".into());
        swapped_values.insert("shortcut.focus.pause_resume".into(), "Ctrl+Alt+F".into());
        let swapped = ShortcutPlan::parse(&swapped_values).unwrap();
        let mut registrar = FakeRegistrar::default();
        let mut persistence = FakePersistence::default();
        let mut active = FakeActiveMap::default();

        activate_plan(
            &old,
            &swapped,
            &mut registrar,
            &mut persistence,
            &mut active,
        )
        .unwrap();

        assert!(registrar.registered.is_empty());
        assert!(registrar.unregistered.is_empty());
        assert_eq!(active.0, vec![swapped.clone()]);
        assert_eq!(persistence.writes, vec![swapped.values()]);
    }

    #[test]
    fn persistence_failure_restores_bindings_map_and_old_settings() {
        let old = ShortcutPlan::parse(&defaults()).unwrap();
        let mut next_values = defaults();
        next_values.insert("shortcut.focus.start_last".into(), "Ctrl+Alt+S".into());
        let next = ShortcutPlan::parse(&next_values).unwrap();
        let mut registrar = FakeRegistrar::default();
        let mut persistence = FakePersistence {
            fail_first: true,
            ..Default::default()
        };
        let mut active = FakeActiveMap::default();

        let result = activate_plan(&old, &next, &mut registrar, &mut persistence, &mut active);

        assert!(result.is_err());
        assert_eq!(active.0, vec![next, old.clone()]);
        assert_eq!(persistence.writes, vec![active.0[0].values(), old.values()]);
        assert_eq!(registrar.registered.len(), 2);
        assert_eq!(registrar.unregistered.len(), 2);
    }

    #[test]
    fn pause_resume_resolves_only_an_allowed_current_action() {
        assert_eq!(
            resolve_contextual_action(
                ShortcutAction::PauseResume,
                &[crate::commands::FocusAction::Pause]
            ),
            Some(crate::commands::FocusAction::Pause)
        );
        assert_eq!(
            resolve_contextual_action(
                ShortcutAction::PauseResume,
                &[crate::commands::FocusAction::Resume]
            ),
            Some(crate::commands::FocusAction::Resume)
        );
        assert_eq!(
            resolve_contextual_action(ShortcutAction::PauseResume, &[]),
            None
        );
    }

    #[test]
    fn finish_intent_is_consumed_once() {
        let intent = FinishIntent::default();
        intent.request();

        assert!(intent.take());
        assert!(!intent.take());
    }
}
