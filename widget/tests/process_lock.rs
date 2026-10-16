use colmena_widget::platform::{ProcessRecord, ProcessRegistry, mutex_name};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_HOME: AtomicU64 = AtomicU64::new(0);

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "colmena-widget-lock-{}-{}",
            std::process::id(),
            NEXT_HOME.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn record(pid: u32, executable: &str) -> ProcessRecord {
    ProcessRecord {
        pid,
        executable: PathBuf::from(executable),
    }
}

#[test]
fn mutex_name_is_stable_for_normalized_paths_and_distinct_between_homes() {
    let first = Home::new();
    let second = Home::new();
    let first_name = mutex_name(&first.0).unwrap();
    let normalized_name = mutex_name(&first.0.join(".")).unwrap();

    assert_eq!(first_name, normalized_name);
    assert_ne!(first_name, mutex_name(&second.0).unwrap());
    assert!(first_name.starts_with("Local\\ColmenaWidget-"));
}

#[test]
fn registry_removes_its_own_record_but_preserves_a_replacement_owned_by_another_process() {
    let home = Home::new();
    let original = record(11, "C:/widget/first.exe");
    let registry = ProcessRegistry::publish(&home.0, original).unwrap();
    assert!(home.0.join("widget-process.json").exists());
    drop(registry);
    assert!(!home.0.join("widget-process.json").exists());

    let registry = ProcessRegistry::publish(&home.0, record(11, "C:/widget/first.exe")).unwrap();
    let foreign = record(22, "C:/other/widget.exe");
    fs::write(
        home.0.join("widget-process.json"),
        serde_json::to_vec(&foreign).unwrap(),
    )
    .unwrap();
    drop(registry);

    assert_eq!(ProcessRegistry::read(&home.0).unwrap(), Some(foreign));
}

#[test]
fn publisher_replaces_stale_registry_atomically_without_leaving_a_temporary_file() {
    let home = Home::new();
    let path = home.0.join("widget-process.json");
    let stale = record(11, "C:/widget/old.exe");
    fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();

    let current = record(22, "C:/widget/current.exe");
    let registry = ProcessRegistry::publish(&home.0, current.clone()).unwrap();

    assert_eq!(ProcessRegistry::read(&home.0).unwrap(), Some(current));
    assert_eq!(fs::read_dir(&home.0).unwrap().count(), 1);
    drop(registry);
    assert!(!path.exists());
}

#[cfg(target_os = "windows")]
#[test]
fn named_mutex_rejects_a_second_instance_for_the_same_home_and_releases_on_drop() {
    let home = Home::new();
    let executable = std::env::current_exe().unwrap();
    let first = colmena_widget::platform::windows::acquire_instance(&home.0, &executable)
        .expect("first process should acquire the home mutex");
    let second = colmena_widget::platform::windows::acquire_instance(&home.0, &executable);

    assert!(second.unwrap_err().to_string().contains("activo"));
    drop(first);

    let after_release = colmena_widget::platform::windows::acquire_instance(&home.0, &executable);
    assert!(after_release.is_ok());
}
