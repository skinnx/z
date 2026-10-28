import type { DictOf } from "./types.ts";

export const en = {
  // shell
  skipToContent: "Skip to content",
  mainNav: "Main",
  nav_today: "Today",
  nav_chat: "Chat",
  nav_tasks: "Tasks",
  nav_channels: "Channels",
  nav_models: "Models",
  nav_plugins: "Plugins",
  nav_settings: "Settings",
  more: "More",
  commandMenu: "Command menu",
  searchCommands: "Jump to or do anything…",
  noResults: "No matches",
  group_go: "Go to",
  group_do: "Actions",
  group_tasks: "Tasks",
  group_threads: "Chats",
  enterToRun: "Enter to run",
  toggleTheme: "Toggle light/dark",
  switchLanguage: "Tiếng Việt",
  pendingCount: (n: number) => `${n} waiting for you`,

  // auth
  tokenTitle: "Server token",
  tokenHint: "This server requires its Z_TOKEN.",
  tokenLabel: "Token",
  tokenSave: "Connect",
  tokenWrong: "That token was rejected.",
  offline: "Can't reach the z server.",

  // UI polish: failed screens, channel status the server words in English
  reload: "Reload",
  screenFailed: "This screen didn't load. z may have just been updated: reload to get the latest version.",
} as const;

export const vi: DictOf<typeof en> = {
  skipToContent: "Chuyển đến nội dung",
  mainNav: "Điều hướng chính",
  nav_today: "Hôm nay",
  nav_chat: "Trò chuyện",
  nav_tasks: "Công việc",
  nav_channels: "Kênh",
  nav_models: "Mô hình",
  nav_plugins: "Tiện ích",
  nav_settings: "Cài đặt",
  more: "Thêm",
  commandMenu: "Bảng lệnh",
  searchCommands: "Đi tới hoặc làm bất cứ điều gì…",
  noResults: "Không có kết quả",
  group_go: "Đi tới",
  group_do: "Hành động",
  group_tasks: "Công việc",
  group_threads: "Trò chuyện",
  enterToRun: "Enter để chạy",
  toggleTheme: "Đổi sáng/tối",
  switchLanguage: "English",
  pendingCount: (n) => `${n} việc đang chờ bạn`,

  tokenTitle: "Mã truy cập máy chủ",
  tokenHint: "Máy chủ này yêu cầu Z_TOKEN.",
  tokenLabel: "Mã",
  tokenSave: "Kết nối",
  tokenWrong: "Mã không đúng.",
  offline: "Không kết nối được máy chủ z.",

  reload: "Tải lại",
  screenFailed: "Màn hình này không tải được. Có thể z vừa được cập nhật: hãy tải lại để dùng bản mới nhất.",
};
