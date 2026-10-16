use colmena_widget::art::{
    BeeArtState, Sprite, bee_sprite, scenery_sprites, sprite_for_bee, tooltip_size,
};
use colmena_widget::framebuffer::{Color, FrameBuffer, pack_bgra_premultiplied};
use colmena_widget::jobs::{Job, JobState};
use colmena_widget::render::render;
use colmena_widget::scene::{Point, Rect, Scene, WorkerPalette, place_tooltip, reconcile};

fn assert_sprite_is_complete(sprite: Sprite) {
    assert!(sprite.width() > 0);
    assert!(sprite.height() > 0);
    assert!(sprite.is_rectangular());
    for symbol in sprite.rows.iter().flat_map(|row| row.chars()) {
        assert!(
            sprite.color_for(symbol).is_some(),
            "sin color para {symbol:?}"
        );
    }
}

fn job(id: &str, state: JobState, worker: &str, task: &str) -> Job {
    Job {
        id: id.to_owned(),
        state,
        kind: Some("run".to_owned()),
        task: Some(task.to_owned()),
        worker: Some(worker.to_owned()),
        provider: None,
        branch: None,
        created_at: Some(1_000),
        started_at: Some(2_000),
        ended_at: None,
        cost_usd: Some(0.0),
    }
}

#[test]
fn every_scenery_and_bee_sprite_is_rectangular_and_covers_its_symbols() {
    let scenery = scenery_sprites();
    for sprite in scenery {
        assert_sprite_is_complete(sprite);
    }
    assert!(scenery[0].rows.iter().any(|row| row.contains('g')));
    assert!(scenery[0].rows.iter().any(|row| row.contains('G')));
    assert!(scenery[1].rows.iter().any(|row| row.contains('p')));
    assert!(scenery[3].rows.iter().any(|row| row.contains('w')));
    assert!(scenery[4].rows.iter().any(|row| row.contains('b')));
    for palette in [
        WorkerPalette::Golden,
        WorkerPalette::Blue,
        WorkerPalette::Green,
        WorkerPalette::Neutral,
    ] {
        for state in [
            BeeArtState::Idle,
            BeeArtState::Queued,
            BeeArtState::Flying,
            BeeArtState::Returning,
            BeeArtState::Done,
            BeeArtState::Failed,
        ] {
            assert_sprite_is_complete(bee_sprite(palette, state, 0));
        }
    }
}

#[test]
fn scene_states_and_worker_aliases_select_the_matching_sprite_and_scale() {
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: 320.0,
        height: 180.0,
    };
    let active = [
        job("gold", JobState::Running, "luna-max", "task"),
        job("blue", JobState::Running, "ds-flash", "task"),
        job("green", JobState::Queued, "max-hive", "task"),
    ];
    let scene = reconcile(&Scene::default(), &active, 100, bounds);
    let style_by_id = ["gold", "blue", "green"].map(|id| {
        let bee = scene
            .bees
            .iter()
            .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == id))
            .unwrap();
        sprite_for_bee(bee, 0)
    });
    assert_eq!(style_by_id[0].1, 3);
    assert_eq!(style_by_id[1].1, 3);
    assert_eq!(style_by_id[2].1, 1);
    assert_ne!(
        style_by_id[0].0.color_for('m'),
        style_by_id[1].0.color_for('m')
    );
    assert_ne!(
        style_by_id[1].0.color_for('m'),
        style_by_id[2].0.color_for('m')
    );
    let neutral_scene = reconcile(
        &Scene::default(),
        &[job("neutral", JobState::Running, "unknown-worker", "task")],
        100,
        bounds,
    );
    let neutral_bee = neutral_scene
        .bees
        .iter()
        .find(|bee| bee.job.is_some())
        .unwrap();
    assert_eq!(sprite_for_bee(neutral_bee, 0).1, 2);

    let done_scene = reconcile(
        &scene,
        &[job("gold", JobState::Done, "luna-max", "task")],
        200,
        bounds,
    );
    let done = done_scene
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == "gold"))
        .unwrap();
    assert_eq!(
        sprite_for_bee(done, 0).0.rows,
        bee_sprite(WorkerPalette::Golden, BeeArtState::Done, 0).rows
    );

    let failed_scene = reconcile(
        &scene,
        &[job("blue", JobState::Failed, "ds-flash", "task")],
        200,
        bounds,
    );
    let failed = failed_scene
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == "blue"))
        .unwrap();
    assert_eq!(
        sprite_for_bee(failed, 0).0.rows,
        bee_sprite(WorkerPalette::Blue, BeeArtState::Failed, 0).rows
    );

    let cancelled_scene = reconcile(
        &scene,
        &[job("gold", JobState::Cancelled, "luna-max", "task")],
        200,
        bounds,
    );
    let cancelled = cancelled_scene
        .bees
        .iter()
        .find(|bee| bee.job.as_ref().is_some_and(|job| job.id == "gold"))
        .unwrap();
    assert_eq!(
        sprite_for_bee(cancelled, 0).0.color_for('m'),
        bee_sprite(WorkerPalette::Neutral, BeeArtState::Returning, 0).color_for('m')
    );
}

#[test]
fn workers_use_their_own_palettes_and_wings_have_two_distinct_frames() {
    let gold = bee_sprite(WorkerPalette::Golden, BeeArtState::Flying, 0);
    let blue = bee_sprite(WorkerPalette::Blue, BeeArtState::Flying, 0);
    let green = bee_sprite(WorkerPalette::Green, BeeArtState::Flying, 0);
    let neutral = bee_sprite(WorkerPalette::Neutral, BeeArtState::Flying, 0);

    let worker_colors = [
        gold.color_for('m').unwrap(),
        blue.color_for('m').unwrap(),
        green.color_for('m').unwrap(),
        neutral.color_for('m').unwrap(),
    ];
    assert!(worker_colors.windows(2).all(|pair| pair[0] != pair[1]));
    assert_ne!(
        bee_sprite(WorkerPalette::Golden, BeeArtState::Flying, 0).rows,
        bee_sprite(WorkerPalette::Golden, BeeArtState::Flying, 1).rows
    );
    assert_ne!(
        bee_sprite(WorkerPalette::Golden, BeeArtState::Idle, 0).rows,
        bee_sprite(WorkerPalette::Golden, BeeArtState::Queued, 0).rows
    );
    assert_ne!(
        bee_sprite(WorkerPalette::Golden, BeeArtState::Failed, 0).rows,
        bee_sprite(WorkerPalette::Golden, BeeArtState::Done, 0).rows
    );
}

#[test]
fn framebuffer_has_known_dimensions_clips_and_scales_sprites_by_integers() {
    let mut frame = FrameBuffer::new(5, 4);
    assert_eq!(frame.width, 5);
    assert_eq!(frame.height, 4);
    assert_eq!(frame.pixels.len(), 20);

    let red = Color::rgba(255, 0, 0, 255);
    let green = Color::rgba(0, 255, 0, 255);
    let rows = ["xy", "yx"];
    let colors = [('x', red), ('y', green)];
    let sprite = Sprite::new(&rows, &colors);
    frame.draw_sprite(1, 1, sprite, 2);

    assert_eq!(frame.pixel(1, 1), Some(pack_bgra_premultiplied(red)));
    assert_eq!(frame.pixel(2, 2), Some(pack_bgra_premultiplied(red)));
    assert_eq!(frame.pixel(3, 1), Some(pack_bgra_premultiplied(green)));

    frame.clear(Color::rgba(10, 20, 30, 255));
    frame.draw_pixel(-1, 0, red);
    frame.fill_rect(-1, 1, 3, 2, green);
    assert_eq!(
        frame.pixel(0, 0),
        Some(pack_bgra_premultiplied(Color::rgba(10, 20, 30, 255)))
    );
    assert_eq!(frame.pixel(0, 1), Some(pack_bgra_premultiplied(green)));
    assert_eq!(frame.pixel(1, 2), Some(pack_bgra_premultiplied(green)));
    assert_eq!(
        frame.pixel(2, 1),
        Some(pack_bgra_premultiplied(Color::rgba(10, 20, 30, 255)))
    );
}

#[test]
fn transparent_pixels_are_noops_and_alpha_is_composited_in_premultiplied_bgra() {
    let transparent = Color::rgba(1, 200, 30, 0);
    assert_eq!(
        pack_bgra_premultiplied(Color::rgba(200, 100, 50, 128)),
        0x8064_3219
    );

    let mut frame = FrameBuffer::new(1, 1);
    frame.draw_pixel(0, 0, transparent);
    assert_eq!(frame.pixel(0, 0), Some(0));
    frame.draw_pixel(0, 0, Color::rgba(255, 0, 0, 128));
    frame.draw_pixel(0, 0, transparent);
    frame.draw_pixel(0, 0, Color::rgba(0, 0, 255, 128));

    assert_eq!(frame.pixel(0, 0), Some(0xC040_0080));
}

#[test]
fn bitmap_font_draws_ascii_cost_accents_and_a_stable_replacement_glyph() {
    let mut text_frame = FrameBuffer::new(240, 12);
    let text = "LUNA Ñandú $0.0000";
    let size = text_frame.draw_bitmap_text(0, 0, text, 1, Color::rgba(255, 255, 255, 255));
    assert_eq!(size.width, text.chars().count() as u32 * 6);
    assert_eq!(size.height, 7);
    assert!(text_frame.pixels.iter().any(|pixel| *pixel != 0));

    let mut unknown = FrameBuffer::new(12, 8);
    let mut replacement = FrameBuffer::new(12, 8);
    let white = Color::rgba(255, 255, 255, 255);
    unknown.draw_bitmap_text(0, 0, "🦊", 1, white);
    replacement.draw_bitmap_text(0, 0, "�", 1, white);
    assert_eq!(unknown.pixels, replacement.pixels);

    let mut lowercase = FrameBuffer::new(48, 8);
    let mut uppercase = FrameBuffer::new(48, 8);
    lowercase.draw_bitmap_text(0, 0, "áéíóúñü", 1, white);
    uppercase.draw_bitmap_text(0, 0, "ÁÉÍÓÚÑÜ", 1, white);
    assert_eq!(lowercase.pixels, uppercase.pixels);
}

#[test]
fn tooltip_width_and_scene_composition_stay_within_bounds_and_repeat_exactly() {
    let tooltip = colmena_widget::scene::Tooltip {
        worker: "luna-max".to_owned(),
        kind: "run".to_owned(),
        task: "ñá界".repeat(20),
        elapsed: "73:09".to_owned(),
        cost: "0.0000".to_owned(),
    };
    let size = tooltip_size(&tooltip, 1);
    assert!(size.width >= 60 * 6 + 12);
    assert!(size.height >= 5 * 9 + 8);

    let scene = reconcile(
        &Scene::default(),
        &[job(
            "bee",
            JobState::Running,
            "luna-max",
            "surcar el pastizal",
        )],
        2_500,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 256.0,
            height: 160.0,
        },
    );
    let frame_a = render(
        &scene,
        2_500,
        256,
        160,
        Some((&tooltip, Point { x: 250.0, y: 155.0 })),
    );
    let frame_b = render(
        &scene,
        2_500,
        256,
        160,
        Some((&tooltip, Point { x: 250.0, y: 155.0 })),
    );

    assert_eq!(frame_a, frame_b);
    assert_eq!(frame_a.pixels.len(), 256 * 160);
    assert!(frame_a.pixels.iter().any(|pixel| *pixel != 0));
    assert!(frame_a.pixels.contains(&0));

    let placed = place_tooltip(
        Point { x: 250.0, y: 155.0 },
        Rect {
            x: 0.0,
            y: 0.0,
            width: 240.0,
            height: 57.0,
        },
        Rect {
            x: 0.0,
            y: 0.0,
            width: 256.0,
            height: 160.0,
        },
    );
    assert!(placed.x >= 0.0 && placed.y >= 0.0);
    assert!(placed.x + 240.0 <= 256.0 && placed.y + 57.0 <= 160.0);
}
