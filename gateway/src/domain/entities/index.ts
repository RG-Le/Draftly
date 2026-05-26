// Domain entities — pure data, no framework dependencies

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  authProvider: 'google' | 'local';
  googleSub: string | null;
  role: 'user' | 'admin';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserConnection {
  id: string;
  userId: string;
  connectorType: string;
  encryptedAccessToken: Buffer;
  encryptedRefreshToken: Buffer;
  tokenExpiresAt: Date;
  status: 'active' | 'expired' | 'revoked' | 'error';
  connectorMetadata: Record<string, unknown> | null;
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailThread {
  id: string;
  connectionId: string;
  externalThreadId: string;
  subject: string | null;
  participants: Array<{ email: string; name?: string }> | null;
  messageCount: number;
  lastMessageAt: Date | null;
  syncStatus: 'synced' | 'partial' | 'error';
  createdAt: Date;
  updatedAt: Date;
  
  // Joined fields
  triage?: TriageResult | null;
  draft?: Draft | null;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  externalMessageId: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[] | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  rawHeaders: Record<string, unknown> | null;
  receivedAt: Date;
  isSentByUser: boolean;
  isDraft: boolean;
  createdAt: Date;
}

export interface Draft {
  id: string;
  threadId: string;
  userId: string;
  generatedContent: string | null;
  currentContent: string | null;
  status: DraftStatus;
  version: number;
  generationMetadata: Record<string, unknown> | null;
  idempotencyKey: string | null;
  externalDraftId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DraftStatus =
  | 'draft_pending'
  | 'draft_ready'
  | 'draft_failed'
  | 'draft_edited'
  | 'approved'
  | 'rejected'
  | 'send_queued'
  | 'sending'
  | 'sent'
  | 'send_failed';

export interface TriageResult {
  id: string;
  threadId: string;
  classification: 'reply_needed' | 'promotions' | 'info' | 'junk' | 'unclassified';
  method: 'heuristic' | 'llm' | 'hybrid';
  confidence: number | null;
  reasoning: string | null;
  llmMetadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SendAttempt {
  id: string;
  draftId: string;
  idempotencyKey: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  externalMessageId: string | null;
  errorMessage: string | null;
  attemptNumber: number;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface UserProfile {
  id: string;
  userId: string;
  greetingStyle: Record<string, unknown> | null;
  closingStyle: Record<string, unknown> | null;
  signatureTemplate: string | null;
  preferredTone: string | null;
  communicationNorms: Record<string, unknown> | null;
  currentPriorities: Record<string, unknown> | null;
  profileVersion: number;
  confidenceScore: number;
  lastCalibratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageRecord {
  id: string;
  userId: string;
  resourceType: string;
  resourceDetail: string | null;
  quantity: number;
  estimatedCostUsd: number | null;
  usageDate: Date;
  correlationId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}
