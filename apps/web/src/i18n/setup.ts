import type { DictOf } from "./types.ts";

export const en = {
  // settings surface
  set_setup: "Setup",
  checkAgain: "Check again",
  checking: "Checking…",
  setupSummary: (ready: number, total: number) => `${ready} of ${total} ready`,
  setupCheckedAt: (when: string) => `Checked ${when}`,
  setupNeverChecked: "Not checked yet",
  setupFirstRun: "z needs a model that answers before anything else works.",
  setup_ready: "Ready",
  setup_needs_setup: "Needs setup",
  setup_not_checked: "Not checked",
  setup_optional: "Optional",
  continueAnyway: "Continue to Today",
  diagnostics: "Diagnostics",
  diagnosticsHint: "Version, setup checks, statuses and the last 200 server log lines. Secrets are replaced by [secret:…].",
  copyDiagnostics: "Copy diagnostics",
  diagnosticsCopied: "Diagnostics copied",
  download: "Download",
} as const;

export const vi: DictOf<typeof en> = {
  set_setup: "Thiết lập",
  checkAgain: "Kiểm tra lại",
  checking: "Đang kiểm tra…",
  setupSummary: (ready: number, total: number) => `${ready}/${total} đã sẵn sàng`,
  setupCheckedAt: (when: string) => `Đã kiểm tra ${when}`,
  setupNeverChecked: "Chưa kiểm tra",
  setupFirstRun: "z cần một mô hình trả lời được trước khi mọi thứ khác hoạt động.",
  setup_ready: "Sẵn sàng",
  setup_needs_setup: "Cần thiết lập",
  setup_not_checked: "Chưa kiểm tra",
  setup_optional: "Tùy chọn",
  continueAnyway: "Tiếp tục tới Hôm nay",
  diagnostics: "Chẩn đoán",
  diagnosticsHint: "Phiên bản, kết quả kiểm tra, trạng thái và 200 dòng nhật ký máy chủ gần nhất. Bí mật được thay bằng [secret:…].",
  copyDiagnostics: "Sao chép chẩn đoán",
  diagnosticsCopied: "Đã sao chép chẩn đoán",
  download: "Tải xuống",
};
