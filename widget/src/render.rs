use crate::art::{scenery_sprites, sprite_for_bee};
use crate::framebuffer::{Color, FrameBuffer};
use crate::position::Size;
use crate::scene::{EffectKind, Motion, Point, Rect, Scene, Tooltip, place_tooltip, position_at};

const CLEAR: Color = Color::rgba(0, 0, 0, 0);

pub fn render(
    scene: &Scene,
    now_ms: i64,
    width: u32,
    height: u32,
    tooltip: Option<(&Tooltip, Point)>,
) -> FrameBuffer {
    let mut frame = FrameBuffer::new(width, height);
    frame.clear(CLEAR);
    if width == 0 || height == 0 {
        return frame;
    }

    draw_meadow(&mut frame);
    draw_effects(&mut frame, scene, now_ms);
    draw_bees(&mut frame, scene, now_ms);
    if let Some(menu) = scene.menu {
        draw_menu(&mut frame, menu.bounds, menu.exit_button);
    }
    if let Some((tooltip, anchor)) = tooltip {
        draw_tooltip(&mut frame, tooltip, anchor);
    }
    frame
}

fn draw_meadow(frame: &mut FrameBuffer) {
    let width = frame.width as i32;
    let height = frame.height as i32;
    let ground_top = (height as f32 * 0.69).floor() as i32;
    let sprites = scenery_sprites();

    draw_sun(frame, width, height);
    draw_hills(frame, width, ground_top);
    frame.fill_rect(
        0,
        ground_top,
        frame.width,
        frame.height.saturating_sub(ground_top.max(0) as u32),
        Color::rgba(39, 111, 54, 255),
    );
    frame.fill_rect(
        0,
        ground_top + 7,
        frame.width,
        frame.height.saturating_sub((ground_top + 7).max(0) as u32),
        Color::rgba(30, 87, 47, 255),
    );

    draw_grass_blades(frame, ground_top);
    let grass = sprites[0];
    let mut tuft_x = -6;
    let mut tuft_index = 0;
    while tuft_x < width {
        let tuft_y = ground_top - 4 - tuft_index % 3;
        frame.draw_sprite(tuft_x, tuft_y, grass, 1);
        tuft_x += 18;
        tuft_index += 1;
    }

    let flower_step = (width / 6).max(20);
    for (index, x) in (flower_step / 2..width)
        .step_by(flower_step as usize)
        .enumerate()
    {
        let flower = if index % 2 == 0 {
            sprites[1]
        } else {
            sprites[2]
        };
        let bob = if index % 3 == 0 { 2 } else { 0 };
        frame.draw_sprite(
            x - (flower.width() as i32),
            ground_top - 16 - bob,
            flower,
            2,
        );
    }

    let mushroom = sprites[3];
    frame.draw_sprite(
        (width as f32 * 0.16) as i32,
        ground_top - mushroom.height() as i32 * 2,
        mushroom,
        2,
    );

    let hive = sprites[4];
    let hive_scale = 2;
    frame.draw_sprite(
        width / 2 - (hive.width() as i32 * hive_scale as i32) / 2,
        ground_top - hive.height() as i32 * hive_scale as i32,
        hive,
        hive_scale,
    );
}

fn draw_sun(frame: &mut FrameBuffer, width: i32, height: i32) {
    let sun_x = width - 42;
    let sun_y = (height as f32 * 0.14) as i32;
    frame.fill_rect(sun_x - 5, sun_y + 2, 22, 12, Color::rgba(248, 204, 95, 34));
    frame.fill_rect(sun_x, sun_y, 12, 16, Color::rgba(247, 210, 117, 180));
    frame.fill_rect(sun_x + 3, sun_y + 3, 6, 10, Color::rgba(255, 230, 159, 220));
}

fn draw_hills(frame: &mut FrameBuffer, width: i32, ground_top: i32) {
    let hill = Color::rgba(95, 149, 98, 76);
    let left_hill = [
        (width / 7, width / 4, ground_top - 27),
        (width / 10, width * 2 / 5, ground_top - 22),
        (0, width / 2, ground_top - 17),
        (0, width * 3 / 5, ground_top - 12),
    ];
    let right_hill = [
        (width * 3 / 4, width / 4, ground_top - 23),
        (width * 2 / 3, width / 3, ground_top - 18),
        (width * 3 / 5, width * 2 / 5, ground_top - 13),
        (width / 2, width / 2, ground_top - 8),
    ];
    for (x, band_width, y) in left_hill.into_iter().chain(right_hill) {
        frame.fill_rect(x, y, band_width.max(0) as u32, 5, hill);
    }
}

fn draw_grass_blades(frame: &mut FrameBuffer, ground_top: i32) {
    let shades = [
        Color::rgba(118, 190, 72, 255),
        Color::rgba(73, 157, 65, 255),
        Color::rgba(170, 202, 77, 255),
        Color::rgba(45, 129, 60, 255),
    ];
    let mut x = 0;
    while x < frame.width as i32 {
        let index = (x as usize / 5) % shades.len();
        let rise = (x as usize / 5 % 4) as i32;
        frame.draw_pixel(x, ground_top - rise, shades[index]);
        frame.draw_pixel(
            x + 1,
            ground_top - rise + 2,
            shades[(index + 1) % shades.len()],
        );
        if x % 3 == 0 {
            frame.draw_pixel(x + 3, ground_top + 2, shades[(index + 2) % shades.len()]);
        }
        x += 5;
    }
}

fn draw_bees(frame: &mut FrameBuffer, scene: &Scene, now_ms: i64) {
    for bee in &scene.bees {
        let wing_frame = ((now_ms.max(0) / 160) as u8).wrapping_add(bee.phase) % 2;
        let (sprite, scale) = sprite_for_bee(bee, wing_frame);
        let position = position_at(bee, now_ms);
        let x = position.x.round() as i32 - (sprite.width() as i32 * scale as i32) / 2;
        let y = position.y.round() as i32 - (sprite.height() as i32 * scale as i32) / 2;
        frame.draw_sprite(x, y, sprite, scale);
        if bee.motion == Motion::Idle {
            frame.draw_bitmap_text(x + 3, y - 8, "ZZ", 1, Color::rgba(231, 240, 197, 230));
        }
    }
}

fn draw_effects(frame: &mut FrameBuffer, scene: &Scene, now_ms: i64) {
    for effect in &scene.effects {
        let age = now_ms.saturating_sub(effect.started_at_ms).max(0);
        let alpha = (180_i64 - age * 180 / 900).clamp(0, 180) as u8;
        if alpha == 0 {
            continue;
        }
        let color = match effect.kind {
            EffectKind::Glow => Color::rgba(255, 223, 104, alpha),
            EffectKind::RedFlash => Color::rgba(241, 52, 56, alpha),
        };
        let x = effect.position.x.round() as i32;
        let y = effect.position.y.round() as i32;
        frame.fill_rect(x - 7, y - 7, 15, 2, color);
        frame.fill_rect(x - 7, y + 6, 15, 2, color);
        frame.fill_rect(x - 7, y - 5, 2, 11, color);
        frame.fill_rect(x + 6, y - 5, 2, 11, color);
    }
}

fn draw_menu(frame: &mut FrameBuffer, bounds: Rect, exit_button: Rect) {
    let x = bounds.x.floor() as i32;
    let y = bounds.y.floor() as i32;
    let width = bounds.width.max(0.0).ceil() as u32;
    let height = bounds.height.max(0.0).ceil() as u32;
    frame.fill_rect(x, y, width, height, Color::rgba(32, 39, 29, 246));
    frame.fill_rect(x, y, width, 2, Color::rgba(238, 199, 105, 255));
    frame.fill_rect(
        x,
        y + height as i32 - 2,
        width,
        2,
        Color::rgba(238, 199, 105, 255),
    );
    frame.fill_rect(x, y, 2, height, Color::rgba(238, 199, 105, 255));
    frame.fill_rect(
        x + width as i32 - 2,
        y,
        2,
        height,
        Color::rgba(238, 199, 105, 255),
    );
    let button_x = exit_button.x.round() as i32;
    let button_y = exit_button.y.round() as i32;
    frame.fill_rect(
        button_x,
        button_y,
        exit_button.width.max(0.0).ceil() as u32,
        exit_button.height.max(0.0).ceil() as u32,
        Color::rgba(147, 52, 44, 255),
    );
    frame.draw_bitmap_text(
        button_x + 5,
        button_y + 4,
        "SALIR",
        1,
        Color::rgba(255, 238, 197, 255),
    );
}

fn draw_tooltip(frame: &mut FrameBuffer, tooltip: &Tooltip, anchor: Point) {
    let scale = 1;
    let max_chars = (frame.width / 6).saturating_sub(2).max(1) as usize;
    let lines = tooltip_lines(tooltip, max_chars);
    let longest = lines
        .iter()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0) as u32;
    let padding = 12_u32.min(frame.width.saturating_sub(1));
    let width = longest
        .saturating_mul(6 * scale)
        .saturating_add(padding)
        .max(1)
        .min(frame.width);
    let height = (lines.len() as u32)
        .saturating_mul(9 * scale)
        .saturating_add(8)
        .max(1)
        .min(frame.height);
    let size = Size { width, height };
    let origin = place_tooltip(
        anchor,
        Rect {
            x: 0.0,
            y: 0.0,
            width: size.width as f32,
            height: size.height as f32,
        },
        Rect {
            x: 0.0,
            y: 0.0,
            width: frame.width as f32,
            height: frame.height as f32,
        },
    );
    let x = origin.x.floor() as i32;
    let y = origin.y.floor() as i32;
    frame.fill_rect(x, y, size.width, size.height, Color::rgba(24, 35, 29, 238));
    frame.fill_rect(x, y, size.width, 2, Color::rgba(236, 193, 93, 255));
    frame.fill_rect(
        x,
        y + size.height as i32 - 2,
        size.width,
        2,
        Color::rgba(236, 193, 93, 255),
    );
    frame.fill_rect(x, y, 2, size.height, Color::rgba(236, 193, 93, 255));
    frame.fill_rect(
        x + size.width as i32 - 2,
        y,
        2,
        size.height,
        Color::rgba(236, 193, 93, 255),
    );

    for (index, line) in lines.iter().enumerate() {
        let color = if index == 0 {
            Color::rgba(255, 220, 131, 255)
        } else {
            Color::rgba(238, 241, 212, 255)
        };
        frame.draw_bitmap_text(x + 6, y + 4 + index as i32 * 9, line, scale, color);
    }
}

fn tooltip_lines(tooltip: &Tooltip, max_task_chars: usize) -> Vec<String> {
    let max_chars = max_task_chars.max(1);
    let mut lines = Vec::new();
    let cost = if tooltip.cost == "pendiente" {
        tooltip.cost.clone()
    } else {
        format!("${}", tooltip.cost)
    };
    for value in [
        &tooltip.worker,
        &tooltip.kind,
        &tooltip.task,
        &tooltip.elapsed,
        &cost,
    ] {
        let characters: Vec<_> = value.chars().collect();
        if characters.is_empty() {
            lines.push(String::new());
        } else {
            lines.extend(
                characters
                    .chunks(max_chars)
                    .map(|chunk| chunk.iter().collect()),
            );
        }
    }
    lines
}
