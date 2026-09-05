'use node';

/**
 * LLM chore planner (optional). Runs server-side so the key never reaches the
 * browser. Returns null-equivalent (empty steps) on any failure; the client
 * then falls back to the deterministic rule-based planner.
 *
 * Model: claude-sonnet-5 (fast, cheap). Set ANTHROPIC_API_KEY with
 *   npx convex env set ANTHROPIC_API_KEY sk-ant-...   (add --prod for prod)
 */

import { v } from 'convex/values';
import { action } from './_generated/server';

const SYSTEM = `You are the task planner for a home robot rehearsing a chore inside a digital twin of a real room.
You will receive the chore in plain English and the list of entities in the room (items the robot can pick up, fixtures it can open/close such as drawers and doors, and zones it can place things in).
Return the ordered list of primitive steps. Allowed step kinds and rules:
- navigate <target>: drive next to the target. Required before pick/place/open/close of that target.
- pick <item>: robot must be next to the item and holding nothing.
- place <zone|fixture|item>: robot must hold an item; a fixture must be open before placing into it.
- open <fixture> / close <fixture>.
Only reference entities by their exact name from the list. If the chore cannot be done with the entities present, return an empty steps list and a short reason.`;

export const plan = action({
  args: {
    text: v.string(),
    entities: v.array(v.object({ id: v.string(), kind: v.string(), name: v.string(), tags: v.array(v.string()) })),
  },
  handler: async (_ctx, { text, entities }): Promise<{ steps: { kind: string; target: string }[]; reason?: string; model?: string }> => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { steps: [], reason: 'ANTHROPIC_API_KEY not set' };
    const model = process.env.PLANNER_MODEL || 'claude-sonnet-5';
    const body = {
      model,
      max_tokens: 600,
      system: SYSTEM,
      tools: [
        {
          name: 'submit_plan',
          description: 'Submit the ordered steps for the robot.',
          input_schema: {
            type: 'object',
            properties: {
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['navigate', 'pick', 'place', 'open', 'close'] },
                    target: { type: 'string', description: 'exact entity name' },
                  },
                  required: ['kind', 'target'],
                },
              },
              reason: { type: 'string' },
            },
            required: ['steps'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_plan' },
      messages: [
        {
          role: 'user',
          content: `Chore: "${text}"\n\nEntities:\n${entities.map((e) => `- ${e.kind}: ${e.name}${e.tags.length ? ` (${e.tags.join(', ')})` : ''}`).join('\n')}`,
        },
      ],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { steps: [], reason: `planner HTTP ${res.status}` };
    const json = (await res.json()) as { content?: { type: string; name?: string; input?: { steps?: { kind: string; target: string }[]; reason?: string } }[] };
    const tool = json.content?.find((c) => c.type === 'tool_use' && c.name === 'submit_plan');
    const steps = tool?.input?.steps ?? [];
    return { steps, reason: tool?.input?.reason, model };
  },
});
