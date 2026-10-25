// ============================================================
// Gorge Studio - React 前端
// ============================================================
// 本文件是 Tauri 应用的前端主组件，负责：
// 1. 使用 Ant Design 组件搭建桌面应用的 UI 布局
// 2. 通过 Tauri IPC（invoke）调用 Rust 后端的命令
// 3. 通过 @tauri-apps/plugin-dialog 调用系统原生文件对话框
// 4. 谱面编辑器侧边面板（Drawer）—— 乐曲信息、BPM、音频预览
//
// 通信流程：
//   前端 invoke("命令名")  →  Tauri IPC 桥  →  Rust #[tauri::command] 函数
// ============================================================

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

/// 支持的音频文件扩展名
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus", "aiff"];

/// 可选节拍
const TIME_SIGNATURES = ["2/4", "3/4", "4/4", "6/8"];

/// 从文件路径中提取扩展名（不含点号）
function extFromPath(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.substring(i + 1).toLowerCase() : "";
}

/// 将 base64 字符串转为 Blob URL，供 <audio> 元素使用
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

/// 根据扩展名推断 MIME 类型
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

// ============================================================
// 工程数据的 TypeScript 接口
// ============================================================
interface ProjectData {
  version: string;
  song_title: string;
  bpm: number;
  time_signature: string;
  audio_ext: string;
  audio_name: string;
  notes: { placeholder: string }[];
}

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
  const pendingActionRef = useRef<(() => void) | null>(null);
  const loadingRef = useRef(false);
  const dirtyRef = useRef(false);
  const closeRequestedRef = useRef<(() => void) | null>(null);

  // 同步 dirty 到 ref，供 onCloseRequested 回调闭包使用
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // 监听窗口关闭请求
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      if (dirtyRef.current) {
        event.preventDefault();
        closeRequestedRef.current = () => appWindow.close();
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

  /// 释放旧的 blob URL
  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  // ============================================
  // 音频播放（核心：base64 → blob URL → <audio>）
  // ============================================

  /// 停止当前音频播放
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setAudioPlaying(false);
  }, []);

  /// 给定 base64 和扩展名，创建 blob URL 并加载到 audio 元素
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

  /// 通过 Rust 命令读取磁盘音频文件并加载播放
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
  const handlePlay = useCallback(() => {
    audioRef.current?.play().catch((e) => {
      console.error("播放失败:", e);
      notification.error({ message: "播放失败", description: String(e) });
    });
    setAudioPlaying(true);
  }, []);

  const handlePause = useCallback(() => {
    audioRef.current?.pause();
    setAudioPlaying(false);
  }, []);

  const onAudioEnded = useCallback(() => setAudioPlaying(false), []);
  const onAudioPlay = useCallback(() => setAudioPlaying(true), []);
  const onAudioPause = useCallback(() => setAudioPlaying(false), []);

  // ---------- 打拍子获取 BPM ----------
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

  const resetTap = useCallback(() => {
    tapTimestampsRef.current = [];
    setTapCount(0);
  }, []);

  // ============================================
  // 加载工程数据到编辑状态
  // ============================================
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

  // ============================================
  // 文件操作回调
  // ============================================

  /// 带未保存确认的动作包装
  const withConfirm = useCallback((action: () => void) => {
    if (dirty) {
      pendingActionRef.current = action;
      setConfirmOpen(true);
    } else {
      action();
    }
  }, [dirty]);

  /// 执行实际保存（供 handleSave 和确认对话框共用）
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

  /// 新建工程
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

  /// 打开工程
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

  /// 保存工程
  const handleSave = useCallback(async () => {
    doSave();
  }, [doSave]);

  /// 另存为
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

  // ============================================
  // 谱面菜单操作
  // ============================================

  /// 选择音乐文件（更换时停止当前播放）
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

  /// 打开谱面编辑面板
  const handleEditSheet = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  // ============================================
  // 未保存确认对话框
  // ============================================
  const handleConfirmSave = useCallback(async () => {
    setConfirmOpen(false);
    const ok = await doSave();
    if (ok) {
      if (closeRequestedRef.current) {
        closeRequestedRef.current();
        closeRequestedRef.current = null;
      } else {
        pendingActionRef.current?.();
      }
    }
  }, [doSave]);

  const handleConfirmDiscard = useCallback(() => {
    setConfirmOpen(false);
    setDirty(false);
    dirtyRef.current = false;
    if (closeRequestedRef.current) {
      closeRequestedRef.current();
      closeRequestedRef.current = null;
    } else {
      pendingActionRef.current?.();
    }
  }, []);

  const handleConfirmCancel = useCallback(() => {
    setConfirmOpen(false);
    closeRequestedRef.current = null;
  }, []);

  // ============================================
  // 辅助函数
  // ============================================

  /// 简易 TOML 解析
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

  /// 将当前编辑状态构建为 TOML 字符串
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

  // ============================================
  // 菜单定义
  // ============================================

  const fileMenuItems = [
    { key: "file-new", icon: <FileAddOutlined />, label: "新建" },
    { key: "file-open", icon: <FolderOpenOutlined />, label: "打开" },
    { type: "divider" as const },
    { key: "file-save", icon: <SaveOutlined />, label: "保存" },
    { key: "file-saveas", icon: <SaveFilled />, label: "另存为" },
  ];

  const sheetMenuItems = [
    { key: "sheet-music", icon: <SoundOutlined />, label: "选择音乐" },
    { key: "sheet-edit", icon: <EditOutlined />, label: "编辑谱面" },
  ];

  const menuItems = [
    { key: "file", icon: <FileOutlined />, label: "文件", children: fileMenuItems },
    { key: "sheet", icon: <SoundOutlined />, label: "谱面", children: sheetMenuItems },
  ];

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

        {/* ============================================ */}
        {/* 未保存确认对话框 */}
        {/* ============================================ */}
        <Modal
          open={confirmOpen}
          title="未保存的更改"
          onCancel={handleConfirmCancel}
          footer={[
            <Button key="cancel" onClick={handleConfirmCancel}>取消</Button>,
            <Button key="discard" onClick={handleConfirmDiscard}>不保存</Button>,
            <Button key="save" type="primary" onClick={handleConfirmSave}>保存</Button>,
          ]}
        >
          <p>当前工程有未保存的更改，是否保存？</p>
        </Modal>

        {/* ============================================ */}
        {/* 谱面编辑 Drawer */}
        {/* ============================================ */}
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

        {/* ============================================ */}
        {/* 调试面板（Ctrl+Shift+I 切换） */}
        {/* ============================================ */}
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