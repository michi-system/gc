use std::{
  env,
  net::TcpStream,
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, Instant},
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const LOCAL_URL: &str = "http://127.0.0.1:3131";
const BACKEND_HOST: &str = "127.0.0.1:3131";

struct BackendProcess(Mutex<Option<Child>>);

fn backend_reachable() -> bool {
  TcpStream::connect(BACKEND_HOST).is_ok()
}

fn wait_for_backend(timeout: Duration) -> Result<(), String> {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    if backend_reachable() {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(250));
  }
  Err(format!("Timed out waiting for local backend at {LOCAL_URL}."))
}

fn bundled_node_name() -> String {
  #[cfg(target_os = "macos")]
  {
    format!("node-sidecar-{}-apple-darwin", env::consts::ARCH)
  }

  #[cfg(not(target_os = "macos"))]
  {
    "node-sidecar".to_string()
  }
}

fn packaged_node_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let binary_name = bundled_node_name();
  let fallback_name = "node-sidecar".to_string();
  let mut candidates = Vec::new();

  if let Ok(current_exe) = env::current_exe() {
    if let Some(parent) = current_exe.parent() {
      candidates.push(parent.join(&binary_name));
      candidates.push(parent.join(&fallback_name));
    }
  }

  let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
  candidates.push(resource_dir.join(&binary_name));
  candidates.push(resource_dir.join(&fallback_name));
  candidates.push(resource_dir.join("_up_").join(&binary_name));
  candidates.push(resource_dir.join("_up_").join(&fallback_name));

  candidates
    .into_iter()
    .find(|candidate| candidate.is_file())
    .ok_or_else(|| format!("Bundled Node runtime not found for {} or {}", binary_name, fallback_name))
}

fn spawn_packaged_backend(app: &tauri::AppHandle) -> Result<Option<Child>, String> {
  if cfg!(debug_assertions) || backend_reachable() {
    return Ok(None);
  }

  let node_binary = packaged_node_path(app)?;
  let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
  let backend_root = if resource_dir.join("_up_").is_dir() {
    resource_dir.join("_up_")
  } else {
    resource_dir
  };

  let child = Command::new(node_binary)
    .arg(backend_root.join("dist/src/server.js"))
    .current_dir(&backend_root)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|error| format!("Failed to launch local backend with node: {error}"))?;

  Ok(Some(child))
}

fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
  let url = WebviewUrl::External(LOCAL_URL.parse().expect("valid localhost url"));

  #[cfg(target_os = "macos")]
  let builder = WebviewWindowBuilder::new(app, "main", url)
    .title("GC Console")
    .inner_size(1480.0, 980.0)
    .min_inner_size(1240.0, 780.0)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  #[cfg(not(target_os = "macos"))]
  let builder = WebviewWindowBuilder::new(app, "main", url)
    .title("GC Console")
    .inner_size(1480.0, 980.0)
    .min_inner_size(1240.0, 780.0);

  builder.build()?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .manage(BackendProcess(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      if let Some(child) =
        spawn_packaged_backend(app.handle()).map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?
      {
        let backend = app.state::<BackendProcess>();
        *backend.0.lock().expect("backend mutex poisoned") = Some(child);
      }

      wait_for_backend(Duration::from_secs(30)).map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;
      create_main_window(app.handle())?;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if let RunEvent::Exit = event {
      let backend = app_handle.state::<BackendProcess>();
      let child = {
        let mut guard = backend.0.lock().expect("backend mutex poisoned");
        guard.take()
      };
      if let Some(mut child) = child {
        let _ = child.kill();
      }
    }
  });
}
