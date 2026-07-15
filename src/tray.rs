//! Windows system tray integration for WildToken.
//!
//! Runs the tao event loop on the main thread (required for tray messages) and
//! hosts the HTTP server on a background tokio runtime.

use std::sync::mpsc;
use std::time::Duration;

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::app;

#[derive(Debug, Clone)]
enum UserEvent {
    OpenAdmin,
    Quit,
}

/// Start tray UI + background HTTP server. Blocks until the user quits.
pub fn run() {
    crate::init_tracing(true);

    let (ready_tx, ready_rx) = mpsc::channel::<(u16, String)>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let server_thread = std::thread::Builder::new()
        .name("wildtoken-server".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!("failed to create tokio runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                if let Err(e) = app::run_server(Some(ready_tx), async move {
                    let _ = shutdown_rx.await;
                })
                .await
                {
                    tracing::error!("WildToken server failed: {e}");
                }
            });
        })
        .expect("spawn server thread");

    let (port, admin_url) = match ready_rx.recv_timeout(Duration::from_secs(60)) {
        Ok(info) => info,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            tracing::error!("server did not become ready within 60s");
            std::process::exit(1);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            tracing::error!("server thread exited before becoming ready");
            std::process::exit(1);
        }
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let proxy_menu = proxy.clone();
    let proxy_tray = proxy.clone();

    let open_item = MenuItem::new("打开管理后台", true, None);
    let quit_item = MenuItem::new("退出", true, None);
    let open_id = open_item.id().clone();
    let quit_id = quit_item.id().clone();

    let menu = Menu::new();
    if let Err(e) = menu.append(&open_item) {
        tracing::error!("failed to build tray menu: {e}");
        std::process::exit(1);
    }
    if let Err(e) = menu.append(&quit_item) {
        tracing::error!("failed to build tray menu: {e}");
        std::process::exit(1);
    }

    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if event.id == open_id {
            let _ = proxy_menu.send_event(UserEvent::OpenAdmin);
        } else if event.id == quit_id {
            let _ = proxy_menu.send_event(UserEvent::Quit);
        }
    }));

    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
        | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } = event
        {
            let _ = proxy_tray.send_event(UserEvent::OpenAdmin);
        }
    }));

    let tooltip = format!("WildToken :{port}");
    let tray_icon = match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip(&tooltip)
        .with_icon(make_icon())
        .with_title("WildToken")
        .build()
    {
        Ok(icon) => icon,
        Err(e) => {
            tracing::error!("failed to create tray icon: {e}");
            // Keep serving without tray if icon creation fails.
            let _ = server_thread.join();
            return;
        }
    };

    // Keep the tray icon alive for the lifetime of the event loop.
    let mut tray_icon = Some(tray_icon);
    let mut shutdown_tx = Some(shutdown_tx);
    let mut server_thread = Some(server_thread);
    let admin_url_for_loop = admin_url.clone();

    event_loop.run(move |event, _event_loop, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                tracing::info!(
                    port,
                    admin_url = %admin_url_for_loop,
                    "WildToken tray ready"
                );
            }
            Event::UserEvent(UserEvent::OpenAdmin) => {
                open_admin(&admin_url_for_loop);
            }
            Event::UserEvent(UserEvent::Quit) => {
                tracing::info!("quit requested from tray");
                if let Some(tx) = shutdown_tx.take() {
                    let _ = tx.send(());
                }
                tray_icon.take();
                *control_flow = ControlFlow::Exit;
            }
            Event::LoopDestroyed => {
                if let Some(tx) = shutdown_tx.take() {
                    let _ = tx.send(());
                }
                if let Some(handle) = server_thread.take() {
                    let _ = handle.join();
                }
            }
            _ => {}
        }
    });
}

fn open_admin(admin_url: &str) {
    if let Err(e) = open::that(admin_url) {
        tracing::error!(%admin_url, error = %e, "failed to open admin URL in browser");
    }
}

/// Generate a simple 32×32 RGBA tray icon (blue tile with a light “W”).
fn make_icon() -> tray_icon::Icon {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let i = ((y * SIZE + x) * 4) as usize;
            // Soft blue background
            rgba[i] = 0x25;
            rgba[i + 1] = 0x63;
            rgba[i + 2] = 0xeb;
            rgba[i + 3] = 0xff;
        }
    }

    // Draw a rough white “W” with thick strokes
    let paint = |rgba: &mut [u8], x: i32, y: i32| {
        if x < 0 || y < 0 || x >= SIZE as i32 || y >= SIZE as i32 {
            return;
        }
        let i = ((y as u32 * SIZE + x as u32) * 4) as usize;
        rgba[i] = 0xff;
        rgba[i + 1] = 0xff;
        rgba[i + 2] = 0xff;
        rgba[i + 3] = 0xff;
    };
    let stroke = |rgba: &mut [u8], x0: i32, y0: i32, x1: i32, y1: i32| {
        let steps = ((x1 - x0).abs().max((y1 - y0).abs())).max(1);
        for s in 0..=steps {
            let t = s as f32 / steps as f32;
            let x = x0 as f32 + (x1 - x0) as f32 * t;
            let y = y0 as f32 + (y1 - y0) as f32 * t;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    paint(rgba, (x as i32) + dx, (y as i32) + dy);
                }
            }
        }
    };

    // W: left down, up mid, down mid, up right
    stroke(&mut rgba, 7, 8, 10, 24);
    stroke(&mut rgba, 10, 24, 16, 14);
    stroke(&mut rgba, 16, 14, 22, 24);
    stroke(&mut rgba, 22, 24, 25, 8);

    tray_icon::Icon::from_rgba(rgba, SIZE, SIZE).expect("valid tray icon rgba")
}
