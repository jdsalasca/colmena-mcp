use crate::art::{PIXEL_SCALE, scenery_sprites, sprite_for_bee};
use crate::framebuffer::{Color, FrameBuffer};
use crate::position::Size;
use crate::scene::{
    Bee, EffectKind, Motion, Point, Rect, Scene, Tooltip, place_tooltip, position_at,
};

const CLEAR: Color = Color::rgba(0, 0, 0, 0);
const MAX_VISIBLE_BEES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeeRenderLayout<'a> {
    pub visible: &'a [Bee],
    pub overflow: usize,
}

pub fn bee_layout(bees: &[Bee]) -> BeeRenderLayout<'_> {
    let visible_count = bees.len().min(MAX_VISIBLE_BEES);
    BeeRenderLayout {
        visible: &bees[..visible_count],
        overflow: bees.len() - visible_count,
    }
}

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

    draw_meadow(&mut frame, now_ms);
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

fn draw_meadow(frame: &mut FrameBuffer, now_ms: i64) {
    let width = frame.width as i32;
    let height = frame.height as i32;
    let ground_top = align(width_height_percent(height, 69));
    let sprites = scenery_sprites();

    draw_sun(frame, width, height);
    draw_clouds(frame, &sprites[5], now_ms);
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
        ground_top + PIXEL_SCALE as i32 * 4,
        frame.width,
        frame
            .height
            .saturating_sub((ground_top + PIXEL_SCALE as i32 * 4).max(0) as u32),
        Color::rgba(30, 87, 47, 255),
    );
    draw_grass_layer(frame, ground_top - 2, now_ms, 0);

    let flower_step = (width / 7).max(54);
    for (index, x) in (flower_step / 2..width)
        .step_by(flower_step as usize)
        .enumerate()
    {
        let flower = if index % 2 == 0 {
            sprites[1]
        } else {
            sprites[2]
        };
        let sway = ((now_ms / 520 + index as i64).rem_euclid(3) - 1) as i32 * 2;
        let x_sway = ((now_ms / 760 + index as i64).rem_euclid(3) - 1) as i32 * 2;
        let y = ground_top - (flower.height() as i32 * PIXEL_SCALE as i32) + sway;
        frame.draw_sprite(align(x - 8 + x_sway), align(y), flower, PIXEL_SCALE);
    }

    let mushroom = sprites[3];
    frame.draw_sprite(
        align(width / 10),
        ground_top - mushroom.height() as i32 * PIXEL_SCALE as i32,
        mushroom,
        PIXEL_SCALE,
    );

    let hive = sprites[4];
    let hive_scale = PIXEL_SCALE;
    frame.draw_sprite(
        width / 2 - (hive.width() as i32 * hive_scale as i32) / 2,
        ground_top - hive.height() as i32 * hive_scale as i32,
        hive,
        hive_scale,
    );

    draw_butterfly(frame, &sprites[6], now_ms, ground_top);
    draw_grass_layer(frame, ground_top + 6, now_ms, 1);
    draw_grass_layer(frame, ground_top + 18, now_ms, 2);
}

fn draw_sun(frame: &mut FrameBuffer, width: i32, height: i32) {
    let scale = PIXEL_SCALE as i32;
    let sun_x = align(width - 62);
    let sun_y = align(height / 8);
    frame.fill_rect(
        sun_x - 6 * scale,
        sun_y + scale,
        30 * PIXEL_SCALE,
        22 * PIXEL_SCALE,
        Color::rgba(248, 204, 95, 34),
    );
    frame.fill_rect(
        sun_x,
        sun_y,
        18 * PIXEL_SCALE,
        24 * PIXEL_SCALE,
        Color::rgba(247, 210, 117, 190),
    );
    frame.fill_rect(
        sun_x + 4 * scale,
        sun_y + 4 * scale,
        10 * PIXEL_SCALE,
        16 * PIXEL_SCALE,
        Color::rgba(255, 230, 159, 220),
    );
}

fn draw_clouds(frame: &mut FrameBuffer, cloud: &crate::art::Sprite<'_>, now_ms: i64) {
    let scale = PIXEL_SCALE as i32;
    let cloud_width = cloud.width() as i32 * scale;
    let span = frame.width as i32 + cloud_width;
    let drift = (now_ms / 110).rem_euclid(i64::from(span.max(1))) as i32;
    for (index, start) in [frame.width as i32 / 5, frame.width as i32 * 3 / 5]
        .into_iter()
        .enumerate()
    {
        let offset = drift / (index as i32 + 1);
        let x = (start - offset + cloud_width).rem_euclid(span) - cloud_width;
        let y = align(24 + index as i32 * 28);
        frame.draw_sprite(x, y, *cloud, PIXEL_SCALE);
    }
}

fn draw_hills(frame: &mut FrameBuffer, width: i32, ground_top: i32) {
    let scale = PIXEL_SCALE as i32;
    let hill = Color::rgba(95, 149, 98, 76);
    let left_hill = [
        (width / 7, width / 4, ground_top - 30 * scale),
        (width / 10, width * 2 / 5, ground_top - 24 * scale),
        (0, width / 2, ground_top - 18 * scale),
    ];
    let right_hill = [
        (width * 3 / 4, width / 4, ground_top - 27 * scale),
        (width * 2 / 3, width / 3, ground_top - 21 * scale),
        (width * 3 / 5, width * 2 / 5, ground_top - 15 * scale),
    ];
    for (x, band_width, y) in left_hill.into_iter().chain(right_hill) {
        frame.fill_rect(
            align(x),
            align(y),
            band_width.max(0) as u32,
            5 * PIXEL_SCALE,
            hill,
        );
    }
}

fn draw_grass_layer(frame: &mut FrameBuffer, baseline: i32, now_ms: i64, layer: usize) {
    let scale = PIXEL_SCALE as i32;
    let shades = [
        Color::rgba(118, 190, 72, 255),
        Color::rgba(73, 157, 65, 255),
        Color::rgba(170, 202, 77, 255),
        Color::rgba(45, 129, 60, 255),
    ];
    let mut x = 0;
    let stride = 10 * scale;
    while x < frame.width as i32 {
        let index = (x as usize / stride as usize + layer) % shades.len();
        let sway = if ((now_ms / 600 + (x / stride) as i64 + layer as i64) % 2) == 0 {
            -scale
        } else {
            scale
        };
        let rise = (2 + (index % 4) as i32 * 2) * scale;
        frame.fill_rect(
            align(x + sway),
            baseline - rise,
            scale as u32,
            rise as u32,
            shades[index],
        );
        frame.fill_rect(
            align(x - scale + sway),
            baseline - rise + 2 * scale,
            scale as u32,
            scale as u32,
            shades[(index + 1) % shades.len()],
        );
        x += stride;
    }
}

fn draw_butterfly(
    frame: &mut FrameBuffer,
    butterfly: &crate::art::Sprite<'_>,
    now_ms: i64,
    ground_top: i32,
) {
    if !butterfly_visible_at(now_ms) {
        return;
    }
    let scale = PIXEL_SCALE as i32;
    let width = butterfly.width() as i32 * scale;
    let span = frame.width as i32 + width;
    let x = ((now_ms / 42).rem_euclid(i64::from(span.max(1))) as i32) - width;
    let bob = (now_ms / 310).rem_euclid(3) as i32 * scale;
    frame.draw_sprite(x, ground_top - 36 * scale + bob, *butterfly, PIXEL_SCALE);
}

fn draw_bees(frame: &mut FrameBuffer, scene: &Scene, now_ms: i64) {
    let layout = bee_layout(&scene.bees);
    let ground_top = align(width_height_percent(frame.height as i32, 69));
    for bee in layout.visible {
        let wing_frame = ((now_ms.max(0) / 130) as u8).wrapping_add(bee.phase) % 3;
        let (sprite, worker_scale) = sprite_for_bee(bee, wing_frame);
        let scale = worker_scale.max(PIXEL_SCALE);
        let position = position_at(bee, now_ms);
        let sprite_width = sprite.width() as i32 * scale as i32;
        let sprite_height = sprite.height() as i32 * scale as i32;
        let x = align(position.x.round() as i32 - sprite_width / 2);
        let y = align(position.y.round() as i32 - sprite_height / 2);
        draw_bee_shadow(frame, position.x.round() as i32, ground_top + 8);
        if bee.motion == Motion::Flying {
            draw_flight_trail(frame, bee, now_ms, sprite, scale);
        }
        frame.draw_sprite(x, y, sprite, scale);

        match bee.motion {
            Motion::Idle => {
                frame.draw_bitmap_text(
                    x + sprite_width / 2 - 7 * PIXEL_SCALE as i32,
                    y - 12 * PIXEL_SCALE as i32,
                    "Zz",
                    PIXEL_SCALE,
                    Color::rgba(231, 240, 197, 230),
                );
            }
            Motion::Queued => draw_queued_bubble(frame, x, y, sprite_width),
            Motion::Returning
                if bee
                    .job
                    .as_ref()
                    .is_some_and(|job| job.state == crate::jobs::JobState::Done) =>
            {
                draw_sparkles(frame, x + sprite_width / 2, y, sprite.color_for('g'));
            }
            Motion::Flying | Motion::Returning | Motion::Falling => {}
        }
    }
    if layout.overflow > 0 {
        draw_overflow_badge(frame, layout.overflow);
    }
}

fn draw_bee_shadow(frame: &mut FrameBuffer, center_x: i32, baseline: i32) {
    let scale = PIXEL_SCALE;
    let x = center_x - (12 * scale as i32) / 2;
    let y = align(baseline);
    let color = Color::rgba(15, 47, 30, 86);
    frame.fill_rect(x + 2 * scale as i32, y, 8 * scale, scale, color);
    frame.fill_rect(x, y + scale as i32, 12 * scale, scale, color);
}

fn draw_flight_trail(
    frame: &mut FrameBuffer,
    bee: &Bee,
    now_ms: i64,
    sprite: crate::art::Sprite<'_>,
    scale: u32,
) {
    let color = sprite
        .color_for('g')
        .unwrap_or(Color::rgba(255, 239, 153, 210));
    for (index, age) in [250, 500, 750].into_iter().enumerate() {
        let point = position_at(bee, now_ms.saturating_sub(age));
        let alpha = [132, 92, 55][index];
        frame.fill_rect(
            align(point.x.round() as i32 - scale as i32),
            align(point.y.round() as i32 - scale as i32),
            scale * 2,
            scale * 2,
            Color::rgba(color.r, color.g, color.b, alpha),
        );
    }
}

fn draw_queued_bubble(frame: &mut FrameBuffer, x: i32, y: i32, bee_width: i32) {
    let scale = PIXEL_SCALE as i32;
    let bubble_x = x + bee_width - 2 * scale;
    let bubble_y = y - 12 * scale;
    frame.fill_rect(
        bubble_x,
        bubble_y,
        14 * PIXEL_SCALE,
        10 * PIXEL_SCALE,
        Color::rgba(250, 244, 217, 238),
    );
    frame.fill_rect(
        bubble_x + 2 * scale,
        bubble_y + 2 * scale,
        10 * PIXEL_SCALE,
        6 * PIXEL_SCALE,
        Color::rgba(35, 54, 39, 255),
    );
    for dot in 0..3 {
        frame.fill_rect(
            bubble_x + (4 + dot * 3) * scale,
            bubble_y + 4 * scale,
            scale as u32,
            scale as u32,
            Color::rgba(255, 226, 132, 255),
        );
    }
}

fn draw_sparkles(frame: &mut FrameBuffer, center_x: i32, y: i32, color: Option<Color>) {
    let color = color.unwrap_or(Color::rgba(255, 231, 129, 230));
    let scale = PIXEL_SCALE as i32;
    for (x, y) in [
        (center_x - 12 * scale, y - 4 * scale),
        (center_x + 11 * scale, y + 4 * scale),
    ] {
        frame.fill_rect(x, y + scale, scale as u32, 3 * scale as u32, color);
        frame.fill_rect(
            x - scale,
            y + 2 * scale,
            3 * scale as u32,
            scale as u32,
            color,
        );
    }
}

fn draw_overflow_badge(frame: &mut FrameBuffer, overflow: usize) {
    let label = format!("+{overflow}");
    let scale = PIXEL_SCALE;
    let width = label.chars().count() as u32 * 6 * scale + 12 * scale;
    let height = 12 * scale;
    let x = frame.width.saturating_sub(width + 8 * scale) as i32;
    let y = 8 * scale as i32;
    frame.fill_rect(x, y, width, height, Color::rgba(27, 41, 30, 236));
    frame.fill_rect(x, y, width, scale, Color::rgba(245, 205, 110, 255));
    frame.draw_bitmap_text(
        x + 6 * scale as i32,
        y + 2 * scale as i32,
        &label,
        scale,
        Color::rgba(255, 240, 192, 255),
    );
}

fn draw_effects(frame: &mut FrameBuffer, scene: &Scene, now_ms: i64) {
    let scale = PIXEL_SCALE as i32;
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
        let x = align(effect.position.x.round() as i32);
        let y = align(effect.position.y.round() as i32);
        frame.fill_rect(
            x - 7 * scale,
            y - 7 * scale,
            15 * PIXEL_SCALE,
            2 * PIXEL_SCALE,
            color,
        );
        frame.fill_rect(
            x - 7 * scale,
            y + 6 * scale,
            15 * PIXEL_SCALE,
            2 * PIXEL_SCALE,
            color,
        );
        frame.fill_rect(
            x - 7 * scale,
            y - 5 * scale,
            2 * PIXEL_SCALE,
            11 * PIXEL_SCALE,
            color,
        );
        frame.fill_rect(
            x + 6 * scale,
            y - 5 * scale,
            2 * PIXEL_SCALE,
            11 * PIXEL_SCALE,
            color,
        );
    }
}

fn draw_menu(frame: &mut FrameBuffer, bounds: Rect, exit_button: Rect) {
    let x = align(bounds.x.floor() as i32);
    let y = align(bounds.y.floor() as i32);
    let width = bounds.width.max(0.0).ceil() as u32;
    let height = bounds.height.max(0.0).ceil() as u32;
    let scale = PIXEL_SCALE;
    frame.fill_rect(x, y, width, height, Color::rgba(32, 39, 29, 246));
    frame.fill_rect(x, y, width, scale, Color::rgba(238, 199, 105, 255));
    frame.fill_rect(
        x,
        y + height as i32 - scale as i32,
        width,
        scale,
        Color::rgba(238, 199, 105, 255),
    );
    frame.fill_rect(x, y, scale, height, Color::rgba(238, 199, 105, 255));
    frame.fill_rect(
        x + width as i32 - scale as i32,
        y,
        scale,
        height,
        Color::rgba(238, 199, 105, 255),
    );
    let button_x = align(exit_button.x.round() as i32);
    let button_y = align(exit_button.y.round() as i32);
    frame.fill_rect(
        button_x,
        button_y,
        exit_button.width.max(0.0).ceil() as u32,
        exit_button.height.max(0.0).ceil() as u32,
        Color::rgba(147, 52, 44, 255),
    );
    frame.draw_bitmap_text(
        button_x + 5 * scale as i32,
        button_y + 4 * scale as i32,
        "SALIR",
        scale,
        Color::rgba(255, 238, 197, 255),
    );
}

fn draw_tooltip(frame: &mut FrameBuffer, tooltip: &Tooltip, anchor: Point) {
    let scale = PIXEL_SCALE;
    let max_chars = (frame.width / (6 * scale)).saturating_sub(2).max(1) as usize;
    let lines = tooltip_lines(tooltip, max_chars);
    let longest = lines
        .iter()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0) as u32;
    let padding = (12 * scale).min(frame.width.saturating_sub(1));
    let width = longest
        .saturating_mul(6 * scale)
        .saturating_add(padding)
        .max(1)
        .min(frame.width);
    let height = (lines.len() as u32)
        .saturating_mul(9 * scale)
        .saturating_add(8 * scale)
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
    let x = align(origin.x.floor() as i32);
    let y = align(origin.y.floor() as i32);
    frame.fill_rect(x, y, size.width, size.height, Color::rgba(24, 35, 29, 244));
    frame.fill_rect(x, y, size.width, scale, Color::rgba(236, 193, 93, 255));
    frame.fill_rect(
        x,
        y + size.height as i32 - scale as i32,
        size.width,
        scale,
        Color::rgba(236, 193, 93, 255),
    );
    frame.fill_rect(x, y, scale, size.height, Color::rgba(236, 193, 93, 255));
    frame.fill_rect(
        x + size.width as i32 - scale as i32,
        y,
        scale,
        size.height,
        Color::rgba(236, 193, 93, 255),
    );

    for (index, line) in lines.iter().enumerate() {
        let color = if index == 0 {
            Color::rgba(255, 220, 131, 255)
        } else {
            Color::rgba(238, 241, 212, 255)
        };
        frame.draw_bitmap_text(
            x + 6 * scale as i32,
            y + 4 * scale as i32 + index as i32 * 9 * scale as i32,
            line,
            scale,
            color,
        );
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

fn width_height_percent(value: i32, percent: i32) -> i32 {
    value.saturating_mul(percent) / 100
}

fn align(value: i32) -> i32 {
    let scale = PIXEL_SCALE as i32;
    value.div_euclid(scale) * scale
}

fn butterfly_visible_at(now_ms: i64) -> bool {
    (8_000..12_000).contains(&now_ms.rem_euclid(30_000))
}

#[cfg(test)]
mod tests {
    use super::butterfly_visible_at;

    #[test]
    fn butterfly_appears_in_a_repeatable_short_window() {
        assert!(butterfly_visible_at(10_000));
        assert!(butterfly_visible_at(40_000));
        assert!(!butterfly_visible_at(15_000));
        assert!(!butterfly_visible_at(-10_000));
    }
}
