export function completedResponseEvent(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  };
}
