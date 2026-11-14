// Mirrors server/internal/store/models.go.

export const STATUSES = ['new', 'triaged', 'in_progress', 'resolved', 'closed'] as const;
export const PRIORITIES = ['P0_Critical', 'P1_High', 'P2_Normal', 'P3_Low'] as const;
export const CATEGORIES = ['bug', 'feature', 'query', 'amc_request'] as const;
export const SCOPES = ['unclassified', 'bug', 'change_request'] as const;

export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Scope = (typeof SCOPES)[number];

export interface TicketSummary {
  id: string;
  ticket_code: string;
  project_id: string;
  project_name: string;
  team_id: string | null;
  assignee_id: string | null;
  parent_ticket_id: string | null;
  title: string;
  category: Category;
  priority: Priority;
  status: Status;
  scope_class: Scope;
  reporter_name: string | null;
  reporter_email: string | null;
  app_version: string | null;
  has_attachments: boolean;
  duplicate_count: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  ticket_id: string;
  author_type: 'client' | 'developer' | 'system';
  author_id: string | null;
  body: string;
  is_internal: boolean;
  created_at: string;
}

export interface AttachmentMeta {
  id: string;
  ticket_id: string;
  message_id: string | null;
  file_name: string;
  mime_type: string;
  compression_type: string;
  thumbnail_b64: string | null;
  compressed_size: number | null;
  created_at: string;
}

export interface TicketRef {
  id: string;
  ticket_code: string;
  title: string;
  status: Status;
}

export type TelemetryEvent =
  | { t: number; k: 'click'; el: string; text?: string }
  | { t: number; k: 'route'; to: string }
  | { t: number; k: 'console'; msg: string }
  | { t: number; k: 'error'; msg: string; src?: string }
  | { t: number; k: 'http'; m: string; url: string; status: number; ms: number; err?: string };

export interface Telemetry {
  v?: number;
  captured_at?: string;
  env?: Record<string, string | number | boolean | null>;
  events?: TelemetryEvent[];
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  telemetry: Telemetry | null;
  messages: Message[];
  attachments: AttachmentMeta[];
  parent: TicketRef | null;
  duplicates: TicketRef[];
}

export interface Project {
  id: string;
  name: string;
  project_key: string;
  allowed_origins: string[];
  is_active: boolean;
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type SnagEvent =
  | { type: 'ticket.created' | 'ticket.updated'; data: TicketSummary }
  | { type: 'message.created'; data: { ticket_id: string; ticket_code: string; message: Message } };

// ---- users, roles & permissions ----

export interface User {
  id: string;
  email: string;
  name: string;
  role_id: string;
  role_name: string;
  is_owner: boolean;
  is_active: boolean;
  permissions: string[];
  last_login_at: string | null;
  created_at: string;
}

/** The signed-in user; `permissions` are effective (the owner gets every key). */
export type Me = User;

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  user_count: number;
  created_at: string;
}

export interface PermissionDef {
  key: string;
  group: string;
  label: string;
  description: string;
}

export interface DirectoryEntry {
  id: string;
  name: string;
}
