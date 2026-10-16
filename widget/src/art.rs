use crate::framebuffer::Color;
use crate::jobs::JobState;
use crate::position::Size;
use crate::scene::{Bee, Motion, Tooltip, WorkerPalette, style_for_worker};

const TRANSPARENT: Color = Color::rgba(0, 0, 0, 0);
pub const PIXEL_SCALE: u32 = 2;

const GRASS_ROWS: &[&str] = &[
    "....g.......",
    "...gg...G...",
    "..ggg..GG...",
    ".gGgGg.GGg..",
    "gGGgGGgGGGgg",
    "GGgGGGGgGgGG",
];
const FLOWER_ROWS: &[&str] = &[
    "...p.p...",
    "..ppppp..",
    ".pppYppp.",
    "..ppppp..",
    "...p.p...",
    "....g....",
    "...ggg...",
    "....g....",
    "....g....",
];
const MUSHROOM_ROWS: &[&str] = &[
    "....rrr....",
    "..rrRRRrr..",
    ".rRRRRRRRr.",
    "rRRRRRRRRRr",
    "rrwrrRrrwrr",
    "...wwwww...",
    "....www....",
    "....www....",
    "...ggggg...",
];
const HIVE_ROWS: &[&str] = &[
    "...............ss...............",
    "...............ss...............",
    "..............sHHs..............",
    ".............sHHHHs.............",
    ".............sHHHHs.............",
    "............sHHHHHHs............",
    "...........shhhhhhhhs...........",
    "...........sHHHHHHHHs...........",
    "..........ssHHHHHHHHss..........",
    ".........sHHHHHHHHHHHHs.........",
    ".........shhhhhhhhhhhhs.........",
    "........sHHHHHHHHHHHHHHs........",
    ".......ssHHHHHHHHHHHHHHss.......",
    ".......sHHHHHHHHHHHHHHHHs.......",
    "......shhhhhhhhhhhhhhhhhhs......",
    ".....sHHHHHHHHHHHHHHHHHHHHs.....",
    ".....ssHHHHHHHHHHHHHHHHHHss.....",
    "....sHHHHHHHHHHHHHHHHHHHHHHs....",
    "...shhhhhhhhsbbbbbbshhhhhhhhs...",
    "...sHHHHHHHHsbbbbbbsHHHHHHHHs...",
    "..ssHHHHHHHHsbbbbbbsHHHHHHHHss..",
    ".sHHHHHHHHHHsbbbbbbsHHHHHHHHHHs.",
    "............sbbbbbbs............",
    "............sbbbbbbs............",
    "ssssssssssssssssssssssssssssssss",
    "ssssssssssssssssssssssssssssssss",
    "ssssssssssssssssssssssssssssssss",
    "ssssssssssssssssssssssssssssssss",
];
const CLOUD_ROWS: &[&str] = &[
    "....wwwwww....",
    "..wwwwwwwwww..",
    ".wwwwwwwwwwww.",
    "wwwwwwwwwwwwww",
    "wwwwwwwwwwwwww",
    ".wwwwwwwwwwww.",
];
const BUTTERFLY_ROWS: &[&str] = &[
    "..p....p..",
    ".ppp..ppp.",
    "pppppppppp",
    ".pppYYppp.",
    "...pYYp...",
    "....g....g",
];

const GRASS_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('g', Color::rgba(27, 103, 50, 255)),
    ('G', Color::rgba(61, 147, 61, 255)),
    ('l', Color::rgba(132, 190, 78, 255)),
];
const FLOWER_GOLD_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('p', Color::rgba(240, 170, 52, 255)),
    ('P', Color::rgba(255, 221, 99, 255)),
    ('Y', Color::rgba(113, 72, 33, 255)),
    ('g', Color::rgba(50, 131, 56, 255)),
];
const FLOWER_PINK_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('p', Color::rgba(204, 97, 147, 255)),
    ('P', Color::rgba(244, 160, 190, 255)),
    ('Y', Color::rgba(255, 222, 132, 255)),
    ('g', Color::rgba(47, 120, 54, 255)),
];
const MUSHROOM_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('r', Color::rgba(182, 54, 58, 255)),
    ('R', Color::rgba(232, 89, 73, 255)),
    ('w', Color::rgba(246, 224, 174, 255)),
    ('g', Color::rgba(52, 132, 57, 255)),
];
const HIVE_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('s', Color::rgba(133, 75, 31, 255)),
    ('H', Color::rgba(224, 160, 58, 255)),
    ('h', Color::rgba(248, 207, 116, 255)),
    ('b', Color::rgba(47, 34, 26, 255)),
];
const CLOUD_PALETTE: &[(char, Color)] =
    &[('.', TRANSPARENT), ('w', Color::rgba(255, 250, 224, 226))];
const BUTTERFLY_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('p', Color::rgba(225, 92, 149, 255)),
    ('Y', Color::rgba(255, 222, 117, 255)),
    ('g', Color::rgba(86, 166, 72, 255)),
];

const BEE_EMPTY_ROW: &str = "..............";
const BEE_ANTENNA_ROW: &str = "...a......a...";
const BEE_BODY_TOP: &str = "....mmmmmm....";
const BEE_BODY_HEAD: &str = "..mmhhmmhhmm..";
const BEE_OPEN_EYES: &str = "...m.e..e.m...";
const BEE_CLOSED_EYES: &str = "...c......c...";
const BEE_BODY_STRIPES: &str = "..mmssssssmm..";
const BEE_BODY_ABDOMEN: &str = "...ssmmmmss...";
const BEE_WORKER_BADGE: &str = "....g....g....";
const BEE_LEGS: &str = "..s..s..s..s..";
const BEE_BODY_ROWS: [&str; 8] = [
    BEE_BODY_TOP,
    BEE_BODY_HEAD,
    BEE_OPEN_EYES,
    BEE_BODY_STRIPES,
    BEE_BODY_ABDOMEN,
    BEE_WORKER_BADGE,
    BEE_LEGS,
    BEE_EMPTY_ROW,
];
const BEE_QUEUED_ROWS: &[&str] = &[
    "...q......q...",
    BEE_ANTENNA_ROW,
    "...w......w...",
    "..w........w..",
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_BODY_ROWS[2],
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_FLY_A_ROWS: &[&str] = &[
    BEE_EMPTY_ROW,
    BEE_ANTENNA_ROW,
    ".ww........ww.",
    "..w........w..",
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_BODY_ROWS[2],
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_FLY_B_ROWS: &[&str] = &[
    ".ww........ww.",
    BEE_ANTENNA_ROW,
    "..w........w..",
    BEE_EMPTY_ROW,
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_BODY_ROWS[2],
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_FLY_C_ROWS: &[&str] = &[
    "...w......w...",
    ".ww........ww.",
    BEE_ANTENNA_ROW,
    "..w........w..",
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_BODY_ROWS[2],
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_IDLE_ROWS: &[&str] = &[
    BEE_EMPTY_ROW,
    BEE_ANTENNA_ROW,
    "...w......w...",
    "..w........w..",
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_CLOSED_EYES,
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_DONE_ROWS: &[&str] = &[
    "....g....g....",
    BEE_ANTENNA_ROW,
    ".ww........ww.",
    "..w........w..",
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_BODY_ROWS[2],
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_FAILED_ROWS: &[&str] = &[
    BEE_EMPTY_ROW,
    BEE_ANTENNA_ROW,
    "..w........w..",
    BEE_EMPTY_ROW,
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    "...x......x...",
    "..mmrrrrrrmm..",
    "...ssrrrrss...",
    "...r......r...",
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];
const BEE_RETURN_ROWS: &[&str] = &[
    BEE_EMPTY_ROW,
    BEE_ANTENNA_ROW,
    "...w......w...",
    "..w........w..",
    BEE_BODY_ROWS[0],
    BEE_BODY_ROWS[1],
    BEE_BODY_ROWS[2],
    BEE_BODY_ROWS[3],
    BEE_BODY_ROWS[4],
    BEE_BODY_ROWS[5],
    BEE_BODY_ROWS[6],
    BEE_BODY_ROWS[7],
];

const GOLD_BEE_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('w', Color::rgba(220, 246, 244, 220)),
    ('a', Color::rgba(50, 43, 31, 255)),
    ('m', Color::rgba(224, 157, 37, 255)),
    ('h', Color::rgba(255, 220, 94, 255)),
    ('s', Color::rgba(76, 47, 24, 255)),
    ('r', Color::rgba(231, 61, 58, 255)),
    ('g', Color::rgba(255, 243, 147, 230)),
    ('e', Color::rgba(46, 39, 30, 255)),
    ('c', Color::rgba(115, 81, 40, 255)),
    ('x', Color::rgba(227, 34, 42, 255)),
    ('q', Color::rgba(255, 247, 210, 255)),
];
const BLUE_BEE_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('w', Color::rgba(211, 244, 255, 220)),
    ('a', Color::rgba(31, 48, 62, 255)),
    ('m', Color::rgba(55, 154, 197, 255)),
    ('h', Color::rgba(125, 218, 243, 255)),
    ('s', Color::rgba(35, 65, 91, 255)),
    ('r', Color::rgba(235, 66, 67, 255)),
    ('g', Color::rgba(194, 247, 255, 230)),
    ('e', Color::rgba(27, 45, 58, 255)),
    ('c', Color::rgba(51, 108, 132, 255)),
    ('x', Color::rgba(227, 34, 42, 255)),
    ('q', Color::rgba(232, 250, 255, 255)),
];
const GREEN_BEE_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('w', Color::rgba(224, 247, 221, 220)),
    ('a', Color::rgba(36, 51, 32, 255)),
    ('m', Color::rgba(70, 166, 82, 255)),
    ('h', Color::rgba(143, 219, 105, 255)),
    ('s', Color::rgba(39, 76, 39, 255)),
    ('r', Color::rgba(235, 66, 67, 255)),
    ('g', Color::rgba(219, 255, 179, 230)),
    ('e', Color::rgba(32, 56, 31, 255)),
    ('c', Color::rgba(75, 126, 66, 255)),
    ('x', Color::rgba(227, 34, 42, 255)),
    ('q', Color::rgba(242, 255, 227, 255)),
];
const NEUTRAL_BEE_PALETTE: &[(char, Color)] = &[
    ('.', TRANSPARENT),
    ('w', Color::rgba(231, 241, 239, 220)),
    ('a', Color::rgba(42, 48, 51, 255)),
    ('m', Color::rgba(151, 169, 175, 255)),
    ('h', Color::rgba(219, 227, 204, 255)),
    ('s', Color::rgba(63, 69, 66, 255)),
    ('r', Color::rgba(235, 66, 67, 255)),
    ('g', Color::rgba(244, 248, 211, 230)),
    ('e', Color::rgba(44, 52, 55, 255)),
    ('c', Color::rgba(102, 112, 107, 255)),
    ('x', Color::rgba(227, 34, 42, 255)),
    ('q', Color::rgba(248, 250, 239, 255)),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sprite<'a> {
    pub rows: &'a [&'a str],
    pub palette: &'a [(char, Color)],
}

impl<'a> Sprite<'a> {
    pub const fn new(rows: &'a [&'a str], palette: &'a [(char, Color)]) -> Self {
        Self { rows, palette }
    }

    pub fn width(self) -> usize {
        self.rows.first().map_or(0, |row| row.chars().count())
    }

    pub fn height(self) -> usize {
        self.rows.len()
    }

    pub fn is_rectangular(self) -> bool {
        let width = self.width();
        width > 0 && self.rows.iter().all(|row| row.chars().count() == width)
    }

    pub fn color_for(self, symbol: char) -> Option<Color> {
        self.palette
            .iter()
            .find_map(|(candidate, color)| (*candidate == symbol).then_some(*color))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BeeArtState {
    Idle,
    Queued,
    Flying,
    Returning,
    Done,
    Failed,
}

pub fn scenery_sprites() -> [Sprite<'static>; 7] {
    [
        Sprite::new(GRASS_ROWS, GRASS_PALETTE),
        Sprite::new(FLOWER_ROWS, FLOWER_GOLD_PALETTE),
        Sprite::new(FLOWER_ROWS, FLOWER_PINK_PALETTE),
        Sprite::new(MUSHROOM_ROWS, MUSHROOM_PALETTE),
        Sprite::new(HIVE_ROWS, HIVE_PALETTE),
        Sprite::new(CLOUD_ROWS, CLOUD_PALETTE),
        Sprite::new(BUTTERFLY_ROWS, BUTTERFLY_PALETTE),
    ]
}

pub fn bee_sprite(palette: WorkerPalette, state: BeeArtState, wing_frame: u8) -> Sprite<'static> {
    let rows = match state {
        BeeArtState::Idle => BEE_IDLE_ROWS,
        BeeArtState::Queued => BEE_QUEUED_ROWS,
        BeeArtState::Flying => match wing_frame % 3 {
            0 => BEE_FLY_A_ROWS,
            1 => BEE_FLY_B_ROWS,
            _ => BEE_FLY_C_ROWS,
        },
        BeeArtState::Returning => BEE_RETURN_ROWS,
        BeeArtState::Done => BEE_DONE_ROWS,
        BeeArtState::Failed => BEE_FAILED_ROWS,
    };
    let palette = match palette {
        WorkerPalette::Golden => GOLD_BEE_PALETTE,
        WorkerPalette::Blue => BLUE_BEE_PALETTE,
        WorkerPalette::Green => GREEN_BEE_PALETTE,
        WorkerPalette::Neutral => NEUTRAL_BEE_PALETTE,
    };
    Sprite::new(rows, palette)
}

pub fn sprite_for_bee(bee: &Bee, wing_frame: u8) -> (Sprite<'static>, u32) {
    let style = bee
        .job
        .as_ref()
        .and_then(|job| job.worker.as_deref())
        .map(style_for_worker)
        .unwrap_or_else(|| style_for_worker("hive"));
    let state = match bee.motion {
        Motion::Idle => BeeArtState::Idle,
        Motion::Queued => BeeArtState::Queued,
        Motion::Flying => BeeArtState::Flying,
        Motion::Returning => match bee.job.as_ref().map(|job| job.state) {
            Some(JobState::Done) => BeeArtState::Done,
            Some(JobState::Failed | JobState::Orphaned) => BeeArtState::Failed,
            _ => BeeArtState::Returning,
        },
        Motion::Falling => BeeArtState::Failed,
    };
    let palette = if bee
        .job
        .as_ref()
        .is_some_and(|job| job.state == JobState::Cancelled)
    {
        WorkerPalette::Neutral
    } else {
        style.palette
    };
    (bee_sprite(palette, state, wing_frame), style.size_scale)
}

pub fn tooltip_size(tooltip: &Tooltip, scale: u32) -> Size {
    let scale = scale.max(1);
    let task_characters = tooltip.task.chars().count();
    let task_lines = task_characters.div_ceil(40).max(1) as u32;
    let longest_line = [
        tooltip.worker.as_str(),
        tooltip.kind.as_str(),
        tooltip.elapsed.as_str(),
    ]
    .into_iter()
    .map(|line| line.chars().count())
    .max()
    .unwrap_or(0)
    .max(if tooltip.cost == "pendiente" {
        tooltip.cost.chars().count()
    } else {
        tooltip.cost.chars().count() + 1
    })
    .max(task_characters.min(40)) as u32;
    let line_count = 4_u32.saturating_add(task_lines);
    Size {
        width: (longest_line.saturating_mul(6).saturating_add(12) * scale).max(72 * scale),
        height: (line_count.saturating_mul(9).saturating_add(8)) * scale,
    }
}
