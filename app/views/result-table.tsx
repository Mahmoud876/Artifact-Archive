"use client";

import { useState } from "react";
import { PlateMatchMethod, TableBlock, findPlateColumn } from "../types";
import { fitTextarea } from "./fit-textarea";

export type RowPlate = {
  file: string;
  url?: string;
  title: string;
  matchMethod?: PlateMatchMethod | "manual";
  plateSerial?: string;
  rowSerial?: string;
};

type Props = {
  table: TableBlock;
  /** Row index (as string) -> plate for that row. */
  plates?: Record<string, RowPlate>;
  /** All plates in the run, offered when re-pointing a row by hand. */
  allPlates?: RowPlate[];
  onSetRowPlate?: (rowIndex: number, file: string | null) => void;
  onSetCell?: (rowIndex: number, columnIndex: number, value: string) => void;
  /** Open an enlarged view of one cell, for reading the hand before typing it. */
  onViewCell?: (rowIndex: number, columnIndex: number) => void;
  /** Only these leading columns have source geometry in the image service. */
  viewableColumnCount?: number;
  /** Review-only tables may reveal drafts immediately while keeping [؟] official. */
  defaultShowUnverified?: boolean;
  onDownloadCsv?: () => void;
};

const unreadable = (value: string) => /^\s*\[(?:\?|؟)\]\s*$/u.test(value);

// A register read back as cells. Rendered RTL because these sheets are Arabic,
// with the printed column order preserved exactly as the model reported it.
export default function ResultTable({ table, plates = {}, allPlates = [], onSetRowPlate, onSetCell, onViewCell, viewableColumnCount = 0, defaultShowUnverified = false, onDownloadCsv }: Props) {
  const [showUnverified, setShowUnverified] = useState(defaultShowUnverified);
  const plateColumn = findPlateColumn(table.columns);
  const hasPlates = Object.keys(plates).length > 0 || allPlates.length > 0;
  const unverifiedCount = table.alternatives?.length ?? 0;
  // Use the register's own photograph column when it has one; otherwise add one.
  const showOwnColumn = hasPlates && plateColumn < 0;
  const serialMatches = Object.values(plates).filter((plate) => plate.matchMethod === "label-exact" || plate.matchMethod === "label-number").length;
  const positionMatches = Object.values(plates).filter((plate) => plate.matchMethod === "position").length;

  const renderPlate = (rowIndex: number) => {
    const plate = plates[String(rowIndex)];
    return <div className="plate-cell">
      {plate?.url
        ? <img src={plate.url} alt={plate.title} title={plate.title} />
        : <span className="plate-empty">—</span>}
      {onSetRowPlate && allPlates.length > 0 && <select
        aria-label={`Plate for row ${rowIndex + 1}`}
        value={plate?.file ?? ""}
        onChange={(event) => onSetRowPlate(rowIndex, event.target.value || null)}
      >
        <option value="">no plate</option>
        {allPlates.map((candidate) => <option key={candidate.file} value={candidate.file}>{candidate.title}</option>)}
      </select>}
      {plate && <small className={`plate-match-note ${plate.matchMethod ?? "manual"}`}>
        {plate.matchMethod === "label-exact" || plate.matchMethod === "label-number"
          ? `Label ${plate.plateSerial} ↔ row ${plate.rowSerial}`
          : plate.matchMethod === "position" ? "Position fallback · check" : "Manual link"}
      </small>}
    </div>;
  };

  return <div className="table-block">
    <div className="table-head">
      <small>
        {table.rows.length} row{table.rows.length === 1 ? "" : "s"} · {table.columns.length} columns
        {serialMatches ? ` · ${serialMatches} matched by label serial` : ""}
        {positionMatches ? ` · ${positionMatches} position fallback` : ""}
      </small>
      <div className="table-head-actions">
        {unverifiedCount > 0 && <button
          type="button"
          className={`unverified-toggle ${showUnverified ? "active" : ""}`}
          aria-pressed={showUnverified}
          onClick={() => setShowUnverified((current) => !current)}
        >{showUnverified ? "Hide" : "Show"} {unverifiedCount} unverified OCR drafts</button>}
        {onDownloadCsv && <button className="text-button" onClick={onDownloadCsv}>Download CSV</button>}
      </div>
    </div>
    <div className="table-wrap">
      <table className="register-table" dir="rtl" lang="ar">
        <thead>
          <tr>
            <th scope="col" className="row-number">#</th>
            {showOwnColumn && <th scope="col" className="plate-head">صورة الأثر</th>}
            {table.columns.map((column, index) => <th key={`${column}-${index}`} scope="col">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => <tr key={rowIndex}>
            <td className="row-number">{rowIndex + 1}</td>
            {showOwnColumn && <td className="plate-col">{renderPlate(rowIndex)}</td>}
            {table.columns.map((_, columnIndex) => {
              if (hasPlates && columnIndex === plateColumn) {
                return <td key={columnIndex} className="plate-col">{renderPlate(rowIndex)}</td>;
              }
              const cell = row[columnIndex] ?? "";
              const alternative = table.alternatives?.find((entry) => entry.row === rowIndex && entry.column === columnIndex);
              const choices = alternative
                ? [...new Set([alternative.first, alternative.second].filter((value) => value && value !== "[?]" && value !== "[؟]"))]
                : [];
              const needsReview = table.review_cells?.includes(`${rowIndex}:${columnIndex}`) ?? false;
              const visibleCell = unreadable(cell) ? "" : cell;
              const draftValue = showUnverified && !visibleCell ? choices[0] ?? "" : "";
              const shownValue = visibleCell || draftValue;
              const isDraft = Boolean(draftValue);
              const cellClass = [unreadable(cell) ? "uncertain-cell" : "", needsReview ? "review-cell" : ""].filter(Boolean).join(" ");
              return <td key={columnIndex} className={cellClass} title={needsReview ? "The two OCR passes differed. Check this reading against the scan." : undefined}>
                {onSetCell ? <div className="cell-review-editor">
                  <textarea
                      key={`${rowIndex}-${columnIndex}-${cell}-${showUnverified ? "drafts" : "official"}`}
                      className={`table-cell-editor ${isDraft ? "is-ocr-draft" : ""}`}
                      dir="auto"
                      lang="ar"
                      rows={Math.max(1, Math.min(5, cell.split("\n").length))}
                      defaultValue={shownValue}
                      ref={fitTextarea}
                      onInput={(event) => fitTextarea(event.currentTarget)}
                      aria-label={`Row ${rowIndex + 1}, ${table.columns[columnIndex]}`}
                      placeholder="غير منسوخ"
                      onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next !== shownValue) onSetCell(rowIndex, columnIndex, next || "[؟]");
                      }}
                    />
                  {isDraft && <span className="ocr-draft-label">OCR draft · unverified · edit to correct</span>}
                  {onViewCell && columnIndex < viewableColumnCount && <button
                    type="button"
                    className="cell-magnify"
                    onClick={() => onViewCell(rowIndex, columnIndex)}
                    title="Enlarge this cell to read the handwriting"
                  >Enlarge<span aria-hidden="true"> ⤢</span></button>}
                  {isDraft && choices.length > 1 && <details className="ocr-alternate"><summary>Alternate OCR reading</summary><p dir="rtl" lang="ar">{choices[1]}</p></details>}
                </div> : <>
                  <span className={!visibleCell && choices.length ? "readonly-ocr-draft" : undefined}>{visibleCell || choices[0] || "Not transcribed"}</span>
                  {!visibleCell && choices.length > 0 && <span className="ocr-draft-label">OCR draft · unverified</span>}
                </>}
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

export function tableToCsv(table: TableBlock, plates: Record<string, RowPlate> = {}) {
  const escape = (value: string) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const plateColumn = findPlateColumn(table.columns);
  const header = [...table.columns];
  if (plateColumn < 0) header.push("plate file");

  const lines = [header.map(escape).join(",")];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex];
    const plateFile = plates[String(rowIndex)]?.file ?? "";
    const cells = table.columns.map((_, columnIndex) =>
      columnIndex === plateColumn && plateFile ? plateFile : row[columnIndex] ?? "");
    if (plateColumn < 0) cells.push(plateFile);
    lines.push(cells.map(escape).join(","));
  }
  // Leading BOM so Excel opens the Arabic correctly instead of mojibake.
  return String.fromCharCode(0xFEFF) + lines.join("\r\n");
}
