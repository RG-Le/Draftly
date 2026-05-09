import { ApiError, apiRequest } from '../lib/http';
import type { ProfileData, UserPreference } from '../types';

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
    lastCalibratedAt: raw.lastCalibratedAt || raw.last_calibrated_at || null
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
