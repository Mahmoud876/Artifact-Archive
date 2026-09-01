import { expiredSessionCookie } from "../../../local-auth";

export async function POST(request: Request) {
  return Response.json({ ok: true }, {
    headers: { "set-cookie": expiredSessionCookie(request), "cache-control": "no-store" },
  });
}
