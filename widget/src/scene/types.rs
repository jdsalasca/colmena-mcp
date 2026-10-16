use crate::jobs::Job;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Motion {
    Idle,
    Queued,
    Flying,
    Returning,
    Falling,
}

impl Rect {
    pub fn contains(self, point: Point) -> bool {
        point.x >= self.x
            && point.y >= self.y
            && point.x < self.x + self.width
            && point.y < self.y + self.height
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bee {
    pub job: Option<Job>,
    pub motion: Motion,
    pub position: Point,
    pub route: Vec<Point>,
    pub launch_from: Option<Point>,
    pub phase: u8,
    pub radius: f32,
    pub motion_started_at_ms: i64,
    pub exit_started_at_ms: Option<i64>,
    pub missing_polls: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectKind {
    Glow,
    RedFlash,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Effect {
    pub kind: EffectKind,
    pub position: Point,
    pub started_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Menu {
    pub bounds: Rect,
    pub exit_button: Rect,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scene {
    pub bees: Vec<Bee>,
    pub effects: Vec<Effect>,
    pub menu: Option<Menu>,
}
