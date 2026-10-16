use crate::art::Sprite;
use crate::position::Size;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameBuffer {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u32>,
}

impl FrameBuffer {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width as usize).saturating_mul(height as usize)],
        }
    }

    pub fn clear(&mut self, color: Color) {
        self.pixels.fill(pack_bgra_premultiplied(color));
    }

    pub fn pixel(&self, x: i32, y: i32) -> Option<u32> {
        let index = self.index(x, y)?;
        self.pixels.get(index).copied()
    }

    pub fn draw_pixel(&mut self, x: i32, y: i32, color: Color) {
        let Some(index) = self.index(x, y) else {
            return;
        };
        if color.a == 0 {
            return;
        }

        let source = pack_bgra_premultiplied(color);
        let destination = self.pixels[index];
        self.pixels[index] = source_over(source, destination);
    }

    pub fn fill_rect(&mut self, x: i32, y: i32, width: u32, height: u32, color: Color) {
        if width == 0 || height == 0 || color.a == 0 {
            return;
        }
        let left = i64::from(x).max(0);
        let top = i64::from(y).max(0);
        let right = (i64::from(x) + i64::from(width)).min(i64::from(self.width));
        let bottom = (i64::from(y) + i64::from(height)).min(i64::from(self.height));
        if left >= right || top >= bottom {
            return;
        }
        for py in top..bottom {
            for px in left..right {
                self.draw_pixel(px as i32, py as i32, color);
            }
        }
    }

    pub fn draw_sprite(&mut self, x: i32, y: i32, sprite: Sprite<'_>, scale: u32) {
        let scale = scale.max(1);
        for (row_index, row) in sprite.rows.iter().enumerate() {
            for (column_index, symbol) in row.chars().enumerate() {
                let Some(color) = sprite.color_for(symbol) else {
                    continue;
                };
                let px = i64::from(x) + column_index as i64 * i64::from(scale);
                let py = i64::from(y) + row_index as i64 * i64::from(scale);
                if let (Ok(px), Ok(py)) = (i32::try_from(px), i32::try_from(py)) {
                    self.fill_rect(px, py, scale, scale, color);
                }
            }
        }
    }

    pub fn draw_bitmap_text(
        &mut self,
        x: i32,
        y: i32,
        text: &str,
        scale: u32,
        color: Color,
    ) -> Size {
        let scale = scale.max(1);
        for (character_index, character) in text.chars().enumerate() {
            let glyph = glyph_rows(character);
            for (row_index, bits) in glyph.into_iter().enumerate() {
                for column_index in 0..5 {
                    let mask = 1 << (4 - column_index);
                    if bits & mask == 0 {
                        continue;
                    }
                    let px = i64::from(x)
                        + (character_index as i64 * 6 + column_index as i64) * i64::from(scale);
                    let py = i64::from(y) + row_index as i64 * i64::from(scale);
                    if let (Ok(px), Ok(py)) = (i32::try_from(px), i32::try_from(py)) {
                        self.fill_rect(px, py, scale, scale, color);
                    }
                }
            }
        }

        let character_count = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
        Size {
            width: character_count.saturating_mul(6).saturating_mul(scale),
            height: 7_u32.saturating_mul(scale),
        }
    }

    fn index(&self, x: i32, y: i32) -> Option<usize> {
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return None;
        }
        Some(y as usize * self.width as usize + x as usize)
    }
}

pub fn pack_bgra_premultiplied(color: Color) -> u32 {
    let alpha = u32::from(color.a);
    let red = u32::from(premultiply(color.r, color.a));
    let green = u32::from(premultiply(color.g, color.a));
    let blue = u32::from(premultiply(color.b, color.a));
    (alpha << 24) | (red << 16) | (green << 8) | blue
}

fn premultiply(channel: u8, alpha: u8) -> u8 {
    ((u16::from(channel) * u16::from(alpha) + 127) / 255) as u8
}

fn source_over(source: u32, destination: u32) -> u32 {
    let source_alpha = (source >> 24) & 0xff;
    let inverse_alpha = 255 - source_alpha;
    let destination_alpha = (destination >> 24) & 0xff;
    let out_alpha = source_alpha + multiply_255(destination_alpha, inverse_alpha);
    let mut output = out_alpha << 24;

    for shift in [0, 8, 16] {
        let source_channel = (source >> shift) & 0xff;
        let destination_channel = (destination >> shift) & 0xff;
        let channel = source_channel + multiply_255(destination_channel, inverse_alpha);
        output |= channel.min(255) << shift;
    }
    output
}

fn multiply_255(value: u32, multiplier: u32) -> u32 {
    (value * multiplier + 127) / 255
}

fn glyph_rows(character: char) -> [u8; 7] {
    let character = match character {
        'a'..='z' => character.to_ascii_uppercase(),
        'á' => 'Á',
        'é' => 'É',
        'í' => 'Í',
        'ó' => 'Ó',
        'ú' => 'Ú',
        'ñ' => 'Ñ',
        'ü' => 'Ü',
        other => other,
    };
    match character {
        'Á' => accented_glyph('A', 0b00100),
        'É' => accented_glyph('E', 0b00100),
        'Í' => accented_glyph('I', 0b00100),
        'Ó' => accented_glyph('O', 0b00100),
        'Ú' => accented_glyph('U', 0b00100),
        'Ñ' => accented_glyph('N', 0b01010),
        'Ü' => accented_glyph('U', 0b01010),
        _ => glyph_ascii(character),
    }
}

fn accented_glyph(base: char, mark: u8) -> [u8; 7] {
    let glyph = glyph_ascii(base);
    [
        mark, glyph[0], glyph[1], glyph[2], glyph[3], glyph[4], glyph[5],
    ]
}

fn glyph_ascii(character: char) -> [u8; 7] {
    match character {
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'B' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ],
        'C' => [
            0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111,
        ],
        'D' => [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'F' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'G' => [
            0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111,
        ],
        'H' => [
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'I' => [
            0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        'J' => [
            0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100,
        ],
        'K' => [
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ],
        'L' => [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
        'M' => [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
        'N' => [
            0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
        ],
        'O' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'P' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'Q' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        'T' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'U' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ],
        'W' => [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
        ],
        'X' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
        ],
        'Y' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'Z' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110,
        ],
        ':' => [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0],
        '.' => [0, 0, 0, 0, 0, 0b00110, 0b00110],
        ',' => [0, 0, 0, 0, 0b00110, 0b00110, 0b00100],
        '-' => [0, 0, 0, 0b01110, 0, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 0b11111],
        '$' => [
            0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100,
        ],
        '/' => [
            0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000,
        ],
        '+' => [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
        '=' => [0, 0, 0b11111, 0, 0b11111, 0, 0],
        '?' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
        '!' => [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
        '(' => [
            0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010,
        ],
        ')' => [
            0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000,
        ],
        '%' => [0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b00110, 0],
        ' ' => [0; 7],
        _ => [
            0b11111, 0b10001, 0b10101, 0b10001, 0b10101, 0b10001, 0b11111,
        ],
    }
}
