// Su Windows la shell è un'app da tray: niente console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    win_buddy_lib::run()
}
