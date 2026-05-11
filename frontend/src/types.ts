export type Nullable<T> = T | null;

export interface User {
  id: string;
  email: string;
  name: string;
  role?: string;
  authProvider?: string;
}

export type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'error' | string;

export interface ConnectionSummary {
  id?: string;
  connectorType: string;
  displayName: string;
  status: ConnectionStatus;
  connected: boolean;
  isUsable?: boolean;
  lastSyncedAt?: string | null;
  lastSyncStatus?: string | null;
}

export type TriageClassification =
  | 'reply_needed'
  | 'promotions'
  | 'info'
  | 'informational_no_action'
  | 'notification_or_subscription'
  | 'cc_or_bulk_low_priority'
  | string;

export interface ThreadSummary {
  id: string;
  subject: string;
  participants: Array<{ email: string; name?: string }>;
  messageCount: number;
  lastMessageAt?: string | null;
  syncStatus?: string;
  triage?: {
    classification: TriageClassification;
    confidence?: number | null;
    reasoning?: string | null;
  } | null;
  latestDraft?: {
    id: string;
    status: string;
    version?: number;
  } | null;
}

export interface ThreadMessage {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  receivedAt?: string | null;
  isSentByUser: boolean;
}

export interface DraftSummary {
  id: string;
  threadId: string;
  threadSubject?: string;
  status: string;
  generatedContent?: string | null;
  currentContent?: string | null;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  triage?: {
    classification: TriageClassification;
    confidence?: number | null;
    method?: string;
    reasoning?: string | null;
  } | null;
  draft?: DraftSummary | null;
}

export interface Pagination {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  count?: number;
  offset?: number;
}

export interface SendsHistoryItem {
  id: string;
  draftId?: string;
  threadSubject?: string;
  status: string;
  externalMessageId?: string | null;
  attemptNumber?: number;
  queuedAt?: string | null;
  completedAt?: string | null;
}

export interface UsageSummary {
  month: string;
  totalEstimatedCost?: number;
  currency?: string;
  breakdown?: Record<string, unknown>;
}

export interface UsageRecord {
  resourceType: string;
  resourceDetail?: string;
  quantity: number;
  estimatedCostUsd?: number;
  usageDate?: string;
  correlationId?: string;
}

export interface ProfileData {
  greetingStyle?: Record<string, string>;
  closingStyle?: Record<string, string>;
  signatureTemplate?: string;
  preferredTone?: string;
  personalizedProfile?: string;
  communicationNorms?: Record<string, unknown>;
  profileVersion?: number;
  confidenceScore?: number;
  lastCalibratedAt?: string | null;
}

export interface UserPreference {
  key: string;
  value: unknown;
}

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface AutoSyncPreference {
  enabled: boolean;
  intervalHours: number;
  lastSyncAt?: string | null;
  gmailConnected?: boolean;
}

export interface UsageStats {
  period: string;
  emailsSynced: number;
  emailsClassified: number;
  heuristicClassified: number;
  llmClassified: number;
  triageBreakdown: Record<string, number>;
  draftsGenerated: number;
  draftsApproved: number;
  draftsSent: number;
  totalLlmCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}
