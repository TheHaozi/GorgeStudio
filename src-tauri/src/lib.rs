//! Gorge Studio 的 Tauri 后端 crate 根模块。
//!
//! 职责：
//! 1. 注册可被前端（React）通过 Tauri IPC 调用的 Rust 命令；
//! 2. 读写工程文件（`.zip` 包内为 `project.toml` 配置与音频条目）；
//! 3. 初始化 Tauri 官方插件（文件对话框、系统浏览器等）。
//!
//! IPC 约定：
//! - 前端通过 `invoke("命令名", { 参数 })` 调用后端；
//! - 只有 `#[tauri::command]` 标记、并经 `generate_handler!` 注册的函数才可被调用；
//! - `plugin()` 用于注册 Tauri 官方插件。
//!
//! 命令统一返回 `Result<T, String>`，错误信息以中文字符串透传给前端展示。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use zip::write::FileOptions;
use zip::ZipWriter;

/// 工程配置文件在 `zip` 包内的文件名。
const PROJECT_FILE: &str = "project.toml";
/// 音频文件在 `zip` 包内的条目名（无扩展名）。
const AUDIO_ENTRY: &str = "audio";

/// 完整工程的数据结构，字段与前端 `ProjectData` 一一对应。
///
/// 新建工程时由 `new_project` 生成默认值；打开/保存工程时以 TOML 文本整体读写，
/// 因此字段名即 `project.toml` 的键名，修改时需同步前端解析逻辑。
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Project {
    /// 工程文件格式版本号。
    version: String,
    /// 乐曲名称。
    song_title: String,
    /// 曲目 BPM（Beats Per Minute，每分钟节拍数）。
    bpm: f64,
    /// 节拍（如 `"4/4"`、`"3/4"`、`"6/8"`）。
    time_signature: String,
    /// 音频文件扩展名（如 `"mp3"`、`"wav"`），不含点号。
    audio_ext: String,
    /// 音频源文件名（如 `"song.mp3"`）。
    audio_name: String,
    /// 音符列表。
    notes: Vec<Note>,
}

/// 单个音符的数据结构。
///
/// 当前尚无真实谱面数据，仅以 `placeholder` 占位，保持 `notes` 数组格式稳定。
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Note {
    /// 占位字段：当前没有业务含义，仅用于保持 `notes` 数组项的结构稳定。
    placeholder: String,
}

/// `open_project` 命令的返回值。
///
/// TOML 以文本、音频以 base64 返回，前端无需再次解压 zip。
#[derive(Serialize)]
struct OpenProjectResult {
    /// `project.toml` 的原始文本，由前端再解析为 `ProjectData`。
    toml: String,
    /// 音频文件的 base64 编码，如果工程中没有音频则为 `None`。
    audio_base64: Option<String>,
}

/// 将指定磁盘文件读取为 base64 字符串。
///
/// 读取失败时返回中文错误信息，由调用它的命令透传给前端。
fn file_to_base64(path: &str) -> Result<String, String> {
    let data = fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

/// 新建工程并返回默认配置的 TOML 文本。
///
/// 默认值：version 0.1.0、BPM 120、4/4 拍、空音频信息与空音符列表。
#[tauri::command]
fn new_project() -> Result<String, String> {
    let project = Project {
        version: "0.1.0".to_string(),
        song_title: String::new(),
        bpm: 120.0,
        time_signature: "4/4".to_string(),
        audio_ext: String::new(),
        audio_name: String::new(),
        notes: vec![],
    };
    toml::to_string_pretty(&project).map_err(|e| format!("TOML 序列化失败: {}", e))
}

/// 打开工程文件，读取 `zip` 内的 `project.toml` 与可选音频。
///
/// 返回 `{ toml: "...", audio_base64: "..." | null }`：
/// 条目 `project.toml` 缺失时报错；存在 `audio` 条目时将其读为 base64 一并返回，
/// 否则 `audio_base64` 为 `null`。
#[tauri::command]
fn open_project(path: &str) -> Result<OpenProjectResult, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法读取 zip: {}", e))?;

    // 读取 project.toml：独立作用域确保 entry 在读取音频前释放；该条目缺失时直接报错
    let contents = {
        let mut entry = archive
            .by_name(PROJECT_FILE)
            .map_err(|_| format!("无效的工程文件：zip 中未找到 {}", PROJECT_FILE))?;
        let mut s = String::new();
        entry
            .read_to_string(&mut s)
            .map_err(|e| format!("读取 project.toml 失败: {}", e))?;
        s
    }; // entry 在此处被 drop，archive 的借用释放

    // 读取音频：该条目不存在时视为工程没有音频（audio_base64 为 null）
    let audio_base64 = match archive.by_name(AUDIO_ENTRY) {
        Ok(mut audio_entry) => {
            let mut audio_data = Vec::new();
            audio_entry
                .read_to_end(&mut audio_data)
                .map_err(|e| format!("读取音频数据失败: {}", e))?;
            Some(base64::engine::general_purpose::STANDARD.encode(&audio_data))
        }
        Err(_) => None,
    };

    Ok(OpenProjectResult {
        toml: contents,
        audio_base64,
    })
}

/// 保存工程文件，把 TOML 配置与可选音频写入 `zip` 包。
///
/// `data` 为前端序列化好的 TOML 文本；`audio_path` 为音频文件在磁盘上的路径，
/// 仅在提供非空路径时读取该文件，并以固定条目名 `audio` 存入 `zip`，
/// 否则 `zip` 内只写入 `project.toml`。
#[tauri::command]
fn save_project(path: &str, data: &str, audio_path: Option<&str>) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| format!("无法创建文件: {}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);

    // 写入 project.toml
    zip.start_file(PROJECT_FILE, options)
        .map_err(|e| format!("写入 zip 失败: {}", e))?;
    zip.write_all(data.as_bytes())
        .map_err(|e| format!("写入数据失败: {}", e))?;

    // 如果提供了音频路径，将音频文件读入 zip（条目名固定为 "audio"）
    if let Some(audio) = audio_path {
        if !audio.is_empty() {
            let audio_data =
                fs::read(audio).map_err(|e| format!("读取音频文件失败: {}", e))?;
            zip.start_file(AUDIO_ENTRY, options)
                .map_err(|e| format!("写入音频到 zip 失败: {}", e))?;
            zip.write_all(&audio_data)
                .map_err(|e| format!("写入音频数据失败: {}", e))?;
        }
    }

    zip.finish().map_err(|e| format!("完成 zip 失败: {}", e))?;
    Ok(())
}

/// 读取指定音频文件并返回 base64 编码。
///
/// 用户在谱面编辑器中选定音乐文件后，前端调用它获取可播放的音频数据。
#[tauri::command]
fn read_audio_file(path: &str) -> Result<String, String> {
    file_to_base64(path)
}

/// Tauri 应用入口：构建应用、注册插件与命令后启动事件循环。
///
/// `generate_handler!` 注册的命令必须与上面的 `#[tauri::command]` 函数一致；
/// 由 `main.rs` 调用，移动端则通过 `mobile_entry_point` 进入。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            new_project,
            open_project,
            save_project,
            read_audio_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}