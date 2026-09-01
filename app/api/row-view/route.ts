type RowView = {
  row?: number;
  bbox?: number[];
  source_dimensions?: number[];
  geometry?: string;
  views?: Array<{ kind: string; image: string; width?: number; height?: number }>;
  detail?: string;
};

export async function POST(request: Request) {
  if (!await authenticatedUser(request)) return unauthorizedResponse();
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Attach the source page to review a row." }, { status: 400 });
    }

    const baseUrl = (process.env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
    const body = new FormData();
    body.append("file", file, file.name);
    for (const field of ["rows", "row", "width"]) {
      const value = form.get(field);
      if (value !== null) body.append(field, String(value));
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/register-row-view`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      return Response.json({ error: `The local image service is offline at ${baseUrl}.` }, { status: 502 });
    }

    const payload = await response.json() as RowView;
    if (!response.ok || !payload.views?.length) {
      return Response.json({ error: payload.detail || `The row view service returned ${response.status}.` }, { status: 502 });
    }

    return Response.json({
      row: payload.row,
      bbox: payload.bbox ?? [],
      sourceDimensions: payload.source_dimensions ?? [],
      geometry: payload.geometry,
      views: payload.views.map((view) => ({
        kind: view.kind,
        imageUrl: `data:image/png;base64,${view.image}`,
        width: view.width,
        height: view.height,
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The row view failed." }, { status: 500 });
  }
}
import { authenticatedUser, unauthorizedResponse } from "../../local-auth";
