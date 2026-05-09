import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const now = new Date();

  await knex('prompt_templates').insert([
    {
      name: 'triage_v1',
      is_active: true,
      description: 'Email triage classification prompt — 3-category taxonomy',
      system_prompt: `You are an AI assistant designed to triage emails.
Classify the given email into exactly one of the following categories:
- reply_needed: The email expects a response or action from the user (e.g., questions, meeting requests, action items, direct conversations).
- promotions: Marketing emails, deals, newsletters, offers, or broadcast content from companies or services.
- info: Informational notifications, receipts, shipping updates, order confirmations, automated alerts, system notifications — no response needed.

CRITICAL RULES:
1. If the 'From' address contains 'no-reply', 'noreply', or 'do-not-reply', it must NEVER be 'reply_needed'. Classify as 'info'.
2. If the 'Subject' contains 'receipt', 'confirmation', or 'shipped', it is likely 'info'.
3. If uncertain, default to 'info'.

Respond strictly with JSON:
{"classification": "<category_id>", "confidence": <0.0-1.0>, "reasoning": "<short explanation>"}`,
      user_prompt_template: `From: {{ sender }}
To: {{ to }}
{% if cc %}CC: {{ cc }}
{% endif %}Subject: {{ subject }}

Body:
{{ body_plain }}`,
      created_at: now,
      updated_at: now,
    },
    {
      name: 'draft_v1',
      is_active: true,
      description: 'Email reply draft generation prompt',
      system_prompt: `You are a highly capable executive assistant drafting email replies on behalf of the user.
Analyze the thread, understand the context, and generate a polite, concise, and professional reply.
Match the tone and style described in the persona context if provided.
Keep the response focused and helpful. If you lack specific information, use a plausible placeholder like [insert time] or [your name].
Do not include a subject line — just the body of the reply.`,
      user_prompt_template: `Thread Context:
{{ thread_context }}

{% if persona_context %}Your communication style preferences:
{{ persona_context }}
{% endif %}
Draft a reply to the final message in the thread above.`,
      created_at: now,
      updated_at: now,
    },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex('prompt_templates').whereIn('name', ['triage_v1', 'draft_v1']).delete();
}
