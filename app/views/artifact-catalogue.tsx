"use client";

import { ArchiveRun, artifactDisplaySerial, artifactGovernorate, formatDate, normalizeWrittenSerial, seriesArtifacts, sourceMetadataForItem } from "../types";

type Props = {
  runs: ArchiveRun[];
  cropUrls: Record<string, string>;
  series: string | null;
  governorate: string;
  query: string;
  onOpenArtifact: (runId: string, itemId: string) => void;
};

const cropKey = (runId: string, name: string) => `${runId}::${name}`;

export function artifactMatchesQuery(item: ArchiveRun["manifest"]["items"][number], run: ArchiveRun, query: string) {
  const needle = normalizeWrittenSerial(query);
  if (!needle) return true;
  const numericNeedle = /^\d+$/.test(needle) ? String(Number(needle)) : "";
  if (numericNeedle) {
    const displayedNumbers = normalizeWrittenSerial(artifactDisplaySerial(item)).match(/\d+/gu) ?? [];
    return displayedNumbers.map((value) => String(Number(value))).includes(numericNeedle);
  }
  const intake = run.manifest.intake;
  const source = sourceMetadataForItem(run, item);
  const searchable = [
    item.serial, item.display_serial, item.plate_serial, artifactDisplaySerial(item), item.title, item.category,
    item.description, run.label, artifactGovernorate(run, item), source?.archaeological_area, source?.storehouse_name,
    source?.inventory_id, intake?.governorate, intake?.archaeologicalArea, intake?.storehouseName,
    intake?.storeRegisterName, intake?.storeRegisterNumber, intake?.registerPageNumber,
  ].filter(Boolean).join(" ");
  return normalizeWrittenSerial(searchable).includes(needle);
}

export default function ArtifactCatalogue({ runs, cropUrls, series, governorate, query, onOpenArtifact }: Props) {
  const needle = normalizeWrittenSerial(query);
  const rows = seriesArtifacts(runs, series).filter(({ item, run }) => {
    if (governorate && artifactGovernorate(run, item) !== governorate) return false;
    return artifactMatchesQuery(item, run, query);
  });

  if (!rows.length) {
    return <div className="empty-row">
      <span className="glyph-mark" aria-hidden="true" />
      <div>
        <strong>{needle ? "لا توجد قطعة مطابقة للبحث" : "لا توجد قطع محفوظة حتى الآن"}</strong>
        <p>{needle ? "جرّب الرقم التسلسلي أو اسم القطعة أو اسم صفحة السجل." : "شغّل استخراج صفحة وسيظهر محتواها هنا."}</p>
      </div>
    </div>;
  }

  return <div className="artifact-grid">
    {rows.map(({ item, run }) => {
      const url = item.file ? cropUrls[cropKey(run.id, item.file)] : undefined;
      const governorateName = artifactGovernorate(run, item);
      return <article key={`${run.id}-${item.id}`} className="artifact-card">
        <div className="artifact-plate">
          {url ? <img src={url} alt={item.title} /> : <div className="crop-placeholder" />}
          <span className="artifact-serial">{artifactDisplaySerial(item)}</span>
        </div>
        <div className="artifact-body">
          <strong>{item.title}</strong>
          <small>{item.category || "غير مصنّفة"}</small>
          {item.description && <p>{item.description}</p>}
          <div className="artifact-foot">
            <span title={run.label}>{governorateName || "غير مسجلة"} · {formatDate(run.createdAt)}</span>
            {item.confidence !== null && <b>{Math.round(item.confidence * 100)}%</b>}
          </div>
          <button className="text-button" onClick={() => onOpenArtifact(run.id, item.id)}>عرض القطعة مع صفحة السجل</button>
        </div>
      </article>;
    })}
  </div>;
}
