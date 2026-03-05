const { isValidToolCall, isValidFinal } = require("./llm/schema");

/**
 * detectPromptInjection(text)
 *
 * Return array of detected issue codes (empty array if safe).
 */
function detectPromptInjection(text) {
  if (!text || typeof text !== "string") return [];

  const patterns = [
    /ignore previous instructions/i,
    /reveal secrets/i,
    /override policy/i,
    /send confidential/i
  ];

  const matches = patterns.some((p) => p.test(text));

  return matches ? ["PROMPT_INJECTION"] : [];
}

/**
 * enforceToolAllowlist(toolName, allowedTools)
 */
function enforceToolAllowlist(toolName, allowedTools) {
  if (!Array.isArray(allowedTools)) return false;
  return allowedTools.includes(toolName);
}

/**
 * validateLlmResponse(obj)
 */
function validateLlmResponse(obj) {
  if (isValidToolCall(obj)) {
    return { ok: true, type: "tool_call" };
  }

  if (isValidFinal(obj)) {
    return { ok: true, type: "final" };
  }

  return { ok: false, reason: "Invalid LLM response schema" };
}

module.exports = {
  detectPromptInjection,
  enforceToolAllowlist,
  validateLlmResponse
};
