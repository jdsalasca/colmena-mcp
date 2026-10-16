use super::trajectory::EXIT_DURATION_MS;
use super::{Bee, Effect, EffectKind, Motion, Point, Rect, Scene, position_at};
use crate::jobs::Job;
use crate::jobs::JobState;
use std::collections::{BTreeMap, BTreeSet};

const MISSING_POLL_LIMIT: u8 = 2;
const EFFECT_DURATION_MS: i64 = 900;
const QUEUE_COLUMNS: usize = 8;

pub fn reconcile(previous: &Scene, jobs: &[Job], now_ms: i64, bounds: Rect) -> Scene {
    let mut snapshot = BTreeMap::new();
    let mut ordered_jobs: Vec<_> = jobs.iter().collect();
    ordered_jobs.sort_by(|left, right| left.id.cmp(&right.id));
    for job in ordered_jobs {
        snapshot.entry(job.id.clone()).or_insert(job);
    }

    let previous_by_id: BTreeMap<_, _> = previous
        .bees
        .iter()
        .filter_map(|bee| bee.job.as_ref().map(|job| (job.id.clone(), bee)))
        .collect();

    let mut scene = Scene {
        bees: Vec::new(),
        effects: previous
            .effects
            .iter()
            .copied()
            .filter(|effect| now_ms.saturating_sub(effect.started_at_ms) < EFFECT_DURATION_MS)
            .collect(),
        menu: previous.menu,
    };

    let mut queued_index = 0;
    let mut flying_index = 0;
    for job in snapshot
        .values()
        .copied()
        .filter(|job| job.state.is_active())
    {
        let previous_bee = previous_by_id.get(&job.id).copied();
        let index = if job.state == JobState::Queued {
            let index = queued_index;
            queued_index += 1;
            index
        } else {
            let index = flying_index;
            flying_index += 1;
            index
        };
        scene
            .bees
            .push(active_bee(job, previous_bee, now_ms, bounds, index));
    }

    for job in snapshot
        .values()
        .copied()
        .filter(|job| job.state.is_terminal())
    {
        let Some(previous_bee) = previous_by_id.get(&job.id).copied() else {
            continue;
        };

        if previous_bee
            .job
            .as_ref()
            .is_some_and(|old| old.state.is_active())
        {
            let (bee, effect) = exiting_bee(job, previous_bee, now_ms, bounds);
            scene.bees.push(bee);
            if let Some(effect) = effect {
                scene.effects.push(effect);
            }
        } else if is_exit(previous_bee.motion) && exit_is_alive(previous_bee, now_ms) {
            let mut bee = previous_bee.clone();
            bee.job = Some(job.clone());
            scene.bees.push(bee);
        }
    }

    let present_ids: BTreeSet<_> = snapshot.keys().cloned().collect();
    for (id, previous_bee) in previous_by_id {
        if present_ids.contains(&id) {
            continue;
        }

        if previous_bee
            .job
            .as_ref()
            .is_some_and(|job| job.state.is_active())
        {
            let mut bee = previous_bee.clone();
            bee.missing_polls = bee.missing_polls.saturating_add(1);
            if bee.missing_polls <= MISSING_POLL_LIMIT {
                scene.bees.push(bee);
            }
        } else if is_exit(previous_bee.motion) && exit_is_alive(previous_bee, now_ms) {
            scene.bees.push(previous_bee.clone());
        }
    }

    if scene.bees.iter().all(|bee| bee.job.is_none()) {
        scene.bees.extend(idle_bees(bounds, now_ms));
    }
    scene
}

fn active_bee(job: &Job, previous: Option<&Bee>, now_ms: i64, bounds: Rect, index: usize) -> Bee {
    let style = super::style_for_worker(job.worker.as_deref().unwrap_or(""));
    let radius = style.size_scale as f32 * 3.0;
    let mut bee = if let Some(previous) =
        previous.filter(|bee| bee.job.as_ref().is_some_and(|old| old.state.is_active()))
    {
        let old_state = previous.job.as_ref().unwrap().state;
        let mut bee = previous.clone();
        bee.job = Some(job.clone());
        bee.radius = radius;
        bee.missing_polls = 0;
        bee.exit_started_at_ms = None;

        if old_state != job.state {
            bee.motion_started_at_ms = now_ms;
            if job.state == JobState::Running {
                bee.motion = Motion::Flying;
                bee.launch_from = Some(bee.position);
                bee.route = flight_route(bounds, bee.phase, radius);
            } else {
                bee.motion = Motion::Queued;
                bee.route.clear();
                bee.launch_from = None;
            }
        }
        bee
    } else {
        let phase = stable_phase(&job.id);
        let position = if job.state == JobState::Queued {
            queued_position(index, bounds, radius)
        } else {
            flight_route(bounds, phase, radius)[0]
        };
        let motion = if job.state == JobState::Queued {
            Motion::Queued
        } else {
            Motion::Flying
        };
        let route = if job.state == JobState::Running {
            flight_route(bounds, phase, radius)
        } else {
            Vec::new()
        };
        Bee {
            job: Some(job.clone()),
            motion,
            position,
            route,
            launch_from: None,
            phase,
            radius,
            motion_started_at_ms: now_ms,
            exit_started_at_ms: None,
            missing_polls: 0,
        }
    };

    if bee.motion == Motion::Queued {
        bee.position = queued_position(index, bounds, radius);
    }
    bee
}

fn exiting_bee(job: &Job, previous: &Bee, now_ms: i64, bounds: Rect) -> (Bee, Option<Effect>) {
    let start = position_at(previous, now_ms);
    let entrance = hive_entrance(bounds);
    let (motion, route, effect) = match job.state {
        JobState::Done => (
            Motion::Returning,
            vec![start, entrance],
            Some(EffectKind::Glow),
        ),
        JobState::Failed | JobState::Orphaned => {
            let drift = if previous.phase.is_multiple_of(2) {
                -14.0
            } else {
                14.0
            };
            let fallen = clamp_point(
                Point {
                    x: start.x + drift,
                    y: start.y + 30.0,
                },
                bounds,
                previous.radius,
            );
            (
                Motion::Falling,
                vec![start, fallen],
                Some(EffectKind::RedFlash),
            )
        }
        JobState::Cancelled => (Motion::Returning, vec![start, entrance], None),
        JobState::Queued | JobState::Running => unreachable!("active jobs use active_bee"),
    };

    let bee = Bee {
        job: Some(job.clone()),
        motion,
        position: start,
        route,
        launch_from: None,
        phase: previous.phase,
        radius: previous.radius,
        motion_started_at_ms: now_ms,
        exit_started_at_ms: Some(now_ms),
        missing_polls: 0,
    };
    let effect = effect.map(|kind| Effect {
        kind,
        position: start,
        started_at_ms: now_ms,
    });
    (bee, effect)
}

fn is_exit(motion: Motion) -> bool {
    matches!(motion, Motion::Returning | Motion::Falling)
}

fn exit_is_alive(bee: &Bee, now_ms: i64) -> bool {
    bee.exit_started_at_ms
        .is_some_and(|started| now_ms.saturating_sub(started).max(0) < EXIT_DURATION_MS)
}

fn idle_bees(bounds: Rect, now_ms: i64) -> [Bee; 2] {
    let entrance = hive_entrance(bounds);
    [
        idle_bee(
            clamp_point(
                Point {
                    x: entrance.x - 9.0,
                    y: entrance.y - 8.0,
                },
                bounds,
                4.0,
            ),
            0,
            now_ms,
        ),
        idle_bee(
            clamp_point(
                Point {
                    x: entrance.x + 9.0,
                    y: entrance.y - 8.0,
                },
                bounds,
                4.0,
            ),
            1,
            now_ms,
        ),
    ]
}

fn idle_bee(position: Point, phase: u8, now_ms: i64) -> Bee {
    Bee {
        job: None,
        motion: Motion::Idle,
        position,
        route: Vec::new(),
        launch_from: None,
        phase,
        radius: 4.0,
        motion_started_at_ms: now_ms,
        exit_started_at_ms: None,
        missing_polls: 0,
    }
}

fn queued_position(index: usize, bounds: Rect, radius: f32) -> Point {
    let columns =
        QUEUE_COLUMNS.min(((bounds.width.max(1.0) / (radius * 2.0 + 5.0)).floor() as usize).max(1));
    let column = index % columns;
    let row = index / columns;
    let column_offset = column as f32 - (columns as f32 - 1.0) / 2.0;
    let spacing = radius * 2.0 + 5.0;
    clamp_point(
        Point {
            x: bounds.x + bounds.width / 2.0 + column_offset * spacing,
            y: hive_entrance(bounds).y + row as f32 * spacing * 0.65,
        },
        bounds,
        radius,
    )
}

fn flight_route(bounds: Rect, phase: u8, radius: f32) -> Vec<Point> {
    let anchors = [
        Point { x: 0.5, y: 0.43 },
        Point { x: 0.71, y: 0.58 },
        Point { x: 0.82, y: 0.43 },
        Point { x: 0.71, y: 0.28 },
        Point { x: 0.5, y: 0.43 },
        Point { x: 0.29, y: 0.58 },
        Point { x: 0.18, y: 0.43 },
        Point { x: 0.29, y: 0.28 },
    ];
    let offset = usize::from(phase) % anchors.len();
    let mut route: Vec<_> = (0..anchors.len())
        .map(|index| {
            let anchor = anchors[(index + offset) % anchors.len()];
            clamp_point(
                Point {
                    x: bounds.x + bounds.width * anchor.x,
                    y: bounds.y + bounds.height * anchor.y,
                },
                bounds,
                radius,
            )
        })
        .collect();
    route.push(route[0]);
    route
}

fn stable_phase(id: &str) -> u8 {
    id.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    }) as u8
        % 8
}

fn hive_entrance(bounds: Rect) -> Point {
    clamp_point(
        Point {
            x: bounds.x + bounds.width / 2.0,
            y: bounds.y + bounds.height * 0.66,
        },
        bounds,
        0.0,
    )
}

fn clamp_point(point: Point, bounds: Rect, margin: f32) -> Point {
    let margin_x = margin.max(0.0).min(bounds.width.max(0.0) / 2.0);
    let margin_y = margin.max(0.0).min(bounds.height.max(0.0) / 2.0);
    let min_x = bounds.x + margin_x;
    let max_x = (bounds.x + bounds.width.max(0.0) - margin_x).max(min_x);
    let min_y = bounds.y + margin_y;
    let max_y = (bounds.y + bounds.height.max(0.0) - margin_y).max(min_y);
    Point {
        x: point.x.clamp(min_x, max_x),
        y: point.y.clamp(min_y, max_y),
    }
}

pub fn drag_position(origin: Point, pointer_start: Point, pointer_now: Point) -> Point {
    Point {
        x: origin.x + pointer_now.x - pointer_start.x,
        y: origin.y + pointer_now.y - pointer_start.y,
    }
}

pub fn place_tooltip(anchor: Point, size: Rect, bounds: Rect) -> Point {
    let width = size.width.max(0.0).min(bounds.width.max(0.0));
    let height = size.height.max(0.0).min(bounds.height.max(0.0));
    let min_x = bounds.x;
    let min_y = bounds.y;
    let max_x = (bounds.x + bounds.width.max(0.0) - width).max(min_x);
    let max_y = (bounds.y + bounds.height.max(0.0) - height).max(min_y);
    Point {
        x: (anchor.x + 8.0).clamp(min_x, max_x),
        y: (anchor.y + 8.0).clamp(min_y, max_y),
    }
}
