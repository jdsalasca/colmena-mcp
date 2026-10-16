#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerPalette {
    Golden,
    Blue,
    Green,
    Neutral,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerStyle {
    pub palette: WorkerPalette,
    pub size_scale: u32,
}

pub fn style_for_worker(alias: &str) -> WorkerStyle {
    let alias = alias.to_ascii_lowercase();
    let (palette, size_scale) = if alias.contains("luna") {
        (WorkerPalette::Golden, 2)
    } else if alias.contains("deepseek") || alias.contains("ds") {
        (WorkerPalette::Blue, 2)
    } else if alias.contains("hive") {
        (WorkerPalette::Green, 1)
    } else {
        (WorkerPalette::Neutral, 2)
    };

    WorkerStyle {
        palette,
        size_scale,
    }
}
