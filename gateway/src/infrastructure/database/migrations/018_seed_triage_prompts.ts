import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const now = new Date();
  
  await knex('prompt_templates').insert([
    {
      name: 'triage_v1',
      description: 'Single-thread triage classification prompt',
      system_prompt: `You are an AI assistant designed to triage emails.
Classify the given email into exactly one of the following categories:
{{ categories }}

If uncertain, default to '{{ default_fallback }}'.

Respond strictly with JSON:
{"classification": "<category_id>", "confidence": <0.0-1.0>, "reasoning": "<short explanation>"}`,
      user_prompt_template: '{{ email_content }}',
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    {
      name: 'triage_batch_v1',
      description: 'Batch triage classification prompt',
      system_prompt: `You are an AI assistant designed to triage emails.
You will receive a numbered list of emails. Classify EACH ONE into exactly one category.

Categories:
{{ categories }}

If uncertain, default to '{{ default_fallback }}'.

Return a JSON object with a 'results' array — one entry per email, in the SAME ORDER as the input:
{"results": [{"thread_index": 0, "classification": "<id>", "confidence": 0.9, "reasoning": "<short explanation>"}, ...]}`,
      user_prompt_template: '{{ numbered_emails }}',
      is_active: true,
      created_at: now,
      updated_at: now,
    },
  ]).onConflict('name').ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('prompt_templates').whereIn('name', ['triage_v1', 'triage_batch_v1']).del();
}
