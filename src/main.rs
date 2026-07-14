//! WildToken entrypoint.
//!
//! - Linux / macOS: foreground console HTTP server
//! - Windows: system tray by default (no console window); set `WILDTOKEN_NO_TRAY=1`
//!   or pass `--no-tray` / `--console` for headless/CI server mode

#![cfg_attr(windows, windows_subsystem = "windows")]

mod app;
mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod proxy;
mod state;

#[cfg(windows)]
mod tray;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Initialize tracing: stdout on Unix, or file `wildtoken.log` when `log_to_file` is true
/// (Windows tray / subsystem without a console).
pub(crate) fn init_tracing(log_to_file: bool) {
    let filter = tracing_subscriber::EnvFilter::new(
        std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
    );

    if log_to_file {
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("wildtoken.log")
        {
            Ok(file) => {
                tracing_subscriber::registry()
                    .with(filter)
                    .with(
                        tracing_subscriber::fmt::layer()
                            .with_ansi(false)
                            .with_writer(std::sync::Mutex::new(file)),
                    )
                    .init();
            }
            Err(e) => {
                // Fall back to stdout (may be discarded under windows_subsystem).
                eprintln!("failed to open wildtoken.log: {e}; falling back to stdout");
                tracing_subscriber::registry()
                    .with(filter)
                    .with(tracing_subscriber::fmt::layer())
                    .init();
            }
        }
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
    }
}

/// True when Windows should skip the tray and run a plain HTTP server (CI / Docker / debug).
#[cfg(windows)]
fn force_server_mode() -> bool {
    if std::env::args().any(|a| a == "--no-tray" || a == "--console") {
        return true;
    }
    env_flag_true("WILDTOKEN_NO_TRAY") || env_flag_true("WILDTOKEN_CONSOLE")
}

#[cfg(windows)]
fn env_flag_true(name: &str) -> bool {
    match std::env::var(name) {
        Ok(v) => {
            let v = v.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

fn run_blocking_server(log_to_file: bool) {
    init_tracing(log_to_file);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");
    let result = rt.block_on(async {
        app::run_server(None, async {
            shutdown_signal().await;
            tracing::info!("shutdown signal received");
        })
        .await
    });
    if let Err(e) = result {
        tracing::error!("WildToken exited with error: {e}");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("failed to install Ctrl+C handler: {e}");
            // Park forever if signal setup fails so serve keeps running.
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(e) => {
                tracing::warn!("failed to install SIGTERM handler: {e}");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(windows)]
fn main() {
    if force_server_mode() {
        // No console under windows_subsystem; always log to file.
        run_blocking_server(true);
    } else {
        tray::run();
    }
}

#[cfg(not(windows))]
fn main() {
    run_blocking_server(false);
}
