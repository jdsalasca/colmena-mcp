use std::path::Path;

#[test]
fn deterministic_scene_preview_is_a_png_at_the_documented_path() {
    let path = Path::new("docs/verification/scene-preview.png");
    assert!(path.is_file(), "scene preview PNG has not been generated");

    let bytes = std::fs::read(path).expect("scene preview PNG should be readable");
    assert!(
        bytes.len() >= 24,
        "scene preview PNG should include an IHDR chunk"
    );
    assert_eq!(
        &bytes[..8],
        b"\x89PNG\r\n\x1a\n",
        "scene preview should be PNG"
    );
    assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 1_040);
    assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 240);
}
