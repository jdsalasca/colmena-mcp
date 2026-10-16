use colmena_widget::jobs::{Job, JobState};
use colmena_widget::platform::windows::create_platform;
use colmena_widget::platform::{Platform, PlatformEvent};
use colmena_widget::position::{Position, Size, WorkArea, clamp_position};
use colmena_widget::render::render;
use colmena_widget::scene::{
    Menu, MenuAction, Point, Rect, Scene, drag_position, hit_test_bee, hit_test_menu, reconcile,
    tooltip_for,
};
use std::time::Instant;

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut platform = create_platform(WIDTH, HEIGHT, Position::default())?;
    let areas = platform.work_areas()?;
    let initial_position = fallback_position(&areas);
    platform.move_to(initial_position)?;

    let jobs = [
        synthetic_job("spike-queued", JobState::Queued, "luna-max", 0),
        synthetic_job("spike-running", JobState::Running, "ds-flash", 0),
        synthetic_job("spike-hive", JobState::Running, "max-hive", 0),
    ];
    let mut scene = reconcile(
        &Scene::default(),
        &jobs,
        0,
        Rect {
            x: 0.0,
            y: 0.0,
            width: WIDTH as f32,
            height: HEIGHT as f32,
        },
    );

    let started = Instant::now();
    let mut pointer = Point::default();
    let mut drag: Option<(Position, Point)> = None;
    let mut menu_anchor: Option<Point> = None;
    let mut done = false;

    while !done {
        let events = platform.poll_events()?;
        for event in events {
            match event {
                PlatformEvent::Tick => {}
                PlatformEvent::MouseMove(point) => {
                    pointer = point;
                    if let Some((origin, start)) = drag {
                        let moved = drag_position(
                            Point {
                                x: origin.x as f32,
                                y: origin.y as f32,
                            },
                            start,
                            pointer,
                        );
                        let candidate = Position {
                            x: moved.x.round() as i32,
                            y: moved.y.round() as i32,
                        };
                        let areas = platform.work_areas()?;
                        platform.move_to(clamp_in_area(candidate, &areas))?;
                    }
                }
                PlatformEvent::LeftDown(point) => {
                    if let Some(anchor) = menu_anchor {
                        if let Some(menu) = menu_at(anchor) {
                            if hit_test_menu(&menu, point) == MenuAction::Exit {
                                done = true;
                            } else {
                                menu_anchor = None;
                            }
                        }
                    } else {
                        let position = platform.current_position()?;
                        drag = Some((position, point));
                    }
                }
                PlatformEvent::LeftUp(_) => drag = None,
                PlatformEvent::RightUp(point) => {
                    menu_anchor = Some(point);
                    println!("spike: se recibió clic derecho sobre {point:?}");
                }
                PlatformEvent::Close => done = true,
            }
        }

        let now_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        scene = reconcile(
            &scene,
            &jobs,
            now_ms,
            Rect {
                x: 0.0,
                y: 0.0,
                width: WIDTH as f32,
                height: HEIGHT as f32,
            },
        );
        if let Some(anchor) = menu_anchor {
            scene.menu = menu_at(anchor);
        } else {
            scene.menu = None;
        }
        let tooltip =
            hit_test_bee(&scene, pointer, now_ms).map(|job| (tooltip_for(job, now_ms), pointer));
        let frame = render(
            &scene,
            now_ms,
            WIDTH,
            HEIGHT,
            tooltip.as_ref().map(|(tooltip, point)| (tooltip, *point)),
        );
        platform.present(&frame)?;
    }

    platform.close()?;
    Ok(())
}

fn synthetic_job(id: &str, state: JobState, worker: &str, started_at: i64) -> Job {
    Job {
        id: id.to_owned(),
        state,
        kind: Some("run".to_owned()),
        task: Some("Probar transparencia, hover y arrastre".to_owned()),
        worker: Some(worker.to_owned()),
        provider: Some("codex".to_owned()),
        branch: Some("widget/spike".to_owned()),
        created_at: Some(0),
        started_at: Some(started_at),
        ended_at: None,
        cost_usd: Some(0.0123),
    }
}

fn fallback_position(areas: &[WorkArea]) -> Position {
    areas
        .first()
        .map(|area| {
            clamp_position(
                Position {
                    x: area.x + area.width - WIDTH as i32 - 24,
                    y: area.y + area.height - HEIGHT as i32 - 24,
                },
                Size {
                    width: WIDTH,
                    height: HEIGHT,
                },
                *area,
            )
        })
        .unwrap_or_default()
}

fn clamp_in_area(position: Position, areas: &[WorkArea]) -> Position {
    let area = areas
        .iter()
        .find(|area| {
            position.x >= area.x
                && position.x < area.x.saturating_add(area.width)
                && position.y >= area.y
                && position.y < area.y.saturating_add(area.height)
        })
        .or_else(|| areas.first());
    area.map(|area| {
        clamp_position(
            position,
            Size {
                width: WIDTH,
                height: HEIGHT,
            },
            *area,
        )
    })
    .unwrap_or(position)
}

fn menu_at(point: Point) -> Option<Menu> {
    let x = point.x.clamp(0.0, WIDTH as f32 - 76.0);
    let y = point.y.clamp(0.0, HEIGHT as f32 - 48.0);
    Some(Menu {
        bounds: Rect {
            x,
            y,
            width: 76.0,
            height: 48.0,
        },
        exit_button: Rect {
            x: x + 5.0,
            y: y + 26.0,
            width: 66.0,
            height: 16.0,
        },
    })
}
