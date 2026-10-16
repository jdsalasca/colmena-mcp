use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionWarning {
    pub fallback: Position,
    pub message: String,
}

impl std::fmt::Display for PositionWarning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PositionWarning {}

pub fn load_position(path: &Path, fallback: Position) -> Result<Position, PositionWarning> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(fallback),
        Err(error) => return Err(position_warning(path, fallback, error)),
    };

    serde_json::from_slice(&bytes).map_err(|error| position_warning(path, fallback, error))
}

fn position_warning(
    path: &Path,
    fallback: Position,
    error: impl std::fmt::Display,
) -> PositionWarning {
    PositionWarning {
        fallback,
        message: format!("no se pudo leer la posición {}: {error}", path.display()),
    }
}

pub fn save_position(path: &Path, position: Position) -> io::Result<()> {
    let parent = parent_directory(path);
    fs::create_dir_all(parent)?;
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "la ruta no tiene nombre de archivo",
        )
    })?;

    for _ in 0..8 {
        let temporary = temporary_sibling(parent, file_name);
        let file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let result = write_and_replace(file, &temporary, path, position);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        return result;
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no se pudo reservar un archivo temporal para la posición",
    ))
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn temporary_sibling(parent: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut name = OsString::from(file_name);
    let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
    parent.join(name)
}

fn write_and_replace(
    mut file: std::fs::File,
    temporary: &Path,
    destination: &Path,
    position: Position,
) -> io::Result<()> {
    serde_json::to_writer(&mut file, &position)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    file.flush()?;
    drop(file);
    fs::rename(temporary, destination)
}

pub fn clamp_position(position: Position, widget_size: Size, work_area: WorkArea) -> Position {
    Position {
        x: clamp_axis(position.x, work_area.x, work_area.width, widget_size.width),
        y: clamp_axis(
            position.y,
            work_area.y,
            work_area.height,
            widget_size.height,
        ),
    }
}

fn clamp_axis(position: i32, origin: i32, area_size: i32, widget_size: u32) -> i32 {
    let origin = i64::from(origin);
    let area_size = i64::from(area_size.max(0));
    let widget_size = i64::from(widget_size);
    let max_position = if widget_size <= area_size {
        origin + area_size - widget_size
    } else {
        origin
    };
    i64::from(position)
        .clamp(origin, max_position)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}
