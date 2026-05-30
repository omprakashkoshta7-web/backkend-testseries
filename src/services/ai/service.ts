import { tools } from './tools';

const BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
const API_KEY = process.env.AI_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const MAX_TOOL_ROUNDS = 10;

const toolDefs = tools.map((t) => ({ type: t.type as any, function: t.function }));

const systemPrompt = `You are an AI assistant for the P2 Exam Platform admin panel.
You have FULL access to perform ANY admin operation instantly.

Available operations:
- Categories: create, update, delete, list
- Exams: create, update, delete, list
- Exam Sections: create, delete, list
- Subjects: create, update, delete, list
- Topics: create, update, delete, list
- Tests: create, update, delete, list
- Questions: create, update, delete, list, bulk import from JSON
- Users: list
- Dashboard: stats

Rules:
- DO whatever the admin asks — no confirmations, no questions, just execute.
- For bulk question import, accept a JSON array of question objects.
- Use the provided tools — do not make up tool names.
- If you need information first, call the list tool first without asking.
- Be brief and direct in responses.
- When done, just confirm what was done in 1 line.
- Never ask "are you sure?" or "shall I proceed?" — just do it.
- Current date: ${new Date().toISOString().split('T')[0]}`;

async function callLLM(messages: any[], toolChoice?: 'auto' | 'none'): Promise<any> {
  const body: Record<string, any> = {
    model: MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 800,
  };
  if (toolChoice !== 'none' && toolDefs.length > 0) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI API error ${res.status}: ${errText}`);
  }

  return res.json();
}

function findTool(name: string) {
  return tools.find((t) => t.function.name === name);
}

export async function processChatMessage(userMessage: string, history: any[] = []) {
  if (!API_KEY) {
    return { reply: '❌ AI Assistant is not configured. Set `AI_API_KEY` in environment variables.', role: 'assistant' };
  }

  try {
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-20),
      { role: 'user', content: userMessage },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callLLM(messages);
      const choice = data.choices?.[0];
      if (!choice) throw new Error('No response from AI');

      const { message } = choice;
      messages.push(message);

      const toolCalls = message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return { reply: message.content || 'Done.', role: 'assistant' };
      }

      for (const tc of toolCalls) {
        const tool = findTool(tc.function.name);
        if (!tool) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Unknown tool: ${tc.function.name}` });
          continue;
        }

        let args: Record<string, any>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Invalid arguments JSON' });
          continue;
        }

        try {
          const result = await tool.handler(args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        } catch (err: any) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` });
        }
      }
    }

    return { reply: 'I completed the operation but it required too many steps. Please check the results.', role: 'assistant' };
  } catch (err: any) {
    return { reply: `❌ Error: ${err.message}`, role: 'assistant' };
  }
}
