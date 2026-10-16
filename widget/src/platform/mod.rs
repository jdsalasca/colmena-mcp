use crate::framebuffer::FrameBuffer;
use crate::position::{Position, WorkArea};
use crate::scene::Point;

pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
pub const SWP_NOACTIVATE: u32 = 0x0010;

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
