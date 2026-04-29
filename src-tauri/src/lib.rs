use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::{form_urlencoded, Url};
use yandex_music::{
    api::{
        search::get_search::SearchOptions,
        track::get_download_info::GetDownloadInfoOptions,
    },
    model::search::SearchType,
    YandexMusicClient,
};

const YANDEX_OAUTH_CLIENT_ID: &str = "23cabbbdc6cd418abb4b39c32c41195d";
const TOKEN_FILE_NAME: &str = "yandex_music_token.txt";
const OAUTH_WINDOW_LABEL: &str = "yandex-oauth";

struct AuthState {
    token: Mutex<Option<String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackItem {
    id: String,
    title: String,
    artist: String,
    duration: String,
    cover_url: Option<String>,
}

fn format_duration(duration: Option<Duration>) -> String {
    let duration = match duration {
        Some(value) if value.as_secs() > 0 => value,
        _ => return "--:--".to_string(),
    };

    let total_seconds = duration.as_secs();
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{}:{:02}", minutes, seconds)
}

fn normalize_cover_url(raw: Option<String>) -> Option<String> {
    let value = raw?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let with_size = trimmed.replace("%%", "100x100");
    if with_size.starts_with("http://") || with_size.starts_with("https://") {
        Some(with_size)
    } else {
        Some(format!("https://{with_size}"))
    }
}

fn token_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Failed to resolve app config directory: {err}"))?;
    Ok(config_dir.join(TOKEN_FILE_NAME))
}

fn load_saved_token(app: &AppHandle) -> Result<Option<String>, String> {
    let path = token_file_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read token from {}: {err}", path.display()))?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    Ok(Some(trimmed))
}

fn save_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = token_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create token directory {}: {err}",
                parent.display()
            )
        })?;
    }

    fs::write(&path, token)
        .map_err(|err| format!("Failed to write token to {}: {err}", path.display()))
}

fn create_client(state: &State<AuthState>) -> Result<YandexMusicClient, String> {
    let token = state
        .token
        .lock()
        .map_err(|_| "Auth state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Login via Yandex first".to_string())?;

    YandexMusicClient::builder(token)
        .build()
        .map_err(|err| err.to_string())
}

fn apply_token(app: &AppHandle, token: String) -> Result<(), String> {
    save_token(app, &token)?;

    let state = app.state::<AuthState>();
    let mut guard = state
        .token
        .lock()
        .map_err(|_| "Auth state is unavailable".to_string())?;
    *guard = Some(token);
    Ok(())
}

fn extract_access_token(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Token input is empty".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|err| format!("Invalid URL: {err}"))?;

    if let Some(fragment) = parsed.fragment() {
        for (key, value) in form_urlencoded::parse(fragment.as_bytes()) {
            if key == "access_token" {
                let token = value.trim().to_string();
                if token.is_empty() {
                    return Err("access_token in URL is empty".to_string());
                }
                return Ok(token);
            }
        }
    }

    for (key, value) in parsed.query_pairs() {
        if key == "access_token" {
            let token = value.trim().to_string();
            if token.is_empty() {
                return Err("access_token in URL is empty".to_string());
            }
            return Ok(token);
        }
    }

    Err("Could not find access_token in URL".to_string())
}

#[tauri::command]
fn get_auth_status(state: State<AuthState>) -> Result<bool, String> {
    let has_token = state
        .token
        .lock()
        .map_err(|_| "Auth state is unavailable".to_string())?
        .as_ref()
        .is_some();
    Ok(has_token)
}

#[tauri::command]
fn get_yandex_oauth_url() -> String {
    format!(
        "https://oauth.yandex.ru/authorize?response_type=token&client_id={}",
        YANDEX_OAUTH_CLIENT_ID
    )
}

#[tauri::command]
fn start_yandex_oauth(app: AppHandle) -> Result<(), String> {
    let auth_url = get_yandex_oauth_url();
    let parsed_url = Url::parse(&auth_url).map_err(|err| format!("Invalid OAuth URL: {err}"))?;

    if let Some(existing) = app.get_webview_window(OAUTH_WINDOW_LABEL) {
        let _ = existing.close();
    }

    let app_for_nav = app.clone();
    WebviewWindowBuilder::new(
        &app,
        OAUTH_WINDOW_LABEL,
        WebviewUrl::External(parsed_url),
    )
    .title("Yandex Login")
    .inner_size(480.0, 760.0)
    .resizable(true)
    .on_navigation(move |url| {
        if !url.as_str().contains("access_token=") {
            return true;
        }

        match extract_access_token(url.as_str()) {
            Ok(token) => {
                if let Err(err) = apply_token(&app_for_nav, token) {
                    let _ = app_for_nav.emit("auth://error", err);
                } else {
                    let _ = app_for_nav.emit("auth://success", true);
                }

                if let Some(window) = app_for_nav.get_webview_window(OAUTH_WINDOW_LABEL) {
                    let _ = window.close();
                }
                false
            }
            Err(_) => true,
        }
    })
    .build()
    .map_err(|err| format!("Failed to open OAuth window: {err}"))?;

    Ok(())
}

#[tauri::command]
fn save_token_input(
    input: String,
    state: State<AuthState>,
    app: AppHandle,
) -> Result<(), String> {
    let token = extract_access_token(&input)?;
    drop(state);
    apply_token(&app, token)?;
    Ok(())
}

#[tauri::command]
async fn search_tracks(query: String, state: State<'_, AuthState>) -> Result<Vec<TrackItem>, String> {
    let client = create_client(&state)?;
    let options = SearchOptions::new(query).item_type(SearchType::Tracks);
    let tracks = client
        .search(&options)
        .await
        .map_err(|err| err.to_string())?;

    let items = tracks
        .tracks
        .map(|result| result.results)
        .unwrap_or_default()
        .into_iter()
        .map(|track| {
            let id = track.id;
            let title = track.title.unwrap_or_else(|| "Untitled".to_string());
            let artist = track
                .artists
                .first()
                .and_then(|artist| artist.name.clone())
                .unwrap_or_else(|| "Unknown".to_string());
            let duration = format_duration(track.duration);
            let cover_url =
                normalize_cover_url(track.cover_uri.or_else(|| {
                    track.albums.first().and_then(|album| album.cover_uri.clone())
                }));
            TrackItem {
                id,
                title,
                artist,
                duration,
                cover_url,
            }
        })
        .collect();

    Ok(items)
}

#[tauri::command]
async fn get_stream_url(track_id: String, state: State<'_, AuthState>) -> Result<String, String> {
    let client = create_client(&state)?;
    let options = GetDownloadInfoOptions::new(track_id);
    let mut variants = client
        .get_download_info(&options)
        .await
        .map_err(|err| err.to_string())?;

    if variants.is_empty() {
        return Err("No playable stream for this track".to_string());
    }

    variants.sort_by_key(|item| {
        (
            (!item.preview) as u8,
            (item.codec == "mp3") as u8,
            item.bitrate_in_kbps,
        )
    });

    let selected = variants
        .last()
        .ok_or_else(|| "No playable stream for this track".to_string())?;

    selected
        .get_direct_link(&client.inner)
        .await
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let token = load_saved_token(app.handle()).map_err(std::io::Error::other)?;
            app.manage(AuthState {
                token: Mutex::new(token),
            });
            Ok(())
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_auth_status,
            get_yandex_oauth_url,
            start_yandex_oauth,
            save_token_input,
            search_tracks,
            get_stream_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
