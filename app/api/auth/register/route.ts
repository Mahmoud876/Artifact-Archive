export async function POST() {
  return Response.json({
    error: "Public account creation is disabled. Ask the Seshat administrator for access.",
  }, {
    status: 403,
    headers: { "cache-control": "no-store" },
  });
}
