use colmena_widget::jobs::{Job, JobState};
use colmena_widget::scene::{
    Bee, EffectKind, Menu, MenuAction, Motion, Point, Rect, Scene, WorkerPalette, drag_position,
    format_elapsed_ms, hit_test_bee, hit_test_menu, place_tooltip, position_at, reconcile,
    style_for_worker, tooltip_for,
};

fn rect() -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width: 320.0,
        height: 180.0,
    }
}

fn job(id: &str, state: JobState) -> Job {
    Job {
        id: id.to_owned(),
        state,
        kind: Some("run".to_owned()),
        task: Some("Inspeccionar el jardín".to_owned()),
        worker: Some("luna-max".to_owned()),
        provider: Some("codex".to_owned()),
        branch: Some("feature/widget".to_owned()),
        created_at: Some(1_000),
        started_at: Some(2_000),
        ended_at: Some(10_000),
        cost_usd: Some(0.25),
    }
}

fn bee_for<'a>(scene: &'a Scene, id: &str) -> &'a Bee {
    scene
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == id))
        .unwrap()
}

#[test]
fn worker_styles_are_stable_case_insensitive_and_have_distinct_sizes() {
    let cases = [
        ("luna-max", WorkerPalette::Golden),
        ("LUNA-MAX", WorkerPalette::Golden),
        ("ds-flash", WorkerPalette::Blue),
        ("DeepSeek-v4", WorkerPalette::Blue),
        ("max-hive", WorkerPalette::Green),
        ("remote-agent", WorkerPalette::Neutral),
    ];

    for (alias, palette) in cases {
        assert_eq!(style_for_worker(alias).palette, palette, "{alias}");
    }
    assert!(style_for_worker("max-hive").size_scale < style_for_worker("luna-max").size_scale);
    assert_eq!(style_for_worker("LUNA-MAX"), style_for_worker("luna-max"));
}

#[test]
fn elapsed_time_clamps_negative_values_and_keeps_minutes_after_an_hour() {
    let cases = [
        (0, "00:00"),
        (9_000, "00:09"),
        (61_000, "01:01"),
        (4_389_000, "73:09"),
        (-1, "00:00"),
    ];
    for (milliseconds, expected) in cases {
        assert_eq!(format_elapsed_ms(milliseconds), expected);
    }
}

#[test]
fn tooltip_uses_state_specific_timestamps_and_formats_missing_or_zero_cost() {
    let mut queued = job("queued", JobState::Queued);
    queued.created_at = Some(1_000);
    assert_eq!(tooltip_for(&queued, 10_000).elapsed, "00:09");
    queued.created_at = Some(20_000);
    assert_eq!(tooltip_for(&queued, 10_000).elapsed, "00:00");
    queued.created_at = Some(-1_000);
    assert_eq!(tooltip_for(&queued, 0).elapsed, "00:01");

    let mut running = job("running", JobState::Running);
    running.started_at = Some(1_000);
    assert_eq!(tooltip_for(&running, 10_000).elapsed, "00:09");
    running.started_at = None;
    assert_eq!(tooltip_for(&running, 10_000).elapsed, "00:09");
    running.created_at = None;
    assert_eq!(tooltip_for(&running, 10_000).elapsed, "00:00");

    let mut done = job("done", JobState::Done);
    done.started_at = Some(2_000);
    done.ended_at = Some(10_000);
    assert_eq!(tooltip_for(&done, 100_000).elapsed, "00:08");
    done.ended_at = None;
    assert_eq!(tooltip_for(&done, 100_000).elapsed, "00:00");

    done.cost_usd = None;
    assert_eq!(tooltip_for(&done, 100_000).cost, "pendiente");
    done.cost_usd = Some(0.0);
    assert_eq!(tooltip_for(&done, 100_000).cost, "0.0000");
}

#[test]
fn tooltip_keeps_sixty_multibyte_unicode_characters_without_splitting_them() {
    let task = "ñá界".repeat(20);
    let mut value = job("unicode", JobState::Running);
    value.task = Some(format!("{task}FIN"));

    let tooltip = tooltip_for(&value, 2_000);

    assert_eq!(tooltip.task.chars().count(), 60);
    assert_eq!(tooltip.task, task);
    assert!(tooltip.task.contains('á'));
}

#[test]
fn queued_bee_waits_near_the_hive_entrance() {
    let scene = reconcile(
        &Scene::default(),
        &[job("wait", JobState::Queued)],
        0,
        rect(),
    );
    let bee = bee_for(&scene, "wait");

    assert_eq!(bee.motion, Motion::Queued);
    assert!(bee.position.y > rect().height * 0.55);
}

#[test]
fn queued_to_running_keeps_the_job_identity_and_starts_flight() {
    let before = reconcile(
        &Scene::default(),
        &[job("same-id", JobState::Queued)],
        10,
        rect(),
    );
    let after = reconcile(&before, &[job("same-id", JobState::Running)], 20, rect());
    let matching: Vec<_> = after
        .bees
        .iter()
        .filter(|bee| bee.job.as_ref().is_some_and(|job| job.id == "same-id"))
        .collect();

    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0].motion, Motion::Flying);
    assert_eq!(matching[0].job.as_ref().unwrap().state, JobState::Running);
}

#[test]
fn done_transition_returns_the_bee_and_adds_a_glow_effect() {
    let before = reconcile(
        &Scene::default(),
        &[job("done", JobState::Running)],
        10,
        rect(),
    );
    let after = reconcile(&before, &[job("done", JobState::Done)], 100, rect());

    assert_eq!(bee_for(&after, "done").motion, Motion::Returning);
    assert!(
        after
            .effects
            .iter()
            .any(|effect| effect.kind == EffectKind::Glow)
    );
}

#[test]
fn failed_and_orphaned_transitions_fall_with_a_red_effect() {
    for terminal in [JobState::Failed, JobState::Orphaned] {
        let before = reconcile(
            &Scene::default(),
            &[job("fall", JobState::Running)],
            10,
            rect(),
        );
        let after = reconcile(&before, &[job("fall", terminal)], 100, rect());

        assert_eq!(bee_for(&after, "fall").motion, Motion::Falling);
        assert!(
            after
                .effects
                .iter()
                .any(|effect| effect.kind == EffectKind::RedFlash)
        );
    }
}

#[test]
fn cancelled_transition_returns_without_a_red_or_glow_effect() {
    let before = reconcile(
        &Scene::default(),
        &[job("cancel", JobState::Running)],
        10,
        rect(),
    );
    let after = reconcile(&before, &[job("cancel", JobState::Cancelled)], 100, rect());

    assert_eq!(bee_for(&after, "cancel").motion, Motion::Returning);
    assert!(after.effects.is_empty());
}

#[test]
fn terminal_jobs_in_the_initial_snapshot_do_not_replay_animations() {
    let scene = reconcile(
        &Scene::default(),
        &[job("old", JobState::Done)],
        10_000,
        rect(),
    );

    assert!(scene.effects.is_empty());
    assert!(
        !scene
            .bees
            .iter()
            .any(|bee| bee.job.as_ref().is_some_and(|job| job.id == "old"))
    );
    assert!(scene.bees.iter().any(|bee| bee.motion == Motion::Idle));
}

#[test]
fn missing_jobs_survive_two_polls_and_disappear_on_the_third() {
    let initial = reconcile(
        &Scene::default(),
        &[job("temporary", JobState::Running)],
        0,
        rect(),
    );
    let first = reconcile(&initial, &[], 1_000, rect());
    let second = reconcile(&first, &[], 2_000, rect());
    let third = reconcile(&second, &[], 3_000, rect());

    assert!(
        first
            .bees
            .iter()
            .any(|bee| bee.job.as_ref().is_some_and(|job| job.id == "temporary"))
    );
    assert!(
        second
            .bees
            .iter()
            .any(|bee| bee.job.as_ref().is_some_and(|job| job.id == "temporary"))
    );
    assert!(
        !third
            .bees
            .iter()
            .any(|bee| bee.job.as_ref().is_some_and(|job| job.id == "temporary"))
    );
}

#[test]
fn idle_bees_appear_when_no_jobs_or_exit_animations_remain() {
    let scene = reconcile(&Scene::default(), &[], 0, rect());

    assert!(scene.bees.len() >= 2);
    assert!(
        scene
            .bees
            .iter()
            .all(|bee| bee.motion == Motion::Idle && bee.job.is_none())
    );
}

#[test]
fn every_active_job_keeps_a_bee_even_for_large_snapshots() {
    let jobs: Vec<_> = (0..128)
        .map(|index| job(&format!("job-{index:03}"), JobState::Running))
        .collect();
    let scene = reconcile(&Scene::default(), &jobs, 10_000, rect());
    let represented = scene.bees.iter().filter(|bee| bee.job.is_some()).count();

    assert_eq!(represented, jobs.len());
    assert!(
        scene
            .bees
            .iter()
            .filter(|bee| bee.job.is_some())
            .all(|bee| bee.radius > 0.0)
    );
}

#[test]
fn equal_inputs_produce_equal_routes_and_flying_bees_move_deterministically() {
    let jobs = [job("moving", JobState::Running)];
    let first = reconcile(&Scene::default(), &jobs, 10, rect());
    let repeated = reconcile(&Scene::default(), &jobs, 10, rect());
    assert_eq!(first, repeated);

    let bee = bee_for(&first, "moving");
    assert_ne!(position_at(bee, 10), position_at(bee, 900));
    assert_eq!(position_at(bee, 900), position_at(bee, 900));
}

#[test]
fn hit_test_tie_breaking_is_deterministic_and_idle_is_ignored() {
    let mut scene = reconcile(
        &Scene::default(),
        &[
            job("alpha", JobState::Running),
            job("beta", JobState::Running),
        ],
        10,
        rect(),
    );
    let same_point = Point { x: 80.0, y: 70.0 };
    for bee in &mut scene.bees {
        bee.position = same_point;
        bee.route.clear();
    }
    let mut idle = reconcile(&Scene::default(), &[], 10, rect()).bees.remove(0);
    idle.position = same_point;
    idle.radius = 100.0;
    scene.bees.push(idle);

    let beta = scene
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == "beta"))
        .unwrap();
    assert_eq!(position_at(beta, 10_000), same_point);
    assert_eq!(hit_test_bee(&scene, same_point, 10_000).unwrap().id, "beta");
}

#[test]
fn menu_drag_and_tooltip_placement_keep_their_geometry_contracts() {
    let menu = Menu {
        bounds: Rect {
            x: 20.0,
            y: 30.0,
            width: 70.0,
            height: 50.0,
        },
        exit_button: Rect {
            x: 25.0,
            y: 60.0,
            width: 55.0,
            height: 16.0,
        },
    };
    assert_eq!(
        hit_test_menu(&menu, Point { x: 30.0, y: 65.0 }),
        MenuAction::Exit
    );
    assert_eq!(
        hit_test_menu(&menu, Point { x: 40.0, y: 40.0 }),
        MenuAction::Dismiss
    );
    assert_eq!(
        hit_test_menu(&menu, Point { x: 5.0, y: 5.0 }),
        MenuAction::Dismiss
    );

    assert_eq!(
        drag_position(
            Point { x: 100.0, y: 200.0 },
            Point { x: 10.0, y: 20.0 },
            Point { x: 35.0, y: 55.0 },
        ),
        Point { x: 125.0, y: 235.0 }
    );
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 60.0,
    };
    let placed = place_tooltip(
        Point { x: 95.0, y: 55.0 },
        Rect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 20.0,
        },
        bounds,
    );
    assert!(placed.x >= bounds.x && placed.y >= bounds.y);
    assert!(placed.x + 40.0 <= bounds.width && placed.y + 20.0 <= bounds.height);
}
