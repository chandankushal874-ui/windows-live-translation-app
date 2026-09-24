//! main.rs â€” Tauri entrypoint.
//!
//! Spawns the Tokio runtime in a dedicated thread (so the WebView main thread
//! is never blocked), wires Tauri commands to the call state machine, and
//! brings up the UI.

mod audio;
mod prefs;
mod protocol;
mod state;
mod ws;

use state::AppState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

fn main() {
    // Structured logging â€” RUST_LOG env overrides the default info level.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .with_thread_ids(true)
        .compact()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Build the shared state on the Tauri-managed tokio runtime.
            let handle = app.handle().clone();
            let state = AppState::new(handle);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::mint_session,
            commands::list_audio_devices,
            commands::start_call,
            commands::end_call,
            commands::call_status,
            commands::set_input_volume,
            commands::swap_input_device,
            commands::swap_output_device,
            commands::load_prefs,
            commands::save_prefs,
            commands::set_captions,
            commands::change_languages,
            commands::update_voice_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Tauri commands â€” the UI â†” Rust bridge. All async, all return Result<_, String>.
// ---------------------------------------------------------------------------

pub mod commands {
    use super::state::{AppState, CallArgs, CallState, SessionCredentials};
    use serde::Serialize;
    use tauri::State;

    /// Mint a session token via the relay server.
    /// Returns the WsUrl and token the app will use when starting a call.
    #[tauri::command]
    pub async fn mint_session(
        relay_url: String,
        user_id: String,
        source_lang: String,
        target_lang: String,
    ) -> Result<SessionCredentials, String> {
        crate::ws::mint_session_via_relay(&relay_url, &user_id, &source_lang, &target_lang)
            .await
            .map_err(|e| e.to_string())
    }

    /// Start a call: join a room, open the Ollalink upstream, start audio.
    #[tauri::command]
    pub async fn start_call(
        state: State<'_, AppState>,
        args: CallArgs,
    ) -> Result<serde_json::Value, String> {
        state.start_call(args).await.map_err(|e| e.to_string())
    }

    /// End the current call.
    #[tauri::command]
    pub async fn end_call(state: State<'_, AppState>) -> Result<(), String> {
        state.end_call().await.map_err(|e| e.to_string())
    }

    /// Snapshot of current call state for the UI.
    #[tauri::command]
    pub async fn call_status(state: State<'_, AppState>) -> Result<CallState, String> {
        Ok(state.status().await)
    }

    /// Enumerate input/output audio devices for the picklist.
    #[tauri::command]
    pub async fn list_audio_devices() -> Result<AudioDeviceList, String> {
        crate::audio::list_devices().map_err(|e| e.to_string())
    }

    /// Live input gain (0.0â€“2.0).
    #[tauri::command]
    pub async fn set_input_volume(state: State<'_, AppState>, volume: f32) -> Result<(), String> {
        state.set_input_volume(volume);
        Ok(())
    }

    /// Hot-swap microphone mid-call. Pass null to use default.
    #[tauri::command]
    pub async fn swap_input_device(
        state: State<'_, AppState>,
        name: Option<String>,
    ) -> Result<(), String> {
        state.swap_input_device(name).await.map_err(|e| e.to_string())
    }

    /// Hot-swap speaker mid-call. Pass null to use default.
    #[tauri::command]
    pub async fn swap_output_device(
        state: State<'_, AppState>,
        name: Option<String>,
    ) -> Result<(), String> {
        state.swap_output_device(name).await.map_err(|e| e.to_string())
    }

    /// Load persisted user prefs (display name, langs, devices, relay URL).
    #[tauri::command]
    pub async fn load_prefs() -> Result<crate::prefs::UserPrefs, String> {
        Ok(crate::prefs::load())
    }

    /// Save user prefs to disk.
    #[tauri::command]
    pub async fn save_prefs(prefs: crate::prefs::UserPrefs) -> Result<(), String> {
        crate::prefs::save(&prefs).map_err(|e| e.to_string())
    }

    /// Toggle live captions (mid-call).
    #[tauri::command]
    pub async fn set_captions(state: State<'_, AppState>, on: bool) -> Result<(), String> {
        state.set_captions(on).await.map_err(|e| e.to_string())
    }

    /// Change languages mid-call.
    #[tauri::command]
    pub async fn change_languages(
        state: State<'_, AppState>,
        source_lang: Option<String>,
        target_lang: Option<String>,
    ) -> Result<(), String> {
        state.change_languages(source_lang, target_lang).await.map_err(|e| e.to_string())
    }

    /// Update voice persona and tone mid-call.
    #[tauri::command]
    pub async fn update_voice_settings(
        state: State<'_, AppState>,
        voice: Option<String>,
        tone: Option<String>,
    ) -> Result<(), String> {
        state.update_voice_settings(voice, tone).await.map_err(|e| e.to_string())
    }

    #[derive(Debug, Serialize)]
    pub struct AudioDeviceList {
        pub inputs: Vec<String>,
        pub outputs: Vec<String>,
        pub default_input: Option<String>,
        pub default_output: Option<String>,
    }

    // Re-export so the commands module exposes SessionCredentials to TS via specta/serde.
    pub use crate::state::SessionCredentials as _SC;
}
