//! Server configuration, read from the environment.

use anyhow::{Context, Result};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    /// Directory of built client assets to serve. Serving the client from the
    /// same origin as the websocket keeps us clear of CORS entirely.
    pub web_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let database_url =
            std::env::var("DATABASE_URL").context("DATABASE_URL is not set (see .env.example)")?;

        let bind_addr = std::env::var("BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()
            .context("BIND_ADDR is not a valid socket address")?;

        let web_dir = std::env::var("WEB_DIR")
            .unwrap_or_else(|_| "web/dist".to_string())
            .into();

        Ok(Self {
            database_url,
            bind_addr,
            web_dir,
        })
    }
}
