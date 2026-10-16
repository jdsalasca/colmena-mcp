use crate::framebuffer::FrameBuffer;
use crate::jobs::Job;
use crate::platform::{Platform, PlatformError, PlatformEvent};
use crate::poller::{PollMessage, Poller};
use crate::position::{Position, Size, WorkArea, clamp_position, load_position, save_position};
use crate::render::render;
use crate::scene::{
    Menu, MenuAction, Point, Rect, Scene, Tooltip, drag_position, hit_test_bee, hit_test_menu,
    reconcile, tooltip_for,
};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const WIDGET_SIZE: Size = Size {
    width: 320,
    height: 180,
};
const POSITION_MARGIN: i32 = 24;
const MENU_WIDTH: f32 = 76.0;
const MENU_HEIGHT: f32 = 48.0;

#[derive(Debug)]
pub struct WidgetAppError(String);

impl std::fmt::Display for WidgetAppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for WidgetAppError {}

impl From<PlatformError> for WidgetAppError {
    fn from(error: PlatformError) -> Self {
        Self(error.to_string())
    }
}

impl From<io::Error> for WidgetAppError {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

struct DragState {
    origin: Position,
    pointer_start: Point,
}

pub struct WidgetApp<P: Platform> {
    home: PathBuf,
    position_path: PathBuf,
    platform: P,
    poller: Poller,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    work_areas: Vec<WorkArea>,
    position: Position,
    snapshot: Vec<Job>,
    scene: Scene,
    pointer: Point,
    drag: Option<DragState>,
    last_error: Option<String>,
    last_frame: Option<FrameBuffer>,
    closed: bool,
}

impl<P: Platform> WidgetApp<P> {
    pub fn new<R, C>(
        home: impl Into<PathBuf>,
        platform: P,
        reader: R,
        clock: C,
    ) -> Result<Self, WidgetAppError>
    where
        R: Fn(&Path) -> io::Result<Vec<Job>> + Send + 'static,
        C: Fn() -> i64 + Send + Sync + 'static,
    {
        Self::with_poll_interval(home, platform, reader, clock, Duration::from_secs(1))
    }

    pub fn with_poll_interval<R, C>(
        home: impl Into<PathBuf>,
        mut platform: P,
        reader: R,
        clock: C,
        interval: Duration,
    ) -> Result<Self, WidgetAppError>
    where
        R: Fn(&Path) -> io::Result<Vec<Job>> + Send + 'static,
        C: Fn() -> i64 + Send + Sync + 'static,
    {
        let home = home.into();
        let current = platform.current_position()?;
        let mut work_areas = platform.work_areas()?;
        if work_areas.is_empty() {
            work_areas.push(WorkArea {
                x: current.x,
                y: current.y,
                width: WIDGET_SIZE.width as i32,
                height: WIDGET_SIZE.height as i32,
            });
        }
        let fallback = default_position(work_areas[0]);
        let position_path = home.join("widget-position.json");
        let (requested_position, position_warning) = match load_position(&position_path, fallback) {
            Ok(position) => (position, None),
            Err(warning) => (warning.fallback, Some(warning.to_string())),
        };
        let position = clamp_to_areas(requested_position, &work_areas);
        platform.move_to(position)?;
        let poller = Poller::with_interval(home.clone(), interval, reader)?;

        Ok(Self {
            home,
            position_path,
            platform,
            poller,
            clock: Box::new(clock),
            work_areas,
            position,
            snapshot: Vec::new(),
            scene: Scene::default(),
            pointer: Point::default(),
            drag: None,
            last_error: position_warning,
            last_frame: None,
            closed: false,
        })
    }

    pub fn run(&mut self) -> Result<(), WidgetAppError> {
        while !self.closed {
            self.step()?;
        }
        Ok(())
    }

    pub fn step(&mut self) -> Result<(), WidgetAppError> {
        if self.closed {
            return Ok(());
        }

        let events = self.platform.poll_events()?;
        let mut redraw = false;
        let mut tick = false;
        for event in events {
            match event {
                PlatformEvent::Tick => {
                    tick = true;
                    redraw = true;
                }
                PlatformEvent::MouseMove(point) => {
                    self.pointer = point;
                    self.move_dragged_window(point)?;
                    redraw = true;
                }
                PlatformEvent::LeftDown(point) => {
                    self.pointer = point;
                    if self.handle_menu_click(point)? {
                        redraw = true;
                    } else if !self.closed {
                        self.drag = Some(DragState {
                            origin: self.position,
                            pointer_start: point,
                        });
                    }
                }
                PlatformEvent::LeftUp(point) => {
                    self.pointer = point;
                    if self.drag.take().is_some() {
                        if let Err(error) = save_position(&self.position_path, self.position) {
                            self.last_error =
                                Some(format!("no se pudo guardar la posición: {error}"));
                        }
                        redraw = true;
                    }
                }
                PlatformEvent::RightUp(point) => {
                    self.pointer = point;
                    self.scene.menu = self.scene.menu.is_none().then(|| menu_at(point));
                    redraw = true;
                }
                PlatformEvent::Close => {
                    self.close()?;
                    return Ok(());
                }
            }
            if self.closed {
                return Ok(());
            }
        }

        let now_ms = (self.clock)();
        while let Ok(message) = self.poller.try_recv() {
            match message {
                PollMessage::Snapshot(snapshot) => {
                    self.snapshot = snapshot;
                    self.last_error = None;
                    self.scene = reconcile(&self.scene, &self.snapshot, now_ms, scene_bounds());
                    redraw = true;
                }
                PollMessage::Error { message, .. } => {
                    self.last_error = Some(message);
                    redraw = true;
                }
            }
        }
        if tick {
            self.scene = reconcile(&self.scene, &self.snapshot, now_ms, scene_bounds());
        }
        if redraw {
            let tooltip = self.tooltip_at(now_ms);
            let frame = render(
                &self.scene,
                now_ms,
                WIDGET_SIZE.width,
                WIDGET_SIZE.height,
                tooltip.as_ref().map(|tooltip| (tooltip, self.pointer)),
            );
            self.platform.present(&frame)?;
            self.last_frame = Some(frame);
        }
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), WidgetAppError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.drag = None;
        self.poller.stop();
        self.platform.close()?;
        Ok(())
    }

    pub fn position(&self) -> Position {
        self.position
    }

    pub fn snapshot(&self) -> &[Job] {
        &self.snapshot
    }

    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    pub fn tooltip(&self) -> Option<Tooltip> {
        self.tooltip_at((self.clock)())
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn last_frame(&self) -> Option<&FrameBuffer> {
        self.last_frame.as_ref()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn poller_stopped(&self) -> bool {
        self.poller.is_stopped()
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    fn tooltip_at(&self, now_ms: i64) -> Option<Tooltip> {
        hit_test_bee(&self.scene, self.pointer, now_ms).map(|job| tooltip_for(job, now_ms))
    }

    fn move_dragged_window(&mut self, pointer: Point) -> Result<(), WidgetAppError> {
        let Some(drag) = &self.drag else {
            return Ok(());
        };
        let moved = drag_position(
            Point {
                x: drag.origin.x as f32,
                y: drag.origin.y as f32,
            },
            drag.pointer_start,
            pointer,
        );
        let desired = Position {
            x: moved.x.round() as i32,
            y: moved.y.round() as i32,
        };
        let areas = self.platform.work_areas()?;
        self.work_areas = if areas.is_empty() {
            self.work_areas.clone()
        } else {
            areas
        };
        let position = clamp_to_areas(desired, &self.work_areas);
        if position != self.position {
            self.platform.move_to(position)?;
            self.position = position;
        }
        Ok(())
    }

    fn handle_menu_click(&mut self, point: Point) -> Result<bool, WidgetAppError> {
        let Some(menu) = self.scene.menu else {
            return Ok(false);
        };
        match hit_test_menu(&menu, point) {
            MenuAction::Exit => self.close()?,
            MenuAction::Dismiss => self.scene.menu = None,
        }
        Ok(true)
    }
}

impl<P: Platform> Drop for WidgetApp<P> {
    fn drop(&mut self) {
        if !self.closed {
            self.poller.stop();
            let _ = self.platform.close();
            self.closed = true;
        }
    }
}

fn scene_bounds() -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width: WIDGET_SIZE.width as f32,
        height: WIDGET_SIZE.height as f32,
    }
}

fn default_position(area: WorkArea) -> Position {
    clamp_position(
        Position {
            x: area
                .x
                .saturating_add(area.width)
                .saturating_sub(WIDGET_SIZE.width as i32)
                .saturating_sub(POSITION_MARGIN),
            y: area
                .y
                .saturating_add(area.height)
                .saturating_sub(WIDGET_SIZE.height as i32)
                .saturating_sub(POSITION_MARGIN),
        },
        WIDGET_SIZE,
        area,
    )
}

fn clamp_to_areas(position: Position, areas: &[WorkArea]) -> Position {
    areas
        .iter()
        .map(|area| clamp_position(position, WIDGET_SIZE, *area))
        .min_by_key(|candidate| {
            let dx = i64::from(candidate.x) - i64::from(position.x);
            let dy = i64::from(candidate.y) - i64::from(position.y);
            dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))
        })
        .unwrap_or(position)
}

fn menu_at(point: Point) -> Menu {
    let bounds_x = point.x.clamp(0.0, WIDGET_SIZE.width as f32 - MENU_WIDTH);
    let bounds_y = point.y.clamp(0.0, WIDGET_SIZE.height as f32 - MENU_HEIGHT);
    Menu {
        bounds: Rect {
            x: bounds_x,
            y: bounds_y,
            width: MENU_WIDTH,
            height: MENU_HEIGHT,
        },
        exit_button: Rect {
            x: bounds_x + 5.0,
            y: bounds_y + MENU_HEIGHT - 22.0,
            width: MENU_WIDTH - 10.0,
            height: 16.0,
        },
    }
}
