import { loginAccount, sessionCookie } from "../../../local-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { username?: string; password?: string };
    const result = await loginAccount(body.username ?? "", body.password ?? "");
    if (!result) {
      return Response.json({ error: "The username or password is incorrect." }, { status: 401 });
    }
    return Response.json({ user: result.user }, {
      headers: { "set-cookie": sessionCookie(result.token, request), "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Could not sign in. Please try again." }, { status: 400 });
  }
}
