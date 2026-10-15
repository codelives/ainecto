export const ATTACHMENTS_UPLOAD_COMMAND_PATH = ["attachments", "upload"] as const;
/** 알림·할 일 폴링(종료 코드 0 = 새 것 있음 · 3 = 없음) — inboxPollCommands.ts. */
export const NOTIFICATIONS_POLL_COMMAND_PATH = ["notifications", "poll"] as const;
export const NOTIFICATIONS_ACK_COMMAND_PATH = ["notifications", "ack"] as const;
export const AGENT_TODOS_POLL_COMMAND_PATH = ["agent-todos", "poll"] as const;

export const BESPOKE_COMMAND_PATHS = [
  ATTACHMENTS_UPLOAD_COMMAND_PATH,
  NOTIFICATIONS_POLL_COMMAND_PATH,
  NOTIFICATIONS_ACK_COMMAND_PATH,
  AGENT_TODOS_POLL_COMMAND_PATH,
] as const;
