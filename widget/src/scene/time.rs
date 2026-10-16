pub fn format_elapsed_ms(milliseconds: i64) -> String {
    let seconds = milliseconds.max(0) / 1_000;
    let minutes = seconds / 60;
    let remainder = seconds % 60;
    format!("{minutes:02}:{remainder:02}")
}
