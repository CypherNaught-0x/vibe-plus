//! Which update feed the app follows. See `docs/UPDATER.md`.
//!
//! vibe++ updates from the `latest.json` of the fork's latest GitHub release, signed with the
//! fork's own key. It publishes no beta builds, so both channels read the same file. The plugin's
//! own `check()` only knows the endpoint in `tauri.conf.json`, so the channel is applied here.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const LATEST_URL: &str = "https://github.com/CypherNaught-0x/vibe-plus/releases/latest/download/latest.json";

/// Config keys, shared with `desktop/src/lib/config-keys.ts`.
const CHANNEL_KEY: &str = "general.updateChannel";
const AUTO_KEY: &str = "general.autoUpdate";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
}

impl Channel {
    fn url(self) -> String {
        match self {
            Channel::Stable | Channel::Beta => LATEST_URL.to_string(),
        }
    }
}

/// The update settings, read fresh from the config file each time: it can be edited by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    pub channel: Channel,
    /// "Download updates automatically": fetch in the background so installing takes one click.
    /// On unless the user turned it off.
    pub automatic: bool,
}

impl Settings {
    pub fn read(app: &AppHandle) -> Self {
        let store = app.store(crate::config::STORE_FILENAME).ok();
        let get = |key: &str| store.as_ref().and_then(|store| store.get(key));
        Self {
            channel: get(CHANNEL_KEY)
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default(),
            automatic: get(AUTO_KEY).and_then(|value| value.as_bool()).unwrap_or(true),
        }
    }
}

/// Ask the channel whether a newer version exists.
pub async fn check(app: &AppHandle, channel: Channel) -> Result<Option<Update>, String> {
    let url = channel.url().parse().map_err(|error| format!("{error:?}"))?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_follow_the_forks_latest_release() {
        assert_eq!(Channel::Stable.url(), LATEST_URL);
        assert_eq!(Channel::Beta.url(), LATEST_URL);
        assert_eq!(serde_json::from_str::<Channel>("\"beta\"").unwrap(), Channel::Beta);
        assert!(serde_json::from_str::<Channel>("\"nightly\"").is_err());
    }
}
