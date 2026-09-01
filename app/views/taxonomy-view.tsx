"use client";

import { useMemo, useState } from "react";
import { ArchiveRun, formatDate } from "../types";

type Props = {
  runs: ArchiveRun[];
  cropUrls: Record<string, string>;
  onOpenRun: (id: string) => void;
};

type CategoryEntry = {
  name: string;
  count: number;
  confidenceSum: number;
  confidenceCount: number;
  runs: Set<string>;
  samples: Array<{ runId: string; runLabel: string; cropName: string | null; title: string; confidence: number | null; createdAt: string }>;
};

const cropKey = (runId: string, name: string) => `${runId}::${name}`;

export default function TaxonomyView({ runs, cropUrls, onOpenRun }: Props) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  const { categories, confidenceBands, totalRecords } = useMemo(() => {
    const map = new Map<string, CategoryEntry>();
    const bands = { high: 0, medium: 0, low: 0, unscored: 0 };
    let records = 0;

    for (const run of runs) {
      for (const item of run.manifest.items) {
        records += 1;
        const name = (item.category || "Uncategorized").trim();
        const key = name.toLowerCase();
        const entry = map.get(key) ?? { name, count: 0, confidenceSum: 0, confidenceCount: 0, runs: new Set<string>(), samples: [] };
        entry.count += 1;
        entry.runs.add(run.id);
        if (typeof item.confidence === "number") { entry.confidenceSum += item.confidence; entry.confidenceCount += 1; }
        entry.samples.push({ runId: run.id, runLabel: run.label, cropName: item.file, title: item.title, confidence: item.confidence, createdAt: run.createdAt });
        map.set(key, entry);

        if (typeof item.confidence !== "number") bands.unscored += 1;
        else if (item.confidence >= 0.7) bands.high += 1;
        else if (item.confidence >= 0.4) bands.medium += 1;
        else bands.low += 1;
      }
    }

    const list = [...map.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    return { categories: list, confidenceBands: bands, totalRecords: records };
  }, [runs]);

  const peak = categories[0]?.count ?? 1;
  const active = openCategory ? categories.find((entry) => entry.name.toLowerCase() === openCategory) ?? null : null;

  return <div className="chamber">
    <div className="view-head">
      <div><span className="eyebrow">TAXONOMY</span><h2>Table of categories</h2></div>
      <small>{categories.length} categor{categories.length === 1 ? "y" : "ies"} across {totalRecords} record{totalRecords === 1 ? "" : "s"}</small>
    </div>

    {totalRecords === 0 ? <div className="empty-row">
      <span className="glyph-mark" aria-hidden="true" />
      <div>
        <strong>Nothing has been categorized yet</strong>
        <p>Categories are gathered from every sealed collection in the local archive.</p>
      </div>
    </div> : <>
      <div className="stat-row">
        <div className="stat-card"><small>Confident · 70%+</small><strong>{confidenceBands.high}</strong></div>
        <div className="stat-card"><small>Probable · 40–70%</small><strong>{confidenceBands.medium}</strong></div>
        <div className="stat-card"><small>Uncertain · under 40%</small><strong>{confidenceBands.low}</strong></div>
        <div className="stat-card"><small>Unscored</small><strong>{confidenceBands.unscored}</strong></div>
      </div>

      <section className="detail-panel">
        <div className="panel-title"><span className="eyebrow">DISTRIBUTION</span><h3>Categories by weight</h3></div>
        <div className="tax-list">
          {categories.map((entry) => {
            const key = entry.name.toLowerCase();
            const average = entry.confidenceCount ? entry.confidenceSum / entry.confidenceCount : null;
            return <button
              key={key}
              className={`tax-row ${openCategory === key ? "active" : ""}`}
              aria-expanded={openCategory === key}
              onClick={() => setOpenCategory(openCategory === key ? null : key)}
            >
              <span className="tax-name">{entry.name}</span>
              <span className="tax-bar"><i style={{ width: `${Math.max(6, Math.round((entry.count / peak) * 100))}%` }} /></span>
              <span className="tax-count">{entry.count}</span>
              <span className="tax-meta">{average === null ? "—" : `${Math.round(average * 100)}%`} · {entry.runs.size} run{entry.runs.size === 1 ? "" : "s"}</span>
            </button>;
          })}
        </div>
      </section>

      {active && <section className="detail-panel">
        <div className="panel-title">
          <div><span className="eyebrow">CATEGORY</span><h3>{active.name}</h3></div>
          <button className="secondary" onClick={() => setOpenCategory(null)}>Close</button>
        </div>
        <div className="crop-gallery">
          {active.samples.map((sample, index) => {
            const url = sample.cropName ? cropUrls[cropKey(sample.runId, sample.cropName)] : undefined;
            return <figure key={`${sample.runId}-${index}`}>
              {url ? <img src={url} alt={sample.title} /> : <div className="crop-placeholder" />}
              <figcaption>
                <strong>{sample.title}</strong>
                <small>{sample.runLabel} · {formatDate(sample.createdAt)}{sample.confidence !== null ? ` · ${Math.round(sample.confidence * 100)}%` : ""}</small>
                <button className="text-button" onClick={() => onOpenRun(sample.runId)}>Open collection</button>
              </figcaption>
            </figure>;
          })}
        </div>
      </section>}
    </>}
  </div>;
}
