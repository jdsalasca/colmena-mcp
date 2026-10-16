use super::Motion;
use super::{Bee, Point};

const FLIGHT_SEGMENT_MS: i64 = 1_400;
const LAUNCH_DURATION_MS: i64 = 700;
pub(super) const EXIT_DURATION_MS: i64 = 1_200;

pub fn position_at(bee: &Bee, now_ms: i64) -> Point {
    if bee.route.len() < 2 {
        return bee.position;
    }

    match bee.motion {
        Motion::Flying => flying_position(bee, now_ms),
        Motion::Returning | Motion::Falling => exit_position(bee, now_ms),
        Motion::Idle | Motion::Queued => bee.position,
    }
}

fn flying_position(bee: &Bee, now_ms: i64) -> Point {
    let segments = bee.route.len() - 1;
    let cycle_ms = FLIGHT_SEGMENT_MS.saturating_mul(segments as i64);
    let mut elapsed = now_ms.saturating_sub(bee.motion_started_at_ms).max(0);
    if let Some(start) = bee.launch_from {
        if elapsed < LAUNCH_DURATION_MS {
            return interpolate(
                start,
                bee.route[0],
                ease(elapsed as f32 / LAUNCH_DURATION_MS as f32),
            );
        }
        elapsed -= LAUNCH_DURATION_MS;
    }
    let progress_ms = elapsed % cycle_ms;
    let segment = (progress_ms / FLIGHT_SEGMENT_MS) as usize;
    let fraction = (progress_ms % FLIGHT_SEGMENT_MS) as f32 / FLIGHT_SEGMENT_MS as f32;
    interpolate(bee.route[segment], bee.route[segment + 1], ease(fraction))
}

fn exit_position(bee: &Bee, now_ms: i64) -> Point {
    let start = bee.exit_started_at_ms.unwrap_or(bee.motion_started_at_ms);
    let elapsed = now_ms.saturating_sub(start).max(0);
    let fraction = (elapsed as f32 / EXIT_DURATION_MS as f32).clamp(0.0, 1.0);
    interpolate(bee.route[0], *bee.route.last().unwrap(), ease(fraction))
}

fn interpolate(from: Point, to: Point, fraction: f32) -> Point {
    Point {
        x: from.x + (to.x - from.x) * fraction,
        y: from.y + (to.y - from.y) * fraction,
    }
}

fn ease(value: f32) -> f32 {
    value * value * (3.0 - 2.0 * value)
}
