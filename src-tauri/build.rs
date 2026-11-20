fn main() {
  // On Windows `tauri-build` links the application manifest (which asks for Common Controls v6, where
  // `TaskDialogIndirect` lives) only into the binaries. The unit tests of the library are another
  // executable that loads the same Tauri/dialog code, and without the manifest it fails to start with
  // STATUS_ENTRYPOINT_NOT_FOUND. So the manifest is linked into every artifact from here, and
  // `tauri-build` is told not to add its own copy (two manifests in one binary don't link).
  #[cfg(windows)]
  if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") {
    embed_manifest_everywhere();
    tauri_build::try_build(
      tauri_build::Attributes::new().windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");
    return;
  }
  tauri_build::build()
}

#[cfg(windows)]
fn embed_manifest_everywhere() {
  let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
  let manifest = out.join("app.manifest");
  std::fs::write(&manifest, include_str!("windows-app-manifest.xml")).expect("write the manifest");
  // `.rc` strings take forward slashes; 24 is RT_MANIFEST and 1 the id of an executable's manifest.
  let rc = out.join("app-manifest.rc");
  let manifest_path = manifest.display().to_string().replace('\\', "/");
  std::fs::write(&rc, format!("1 24 \"{manifest_path}\"\n")).expect("write the .rc");
  println!("cargo:rerun-if-changed=windows-app-manifest.xml");
  embed_resource::compile_for_everything(rc, embed_resource::NONE)
    .manifest_required()
    .expect("failed to embed the Windows manifest");
}
