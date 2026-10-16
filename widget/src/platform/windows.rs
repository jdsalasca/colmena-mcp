use super::{
    LayeredPlatform, NativeZOrder, PlatformError, PlatformEvent, SWP_NOACTIVATE, WindowBackend,
    WindowConfig, ZOrder, choose_background_z_order,
};
use crate::framebuffer::FrameBuffer;
use crate::position::{Position, WorkArea};
use crate::scene::Point;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, HBITMAP, HDC,
    HGDIOBJ, MONITORINFO, SelectObject,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow,
    DispatchMessageW, GWL_EXSTYLE, GWLP_USERDATA, GetForegroundWindow, GetShellWindow, HWND_BOTTOM,
    HWND_NOTOPMOST, HWND_TOP, IsIconic, IsWindowVisible, MA_NOACTIVATE, MSG, PM_REMOVE,
    PeekMessageW, PostQuitMessage, RegisterClassW, SWP_NOACTIVATE as WIN_SWP_NOACTIVATE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, ULW_ALPHA, UpdateLayeredWindow, WM_CLOSE, WM_DESTROY, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_RBUTTONUP, WM_TIMER, WNDCLASSW, WaitMessage,
};
use windows::core::BOOL;

const CLASS_NAME: &str = "ColmenaWidgetLayeredWindow";
const WINDOW_TITLE: &str = "Colmena Widget";
const TIMER_ID: usize = 1;

struct DibSurface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    pixels: *mut u32,
    width: u32,
    height: u32,
}

impl DibSurface {
    fn new(width: u32, height: u32) -> Result<Self, PlatformError> {
        if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err(PlatformError(
                "dimensiones inválidas para el DIB".to_owned(),
            ));
        }
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.0.is_null() {
            return Err(last_error("CreateCompatibleDC"));
        }

        let mut info: BITMAPINFO = unsafe { zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits = null_mut();
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) if !bits.is_null() => bitmap,
            Ok(bitmap) => {
                unsafe {
                    let _ = DeleteObject(bitmap.into());
                    let _ = DeleteDC(dc);
                }
                return Err(PlatformError(
                    "CreateDIBSection no asignó píxeles".to_owned(),
                ));
            }
            Err(error) => {
                unsafe {
                    let _ = DeleteDC(dc);
                }
                return Err(PlatformError(format!("CreateDIBSection: {error}")));
            }
        };
        let previous = unsafe { SelectObject(dc, bitmap.into()) };
        if previous.0.is_null() || previous.0 as isize == -1 {
            unsafe {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(dc);
            }
            return Err(last_error("SelectObject"));
        }
        Ok(Self {
            dc,
            bitmap,
            previous,
            pixels: bits.cast(),
            width,
            height,
        })
    }

    fn copy_pixels(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError> {
        if frame.width != self.width || frame.height != self.height {
            return Err(PlatformError(
                "el frame no coincide con el tamaño del DIB".to_owned(),
            ));
        }
        let count = (self.width as usize).saturating_mul(self.height as usize);
        unsafe { std::ptr::copy_nonoverlapping(frame.pixels.as_ptr(), self.pixels, count) };
        Ok(())
    }
}

impl Drop for DibSurface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

#[derive(Default)]
struct WindowState {
    events: Vec<PlatformEvent>,
}

#[derive(Default)]
pub struct WindowsBackend {
    hwnd: Option<HWND>,
    state: Box<WindowState>,
    dib: Option<DibSurface>,
    width: u32,
    height: u32,
    position: Position,
    closed: bool,
    visible: bool,
}

impl WindowsBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn hwnd(&self) -> Result<HWND, PlatformError> {
        self.hwnd
            .ok_or_else(|| PlatformError("la ventana no está creada".to_owned()))
    }

    fn drain_messages(&mut self) -> Result<(), PlatformError> {
        self.hwnd()?;
        let mut message = MSG::default();
        loop {
            let has_message =
                unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() };
            if !has_message {
                break;
            }
            if message.message == 0x0012 {
                self.state.events.push(PlatformEvent::Close);
                self.closed = true;
                break;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }
}

impl WindowBackend for WindowsBackend {
    fn create(&mut self, config: WindowConfig) -> Result<(), PlatformError> {
        if self.hwnd.is_some() {
            return Err(PlatformError("la ventana ya está creada".to_owned()));
        }
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
                .map_err(|error| PlatformError(format!("DPI awareness: {error}")))?;
        }
        let module = unsafe { GetModuleHandleW(None) }
            .map_err(|error| PlatformError(format!("GetModuleHandleW: {error}")))?;
        let module = HINSTANCE(module.0);
        let class_name: Vec<u16> = CLASS_NAME.encode_utf16().chain(Some(0)).collect();
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: module,
            lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        let atom = unsafe { RegisterClassW(&class) };
        if atom == 0 {
            return Err(last_error("RegisterClassW"));
        }
        let title: Vec<u16> = WINDOW_TITLE.encode_utf16().chain(Some(0)).collect();
        let hwnd = unsafe {
            CreateWindowExW(
                windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(config.extended_style),
                windows::core::PCWSTR(class_name.as_ptr()),
                windows::core::PCWSTR(title.as_ptr()),
                windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(config.style),
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                config.width as i32,
                config.height as i32,
                None,
                None,
                Some(module),
                None,
            )
        }
        .map_err(|error| PlatformError(format!("CreateWindowExW: {error}")))?;
        self.hwnd = Some(hwnd);
        self.width = config.width;
        self.height = config.height;
        unsafe {
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                (&mut *self.state as *mut WindowState) as isize,
            );
        }
        self.dib = Some(DibSurface::new(config.width, config.height)?);
        let timer = unsafe { SetTimer(Some(hwnd), TIMER_ID, 16, None) };
        if timer == 0 {
            return Err(last_error("SetTimer"));
        }
        Ok(())
    }

    fn set_position(
        &mut self,
        position: Position,
        z_order: ZOrder,
        flags: u32,
    ) -> Result<(), PlatformError> {
        let hwnd = self.hwnd()?;
        let insert_after = match z_order {
            ZOrder::Bottom => {
                // HWND_BOTTOM is correct while a normal app is visible, but Windows also
                // stacks the desktop shell above it. On the desktop, HWND_TOP stays in the
                // non-topmost band and keeps the widget visible; active normal windows cover it.
                let foreground = unsafe { GetForegroundWindow() };
                let shell = unsafe { GetShellWindow() };
                let foreground_is_shell = foreground == shell || foreground == hwnd;
                let foreground_visible =
                    !foreground.0.is_null() && unsafe { IsWindowVisible(foreground).as_bool() };
                let foreground_minimized =
                    !foreground.0.is_null() && unsafe { IsIconic(foreground).as_bool() };
                let foreground_is_topmost = !foreground.0.is_null()
                    && (unsafe {
                        windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                            foreground,
                            GWL_EXSTYLE,
                        )
                    } as u32
                        & super::WS_EX_TOPMOST)
                        != 0;
                match choose_background_z_order(
                    foreground_is_shell,
                    foreground_visible,
                    foreground_minimized,
                    foreground_is_topmost,
                ) {
                    NativeZOrder::Top => HWND_TOP,
                    NativeZOrder::Bottom => HWND_BOTTOM,
                    NativeZOrder::NonTopmost => HWND_NOTOPMOST,
                }
            }
        };
        let native_flags =
            SWP_NOSIZE.0 | SWP_NOOWNERZORDER.0 | (flags & SWP_NOACTIVATE) | WIN_SWP_NOACTIVATE.0;
        unsafe {
            SetWindowPos(
                hwnd,
                Some(insert_after),
                position.x,
                position.y,
                0,
                0,
                windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS(native_flags),
            )
        }
        .map_err(|error| PlatformError(format!("SetWindowPos: {error}")))?;
        self.position = position;
        Ok(())
    }

    fn present(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError> {
        let hwnd = self.hwnd()?;
        let dib = self
            .dib
            .as_mut()
            .ok_or_else(|| PlatformError("el DIB no está creado".to_owned()))?;
        dib.copy_pixels(frame)?;
        let destination = POINT {
            x: self.position.x,
            y: self.position.y,
        };
        let size = SIZE {
            cx: self.width as i32,
            cy: self.height as i32,
        };
        let source = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        unsafe {
            UpdateLayeredWindow(
                hwnd,
                None,
                Some(&destination),
                Some(&size),
                Some(dib.dc),
                Some(&source),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            )
        }
        .map_err(|error| PlatformError(format!("UpdateLayeredWindow: {error}")))?;
        if !self.visible {
            unsafe {
                let _ = ShowWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE,
                );
            }
            self.visible = true;
        }
        Ok(())
    }

    fn poll_events(&mut self) -> Result<Vec<PlatformEvent>, PlatformError> {
        if self.hwnd.is_none() || self.closed {
            return Ok(std::mem::take(&mut self.state.events));
        }
        self.drain_messages()?;
        if self.state.events.is_empty() && !self.closed {
            unsafe { WaitMessage() }
                .map_err(|error| PlatformError(format!("WaitMessage: {error}")))?;
            self.drain_messages()?;
        }
        Ok(std::mem::take(&mut self.state.events))
    }

    fn current_position(&self) -> Result<Position, PlatformError> {
        self.hwnd()?;
        Ok(self.position)
    }

    fn work_areas(&self) -> Result<Vec<WorkArea>, PlatformError> {
        let mut areas = Vec::new();
        let result = unsafe {
            windows::Win32::Graphics::Gdi::EnumDisplayMonitors(
                None,
                None,
                Some(monitor_enum_proc),
                LPARAM((&mut areas as *mut Vec<WorkArea>) as isize),
            )
        };
        if !result.as_bool() || areas.is_empty() {
            return Err(last_error("EnumDisplayMonitors"));
        }
        Ok(areas)
    }

    fn close(&mut self) -> Result<(), PlatformError> {
        let Some(hwnd) = self.hwnd.take() else {
            return Ok(());
        };
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::KillTimer(Some(hwnd), TIMER_ID);
            DestroyWindow(hwnd)
                .map_err(|error| PlatformError(format!("DestroyWindow: {error}")))?;
        }
        self.dib.take();
        self.closed = true;
        Ok(())
    }
}

impl Drop for WindowsBackend {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }
    let state_ptr =
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWLP_USERDATA) }
            as *mut WindowState;
    if !state_ptr.is_null() {
        let state = unsafe { &mut *state_ptr };
        let point = Point {
            x: (lparam.0 as u16 as i16) as f32,
            y: ((lparam.0 >> 16) as u16 as i16) as f32,
        };
        match message {
            WM_TIMER if wparam.0 == TIMER_ID => state.events.push(PlatformEvent::Tick),
            WM_MOUSEMOVE => state.events.push(PlatformEvent::MouseMove(point)),
            WM_LBUTTONDOWN => {
                unsafe { SetCapture(hwnd) };
                state.events.push(PlatformEvent::LeftDown(point));
            }
            WM_LBUTTONUP => {
                unsafe {
                    let _ = ReleaseCapture();
                }
                state.events.push(PlatformEvent::LeftUp(point));
            }
            WM_RBUTTONUP => state.events.push(PlatformEvent::RightUp(point)),
            WM_CLOSE => {
                state.events.push(PlatformEvent::Close);
                return LRESULT(0);
            }
            WM_DESTROY => unsafe { PostQuitMessage(0) },
            _ => {}
        }
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

unsafe extern "system" fn monitor_enum_proc(
    monitor: windows::Win32::Graphics::Gdi::HMONITOR,
    _dc: HDC,
    _rect: *mut windows::Win32::Foundation::RECT,
    data: LPARAM,
) -> BOOL {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { windows::Win32::Graphics::Gdi::GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        let areas = unsafe { &mut *(data.0 as *mut Vec<WorkArea>) };
        areas.push(WorkArea {
            x: info.rcWork.left,
            y: info.rcWork.top,
            width: info.rcWork.right - info.rcWork.left,
            height: info.rcWork.bottom - info.rcWork.top,
        });
    }
    BOOL(1)
}

fn last_error(operation: &str) -> PlatformError {
    PlatformError(format!("{operation}: {}", std::io::Error::last_os_error()))
}

pub type WindowsPlatform = LayeredPlatform<WindowsBackend>;

pub fn create_platform(
    width: u32,
    height: u32,
    position: Position,
) -> Result<WindowsPlatform, PlatformError> {
    LayeredPlatform::new(WindowsBackend::new(), width, height, position)
}
