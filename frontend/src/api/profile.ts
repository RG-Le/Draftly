import { ApiError, apiRequest } from '../lib/http';
import type { AutoSyncPreference, ProfileData, UserPreference } from '../types';

function mapProfile(raw: any): ProfileData {
  if (!raw || typeof raw !== 'object') return {};

  return {
    greetingStyle: raw.greetingStyle || raw.greeting_style,
    closingStyle: raw.closingStyle || raw.closing_style,
    preferredTone: raw.preferredTone || raw.preferred_tone || 'professional',
    personalizedProfile:
      raw.personalizedProfile ||
      raw.personalized_profile ||
      raw.profileSummary ||
      raw.profile_summary ||
      '',
    signatureTemplate: raw.signatureTemplate || raw.signature_template || '',
    communicationNorms: raw.communicationNorms || raw.communication_norms,
    profileVersion: raw.profileVersion || raw.profile_version,
    confidenceScore: raw.confidenceScore || raw.confidence_score,
    lastCalibratedAt: raw.lastCalibratedAt || raw.last_calibrated_at || null,
    profileSource: raw.profileSource || raw.profile_source || 'default',
    isAiGenerated: raw.isAiGenerated ?? raw.is_ai_generated ?? false
  };
}

function toUpdatePayload(patch: Partial<ProfileData>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (patch.preferredTone !== undefined) {
    payload.preferredTone = patch.preferredTone;
    payload.preferred_tone = patch.preferredTone;
  }
  if (patch.personalizedProfile !== undefined) {
    payload.personalizedProfile = patch.personalizedProfile;
    payload.personalized_profile = patch.personalizedProfile;
  }
  if (patch.signatureTemplate !== undefined) {
    payload.signatureTemplate = patch.signatureTemplate;
    payload.signature_template = patch.signatureTemplate;
  }
  return payload;
}

export async function getProfile(): Promise<ProfileData | null> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/profile',
      method: 'GET'
    });
    return mapProfile(payload.profile || payload);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return null;
    }
    throw error;
  }
}

export async function updateProfile(patch: Partial<ProfileData>): Promise<ProfileData | null> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/profile',
      method: 'PUT',
      body: toUpdatePayload(patch)
    });
    return mapProfile(payload.profile || payload);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return null;
    }
    throw error;
  }
}

export async function getPreferences(): Promise<UserPreference[]> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/preferences',
      method: 'GET'
    });
    return payload.preferences || [];
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return [];
    }
    throw error;
  }
}

export async function updatePreference(key: string, value: unknown): Promise<void> {
  await apiRequest({
    path: '/api/v1/preferences',
    method: 'PUT',
    body: { key, value }
  });
}

export async function getAutoSyncPreference(): Promise<AutoSyncPreference> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/preferences/auto-sync',
      method: 'GET'
    });
    return {
      enabled: Boolean(payload.enabled ?? payload.autoSync ?? false),
      intervalHours: Number(payload.intervalHours ?? payload.interval_hours ?? 24),
      lastSyncAt: payload.lastSyncAt ?? payload.last_sync_at ?? null,
      gmailConnected: payload.gmailConnected ?? payload.gmail_connected ?? true
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return { enabled: false, intervalHours: 24, lastSyncAt: null, gmailConnected: false };
    }
    throw error;
  }
}

export async function updateAutoSyncPreference(data: { enabled: boolean; intervalHours: number }): Promise<void> {
  try {
    await apiRequest({
      path: '/api/v1/preferences/auto-sync',
      method: 'PUT',
      body: { enabled: data.enabled, intervalHours: data.intervalHours }
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      await updatePreference('autoSync', data.enabled);
      await updatePreference('autoSyncIntervalHours', data.intervalHours);
      return;
    }
    throw error;
  }
}

export async function regenerateProfile(): Promise<void> {
  await apiRequest({
    path: '/api/v1/profile/regenerate',
    method: 'POST',
    body: {}
  });
}

// ── Triage Preferences ────────────────────────────────────────────────────────

export async function getTriagePreferences(): Promise<{ customInstructions: string | null }> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/preferences/triage',
      method: 'GET'
    });
    return {
      customInstructions: payload.customInstructions ?? null
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return { customInstructions: null };
    }
    throw error;
  }
}

export async function updateTriagePreferences(data: { customInstructions: string }): Promise<any> {
  const payload = await apiRequest<any>({
    path: '/api/v1/preferences/triage',
    method: 'PUT',
    body: { customInstructions: data.customInstructions }
  });
  return payload;
}
