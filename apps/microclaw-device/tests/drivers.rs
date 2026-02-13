use microclaw_device::boards::WAVESHARE_1_85C_V3;
use microclaw_device::drivers::TouchTransform;

#[test]
fn touch_transform_flips_and_swaps_coordinates() {
    let transform = TouchTransform {
        swap_xy: true,
        invert_x: true,
        invert_y: false,
    };
    let (x, y) = transform.apply(10, 20, 360, 360);
    assert_eq!(x, 339);
    assert_eq!(y, 10);
}

#[test]
fn waveshare_board_defaults_match_known_geometry() {
    let board = WAVESHARE_1_85C_V3;
    assert_eq!(board.display.width, 360);
    assert_eq!(board.display.height, 360);
    assert_eq!(board.touch.i2c_sda.0, 11);
    assert_eq!(board.touch.i2c_scl.0, 10);
}
