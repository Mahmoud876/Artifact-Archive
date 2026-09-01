// One enlarged, cleaned view of a single register cell, for an operator
// transcribing by hand. Served on request rather than with the analysis, so a
// page's sixty cells never have to travel at viewing size.
//
// This is explicitly not transcription evidence. Measured on the reference
// scan, two independent readings of the restored image agreed on none of ten
// cells while reading more confidently than the unrestored ones — restoration
// adds plausible strokes, not recovered ones.

type CellView = {
  row?: number;
  column?: number;
  column_label?: string;
  bbox?: number[];
  geometry?: string;
  views?: Array<{ kind: string; image: string }>;
  warning?: string | null;
  detail?: string;
};

export async function POST(request: Request) {
  if (!await authenticatedUser(request)) return unauthorizedResponse();
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Attach the source page to view one of its cells." }, { status: 400 });
    }

    const baseUrl = (process.env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
    const body = new FormData();
    body.append("file", file, file.name);
    for (const field of ["rows", "row", "column", "height"]) {
      const value = form.get(field);
      if (value !== null) body.append(field, String(value));
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/register-cell-view`, { method: "POST", body, signal: AbortSignal.timeout(120_000) });
    } catch {
      return Response.json({ error: `The local image service is offline at ${baseUrl}.` }, { status: 502 });
    }

    const payload = await response.json() as CellView;
    if (!response.ok || !payload.views?.length) {
      return Response.json({ error: payload.detail || `The cell view service returned ${response.status}.` }, { status: 502 });
    }

    return Response.json({
      row: payload.row,
      column: payload.column,
      columnLabel: payload.column_label,
      bbox: payload.bbox ?? [],
      geometry: payload.geometry,
      warning: payload.warning ?? null,
      views: payload.views.map((view) => ({ kind: view.kind, imageUrl: `data:image/png;base64,${view.image}` })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The cell view failed." }, { status: 500 });
  }
}
import { authenticatedUser, unauthorizedResponse } from "../../local-auth";
