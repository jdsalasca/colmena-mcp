#![cfg_attr(all(target_os = "windows", not(test)), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = run() {
        colmena_widget::platform::windows::show_startup_error(&error.to_string());
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("colmena-widget solo se ejecuta en Windows.");
}

#[cfg(target_os = "windows")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use colmena_widget::app::{WIDGET_SIZE, WidgetApp};
    use colmena_widget::jobs::{read_snapshot, resolve_home};
    use colmena_widget::platform::windows::{acquire_instance, create_platform};
    use colmena_widget::position::Position;
    use std::time::{SystemTime, UNIX_EPOCH};

    let home_override = std::env::var_os("COLMENA_HOME");
    let user_profile = std::env::var_os("USERPROFILE");
    let home = resolve_home(home_override.as_deref(), user_profile.as_deref())?;
    std::fs::create_dir_all(&home)?;
    let executable = std::env::current_exe()?;
    let _instance = acquire_instance(&home, &executable)?;
    let platform = create_platform(WIDGET_SIZE.width, WIDGET_SIZE.height, Position::default())?;
    let mut app = WidgetApp::new(home, platform, read_snapshot, || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or_default()
    })?;
    app.run()?;
    Ok(())
}
