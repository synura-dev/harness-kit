use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Git tree hash of `rust/harness` at HEAD; "unknown" on any failure or after 3s.
fn src_tree() -> String {
    let child = Command::new("git")
        .args(["-c", "safe.directory=*", "rev-parse", "HEAD:rust/harness"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return "unknown".to_string();
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => break,
            Ok(Some(_)) | Err(_) => return "unknown".to_string(),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return "unknown".to_string();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let out = child.wait_with_output().ok();
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| s.len() >= 12 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Host-computed tree: env HARNESS_SRC_TREE, else file `.src-tree` (the podman cargo wrapper drops env).
fn host_tree() -> Option<String> {
    let v = std::env::var("HARNESS_SRC_TREE")
        .ok()
        .or_else(|| std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/.src-tree")).ok())?;
    let v = v.trim().to_string();
    (v.len() >= 12 && v.chars().all(|c| c.is_ascii_hexdigit())).then_some(v)
}

fn main() {
    let tree = host_tree().unwrap_or_else(src_tree);
    println!("cargo:rerun-if-env-changed=HARNESS_SRC_TREE");
    println!("cargo:rerun-if-changed=.src-tree");
    let short: String = tree.chars().take(12).collect();
    println!("cargo:rustc-env=HARNESS_SRC_TREE={tree}");
    println!("cargo:rustc-env=HARNESS_SRC_TREE_SHORT={short}");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=tests");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=build.rs");
}
