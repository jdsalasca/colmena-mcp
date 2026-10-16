use crate::framebuffer::FrameBuffer;
use crate::position::{Position, WorkArea};
use crate::scene::Point;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
pub const SWP_NOACTIVATE: u32 = 0x0010;
static NEXT_PROCESS_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProcessRecord {
    pub pid: u32,
    pub executable: PathBuf,
}

#[derive(Debug)]
pub struct ProcessRegistry {
    path: PathBuf,
    record: ProcessRecord,
}

impl ProcessRegistry {
    pub fn publish(home: &Path, record: ProcessRecord) -> io::Result<Self> {
        fs::create_dir_all(home)?;
        let path = home.join("widget-process.json");
        let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        let file_name = path.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "ruta de registro sin nombre")
        })?;
        let mut published = false;
        for _ in 0..8 {
            let temporary = process_temp_path(home, file_name);
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            };
            let result = file.write_all(&bytes).and_then(|()| file.flush());
            drop(file);
            if let Err(error) = result {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            match fs::rename(&temporary, &path) {
                Ok(()) => {
                    published = true;
                    break;
                }
                Err(error) => {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
            }
        }
        if !published {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "no se pudo reservar temporal para el registro del widget",
            ));
        }
        Ok(Self { path, record })
    }

    pub fn read(home: &Path) -> io::Result<Option<ProcessRecord>> {
        let bytes = match fs::read(home.join("widget-process.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other)
    }
}

impl Drop for ProcessRegistry {
    fn drop(&mut self) {
        let current = Self::read(self.path.parent().unwrap_or_else(|| Path::new(".")))
            .ok()
            .flatten();
        if current.as_ref() == Some(&self.record) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn process_temp_path(home: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut name = OsString::from(file_name);
    let sequence = NEXT_PROCESS_TEMP.fetch_add(1, Ordering::Relaxed);
    name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
    home.join(name)
}

pub fn mutex_name(home: &Path) -> io::Result<String> {
    let normalized = fs::canonicalize(home)?;
    let key = normalized
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let hash = key
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    Ok(format!("Local\\ColmenaWidget-{hash:016x}"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowConfig {
    pub style: u32,
    pub extended_style: u32,
    pub width: u32,
    pub height: u32,
}

pub const fn window_config(width: u32, height: u32) -> WindowConfig {
    WindowConfig {
        style: WS_POPUP,
        extended_style: WS_EX_LAYERED | WS_EX_TOOLWINDOW,
        width,
        height,
    }
}

#[cfg(target_os = "windows")]
pub mod windows;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ZOrder {
    /// Background placement: above the desktop when idle and behind the active app otherwise.
    Bottom,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeZOrder {
    Top,
    Bottom,
    NonTopmost,
}

pub const fn choose_background_z_order(
    foreground_is_shell: bool,
    foreground_visible: bool,
    foreground_minimized: bool,
    foreground_is_topmost: bool,
) -> NativeZOrder {
    if foreground_is_shell || !foreground_visible || foreground_minimized {
        NativeZOrder::Top
    } else if foreground_is_topmost {
        NativeZOrder::NonTopmost
    } else {
        NativeZOrder::Bottom
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformError(pub String);

impl std::fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PlatformError {}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PlatformEvent {
    Tick,
    MouseMove(Point),
    LeftDown(Point),
    LeftUp(Point),
    RightUp(Point),
    Close,
}

pub trait WindowBackend {
    fn create(&mut self, config: WindowConfig) -> Result<(), PlatformError>;
    fn set_position(
        &mut self,
        position: Position,
        z_order: ZOrder,
        flags: u32,
    ) -> Result<(), PlatformError>;
    fn present(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError>;
    fn poll_events(&mut self) -> Result<Vec<PlatformEvent>, PlatformError>;
    fn current_position(&self) -> Result<Position, PlatformError>;
    fn work_areas(&self) -> Result<Vec<WorkArea>, PlatformError>;
    fn close(&mut self) -> Result<(), PlatformError>;
}

pub trait Platform {
    fn current_position(&self) -> Result<Position, PlatformError>;
    fn work_areas(&self) -> Result<Vec<WorkArea>, PlatformError>;
    fn move_to(&mut self, position: Position) -> Result<(), PlatformError>;
    fn present(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError>;
    fn poll_events(&mut self) -> Result<Vec<PlatformEvent>, PlatformError>;
    fn close(&mut self) -> Result<(), PlatformError>;
}

#[derive(Debug)]
pub struct LayeredPlatform<B> {
    backend: B,
    position: Position,
}

impl<B: WindowBackend> LayeredPlatform<B> {
    pub fn new(
        mut backend: B,
        width: u32,
        height: u32,
        position: Position,
    ) -> Result<Self, PlatformError> {
        backend.create(window_config(width, height))?;
        backend.set_position(position, ZOrder::Bottom, SWP_NOACTIVATE)?;
        Ok(Self { backend, position })
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }
}

impl<B: WindowBackend> Platform for LayeredPlatform<B> {
    fn current_position(&self) -> Result<Position, PlatformError> {
        self.backend.current_position()
    }

    fn work_areas(&self) -> Result<Vec<WorkArea>, PlatformError> {
        self.backend.work_areas()
    }

    fn move_to(&mut self, position: Position) -> Result<(), PlatformError> {
        self.backend
            .set_position(position, ZOrder::Bottom, SWP_NOACTIVATE)?;
        self.position = position;
        Ok(())
    }

    fn present(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError> {
        self.backend.present(frame)?;
        self.backend
            .set_position(self.position, ZOrder::Bottom, SWP_NOACTIVATE)
    }

    fn poll_events(&mut self) -> Result<Vec<PlatformEvent>, PlatformError> {
        self.backend.poll_events()
    }

    fn close(&mut self) -> Result<(), PlatformError> {
        self.backend.close()
    }
}
