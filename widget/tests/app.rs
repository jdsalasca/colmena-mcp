use colmena_widget::jobs::{Job, JobState};
use colmena_widget::platform::{Platform, PlatformError, PlatformEvent};
use colmena_widget::position::{Position, WorkArea, load_position, save_position};
use colmena_widget::scene::{Point, position_at};
use colmena_widget::{app::WidgetApp, scene::Motion};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

static NEXT_HOME: AtomicU64 = AtomicU64::new(0);

struct HomeFixture(PathBuf);

impl HomeFixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "colmena-widget-app-{}-{}",
            std::process::id(),
            NEXT_HOME.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for HomeFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct FakeState {
    position: Position,
    areas: Vec<WorkArea>,
    events: Vec<PlatformEvent>,
    moves: Vec<Position>,
    frames: usize,
    closes: usize,
}

#[derive(Clone)]
struct FakePlatform(Arc<Mutex<FakeState>>);

impl FakePlatform {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(FakeState {
            areas: vec![WorkArea {
                x: 10,
                y: 20,
                width: 1_000,
                height: 800,
            }],
            ..FakeState::default()
        })))
    }

    fn push(&self, event: PlatformEvent) {
        self.0.lock().unwrap().events.push(event);
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.0.lock().unwrap()
    }
}

impl Platform for FakePlatform {
    fn current_position(&self) -> Result<Position, PlatformError> {
        Ok(self.state().position)
    }

    fn work_areas(&self) -> Result<Vec<WorkArea>, PlatformError> {
        Ok(self.state().areas.clone())
    }

    fn move_to(&mut self, position: Position) -> Result<(), PlatformError> {
        let mut state = self.state();
        state.position = position;
        state.moves.push(position);
        Ok(())
    }

    fn present(
        &mut self,
        _frame: &colmena_widget::framebuffer::FrameBuffer,
    ) -> Result<(), PlatformError> {
        self.state().frames += 1;
        Ok(())
    }

    fn poll_events(&mut self) -> Result<Vec<PlatformEvent>, PlatformError> {
        Ok(std::mem::take(&mut self.state().events))
    }

    fn close(&mut self) -> Result<(), PlatformError> {
        self.state().closes += 1;
        Ok(())
    }
}

fn job(id: &str, state: JobState) -> Job {
    Job {
        id: id.to_owned(),
        state,
        kind: Some("run".to_owned()),
        task: Some("Revisar la escena del jardín".to_owned()),
        worker: Some("luna-max".to_owned()),
        provider: Some("codex".to_owned()),
        branch: Some("widget/app".to_owned()),
        created_at: Some(0),
        started_at: Some(0),
        ended_at: None,
        cost_usd: Some(0.125),
    }
}

fn app<R>(
    home: &HomeFixture,
    platform: FakePlatform,
    reader: R,
    clock: Arc<AtomicI64>,
) -> WidgetApp<FakePlatform>
where
    R: Fn(&Path) -> std::io::Result<Vec<Job>> + Send + 'static,
{
    WidgetApp::with_poll_interval(
        home.0.clone(),
        platform,
        reader,
        move || clock.load(Ordering::SeqCst),
        Duration::from_millis(20),
    )
    .unwrap()
}

fn wait_for(
    app: &mut WidgetApp<FakePlatform>,
    predicate: impl Fn(&WidgetApp<FakePlatform>) -> bool,
) {
    let deadline = Instant::now() + Duration::from_millis(800);
    while !predicate(app) && Instant::now() < deadline {
        app.step().unwrap();
        thread::sleep(Duration::from_millis(2));
    }
    assert!(predicate(app), "condition was not reached before timeout");
}

#[test]
fn initial_reader_error_keeps_empty_snapshot_and_uses_clamped_fallback_position() {
    let home = HomeFixture::new();
    let platform = FakePlatform::new();
    let mut app = app(
        &home,
        platform.clone(),
        |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied",
            ))
        },
        Arc::new(AtomicI64::new(0)),
    );

    wait_for(&mut app, |app| app.last_error().is_some());

    assert!(app.snapshot().is_empty());
    assert!(app.last_error().unwrap().contains("denied"));
    assert_eq!(app.position(), Position { x: 666, y: 616 });
    assert_eq!(platform.state().position, app.position());
    app.close().unwrap();
}

#[test]
fn slow_reader_does_not_block_the_window_step() {
    let home = HomeFixture::new();
    let mut app = app(
        &home,
        FakePlatform::new(),
        |_| {
            thread::sleep(Duration::from_millis(180));
            Ok(Vec::new())
        },
        Arc::new(AtomicI64::new(0)),
    );
    let started = Instant::now();

    app.step().unwrap();

    assert!(started.elapsed() < Duration::from_millis(80));
    app.close().unwrap();
}

#[test]
fn later_reader_error_preserves_the_last_valid_snapshot() {
    let home = HomeFixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let reader_calls = Arc::clone(&calls);
    let mut app = app(
        &home,
        FakePlatform::new(),
        move |_| {
            if reader_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(vec![job("valid", JobState::Running)])
            } else {
                Err(std::io::Error::other("later read failed"))
            }
        },
        Arc::new(AtomicI64::new(0)),
    );

    wait_for(&mut app, |app| app.snapshot().len() == 1);
    wait_for(&mut app, |app| app.last_error().is_some());

    assert_eq!(app.snapshot()[0].id, "valid");
    assert!(app.last_error().unwrap().contains("later read failed"));
    app.close().unwrap();
}

#[test]
fn tooltip_time_updates_on_ticks_without_reading_a_new_snapshot() {
    let home = HomeFixture::new();
    let platform = FakePlatform::new();
    let clock = Arc::new(AtomicI64::new(9_000));
    let calls = Arc::new(AtomicUsize::new(0));
    let reader_calls = Arc::clone(&calls);
    let mut app = app(
        &home,
        platform.clone(),
        move |_| {
            reader_calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![job("waiting", JobState::Queued)])
        },
        Arc::clone(&clock),
    );
    wait_for(&mut app, |app| !app.snapshot().is_empty());
    let poll_count = calls.load(Ordering::SeqCst);
    let bee = app
        .scene()
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == "waiting"))
        .unwrap();
    assert_eq!(bee.motion, Motion::Queued);
    platform.push(PlatformEvent::MouseMove(position_at(bee, 9_000)));
    app.step().unwrap();
    assert_eq!(app.tooltip().unwrap().elapsed, "00:09");

    clock.store(61_000, Ordering::SeqCst);
    platform.push(PlatformEvent::Tick);
    app.step().unwrap();

    assert_eq!(app.tooltip().unwrap().elapsed, "01:01");
    assert_eq!(calls.load(Ordering::SeqCst), poll_count);
    app.close().unwrap();
}

#[test]
fn drag_moves_window_and_saves_position_only_on_release() {
    let home = HomeFixture::new();
    let platform = FakePlatform::new();
    let saved_start = Position { x: 100, y: 100 };
    let position_path = home.0.join("widget-position.json");
    save_position(&position_path, saved_start).unwrap();
    let saved_bytes = fs::read(&position_path).unwrap();
    let mut app = app(
        &home,
        platform.clone(),
        |_| Ok(Vec::new()),
        Arc::new(AtomicI64::new(0)),
    );
    let start = app.position();
    platform.push(PlatformEvent::LeftDown(Point { x: 10.0, y: 10.0 }));
    platform.push(PlatformEvent::MouseMove(Point { x: 40.0, y: 60.0 }));
    app.step().unwrap();
    assert_eq!(fs::read(&position_path).unwrap(), saved_bytes);
    platform.push(PlatformEvent::LeftUp(Point { x: 40.0, y: 60.0 }));
    app.step().unwrap();

    let expected = Position {
        x: start.x + 30,
        y: start.y + 50,
    };
    assert_eq!(app.position(), expected);
    assert_eq!(platform.state().position, expected);
    assert_eq!(
        load_position(&position_path, Position::default()).unwrap(),
        expected
    );
    app.close().unwrap();
}

#[test]
fn menu_dismisses_and_exit_closes_platform_and_stops_poller() {
    let home = HomeFixture::new();
    let platform = FakePlatform::new();
    let mut app = app(
        &home,
        platform.clone(),
        |_| Ok(Vec::new()),
        Arc::new(AtomicI64::new(0)),
    );
    platform.push(PlatformEvent::RightUp(Point { x: 20.0, y: 20.0 }));
    app.step().unwrap();
    assert!(app.scene().menu.is_some());
    platform.push(PlatformEvent::LeftDown(Point { x: 250.0, y: 20.0 }));
    app.step().unwrap();
    assert!(app.scene().menu.is_none());

    platform.push(PlatformEvent::RightUp(Point { x: 20.0, y: 20.0 }));
    app.step().unwrap();
    let exit = app.scene().menu.unwrap().exit_button;
    platform.push(PlatformEvent::LeftDown(Point {
        x: exit.x + exit.width / 2.0,
        y: exit.y + exit.height / 2.0,
    }));
    app.step().unwrap();

    assert!(app.is_closed());
    assert!(app.poller_stopped());
    assert_eq!(platform.state().closes, 1);
}

#[test]
fn close_event_stops_polling() {
    let home = HomeFixture::new();
    let platform = FakePlatform::new();
    let mut app = app(
        &home,
        platform.clone(),
        |_| Ok(Vec::new()),
        Arc::new(AtomicI64::new(0)),
    );
    platform.push(PlatformEvent::Close);

    app.step().unwrap();

    assert!(app.is_closed());
    assert!(app.poller_stopped());
    assert_eq!(platform.state().closes, 1);
}
