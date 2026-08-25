//! Riconoscimento della scadenza nella cattura rapida (§ 11).
//!
//! Non è un parser di linguaggio naturale: una manciata di pattern espliciti,
//! tutto il resto va al selettore di data. Le librerie di NLP hanno un supporto
//! italiano inaffidabile; poche espressioni regolari sui pattern che si usano
//! davvero funzionano meglio e non si rompono.
//!
//! Il modulo lavora su `NaiveDateTime` (orologio a muro locale): niente fusi,
//! niente `Local::now()` — l'adesso lo inietta il chiamante, così i test sono
//! deterministici. La conversione a epoch ms UTC avviene nella shell.

use chrono::{Datelike, Duration, NaiveDateTime, NaiveTime, Timelike, Weekday};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Ora predefinita per «domani», «dopodomani» e i giorni della settimana.
const MORNING: (u32, u32) = (9, 0);
/// Ora predefinita per «stasera».
const EVENING: (u32, u32) = (20, 0);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Parsed {
    /// Il testo della nota, ripulito dal pattern riconosciuto.
    pub body: String,
    /// Scadenza risolta, in orologio locale. `None` = appunto senza promemoria.
    pub due_local: Option<NaiveDateTime>,
    /// Il frammento riconosciuto, per mostrarlo nella chip di anteprima.
    pub matched: Option<String>,
    /// `!` in testa al testo marca la nota urgente (può interrompere un focus).
    pub urgent: bool,
}

struct Patterns {
    relative: Regex,
    weekday_time: Regex,
    weekday_full: Regex,
    keyword: Regex,
    bare_time: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        // +2h · +30m · +3g (m=minuti, h=ore, g/d=giorni)
        relative: Regex::new(r"(?i)(^|\s)\+(\d{1,3})\s*(m|h|g|d)(?:\b)").unwrap(),
        // lun 9:30 · dom 15 · giovedì 14.15 · «alle» opzionale
        weekday_time: Regex::new(
            r"(?i)(^|\s)(lun(?:ed[iì])?|mar(?:ted[iì])?|mer(?:coled[iì])?|gio(?:ved[iì])?|ven(?:erd[iì])?|sab(?:ato)?|dom(?:enica)?)\s+(?:alle\s+)?(\d{1,2})(?:[:.](\d{2}))?([\s.,;]|$)",
        )
        .unwrap(),
        // solo il nome per esteso vale da solo: «lun» nudo è troppo ambiguo
        weekday_full: Regex::new(
            r"(?i)(^|\s)(luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica)([\s.,;]|$)",
        )
        .unwrap(),
        // stasera · domani (mattina) · dopodomani, con ora opzionale
        keyword: Regex::new(
            r"(?i)(^|\s)(stasera|domattina|domani\s+mattina|dopodomani|domani)(?:\s+(?:alle\s+)?(\d{1,2})(?:[:.](\d{2}))?(?:\b))?([\s.,;]|$)",
        )
        .unwrap(),
        // 18:00 · 9.30 — serve il separatore, un numero nudo non è un'ora
        bare_time: Regex::new(r"(?i)(^|\s)(?:alle\s+)?(\d{1,2})[:.](\d{2})([\s.,;]|$)").unwrap(),
    })
}

/// Analizza il testo della cattura rapida. `now_local` è l'orologio a muro.
pub fn parse_capture(raw: &str, now_local: NaiveDateTime) -> Parsed {
    let mut text = raw.trim().to_string();
    let urgent = text.starts_with('!');
    if urgent {
        text = text[1..].trim_start().to_string();
    }

    let p = patterns();

    // Ordine di precedenza: relativo, giorno+ora, parola chiave,
    // giorno per esteso, ora nuda. Il primo tipo che matcha vince;
    // dentro al tipo vince l'ultima occorrenza (la scadenza si scrive in coda).
    if let Some(c) = collect_last(&p.relative, &text) {
        let n: i64 = c[2].parse().unwrap_or(0);
        if n > 0 {
            let unit = c[3].to_lowercase();
            let delta = match unit.as_str() {
                "m" => Duration::minutes(n),
                "h" => Duration::hours(n),
                _ => Duration::days(n), // g | d
            };
            return finish(&text, &c.get(0).unwrap(), Some(now_local + delta), urgent);
        }
    }

    if let Some(c) = collect_last(&p.weekday_time, &text) {
        let (h, min) = (num(&c, 3), num_opt(&c, 4).unwrap_or(0));
        if let (Some(wd), Some(t)) = (weekday_of(&c[2]), time_of(h, min)) {
            let due = next_weekday(now_local, wd, t);
            return finish(&text, &c.get(0).unwrap(), Some(due), urgent);
        }
    }

    if let Some(c) = collect_last(&p.keyword, &text) {
        let kw = c[2].to_lowercase();
        let explicit = num_opt(&c, 3).and_then(|h| time_of(h, num_opt(&c, 4).unwrap_or(0)));
        // «domani 99» non è un'ora: in quel caso si lascia perdere il match
        let valid = num_opt(&c, 3).is_none() || explicit.is_some();
        let due = if !valid {
            None
        } else {
            match kw.as_str() {
                "stasera" => {
                    let t = explicit
                        .unwrap_or(NaiveTime::from_hms_opt(EVENING.0, EVENING.1, 0).unwrap());
                    let tonight = now_local.date().and_time(t);
                    Some(if tonight > now_local {
                        tonight
                    } else {
                        // è già sera inoltrata: tra un'ora, comunque stasera
                        now_local + Duration::hours(1)
                    })
                }
                "domattina" | "domani mattina" => {
                    Some((now_local + Duration::days(1)).date().and_time(default_morning()))
                }
                "domani" => Some(
                    (now_local + Duration::days(1))
                        .date()
                        .and_time(explicit.unwrap_or(default_morning())),
                ),
                "dopodomani" => Some(
                    (now_local + Duration::days(2))
                        .date()
                        .and_time(explicit.unwrap_or(default_morning())),
                ),
                _ => None,
            }
        };
        if let Some(due) = due {
            return finish(&text, &c.get(0).unwrap(), Some(due), urgent);
        }
    }

    if let Some(c) = collect_last(&p.weekday_full, &text) {
        if let Some(wd) = weekday_of(&c[2]) {
            let due = next_weekday(now_local, wd, default_morning());
            return finish(&text, &c.get(0).unwrap(), Some(due), urgent);
        }
    }

    if let Some(c) = collect_last(&p.bare_time, &text) {
        if let Some(t) = time_of(num(&c, 2), num(&c, 3)) {
            // oggi se futura, domani se passata (§ 11)
            let today = now_local.date().and_time(t);
            let due = if today > now_local { today } else { today + Duration::days(1) };
            return finish(&text, &c.get(0).unwrap(), Some(due), urgent);
        }
    }

    Parsed { body: collapse(&text), due_local: None, matched: None, urgent }
}

/// Etichetta leggibile della scadenza, per la chip di anteprima e il pannello:
/// «oggi 17:47», «domani 09:00», «gio 28/08 09:00».
pub fn format_due_label(due: NaiveDateTime, now: NaiveDateTime) -> String {
    let days = (due.date() - now.date()).num_days();
    let hm = format!("{:02}:{:02}", due.hour(), due.minute());
    match days {
        0 => format!("oggi {hm}"),
        1 => format!("domani {hm}"),
        _ => {
            let wd = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"]
                [due.weekday().num_days_from_monday() as usize];
            format!("{wd} {:02}/{:02} {hm}", due.day(), due.month())
        }
    }
}

// ------------------------------------------------------------------ helpers

fn finish(text: &str, m: &regex::Match, due: Option<NaiveDateTime>, urgent: bool) -> Parsed {
    let matched = m.as_str().trim().trim_end_matches(['.', ',', ';']).to_string();
    let mut body = String::with_capacity(text.len());
    body.push_str(&text[..m.start()]);
    body.push(' ');
    body.push_str(&text[m.end()..]);
    Parsed { body: collapse(&body), due_local: due, matched: Some(matched), urgent }
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Ultima occorrenza del pattern, con ricerca sovrapposta: il confine di
/// spazio consumato in coda a un match può fare da confine di testa al
/// successivo («delle 10:00 alle 16:00» deve vincere 16:00, "alle" compreso).
fn collect_last<'t>(re: &Regex, text: &'t str) -> Option<regex::Captures<'t>> {
    let mut last: Option<regex::Captures> = None;
    let mut last_end = 0;
    let mut pos = 0;
    while let Some(c) = re.captures_at(text, pos) {
        let m = c.get(0).unwrap();
        let (start, end) = (m.start(), m.end());
        let next = start
            + text[start..]
                .chars()
                .next()
                .map_or(1, |ch| ch.len_utf8());
        // Un match successivo può condividere al più il carattere di confine
        // (lo spazio) con il precedente: «alle 16:00» non deve essere
        // scavalcato dal suo stesso pezzo «16:00».
        if last.is_none() || start + 1 >= last_end {
            last = Some(c);
            last_end = end;
        }
        if next <= pos {
            break;
        }
        pos = next;
    }
    last
}

fn num(c: &regex::Captures, i: usize) -> u32 {
    c.get(i).and_then(|m| m.as_str().parse().ok()).unwrap_or(0)
}

fn num_opt(c: &regex::Captures, i: usize) -> Option<u32> {
    c.get(i).and_then(|m| m.as_str().parse().ok())
}

fn time_of(h: u32, m: u32) -> Option<NaiveTime> {
    NaiveTime::from_hms_opt(h, m, 0)
}

fn default_morning() -> NaiveTime {
    NaiveTime::from_hms_opt(MORNING.0, MORNING.1, 0).unwrap()
}

fn weekday_of(s: &str) -> Option<Weekday> {
    let s = s.to_lowercase();
    let key = &s[..3.min(s.len())];
    match key {
        "lun" => Some(Weekday::Mon),
        "mar" => Some(Weekday::Tue),
        "mer" => Some(Weekday::Wed),
        "gio" => Some(Weekday::Thu),
        "ven" => Some(Weekday::Fri),
        "sab" => Some(Weekday::Sat),
        "dom" => Some(Weekday::Sun),
        _ => None,
    }
}

/// Prossima occorrenza del giorno della settimana: oggi stesso se l'ora è
/// ancora futura, altrimenti fra sette giorni.
fn next_weekday(now: NaiveDateTime, wd: Weekday, t: NaiveTime) -> NaiveDateTime {
    let today = now.weekday().num_days_from_monday() as i64;
    let target = wd.num_days_from_monday() as i64;
    let mut ahead = (target - today).rem_euclid(7);
    if ahead == 0 && now.date().and_time(t) <= now {
        ahead = 7;
    }
    (now + Duration::days(ahead)).date().and_time(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// martedì 25/08/2026, 15:47
    fn now() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 8, 25).unwrap().and_hms_opt(15, 47, 0).unwrap()
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap()
    }

    #[test]
    fn relative_offsets() {
        let p = parse_capture("chiamare il commercialista +2h", now());
        assert_eq!(p.body, "chiamare il commercialista");
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 17, 47)));
        assert_eq!(p.matched.as_deref(), Some("+2h"));

        let p = parse_capture("+30m controllare il forno", now());
        assert_eq!(p.body, "controllare il forno");
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 16, 17)));

        let p = parse_capture("rinnovo dominio +3g", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 28, 15, 47)));
    }

    #[test]
    fn bare_time_today_or_tomorrow() {
        // futura → oggi
        let p = parse_capture("standup 18:00", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 18, 0)));
        assert_eq!(p.body, "standup");
        // passata → domani
        let p = parse_capture("standup 9:00", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 26, 9, 0)));
        // col punto e con «alle»
        let p = parse_capture("richiamare alle 18.30", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 18, 30)));
        assert_eq!(p.body, "richiamare");
    }

    #[test]
    fn weekday_with_time() {
        // oggi è martedì: lun 9:30 → lunedì prossimo
        let p = parse_capture("riunione lun 9:30", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 31, 9, 30)));
        assert_eq!(p.body, "riunione");
        // dom 15 → domenica alle 15:00
        let p = parse_capture("pranzo dom 15", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 30, 15, 0)));
        // stesso giorno, ora futura → oggi
        let p = parse_capture("recap mar 18", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 18, 0)));
        // stesso giorno, ora passata → +7
        let p = parse_capture("recap mar 9", now());
        assert_eq!(p.due_local, Some(at(2026, 9, 1, 9, 0)));
        // nome per esteso con ora
        let p = parse_capture("demo giovedì 14.15", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 27, 14, 15)));
    }

    #[test]
    fn keywords() {
        let p = parse_capture("buttare la pasta stasera", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 20, 0)));
        assert_eq!(p.body, "buttare la pasta");

        let p = parse_capture("scrivere a Fabio domani", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 26, 9, 0)));

        let p = parse_capture("domani 15:30 sentire il fornitore", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 26, 15, 30)));
        assert_eq!(p.body, "sentire il fornitore");

        let p = parse_capture("bollo auto dopodomani", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 27, 9, 0)));

        let p = parse_capture("preparare slide domani mattina", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 26, 9, 0)));
        assert_eq!(p.body, "preparare slide");
    }

    #[test]
    fn keyword_stasera_late_at_night() {
        let late = at(2026, 8, 25, 22, 30);
        let p = parse_capture("spegnere il server stasera", late);
        // le 20 sono passate: tra un'ora, comunque stasera
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 23, 30)));
    }

    #[test]
    fn full_weekday_alone() {
        // «lunedì» per esteso vale da solo → lunedì prossimo alle 9
        let p = parse_capture("preparare fattura lunedì", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 31, 9, 0)));
        // l'abbreviazione nuda invece NON è un pattern: «mar» è anche il mare
        let p = parse_capture("guardare il mar", now());
        assert_eq!(p.due_local, None);
        assert_eq!(p.body, "guardare il mar");
    }

    #[test]
    fn urgent_flag() {
        let p = parse_capture("! chiamare il cliente +10m", now());
        assert!(p.urgent);
        assert_eq!(p.body, "chiamare il cliente");
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 15, 57)));

        let p = parse_capture("nota tranquilla", now());
        assert!(!p.urgent);
    }

    #[test]
    fn no_pattern_is_a_plain_note() {
        let p = parse_capture("idea: buddy anche su linux", now());
        assert_eq!(p.due_local, None);
        assert_eq!(p.matched, None);
        assert_eq!(p.body, "idea: buddy anche su linux");
    }

    #[test]
    fn invalid_times_do_not_match() {
        let p = parse_capture("codice errore 99:99 in produzione", now());
        assert_eq!(p.due_local, None);
        // «domani 99» non è un'ora → il pattern non consuma nulla
        let p = parse_capture("lotto domani 99", now());
        assert_eq!(p.due_local, None);
        assert_eq!(p.body, "lotto domani 99");
    }

    #[test]
    fn numbers_in_text_are_not_times() {
        let p = parse_capture("ordinare 3 licenze", now());
        assert_eq!(p.due_local, None);
        let p = parse_capture("rivedere il budget 2027", now());
        assert_eq!(p.due_local, None);
    }

    #[test]
    fn last_occurrence_wins() {
        let p = parse_capture("spostare il meeting delle 10:00 alle 16:00", now());
        assert_eq!(p.due_local, Some(at(2026, 8, 25, 16, 0)));
        assert_eq!(p.body, "spostare il meeting delle 10:00");
    }

    #[test]
    fn due_labels() {
        assert_eq!(format_due_label(at(2026, 8, 25, 17, 47), now()), "oggi 17:47");
        assert_eq!(format_due_label(at(2026, 8, 26, 9, 0), now()), "domani 09:00");
        assert_eq!(format_due_label(at(2026, 8, 27, 9, 0), now()), "gio 27/08 09:00");
    }
}
