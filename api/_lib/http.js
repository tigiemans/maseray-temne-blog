export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function methodNotAllowed() {
  return json({ error: "Method not allowed." }, 405);
}

export function logError(message, error, context = {}) {
  console.error(message, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
}
