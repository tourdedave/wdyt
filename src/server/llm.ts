export const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_LLM_API_KEY = "ollama";
export const DEFAULT_LLM_MODEL = "mistral:instruct";

export async function requestJsonCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const response = await fetch(new URL("chat/completions", `${input.baseUrl.replace(/\/?$/, "/")}`).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      stream: false,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM proposal failed with status ${response.status}: ${errorText}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM response did not include message content");
  }

  return JSON.parse(content) as unknown;
}
