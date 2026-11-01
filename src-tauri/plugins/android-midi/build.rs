// The Rust side calls the Kotlin plugin directly (`run_mobile_plugin`), so there are no commands
// for the webview and no permissions to declare.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
