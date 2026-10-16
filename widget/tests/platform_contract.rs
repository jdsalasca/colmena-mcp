use colmena_widget::framebuffer::{Color, FrameBuffer};
use colmena_widget::platform::{
    LayeredPlatform, NativeZOrder, Platform, PlatformError, PlatformEvent, SWP_NOACTIVATE,
    WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    WindowBackend, WindowConfig, ZOrder, choose_background_z_order, window_config,
};
use colmena_widget::position::{Position, WorkArea};

#[derive(Debug, Default)]
struct FakeBackend {
    config: Option<WindowConfig>,
    positions: Vec<(Position, ZOrder, u32)>,
    frames: Vec<FrameBuffer>,
    events: Vec<PlatformEvent>,
    current: Position,
    areas: Vec<WorkArea>,
    fail_at: Option<&'static str>,
}

impl FakeBackend {
    fn fail(&self, operation: &'static str) -> Result<(), PlatformError> {
        if self.fail_at == Some(operation) {
            Err(PlatformError(format!("{operation} failed")))
        } else {
            Ok(())
        }
    }
}

impl WindowBackend for FakeBackend {
    fn create(&mut self, config: WindowConfig) -> Result<(), PlatformError> {
        self.fail("create")?;
        self.config = Some(config);
        Ok(())
    }

    fn set_position(
        &mut self,
        position: Position,
        z_order: ZOrder,
        flags: u32,
    ) -> Result<(), PlatformError> {
        self.fail("move")?;
        self.current = position;
        self.positions.push((position, z_order, flags));
        Ok(())
    }

    fn present(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError> {
        self.fail("present")?;
        self.frames.push(frame.clone());
        Ok(())
    }

    fn poll_events(&mut self) -> Result<Vec<PlatformEvent>, PlatformError> {
        self.fail("events")?;
        Ok(std::mem::take(&mut self.events))
    }

    fn current_position(&self) -> Result<Position, PlatformError> {
        self.fail("current_position")?;
        Ok(self.current)
    }

    fn work_areas(&self) -> Result<Vec<WorkArea>, PlatformError> {
        self.fail("work_areas")?;
        Ok(self.areas.clone())
    }

    fn close(&mut self) -> Result<(), PlatformError> {
        self.fail("close")
    }
}

#[test]
fn layered_popup_uses_toolwindow_without_changing_alpha_hit_testing() {
    let config = window_config(320, 180);

    assert_eq!(config.style, WS_POPUP);
    assert_eq!(config.extended_style, WS_EX_LAYERED | WS_EX_TOOLWINDOW);
    assert_eq!(config.width, 320);
    assert_eq!(config.height, 180);
    assert_eq!(config.extended_style & WS_EX_APPWINDOW, 0);
    assert_eq!(config.extended_style & WS_EX_TOPMOST, 0);
    assert_eq!(config.extended_style & WS_EX_TRANSPARENT, 0);
}

#[test]
fn initialization_move_and_present_keep_the_window_at_bottom_without_activation() {
    let initial = Position { x: 900, y: 600 };
    let moved = Position { x: 640, y: 400 };
    let mut platform = LayeredPlatform::new(FakeBackend::default(), 320, 180, initial).unwrap();

    platform.move_to(moved).unwrap();
    let mut frame = FrameBuffer::new(2, 1);
    frame.clear(Color::rgba(20, 30, 40, 128));
    platform.present(&frame).unwrap();

    assert_eq!(platform.backend().frames, [frame]);
    assert_eq!(
        platform.backend().positions,
        [
            (initial, ZOrder::Bottom, SWP_NOACTIVATE),
            (moved, ZOrder::Bottom, SWP_NOACTIVATE),
            (moved, ZOrder::Bottom, SWP_NOACTIVATE),
        ]
    );
}

#[test]
fn backend_errors_are_propagated_without_being_replaced() {
    let error = LayeredPlatform::new(
        FakeBackend {
            fail_at: Some("create"),
            ..FakeBackend::default()
        },
        320,
        180,
        Position::default(),
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "create failed");

    let mut platform =
        LayeredPlatform::new(FakeBackend::default(), 320, 180, Position::default()).unwrap();
    platform.backend_mut().fail_at = Some("move");
    assert_eq!(
        platform
            .move_to(Position { x: 1, y: 2 })
            .unwrap_err()
            .to_string(),
        "move failed"
    );
    platform.backend_mut().fail_at = Some("present");
    assert_eq!(
        platform
            .present(&FrameBuffer::new(1, 1))
            .unwrap_err()
            .to_string(),
        "present failed"
    );
    platform.backend_mut().fail_at = Some("close");
    assert_eq!(platform.close().unwrap_err().to_string(), "close failed");
}

#[test]
fn background_order_preserves_desktop_visibility_and_normal_window_coverage() {
    assert_eq!(
        choose_background_z_order(true, true, false, false),
        NativeZOrder::Top
    );
    assert_eq!(
        choose_background_z_order(false, false, false, false),
        NativeZOrder::Top
    );
    assert_eq!(
        choose_background_z_order(false, true, true, false),
        NativeZOrder::Top
    );
    assert_eq!(
        choose_background_z_order(false, true, false, false),
        NativeZOrder::Bottom
    );
    assert_eq!(
        choose_background_z_order(false, true, false, true),
        NativeZOrder::NonTopmost
    );
}
