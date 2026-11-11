/**
 * Provider adapter tests, without network. A fake Gemini client replays
 * scripted stream chunks, so we can check what the adapter sends back on the
 * next request: the model's own parts (thought signatures included) and one
 * functionResponse per call.
 */
import type { GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GeminiChat, GeminiWorker } from "../src/llm/gemini";
import { WEB_SEARCH_TOOL } from "../src/agent/prompt";

type Chunk = Record<string, unknown>;

function fakeGemini(scripts: Chunk[][], jsonText = "") {
  const requests: any[] = [];
  const ai = {
    models: {
      generateContentStream: async (req: any) => {
        // Snapshot: the adapter keeps appending to the same contents array.
        requests.push(structuredClone({ ...req, config: { ...req.config, abortSignal: undefined } }));
        const chunks = scripts.shift() ?? [];
        return (async function* () {
          yield* chunks;
        })();
      },
      generateContent: async (req: any) => {
        requests.push(req);
        return { text: jsonText, candidates: [{ finishReason: "STOP" }] };
      },
    },
  };
  return { ai: ai as unknown as GoogleGenAI, requests };
}

const signal = new AbortController().signal;

describe("GeminiChat", () => {
  it("streams text, returns tool calls, and echoes the model turn back with signatures", async () => {
    const { ai, requests } = fakeGemini([
      [
        { candidates: [{ content: { role: "model", parts: [{ text: "Checking. " }] } }] },
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { functionCall: { name: "web_search", args: { query: "HubSpot pricing", mode: "page" } }, thoughtSignature: "sig-1" },
                  { functionCall: { name: "web_search", args: { query: "Pipedrive pricing", mode: "page" } } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
        },
      ],
      [{ candidates: [{ content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }] }],
    ]);
    const chat = new GeminiChat(ai, "gemini-test", "low");
    const convo = chat.start(
      "system",
      [
        { role: "user", content: "Compare CRMs" },
        { role: "system", content: "Context block" },
      ],
      WEB_SEARCH_TOOL,
    );

    let text = "";
    const first = await convo.round({ allowTools: true, onText: (d) => (text += d), signal });
    expect(text).toBe("Checking. ");
    expect(first.stop).toBe("tool_use");
    expect(first.calls.map((c) => c.id)).toEqual(["call_1", "call_2"]);
    expect(first.usage).toEqual({ input: 60, output: 25, cacheRead: 40, cacheWrite: 0 });

    // The context block joins the user's turn; Gemini has no mid-conversation system role.
    expect(requests[0].contents).toEqual([{ role: "user", parts: [{ text: "Compare CRMs" }, { text: "Context block" }] }]);

    convo.addToolResults([
      { call: first.calls[0]!, content: "results A", isError: false },
      { call: first.calls[1]!, content: "boom", isError: true },
    ]);
    const second = await convo.round({ allowTools: false, onText: () => {}, signal });
    expect(second.stop).toBe("end");

    const [, modelTurn, toolTurn] = requests[1].contents;
    expect(modelTurn.role).toBe("model");
    expect(modelTurn.parts[1].thoughtSignature).toBe("sig-1");
    expect(toolTurn.parts).toEqual([
      { functionResponse: { name: "web_search", response: { output: "results A" } } },
      { functionResponse: { name: "web_search", response: { error: "boom" } } },
    ]);
    expect(requests[1].config.toolConfig.functionCallingConfig.mode).toBe("NONE");
  });

  it("maps a safety stop to a refusal and a malformed call to a retryable error", async () => {
    const { ai } = fakeGemini([
      [{ candidates: [{ finishReason: "SAFETY" }] }],
      [{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }],
    ]);
    const chat = new GeminiChat(ai, "gemini-test", "low");
    const convo = chat.start("system", [{ role: "user", content: "hi" }], WEB_SEARCH_TOOL);
    expect((await convo.round({ allowTools: true, onText: () => {}, signal })).stop).toBe("refusal");
    const err = await convo.round({ allowTools: true, onText: () => {}, signal }).catch((e) => e);
    expect(chat.classifyError(err, signal)).toBe("retry");
  });
});

describe("GeminiWorker", () => {
  it("sends a JSON schema without $schema and validates the reply with zod", async () => {
    const { ai, requests } = fakeGemini([], JSON.stringify({ summary: "CRM pricing", unit: null }));
    const worker = new GeminiWorker(ai, "gemini-lite-test");
    const Out = z.object({ summary: z.string(), unit: z.string().nullable() });
    expect(await worker.json(Out, { system: "s", user: "u" })).toEqual({ summary: "CRM pricing", unit: null });
    expect(requests[0].config.responseJsonSchema.$schema).toBeUndefined();
    expect(requests[0].config.responseMimeType).toBe("application/json");
  });
});
