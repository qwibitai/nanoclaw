#[cfg(feature = "esp")]
fn main() {
    embuild::espidf::sysenv::output();
    slint_build::compile("ui/main.slint").expect("Slint compilation failed");
}

#[cfg(not(feature = "esp"))]
fn main() {
    slint_build::compile("ui/main.slint").expect("Slint compilation failed");
}
