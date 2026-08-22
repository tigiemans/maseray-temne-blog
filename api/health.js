import { json, methodNotAllowed } from "./_lib/http.js";

export default function handler(request) {
  if (request.method !== "GET") return methodNotAllowed();
  return json({
    ok: true,
    service: "Maseray Temne Blogger payment backend",
  });
}
