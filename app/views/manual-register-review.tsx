"use client";

import { useEffect, useMemo, useState } from "react";
import { TableBlock } from "../types";
import ResultTable from "./result-table";
import { fitTextarea } from "./fit-textarea";

type RowView = {
  row: number;
  bbox: number[];
  sourceDimensions: number[];
  geometry?: string;
  views: Array<{ kind: string; imageUrl: string; width?: number; height?: number }>;
};

type Props = {
  table: TableBlock;
  sourceFile: File;
  unresolvedCount: number;
  verifiedCount: number;
  canSave: boolean;
  onSetCell: (rowIndex: number, columnIndex: number, value: string) => void;
  onSave: () => void;
  onDownloadCsv: () => void;
};

const unreadable = (value: string) => /^\s*\[(?:\?|؟)\]\s*$/.test(value);

export default function ManualRegisterReview({
  table,
  sourceFile,
  unresolvedCount,
  verifiedCount,
  canSave,
  onSetCell,
  onSave,
  onDownloadCsv,
}: Props) {
  const [rowIndex, setRowIndex] = useState(0);
  const [rowView, setRowView] = useState<RowView | null>(null);
  const [viewKind, setViewKind] = useState("original");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reviewColumns = useMemo(() => table.columns.slice(0, 6), [table.columns]);
  const row = table.rows[rowIndex] ?? [];
  const suggestions = useMemo(
    () => table.alternatives?.filter((entry) => entry.row === rowIndex) ?? [],
    [rowIndex, table.alternatives],
  );
  const rowDrafts = useMemo(() => reviewColumns.flatMap((_, columnIndex) => {
    const alternative = suggestions.find((entry) => entry.column === columnIndex);
    const choices = alternative
      ? [...new Set([alternative.first, alternative.second].filter((value) => value && !unreadable(value)))]
      : [];
    return choices.length ? [{ columnIndex, choices }] : [];
  }), [reviewColumns, suggestions]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError(null);
      setRowView(null);
      const form = new FormData();
      form.set("file", sourceFile, sourceFile.name);
      form.set("rows", String(table.rows.length));
      form.set("row", String(rowIndex));
      form.set("width", "1800");
      try {
        const response = await fetch("/api/row-view", { method: "POST", body: form, signal: controller.signal });
        const payload = await response.json() as RowView & { error?: string };
        if (!response.ok || !payload.views?.length) throw new Error(payload.error || "This row could not be prepared.");
        setRowView(payload);
        setViewKind("original");
      } catch (loadError) {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "This row could not be prepared.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [rowIndex, sourceFile, table.rows.length]);

  const shown = rowView?.views.find((view) => view.kind === viewKind) ?? rowView?.views[0];

  return <section className="manual-review" aria-labelledby="manual-review-title">
    <header className="manual-review-head">
      <div>
        <span>HUMAN REVIEW</span>
        <h3 id="manual-review-title">Transcribe one record at a time</h3>
        <p>The automatic readers did not agree. Read the complete source row below and enter only what is visible.</p>
      </div>
      <div className="review-count"><strong>{rowIndex + 1}</strong><span>of {table.rows.length}</span></div>
    </header>

    <nav className="row-navigator" aria-label="Register rows">
      <button type="button" onClick={() => setRowIndex((current) => Math.max(0, current - 1))} disabled={rowIndex === 0}>← Previous</button>
      <div>{table.rows.map((_, index) => <button
        type="button"
        key={index}
        className={rowIndex === index ? "active" : ""}
        aria-current={rowIndex === index ? "step" : undefined}
        onClick={() => setRowIndex(index)}
      >{index + 1}</button>)}</div>
      <button type="button" onClick={() => setRowIndex((current) => Math.min(table.rows.length - 1, current + 1))} disabled={rowIndex === table.rows.length - 1}>Next →</button>
    </nav>

    <div className="row-evidence">
      <div className="row-evidence-toolbar">
        <div><strong>Source row {rowIndex + 1}</strong>{rowView && <small>[{rowView.bbox.join(", ")}] · {rowView.geometry === "detected" ? "rules detected" : "estimated bands"}</small>}{rowDrafts.length > 0 && <small className="draft-available">{rowDrafts.length} unverified OCR draft{rowDrafts.length === 1 ? "" : "s"} available below</small>}</div>
        {rowView && <div className="evidence-toggle" role="group" aria-label="Row evidence view">
          {rowView.views.map((view) => <button type="button" key={view.kind} className={view.kind === viewKind ? "active" : ""} onClick={() => setViewKind(view.kind)}>{view.kind === "original" ? "Original" : "Cleaned"}</button>)}
        </div>}
      </div>
      <div className="row-evidence-image">
        {loading && <p>Preparing the complete row…</p>}
        {error && <p className="row-evidence-error">{error}</p>}
        {shown && <img src={shown.imageUrl} alt={`Complete handwritten register row ${rowIndex + 1}`} />}
      </div>
      <p className="evidence-note">Original is the authority. Cleaned removes uneven paper tone but does not reconstruct missing strokes.</p>
    </div>

    <div className="review-fields" dir="rtl" lang="ar">
      {reviewColumns.map((column, columnIndex) => {
        const current = row[columnIndex] ?? "";
        const alternative = suggestions.find((entry) => entry.column === columnIndex);
        const choices = alternative ? [...new Set([alternative.first, alternative.second].filter((value) => value && !unreadable(value)))] : [];
        const officialValue = unreadable(current) ? "" : current;
        const draftValue = !officialValue ? choices[0] ?? "" : "";
        const shownValue = officialValue || draftValue;
        const isDraft = Boolean(draftValue);
        const fieldId = `review-${rowIndex}-${columnIndex}`;
        return <div key={`${rowIndex}-${columnIndex}`} className={`review-field ${columnIndex === 2 ? "wide-field" : ""}`}>
          <label htmlFor={fieldId}>{column}</label>
          <textarea
            id={fieldId}
            key={`${rowIndex}-${columnIndex}-${current}-${draftValue}`}
            className={isDraft ? "is-ocr-draft" : undefined}
            rows={columnIndex === 2 ? 4 : 2}
            defaultValue={shownValue}
            ref={fitTextarea}
            onInput={(event) => fitTextarea(event.currentTarget)}
            placeholder="اكتب ما يظهر في السجل"
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== shownValue) onSetCell(rowIndex, columnIndex, value || "[؟]");
            }}
          />
          {isDraft && <span className="ocr-draft-label">OCR draft · unverified · edit to correct</span>}
          {isDraft && choices.length > 1 && <details className="ocr-alternate"><summary>Alternate OCR reading</summary><p dir="rtl" lang="ar">{choices[1]}</p></details>}
        </div>;
      })}
    </div>

    <div className="row-review-actions">
      <p><strong>{verifiedCount} machine-verified cells</strong><span>{unresolvedCount} still require a person. Empty fields remain explicitly unreadable.</span></p>
      <div className="row-review-buttons">
        <button type="button" onClick={() => setRowIndex((current) => Math.min(table.rows.length - 1, current + 1))} disabled={rowIndex === table.rows.length - 1}>Save row & continue →</button>
      </div>
    </div>

    <details className="full-register-disclosure">
      <summary>Open full 12-column register</summary>
      <p>Use this only for cross-row checking or CSV export.</p>
      <ResultTable table={table} onSetCell={onSetCell} defaultShowUnverified onDownloadCsv={onDownloadCsv} />
    </details>

    <footer className="manual-review-footer">
      <div><strong>{unresolvedCount ? "Save this draft for later" : "Save the reviewed register"}</strong><small>OCR drafts remain marked unverified until an operator edits them.</small></div>
      <button type="button" onClick={onSave} disabled={!canSave}>{unresolvedCount ? "Save draft" : "Save reviewed table"}</button>
    </footer>
  </section>;
}
