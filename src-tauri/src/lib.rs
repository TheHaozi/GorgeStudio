// ============================================================
// Gorge Studio - Rust 后端
// ============================================================
// 本文件是 Tauri 应用的核心后端代码，负责：
// 1. 注册可被前端（React）调用的 Rust 命令
// 2. 处理工程文件（.zip 内包含 .toml 配置 + 音频文件）的读写
// 3. 管理 Tauri 插件的初始化
//
// 快速理解：
// - 前端通过 invoke("命令名", { 参数 }) 调用 Rust 函数
// - #[tauri::command] 宏标记的函数会自动注册为可调用命令
// - plugin() 用于注册 Tauri 官方插件（如文件对话框、系统浏览器等）
// ============================================================

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use zip::write::FileOptions;
use zip::ZipWriter;

// -----------------------------------------------------------
// 数据结构
// -----------------------------------------------------------

/// 工程配置文件在 zip 包内的文件名
const PROJECT_FILE: &str = "project.toml";
/// 音频文件在 zip 包内的条目名（无扩展名）
const AUDIO_ENTRY: &str = "audio";

/// 一个完整的工程数据结构
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Project {
    /// 工程文件格式版本号
    version: String,
    /// 乐曲名称
    song_title: String,
    /// 曲目 BPM（Beats Per Minute，每分钟节拍数）
    bpm: f64,
    /// 节拍（如 "4/4"、"3/4"、"6/8"）
    time_signature: String,
    /// 音频文件扩展名（如 "mp3"、"wav"），不含点号
    audio_ext: String,
    /// 音频源文件名（如 "song.mp3"）
    audio_name: String,
    /// 音符列表
    notes: Vec<Note>,
}

/// 单个音符的数据结构
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Note {
    placeholder: String,
}

/// open_project 命令的返回值
/// 包含 TOML 配置内容和可选的音频 base64 数据
#[derive(Serialize)]
struct OpenProjectResult {
    toml: String,
    /// 音频文件的 base64 编码，如果工程中没有音频则为 None
    audio_base64: Option<String>,
}

// -----------------------------------------------------------
// 辅助函数
// -----------------------------------------------------------

/// 将任意文件读取为 base64 字符串
fn file_to_base64(path: &str) -> Result<String, String> {
    let data = fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

// -----------------------------------------------------------
// Tauri 命令（前端通过 invoke 调用）
// -----------------------------------------------------------

/// 新建工程
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

/// 打开工程文件
///
/// 返回 { toml: "...", audio_base64: "..." | null }
/// 如果 zip 内包含 audio 文件，则将其以 base64 编码一并返回
#[tauri::command]
fn open_project(path: &str) -> Result<OpenProjectResult, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法读取 zip: {}", e))?;

    // 读取 project.toml（独立作用域，确保 entry 在音频读取前释放）
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

    // 尝试读取音频文件
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

/// 保存工程文件
///
/// 将 TOML 配置和可选的音频文件写入 zip 包
/// audio_path 为音频文件的磁盘路径，传入时 Rust 会读取该文件并存入 zip
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

/// 读取任意音频文件并返回 base64 编码
///
/// 用于用户在谱面编辑器中选择了音乐文件后，前端获取可播放的音频数据
#[tauri::command]
fn read_audio_file(path: &str) -> Result<String, String> {
    file_to_base64(path)
}

// -----------------------------------------------------------
// Tauri 应用入口
// -----------------------------------------------------------

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