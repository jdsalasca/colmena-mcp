use super::{Menu, Motion, Point, Scene, position_at};
use crate::jobs::Job;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MenuAction {
    Exit,
    Dismiss,
}

pub fn hit_test_bee(scene: &Scene, point: Point, now_ms: i64) -> Option<&Job> {
    scene.bees.iter().rev().find_map(|bee| {
        let job = bee.job.as_ref()?;
        if bee.motion == Motion::Idle {
            return None;
        }

        let position = position_at(bee, now_ms);
        let dx = point.x - position.x;
        let dy = point.y - position.y;
        (dx * dx + dy * dy <= bee.radius * bee.radius).then_some(job)
    })
}

pub fn hit_test_menu(menu: &Menu, point: Point) -> MenuAction {
    if menu.exit_button.contains(point) {
        MenuAction::Exit
    } else {
        MenuAction::Dismiss
    }
}
