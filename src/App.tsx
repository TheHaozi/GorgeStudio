/**
 * @fileoverview Gorge Studio 的 React 前端主组件（Tauri v2 桌面应用入口）。
 *
 * 职责：
 * 1. 使用 Ant Design 组件搭建桌面应用的 UI 布局（顶部菜单栏 + 内容区 + 侧边抽屉）；
 * 2. 通过 Tauri IPC（`invoke`）调用 Rust 后端的命令；
 * 3. 通过 `@tauri-apps/plugin-dialog` 调用系统原生文件对话框（打开/保存）；
 * 4. 以 Drawer 实现谱面编辑面板（乐曲信息、BPM、音频预览），并提供调试面板；
 * 5. 在新建/打开工程及关闭窗口前执行未保存更改确认。
 *
 * 通信流程：
 *   前端 `invoke("命令名", 参数)` → Tauri IPC 桥 → Rust `#[tauri::command]` 函数 → 返回值/错误。
 *
 * 注意：关闭窗口统一使用 `destroy()` 而非 `close()`，避免再次触发 `close-requested`
 * 导致确认流程循环；对应 capability 必须授予 `core:window:allow-destroy`。
 */

import { ConfigProvider, Layout, Menu, Drawer, Input, InputNumber, Button, Space, Select, Modal, notification, Descriptions, Tag } from "antd";
import {
  FileOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  SaveOutlined,
  SaveFilled,
  SoundOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  EditOutlined,
  ThunderboltOutlined,
  BugOutlined,
} from "@ant-design/icons";
import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

const { Header, Content } = Layout;

/** 支持的音频文件扩展名（小写、不含点号），用于选择音频文件时的对话框过滤。 */
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus", "aiff"];

/** 可选的节拍（拍号）列表，作为谱面编辑面板中节拍选择器的选项。 */
const TIME_SIGNATURES = ["2/4", "3/4", "4/4", "6/8"];

/**
 * 从文件路径中提取扩展名。
 * @param path 文件路径。
 * @returns 小写扩展名（不含点号）；路径中没有扩展名时返回空字符串。
 */
function extFromPath(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.substring(i + 1).toLowerCase() : "";
}

/**
 * 将 base64 音频数据转换为 Blob URL，供 `<audio>` 元素播放。
 * 调用方负责在用完后调用 `URL.revokeObjectURL` 释放，避免内存泄漏。
 * @param base64 纯 base64 字符串，不含 data URL 前缀。
 * @param mimeType 音频 MIME 类型，例如 `audio/mpeg`。
 * @returns 可直接赋给 `audio.src` 的 Blob URL。
 */
function base64ToBlobUrl(base64: string, mimeType: string): string {
  const byteChars = atob(base64);
  const byteNums = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNums[i] = byteChars.charCodeAt(i);
  }
  const byteArr = new Uint8Array(byteNums);
  const blob = new Blob([byteArr], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * 根据扩展名推断音频 MIME 类型。
 * @param ext 小写扩展名（不含点号），通常由 `extFromPath` 得到。
 * @returns 对应的 MIME 类型；未知扩展名回退为 `audio/mpeg`。
 */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
    m4a: "audio/mp4",
    wma: "audio/x-ms-wma",
    opus: "audio/opus",
    aiff: "audio/aiff",
  };
  return map[ext] || "audio/mpeg";
}

/**
 * 工程数据模型，与 project.toml 的字段一一对应。
 * 字段名沿用 TOML 的 snake_case 命名，避免解析/序列化时再做键名映射。
 */
interface ProjectData {
  /** 工程格式版本号，例如 `0.1.0`。 */
  version: string;
  /** 乐曲/谱面名称。 */
  song_title: string;
  /** 每分钟节拍数（BPM）。 */
  bpm: number;
  /** 节拍（拍号），例如 `4/4`。 */
  time_signature: string;
  /** 关联音频文件的扩展名（小写、不含点号）。 */
  audio_ext: string;
  /** 关联音频文件的文件名，仅用于界面展示。 */
  audio_name: string;
  /** 音符列表；当前为占位结构，音符编辑功能尚未启用。 */
  notes: { placeholder: string }[];
}

/**
 * 应用根组件：渲染顶部菜单栏、谱面编辑 Drawer、调试面板与未保存确认对话框，
 * 集中管理工程文件状态、音频播放状态以及全部 Tauri IPC 命令调用。
 */
function App() {
  // ---------- 文件状态 ----------
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [dirty, setDirty] = useState(false);

  // ---------- 谱面编辑面板状态 ----------
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [songTitle, setSongTitle] = useState("");
  const [bpm, setBpm] = useState(120);
  const [timeSignature, setTimeSignature] = useState("4/4");
  const [audioPath, setAudioPath] = useState("");
  const [audioExt, setAudioExt] = useState("");
  const [audioName, setAudioName] = useState("");

  // ---------- 音频播放状态 ----------
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // ---------- 打拍子 BPM 计算 ----------
  const [tapCount, setTapCount] = useState(0);
  const tapTimestampsRef = useRef<number[]>([]);

  // ---------- 未保存确认 ----------
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSaving, setConfirmSaving] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  // 关闭窗口的意图（来自系统关闭按钮 / Alt+F4），与 pendingActionRef 互斥
  const pendingCloseRef = useRef(false);
  const loadingRef = useRef(false);
  const dirtyRef = useRef(false);

  // 同步 dirty 到 ref，供 onCloseRequested 回调闭包使用
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  /**
   * 强制关闭当前窗口。
   * 使用 `destroy()` 而不是 `close()`：`destroy()` 不会再次触发 `close-requested`，
   * 避免“确认关闭 → close() → 又进入确认流程”的循环。
   */
  const destroyWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy();
    } catch (e) {
      console.error("关闭窗口失败:", e);
      notification.error({ message: "关闭窗口失败", description: String(e) });
    }
  }, []);

  // 监听窗口关闭请求
  // 注意：只要注册了该监听，Tauri 就会拦截原生关闭；未调用 preventDefault() 时
  // 由 @tauri-apps/api 自动调用 window.destroy() 完成关闭，
  // 因此 capability 必须授予 core:window:allow-destroy。
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        pendingCloseRef.current = true;
        pendingActionRef.current = null;
        setConfirmOpen(true);
      }
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  // ---------- 调试面板 ----------
  const [debugOpen, setDebugOpen] = useState(false);

  // Ctrl+Shift+I 切换调试面板
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        setDebugOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** 释放当前缓存的 Blob URL，防止切换音频时内存泄漏。 */
  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  // ---------- 音频播放（base64 → Blob URL → <audio>） ----------

  /**
   * 停止当前音频播放，并把播放进度复位到起点。
   * 更换音频文件前调用，避免旧音频继续出声。
   */
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setAudioPlaying(false);
  }, []);

  /**
   * 将 base64 音频载入隐藏的 `<audio>` 元素：先释放旧 Blob URL，再创建并加载新 URL。
   * @param base64 纯 base64 音频数据（不含 data URL 前缀）。
   * @param ext 音频文件扩展名，用于推断 MIME 类型。
   */
  const loadAudioFromBase64 = useCallback(
    (base64: string, ext: string) => {
      revokeBlobUrl();
      const url = base64ToBlobUrl(base64, mimeFromExt(ext));
      blobUrlRef.current = url;
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.load();
      }
    },
    [revokeBlobUrl],
  );

  /**
   * 通过 Rust 命令 `read_audio_file` 读取磁盘音频文件（base64），再交给前端播放。
   * 读取失败时打印日志并弹通知，不向上抛出异常。
   * @param path 音频文件的绝对路径。
   */
  const loadAudioFromPath = useCallback(
    async (path: string) => {
      try {
        const base64 = await invoke<string>("read_audio_file", { path });
        const ext = extFromPath(path);
        loadAudioFromBase64(base64, ext);
      } catch (e) {
        console.error("加载音频失败:", e);
        notification.error({ message: "加载音频失败", description: String(e) });
      }
    },
    [loadAudioFromBase64],
  );

  // ---------- 播放控制 ----------
  /** 播放已加载的音频；失败时打印日志并弹出错误通知，最终播放状态由 `<audio>` 事件同步。 */
  const handlePlay = useCallback(() => {
    audioRef.current?.play().catch((e) => {
      console.error("播放失败:", e);
      notification.error({ message: "播放失败", description: String(e) });
    });
    setAudioPlaying(true);
  }, []);

  /** 暂停当前音频播放，最终播放状态由 `<audio>` 的 `onPause` 事件同步。 */
  const handlePause = useCallback(() => {
    audioRef.current?.pause();
    setAudioPlaying(false);
  }, []);

  /** `<audio>` 播放自然结束：清除播放中标记。 */
  const onAudioEnded = useCallback(() => setAudioPlaying(false), []);
  /** `<audio>` 开始播放：同步播放中标记。 */
  const onAudioPlay = useCallback(() => setAudioPlaying(true), []);
  /** `<audio>` 暂停：同步播放中标记。 */
  const onAudioPause = useCallback(() => setAudioPlaying(false), []);

  // ---------- 打拍子获取 BPM ----------
  /**
   * 记录一次打拍子时间戳，并用最近最多 10 次点击的平均间隔估算 BPM。
   * 至少点击 2 次后才更新 BPM；加载工程期间不标记为已修改。
   */
  const handleTapBpm = useCallback(() => {
    const now = performance.now();
    const timestamps = tapTimestampsRef.current;
    timestamps.push(now);
    if (timestamps.length > 10) timestamps.shift();
    setTapCount(timestamps.length);
    if (timestamps.length >= 2) {
      let totalInterval = 0;
      for (let i = 1; i < timestamps.length; i++) {
        totalInterval += timestamps[i] - timestamps[i - 1];
      }
      const avgMs = totalInterval / (timestamps.length - 1);
      if (avgMs > 0) {
        const calcBpm = Math.round(60000 / avgMs);
        setBpm(calcBpm);
        if (!loadingRef.current) setDirty(true);
      }
    }
  }, []);

  /** 清空打拍子时间戳与点击计数（不改变当前 BPM）。 */
  const resetTap = useCallback(() => {
    tapTimestampsRef.current = [];
    setTapCount(0);
  }, []);

  // ---------- 加载工程数据到编辑状态 ----------
  /**
   * 将解析后的工程数据写入谱面编辑面板的受控状态。
   * 写入期间把 `loadingRef` 置为 true，供输入控件回调判断，避免程序性赋值被误记为编辑。
   * @param parsed 从 project.toml 解析出的工程数据。
   */
  const loadProjectState = useCallback((parsed: ProjectData) => {
    loadingRef.current = true;
    setProjectData(parsed);
    setSongTitle(parsed.song_title || "");
    setBpm(parsed.bpm || 120);
    setTimeSignature(parsed.time_signature || "4/4");
    setAudioExt(parsed.audio_ext || "");
    setAudioName(parsed.audio_name || "");
    loadingRef.current = false;
  }, []);

  // ---------- 文件操作回调 ----------

  /**
   * 包装可能丢失未保存更改的动作：有未保存更改时先弹确认对话框，否则立即执行。
   * 确认对话框会在保存成功或放弃修改后执行 `action`。
   * @param action 确认流程结束后要执行的回调。
   */
  const withConfirm = useCallback((action: () => void) => {
    if (dirty) {
      pendingActionRef.current = action;
      pendingCloseRef.current = false;
      setConfirmOpen(true);
    } else {
      action();
    }
  }, [dirty]);

  /**
   * 执行实际保存：已有当前路径时直接写回，否则先弹出“另存为”对话框。
   * 供 `handleSave` 与未保存确认对话框共用；失败时弹通知并返回 `false`。
   * @returns 是否保存成功；用户在另存为对话框中取消时同样返回 `false`。
   */
  const doSave = useCallback(async (): Promise<boolean> => {
    try {
      const data = buildToml();
      if (currentPath) {
        await invoke("save_project", { path: currentPath, data, audioPath: audioPath || null });
      } else {
        const selected = await save({ filters: [{ name: "Gorge 工程", extensions: ["zip"] }] });
        if (!selected) return false;
        await invoke("save_project", { path: selected, data, audioPath: audioPath || null });
        setCurrentPath(selected);
      }
      setDirty(false);
      dirtyRef.current = false;
      console.log("保存成功:", currentPath);
      return true;
    } catch (e) {
      console.error("保存失败:", e);
      notification.error({ message: "保存失败", description: String(e) });
      return false;
    }
  }, [currentPath, audioPath, songTitle, bpm, audioExt, timeSignature, audioName]);

  /**
   * 新建工程：调用 Rust 命令 `new_project` 获取默认 TOML，解析后重置编辑状态与音频。
   * 若当前工程有未保存更改，会先进入未保存确认流程。
   */
  const handleNew = useCallback(() => {
    withConfirm(async () => {
      try {
        const data = await invoke<string>("new_project");
        const parsed = parseToml(data);
        loadProjectState(parsed);
        setCurrentPath(null);
        setAudioPath("");
        setAudioName("");
        setDirty(false);
        revokeBlobUrl();
        if (audioRef.current) audioRef.current.src = "";
        setAudioPlaying(false);
        resetTap();
        console.log("新建项目成功");
      } catch (e) {
        console.error("新建失败:", e);
      }
    });
  }, [withConfirm, loadProjectState, revokeBlobUrl, resetTap]);

  /**
   * 打开工程：用原生对话框选择 .zip，再由 Rust 命令 `open_project` 解包并返回
   * TOML 文本与可选的音频 base64，随后恢复编辑状态、按需加载音频。
   * 若当前工程有未保存更改，会先进入未保存确认流程。
   */
  const handleOpen = useCallback(() => {
    withConfirm(async () => {
      try {
        const selected = await open({
          filters: [{ name: "Gorge 工程", extensions: ["zip"] }],
          multiple: false,
        });
        if (!selected) return;

        const result = await invoke<{ toml: string; audio_base64: string | null }>(
          "open_project",
          { path: selected },
        );
        const parsed = parseToml(result.toml);
        loadProjectState(parsed);
        setCurrentPath(selected);
        setAudioPath("");
        setDirty(false);
        resetTap();

        if (result.audio_base64) {
          loadAudioFromBase64(result.audio_base64, parsed.audio_ext || "mp3");
        } else {
          revokeBlobUrl();
          if (audioRef.current) audioRef.current.src = "";
        }
        setAudioPlaying(false);
        console.log("打开文件:", selected);
      } catch (e) {
        console.error("打开失败:", e);
        notification.error({
          message: "打开工程失败",
          description: "所选文件不是有效的 Gorge 工程文件（.zip 内缺少 project.toml）",
        });
      }
    });
  }, [withConfirm, loadProjectState, loadAudioFromBase64, revokeBlobUrl, resetTap]);

  /** 保存当前工程；首次保存（尚无当前路径）时由 `doSave` 弹出另存为对话框。 */
  const handleSave = useCallback(async () => {
    doSave();
  }, [doSave]);

  /** 另存为：选择新的 .zip 路径写入当前编辑内容，成功后切换当前路径。 */
  const handleSaveAs = useCallback(async () => {
    try {
      const selected = await save({
        filters: [{ name: "Gorge 工程", extensions: ["zip"] }],
      });
      if (!selected) return;
      const data = buildToml();
      await invoke("save_project", { path: selected, data, audioPath: audioPath || null });
      setCurrentPath(selected);
      setDirty(false);
      console.log("另存为:", selected);
    } catch (e) {
      console.error("另存为失败:", e);
      notification.error({ message: "另存为失败", description: String(e) });
    }
  }, [audioPath, songTitle, bpm, audioExt, timeSignature, audioName]);

  // ---------- 谱面菜单操作 ----------

  /**
   * 选择音乐文件：立即停止当前播放，记录文件名与扩展名并标记为已修改，
   * 再由 Rust 命令 `read_audio_file` 读取音频内容并切换播放源；取消对话框时保持现状。
   */
  const handleSelectMusic = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: "音频文件", extensions: AUDIO_EXTENSIONS }],
        multiple: false,
      });
      if (!selected) return;
      // 立刻停止当前播放
      stopAudio();
      const path = selected as string;
      setAudioPath(path);
      const ext = extFromPath(path);
      setAudioExt(ext);
      const name = path.replace(/\\/g, "/").split("/").pop() || path;
      setAudioName(name);
      setDirty(true);
      await loadAudioFromPath(path);
    } catch (e) {
      console.error("选择音乐失败:", e);
    }
  }, [loadAudioFromPath, stopAudio]);

  /** 打开谱面编辑面板（Drawer）。 */
  const handleEditSheet = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  // ---------- 未保存确认对话框 ----------
  // S2 行为：仅在保存成功后关闭弹窗并执行后续动作；用户取消另存为或保存失败时保留弹窗并给出反馈。
  /**
   * 确认对话框的“保存”分支：先执行保存，成功后关闭弹窗并继续被拦截的动作
   * （关闭窗口或待执行的工程操作）；保存失败/取消时保留弹窗（S2 行为）。
   */
  const handleConfirmSave = useCallback(async () => {
    if (confirmSaving) return;
    const wasClosing = pendingCloseRef.current;
    const pendingAction = pendingActionRef.current;
    setConfirmSaving(true);
    let ok = false;
    try {
      ok = await doSave();
    } finally {
      setConfirmSaving(false);
    }
    if (!ok) return;

    setConfirmOpen(false);
    pendingCloseRef.current = false;
    pendingActionRef.current = null;
    if (wasClosing) {
      await destroyWindow();
    } else {
      pendingAction?.();
    }
  }, [confirmSaving, doSave, destroyWindow]);

  /** 确认对话框的“不保存”分支：放弃未保存更改后继续被拦截的动作（S2 行为）。 */
  const handleConfirmDiscard = useCallback(() => {
    if (confirmSaving) return;
    const wasClosing = pendingCloseRef.current;
    const pendingAction = pendingActionRef.current;
    pendingCloseRef.current = false;
    pendingActionRef.current = null;
    setConfirmOpen(false);
    setDirty(false);
    dirtyRef.current = false;
    if (wasClosing) {
      void destroyWindow();
    } else {
      pendingAction?.();
    }
  }, [confirmSaving, destroyWindow]);

  /** 确认对话框的“取消”分支：仅关闭弹窗，保留编辑内容与 dirty 状态。 */
  const handleConfirmCancel = useCallback(() => {
    if (confirmSaving) return;
    pendingCloseRef.current = false;
    pendingActionRef.current = null;
    setConfirmOpen(false);
  }, [confirmSaving]);

  // ---------- 辅助函数 ----------

  /**
   * 极简 TOML 解析：只识别 `key = value` 形式的单层键值对，足以读取 project.toml。
   * 忽略注释行与空行，并去掉值两侧的引号；无法识别的键保持默认值。
   * @param toml project.toml 的原始文本。
   * @returns 解析出的工程数据；缺失字段使用默认值（如 BPM 120、4/4）。
   */
  function parseToml(toml: string): ProjectData {
    const result: ProjectData = {
      version: "0.1.0",
      song_title: "",
      bpm: 120,
      time_signature: "4/4",
      audio_ext: "",
      audio_name: "",
      notes: [],
    };
    const lines = toml.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed === "") continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      switch (key) {
        case "version": result.version = val; break;
        case "song_title": result.song_title = val; break;
        case "bpm": result.bpm = parseFloat(val) || 120; break;
        case "time_signature": result.time_signature = val; break;
        case "audio_ext": result.audio_ext = val; break;
        case "audio_name": result.audio_name = val; break;
      }
    }
    return result;
  }

  /**
   * 将当前编辑状态序列化为 project.toml 文本（字段顺序与后端结构一致）。
   * 字符串值会转义反斜杠与双引号；`notes` 目前为占位字段，不参与序列化。
   * @returns 可供保存命令写入的 TOML 文本（末尾带换行符）。
   */
  function buildToml(): string {
    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return [
      `version = "${escape(projectData?.version || "0.1.0")}"`,
      `song_title = "${escape(songTitle)}"`,
      `bpm = ${bpm}`,
      `time_signature = "${escape(timeSignature)}"`,
      `audio_ext = "${escape(audioExt)}"`,
      `audio_name = "${escape(audioName)}"`,
    ].join("\n") + "\n";
  }

  // ---------- 菜单定义 ----------

  /** “文件”菜单项：新建、打开、保存、另存为。 */
  const fileMenuItems = [
    { key: "file-new", icon: <FileAddOutlined />, label: "新建" },
    { key: "file-open", icon: <FolderOpenOutlined />, label: "打开" },
    { type: "divider" as const },
    { key: "file-save", icon: <SaveOutlined />, label: "保存" },
    { key: "file-saveas", icon: <SaveFilled />, label: "另存为" },
  ];

  /** “谱面”菜单项：选择音乐、编辑谱面。 */
  const sheetMenuItems = [
    { key: "sheet-music", icon: <SoundOutlined />, label: "选择音乐" },
    { key: "sheet-edit", icon: <EditOutlined />, label: "编辑谱面" },
  ];

  /** 顶栏一级菜单：文件、谱面。 */
  const menuItems = [
    { key: "file", icon: <FileOutlined />, label: "文件", children: fileMenuItems },
    { key: "sheet", icon: <SoundOutlined />, label: "谱面", children: sheetMenuItems },
  ];

  /**
   * 顶栏菜单点击分发：按菜单项 key 调用对应的文件/谱面操作。
   * @param info Ant Design Menu 的点击信息，只使用其中的 `key` 字段。
   */
  const onMenuClick = useCallback(
    (info: { key: string }) => {
      switch (info.key) {
        case "file-new": handleNew(); break;
        case "file-open": handleOpen(); break;
        case "file-save": handleSave(); break;
        case "file-saveas": handleSaveAs(); break;
        case "sheet-music": handleSelectMusic(); break;
        case "sheet-edit": handleEditSheet(); break;
      }
    },
    [handleNew, handleOpen, handleSave, handleSaveAs, handleSelectMusic, handleEditSheet],
  );

  return (
    <ConfigProvider>
      <Layout style={{ minHeight: "100vh" }}>
        <Header
          style={{ display: "flex", alignItems: "center", padding: 0, background: "#fff", borderBottom: "1px solid #f0f0f0" }}
        >
          <div style={{ fontWeight: 600, fontSize: 16, padding: "0 24px", whiteSpace: "nowrap" }}>
            Gorge Studio
          </div>
          <Menu mode="horizontal" selectable={false} items={menuItems} onClick={onMenuClick} style={{ flex: 1, minWidth: 0 }} />
        </Header>
        <Content style={{ flex: 1, background: "#f5f5f5" }} />

        {/* 未保存确认对话框 */}
        <Modal
          open={confirmOpen}
          title="未保存的更改"
          onCancel={handleConfirmCancel}
          closable={!confirmSaving}
          maskClosable={!confirmSaving}
          keyboard={!confirmSaving}
          footer={[
            <Button key="cancel" onClick={handleConfirmCancel} disabled={confirmSaving}>取消</Button>,
            <Button key="discard" onClick={handleConfirmDiscard} disabled={confirmSaving}>不保存</Button>,
            <Button key="save" type="primary" onClick={handleConfirmSave} loading={confirmSaving}>保存</Button>,
          ]}
        >
          <p>当前工程有未保存的更改，是否保存？</p>
        </Modal>

        {/* 谱面编辑 Drawer */}
        <Drawer
          title="编辑谱面"
          placement="right"
          width={400}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {/* 谱面名称 */}
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>谱面名称</div>
              <Input
                value={songTitle}
                onChange={(e) => { setSongTitle(e.target.value); if (!loadingRef.current) setDirty(true); }}
                placeholder="输入谱面名称"
              />
            </div>

            {/* BPM */}
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>BPM</div>
              <InputNumber
                value={bpm}
                onChange={(v) => { setBpm(v ?? 120); if (!loadingRef.current) setDirty(true); }}
                min={1}
                max={999}
                step={0.01}
                style={{ width: "100%" }}
              />
            </div>

            {/* 节拍 */}
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>节拍</div>
              <Select
                value={timeSignature}
                onChange={(v) => { setTimeSignature(v); if (!loadingRef.current) setDirty(true); }}
                style={{ width: "100%" }}
                options={TIME_SIGNATURES.map((ts) => ({ value: ts, label: ts }))}
              />
            </div>

            {/* 音乐名称 */}
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>音乐名称</div>
              <Input
                value={audioName}
                readOnly
                placeholder="点击选择音乐文件"
                onClick={handleSelectMusic}
                style={{ cursor: "pointer" }}
              />
            </div>

            {/* 播放/暂停按钮 */}
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>音乐预览</div>
              <Space>
                {audioPlaying ? (
                  <Button icon={<PauseCircleOutlined />} onClick={handlePause}>暂停</Button>
                ) : (
                  <Button icon={<PlayCircleOutlined />} onClick={handlePlay}>播放</Button>
                )}
              </Space>
            </div>

            {/* 打拍子获取 BPM */}
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>
                打拍子获取 BPM
                {tapCount > 0 && (
                  <span style={{ fontWeight: 400, marginLeft: 8, color: "#888" }}>
                    已点击 {tapCount} 次
                  </span>
                )}
              </div>
              <Space>
                <Button icon={<ThunderboltOutlined />} onClick={handleTapBpm} type="primary">打拍子</Button>
                <Button onClick={resetTap} disabled={tapCount === 0}>重置</Button>
              </Space>
            </div>
          </Space>

          <audio
            ref={audioRef}
            style={{ display: "none" }}
            onEnded={onAudioEnded}
            onPlay={onAudioPlay}
            onPause={onAudioPause}
          />
        </Drawer>

        {/* 调试面板（Ctrl+Shift+I 切换） */}
        <Drawer
          title={<span><BugOutlined /> 调试面板</span>}
          placement="left"
          width={420}
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={2} size="small" bordered title="工程状态">
              <Descriptions.Item label="当前路径" span={2}>
                {currentPath || <Tag color="red">未保存</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="dirty">
                <Tag color={dirty ? "orange" : "green"}>{dirty ? "已修改" : "未修改"}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="drawerOpen">
                <Tag color={drawerOpen ? "blue" : "default"}>{drawerOpen ? "打开" : "关闭"}</Tag>
              </Descriptions.Item>
            </Descriptions>

            <Descriptions column={2} size="small" bordered title="谱面数据">
              <Descriptions.Item label="song_title">{songTitle || "(空)"}</Descriptions.Item>
              <Descriptions.Item label="bpm">{bpm}</Descriptions.Item>
              <Descriptions.Item label="time_signature">{timeSignature}</Descriptions.Item>
              <Descriptions.Item label="audio_ext">{audioExt || "(空)"}</Descriptions.Item>
              <Descriptions.Item label="audio_name">{audioName || "(空)"}</Descriptions.Item>
              <Descriptions.Item label="audioPath" span={2}>
                <span style={{ wordBreak: "break-all", fontSize: 12 }}>{audioPath || "(空)"}</span>
              </Descriptions.Item>
            </Descriptions>

            <Descriptions column={2} size="small" bordered title="音频状态">
              <Descriptions.Item label="audioPlaying">
                <Tag color={audioPlaying ? "green" : "default"}>{audioPlaying ? "播放中" : "已停止"}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="tapCount">{tapCount}</Descriptions.Item>
              <Descriptions.Item label="blobUrl" span={2}>
                <span style={{ wordBreak: "break-all", fontSize: 11 }}>
                  {blobUrlRef.current || "(空)"}
                </span>
              </Descriptions.Item>
            </Descriptions>

            <Descriptions column={1} size="small" bordered title="TOML 内容">
              <Descriptions.Item label="buildToml()">
                <pre style={{ margin: 0, fontSize: 12, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {buildToml()}
                </pre>
              </Descriptions.Item>
            </Descriptions>

            <Descriptions column={1} size="small" bordered title="projectData (raw)">
              <Descriptions.Item>
                <pre style={{ margin: 0, fontSize: 11, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(projectData, null, 2)}
                </pre>
              </Descriptions.Item>
            </Descriptions>
          </Space>
        </Drawer>
      </Layout>
    </ConfigProvider>
  );
}

export default App;