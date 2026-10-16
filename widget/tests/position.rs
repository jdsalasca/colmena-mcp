use colmena_widget::position::{
    Position, PositionWarning, Size, WorkArea, clamp_position, load_position, save_position,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "colmena-widget-position-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn missing_file_returns_the_caller_fallback() {
    let fixture = Fixture::new();
    let fallback = Position { x: 120, y: 240 };

    assert_eq!(
        load_position(&fixture.path().join("missing.json"), fallback).unwrap(),
        fallback
    );
}

#[test]
fn valid_position_json_is_loaded() {
    let fixture = Fixture::new();
    let path = fixture.path().join("widget-position.json");
    fs::write(&path, r#"{"x":-320,"y":840,"future":true}"#).unwrap();

    assert_eq!(
        load_position(&path, Position { x: 0, y: 0 }).unwrap(),
        Position { x: -320, y: 840 }
    );
}

#[test]
fn corrupt_json_returns_the_fallback_inside_a_warning() {
    let fixture = Fixture::new();
    let path = fixture.path().join("widget-position.json");
    fs::write(&path, "{broken").unwrap();
    let fallback = Position { x: 10, y: 20 };

    let warning: PositionWarning = load_position(&path, fallback).unwrap_err();

    assert_eq!(warning.fallback, fallback);
    assert!(warning.message.contains("widget-position.json"));
}

#[test]
fn save_creates_parent_and_round_trips_the_position() {
    let fixture = Fixture::new();
    let path = fixture.path().join("nested").join("widget-position.json");
    let position = Position { x: -1_440, y: 720 };

    save_position(&path, position).unwrap();

    assert_eq!(
        load_position(&path, Position { x: 0, y: 0 }).unwrap(),
        position
    );
}

#[test]
fn replacing_a_position_leaves_no_temporary_sibling() {
    let fixture = Fixture::new();
    let path = fixture.path().join("widget-position.json");
    save_position(&path, Position { x: 1, y: 2 }).unwrap();
    let replacement = Position { x: -30, y: 400 };

    save_position(&path, replacement).unwrap();

    assert_eq!(
        load_position(&path, Position { x: 0, y: 0 }).unwrap(),
        replacement
    );
    let files: Vec<_> = fs::read_dir(fixture.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, ["widget-position.json"]);
}

#[test]
fn save_reports_directory_creation_or_write_errors() {
    let fixture = Fixture::new();
    let blocking_file = fixture.path().join("not-a-directory");
    fs::write(&blocking_file, "block").unwrap();
    let path = blocking_file.join("widget-position.json");

    assert!(save_position(&path, Position { x: 1, y: 2 }).is_err());
}

#[test]
fn clamp_handles_center_and_all_four_edges() {
    let area = WorkArea {
        x: 0,
        y: 0,
        width: 100,
        height: 80,
    };
    let size = Size {
        width: 20,
        height: 10,
    };
    let cases = [
        (Position { x: 40, y: 30 }, Position { x: 40, y: 30 }),
        (Position { x: -50, y: -50 }, Position { x: 0, y: 0 }),
        (Position { x: 500, y: -30 }, Position { x: 80, y: 0 }),
        (Position { x: -20, y: 500 }, Position { x: 0, y: 70 }),
        (Position { x: 90, y: 90 }, Position { x: 80, y: 70 }),
    ];

    for (position, expected) in cases {
        assert_eq!(clamp_position(position, size, area), expected);
    }
}

#[test]
fn clamp_respects_negative_monitor_origins_and_far_offscreen_positions() {
    let area = WorkArea {
        x: -1_920,
        y: -200,
        width: 1_920,
        height: 1_080,
    };
    let size = Size {
        width: 200,
        height: 150,
    };

    assert_eq!(
        clamp_position(
            Position {
                x: -5_000,
                y: -8_000
            },
            size,
            area
        ),
        Position { x: -1_920, y: -200 }
    );
    assert_eq!(
        clamp_position(
            Position {
                x: 20_000,
                y: 20_000
            },
            size,
            area
        ),
        Position { x: -200, y: 730 }
    );
}

#[test]
fn oversized_widget_anchors_to_the_work_area_origin() {
    let area = WorkArea {
        x: -50,
        y: 30,
        width: 100,
        height: 80,
    };
    let widget = Size {
        width: 140,
        height: 120,
    };

    assert_eq!(
        clamp_position(Position { x: 900, y: -900 }, widget, area),
        Position { x: -50, y: 30 }
    );
}

#[test]
fn position_far_from_selected_monitor_clamps_deterministically() {
    let area = WorkArea {
        x: 1_920,
        y: 0,
        width: 1_280,
        height: 1_024,
    };
    let size = Size {
        width: 300,
        height: 180,
    };

    assert_eq!(
        clamp_position(Position { x: -4_000, y: 500 }, size, area),
        Position { x: 1_920, y: 500 }
    );
    assert_eq!(
        clamp_position(Position { x: -4_000, y: 500 }, size, area),
        clamp_position(Position { x: -4_000, y: 500 }, size, area)
    );
}
