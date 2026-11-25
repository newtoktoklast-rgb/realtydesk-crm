// RealtyDesk desktop shell.
//
// This process's only security-relevant job is to back the three
// `keyring_*` commands below with the real Windows Credential Manager
// (via the `keyring` crate), so that Telegram session strings and JWTs
// never touch a plain file or get sent to the server. See
// docs/BUILD_SPEC.md §2 and client/src/lib/secureStorage.ts, which is the
// only frontend module allowed to call these commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;

#[tauri::command]
fn keyring_set(service: String, account: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_get(service: String, account: String) -> Result<String, String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_delete(service: String, account: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.delete_password().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // In-app updater + process (relaunch) plugins. Desktop only.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![keyring_set, keyring_get, keyring_delete])
        .run(tauri::generate_context!())
        .expect("error while running RealtyDesk");
}
