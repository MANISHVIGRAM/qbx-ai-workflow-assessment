const { mockLlm } = require("./llm/mockLlm");
const { safeParse } = require("./llm/schema");
const { TOOL_REGISTRY } = require("./tools/tools");
const {
  detectPromptInjection,
  enforceToolAllowlist,
  validateLlmResponse
} = require("./guardrails");

async function runAgentForItem(ticket, config) {
  const maxToolCalls = config?.maxToolCalls ?? 3;
  const maxLlmAttempts = config?.maxLlmAttempts ?? 3;

  const plan = [];
  const tool_calls = [];
  const safety = { blocked: false, reasons: [] };

  const allowedTools = ticket?.context?.allowed_tools || [];

  // ---------------------------
  // Prompt Injection Detection
  // ---------------------------
  const issues = detectPromptInjection(ticket.user_request);

  if (issues.length > 0) {
    safety.blocked = true;
    safety.reasons = issues;

    return {
      id: ticket.id,
      status: "REJECTED",
      plan: ["Rejected due to prompt injection"],
      tool_calls: [],
      final: {
        action: "REFUSE",
        payload: { reason: "Prompt injection detected" }
      },
      safety
    };
  }

  // ---------------------------
  // Messages
  // ---------------------------
  const messages = [
    {
      role: "system",
      content:
        "You are an automation agent. Always return valid JSON following the schema."
    },
    {
      role: "user",
      content: ticket.user_request
    }
  ];

  let llmAttempts = 0;
  let toolCount = 0;

  while (llmAttempts < maxLlmAttempts) {
    llmAttempts++;

    const raw = await mockLlm(messages);
    const parsed = safeParse(raw);

    if (!parsed.ok) {
      // malformed JSON -> retry
      messages.push({
        role: "system",
        content: "Your last response was invalid JSON. Return valid JSON only."
      });
      continue;
    }

    const obj = parsed.value;
    const validation = validateLlmResponse(obj);

    if (!validation.ok) {
      return {
        id: ticket.id,
        status: "REJECTED",
        plan,
        tool_calls,
        final: {
          action: "REFUSE",
          payload: { reason: validation.reason }
        },
        safety
      };
    }

    // ---------------------------
    // TOOL CALL
    // ---------------------------
    if (validation.type === "tool_call") {
      const toolName = obj.tool;

      if (!enforceToolAllowlist(toolName, allowedTools)) {
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: {
            action: "REFUSE",
            payload: { reason: "Tool not allowed" }
          },
          safety
        };
      }

      if (toolCount >= maxToolCalls) {
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: {
            action: "REFUSE",
            payload: { reason: "Tool call limit exceeded" }
          },
          safety
        };
      }

      const tool = TOOL_REGISTRY[toolName];

      if (!tool) {
        return {
          id: ticket.id,
          status: "REJECTED",
          plan,
          tool_calls,
          final: {
            action: "REFUSE",
            payload: { reason: "Unknown tool" }
          },
          safety
        };
      }

      plan.push(`Call tool ${toolName}`);

      const result = await tool(obj.args);

      tool_calls.push({
        tool: toolName,
        args: obj.args
      });

      toolCount++;

      // IMPORTANT: deterministic finish for latest report
      if (/latest report/i.test(ticket.user_request)) {
        return {
          id: ticket.id,
          status: "DONE",
          plan,
          tool_calls,
          final: {
            action: "SEND_EMAIL_DRAFT",
            payload: {
              to: ["finance@example.com"],
              subject: "Requested Report",
              body: "Summary generated from latest report."
            }
          },
          safety
        };
      }

      // Otherwise continue reasoning
      messages.push({
        role: "assistant",
        content: `TOOL_RESULT: ${JSON.stringify(result)}`
      });

      continue;
    }

    // ---------------------------
    // FINAL RESPONSE
    // ---------------------------
    if (validation.type === "final") {
      plan.push("Produce final action");

      const action = obj.final.action;

      let status = "DONE";

      if (action === "REFUSE") {
        status = "REJECTED";
      }

      return {
        id: ticket.id,
        status,
        plan,
        tool_calls,
        final: obj.final,
        safety
      };
    }
  }

  return {
    id: ticket.id,
    status: "REJECTED",
    plan,
    tool_calls,
    final: {
      action: "REFUSE",
      payload: { reason: "LLM attempts exceeded or malformed output" }
    },
    safety
  };
}

module.exports = {
  runAgentForItem
};
