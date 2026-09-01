"use client";

import { useState } from "react";
import { TableBlock, findPlateColumn } from "../types";
import { RowPlate } from "./result-table";
import { fitTextarea } from "./fit-textarea";

type Props = {
  table: TableBlock;
  plates?: Record<string, RowPlate>;
  allPlates?: RowPlate[];
  onSetRowPlate?: (rowIndex: number, file: string | null) => void;
  onSetCell?: (rowIndex: number, columnIndex: number, value: string) => void;
  onDownloadCsv?: () => void;
  status?: "verified" | "needs_review";
};

const unreadable = (value: string) => /^\s*\[(?:\?|؟)\]\s*$/u.test(value);

function CellValue({
  value,
  choices,
  rowIndex,
  columnIndex,
  column,
  onSetCell,
}: {
  value: string;
  choices: string[];
  rowIndex: number;
  columnIndex: number;
  column: string;
  onSetCell?: Props["onSetCell"];
}) {
  const visible = !value || unreadable(value) ? "" : value;
  const draftValue = !visible ? choices[0] ?? "" : "";
  const shownValue = visible || draftValue;
  const isDraft = Boolean(draftValue);
  return <div className="record-cell-content">
    {onSetCell ? <textarea
      key={`${rowIndex}-${columnIndex}-${value}-${draftValue}`}
      className={isDraft ? "is-ocr-draft" : undefined}
      rows={Math.max(2, Math.min(5, shownValue.split("\n").length + 1))}
      dir="auto"
      lang="ar"
      aria-label={`Record ${rowIndex + 1}, ${column}`}
      defaultValue={shownValue}
      ref={fitTextarea}
      onInput={(event) => fitTextarea(event.currentTarget)}
      placeholder="Not transcribed"
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== shownValue) onSetCell(rowIndex, columnIndex, next || "[؟]");
      }}
    /> : <p className={shownValue ? (isDraft ? "readonly-ocr-draft" : "") : "record-empty"}>{shownValue || "Not transcribed"}</p>}
    {isDraft && <span className="ocr-draft-label">OCR draft · unverified · edit to correct</span>}
    {isDraft && choices.length > 1 && <details className="ocr-alternate"><summary>Alternate OCR reading</summary><p dir="rtl" lang="ar">{choices[1]}</p></details>}
  </div>;
}

export default function RegisterRecords({
  table,
  plates = {},
  allPlates = [],
  onSetRowPlate,
  onSetCell,
  onDownloadCsv,
  status,
}: Props) {
  const [openRow, setOpenRow] = useState<number | null>(0);
  const plateColumn = findPlateColumn(table.columns);
  const fieldIndexes = table.columns.map((_, index) => index).filter((index) => index !== plateColumn);
  const primaryIndexes = fieldIndexes.slice(0, 6);
  const secondaryIndexes = fieldIndexes.slice(6);
  const unresolved = table.review_cells?.length ?? 0;

  const renderPlate = (rowIndex: number) => {
    const plate = plates[String(rowIndex)];
    return <div className="record-plate">
      {plate?.url ? <img src={plate.url} alt={plate.title} /> : <div className="record-plate-empty">No linked plate</div>}
      {onSetRowPlate && allPlates.length > 0 && <label>
        <span>Linked plate</span>
        <select value={plate?.file ?? ""} onChange={(event) => onSetRowPlate(rowIndex, event.target.value || null)}>
          <option value="">No plate</option>
          {allPlates.map((candidate) => <option key={candidate.file} value={candidate.file}>{candidate.title}</option>)}
        </select>
      </label>}
      {plate && <small className={`plate-match-note ${plate.matchMethod ?? "manual"}`}>
        {plate.matchMethod === "label-exact" || plate.matchMethod === "label-number"
          ? `Plate label ${plate.plateSerial} matches row ${plate.rowSerial}`
          : plate.matchMethod === "position" ? "Linked by position · verify" : "Linked manually"}
      </small>}
    </div>;
  };

  return <div className="register-records">
    <div className="register-records-head">
      <div>
        <strong>{table.rows.length} register record{table.rows.length === 1 ? "" : "s"}</strong>
        <span>{table.columns.length} source fields · no horizontal table</span>
      </div>
      <div>
        {(status === "needs_review" || unresolved > 0) && <span className="record-status needs-review">Needs review · {unresolved} cell{unresolved === 1 ? "" : "s"}</span>}
        {status === "verified" && unresolved === 0 && <span className="record-status verified">Operator verified</span>}
        {onDownloadCsv && <button type="button" className="text-button" onClick={onDownloadCsv}>Download CSV</button>}
      </div>
    </div>

    <div className="record-list">
      {table.rows.map((row, rowIndex) => {
        const plate = plates[String(rowIndex)];
        const rowReviewCount = table.review_cells?.filter((key) => key.startsWith(`${rowIndex}:`)).length ?? 0;
        const titleIndex = primaryIndexes.find((index) => {
          const value = row[index] ?? "";
          return value && !unreadable(value);
        });
        const firstSuggestion = table.alternatives?.find((entry) => entry.row === rowIndex && primaryIndexes.includes(entry.column));
        const suggestedTitle = firstSuggestion
          ? [firstSuggestion.first, firstSuggestion.second].find((value) => value && !unreadable(value))
          : undefined;
        const title = titleIndex === undefined ? suggestedTitle || "Not yet transcribed" : row[titleIndex];
        const isOpen = openRow === rowIndex;
        return <article key={rowIndex} className={`register-record ${isOpen ? "open" : ""}`}>
          <button type="button" className="record-summary" aria-expanded={isOpen} onClick={() => setOpenRow(isOpen ? null : rowIndex)}>
            <span className="record-number">{String(rowIndex + 1).padStart(2, "0")}</span>
            {plate?.url ? <img src={plate.url} alt="" /> : <span className="record-thumb-empty" />}
            <span className="record-summary-copy">
              <strong dir="auto" lang="ar">{title}</strong>
              <small>{plate ? (plate.matchMethod === "label-exact" || plate.matchMethod === "label-number" ? "Serial label matched" : plate.matchMethod === "position" ? "Position fallback" : "Plate linked") : "No plate linked"}{titleIndex === undefined && suggestedTitle ? " · unverified OCR draft · editable" : rowReviewCount ? ` · ${rowReviewCount} fields need review` : " · record available"}</small>
            </span>
            <span className="record-chevron" aria-hidden="true">{isOpen ? "−" : "+"}</span>
          </button>

          {isOpen && <div className="record-body">
            {renderPlate(rowIndex)}
            <div className="record-fields" dir="rtl" lang="ar">
              {primaryIndexes.map((columnIndex) => {
                const alternative = table.alternatives?.find((entry) => entry.row === rowIndex && entry.column === columnIndex);
                const choices = alternative ? [...new Set([alternative.first, alternative.second].filter((value) => value && !unreadable(value)))] : [];
                return <section key={columnIndex} className={columnIndex === 2 ? "record-field record-field-wide" : "record-field"}>
                  <h4>{table.columns[columnIndex]}</h4>
                  <CellValue value={row[columnIndex] ?? ""} choices={choices} rowIndex={rowIndex} columnIndex={columnIndex} column={table.columns[columnIndex]} onSetCell={onSetCell} />
                </section>;
              })}
              {secondaryIndexes.length > 0 && <details className="record-more">
                <summary>Additional register fields ({secondaryIndexes.length})</summary>
                <div>
                  {secondaryIndexes.map((columnIndex) => {
                    const alternative = table.alternatives?.find((entry) => entry.row === rowIndex && entry.column === columnIndex);
                    const choices = alternative ? [...new Set([alternative.first, alternative.second].filter((value) => value && !unreadable(value)))] : [];
                    return <section key={columnIndex} className="record-field">
                      <h4>{table.columns[columnIndex]}</h4>
                      <CellValue value={row[columnIndex] ?? ""} choices={choices} rowIndex={rowIndex} columnIndex={columnIndex} column={table.columns[columnIndex]} onSetCell={onSetCell} />
                    </section>;
                  })}
                </div>
              </details>}
            </div>
          </div>}
        </article>;
      })}
    </div>
  </div>;
}
