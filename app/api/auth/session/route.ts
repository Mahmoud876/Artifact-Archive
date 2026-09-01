import { authenticatedUser } from "../../../local-auth";

export async function GET(request: Request) {
  const user = await authenticatedUser(request);
  return user
    ? Response.json({ user }, { headers: { "cache-control": "no-store" } })
    : Response.json({ user: null }, { status: 401, headers: { "cache-control": "no-store" } });
}
