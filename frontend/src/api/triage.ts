import { apiRequest, ApiError } from '../lib/http';

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

export async function updateTriagePreferences(data: { customInstructions: string | null }): Promise<any> {
  const payload = await apiRequest<any>({
    path: '/api/v1/preferences/triage',
    method: 'PUT',
    body: { customInstructions: data.customInstructions }
  });
  return payload;
}

export async function getTriageCategories() {
  // Categories are loaded from the config — system categories cannot be removed
  const SYSTEM_CATEGORIES = ['reply_needed', 'info', 'promotions'];
  return {
    categories: [
      { id: 'reply_needed', label: 'Reply Needed', description: 'The email expects a response or action from the user.', isSystem: true },
      { id: 'already_replied', label: 'Already Replied', description: 'The user has already sent a reply after the last incoming message.', isSystem: false },
      { id: 'promotions', label: 'Promotions', description: 'Marketing emails, deals, newsletters, or broadcast content.', isSystem: true },
      { id: 'info', label: 'Info (FYI)', description: 'Informational notifications, receipts, or automated alerts — no response needed.', isSystem: true },
      { id: 'junk', label: 'Junk', description: 'Spam, irrelevant content, or unsolicited messages with no value.', isSystem: false },
    ]
  };
}
