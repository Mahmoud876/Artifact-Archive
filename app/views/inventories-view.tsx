"use client";

import { useMemo, useState } from "react";
import {
  ArchiveRun,
  InventorySummary,
  formatDate,
  formatFullDate,
  formatSize,
  inventoryArtifacts,
  matchPlatesToRows,
  taskLabel,
  artifactDisplaySerial,
  itemInventoryKey,
} from "../types";

type Props = {
  runs: ArchiveRun[];
  inventories: InventorySummary[];
  cropUrls: Record<string, string>;
  openKey: string | null;
  onOpen: (key: string | null) => void;
  onOpenRun: (id: string) => void;
  onSetArtifactSerial: (runId: string, itemId: string, value: string) => void;
};

const cropKey = (runId: string, name: string) => `${runId}::${name}`;
const unreadable = (value: string) => /^\s*\[(?:\?|؟)\]\s*$/u.test(value);

function registerFieldsForPlate(run: ArchiveRun, file: string | null) {
  const table = run.manifest.table;
  if (!table || !file) return null;
  const assigned = { ...matchPlatesToRows(run.manifest.items, table), ...(run.manifest.table_plates ?? {}) };
  const match = Object.entries(assigned).find(([, assignedFile]) => assignedFile === file);
  if (!match) return null;
  const rowIndex = Number(match[0]);
  const row = table.rows[rowIndex] ?? [];
  const fields = table.columns
    .map((column, index) => {
      const official = row[index] ?? "";
      if (official && !unreadable(official)) return { column, value: official, draft: false };
      const alternative = table.alternatives?.find((entry) => entry.row === rowIndex && entry.column === index);
      const draft = alternative
        ? [alternative.first, alternative.second].find((value) => value && !unreadable(value)) ?? ""
        : "";
      return { column, value: draft, draft: Boolean(draft) };
    })
    .filter(({ value }) => value && !unreadable(value))
    .slice(0, 3);
  return { rowIndex, fields };
}

function InventoryPlates({ inventory, cropUrls }: { inventory: InventorySummary; cropUrls: Record<string, string> }) {
  const plates = inventory.runs.flatMap((run) => run.crops.filter((crop) => {
    const item = run.manifest.items[crop.itemIndex];
    return item ? itemInventoryKey(run, item) === inventory.key : false;
  }).map((crop) => ({
    key: cropKey(run.id, crop.name),
    url: cropUrls[cropKey(run.id, crop.name)],
    title: run.manifest.items[crop.itemIndex]?.title ?? crop.name,
  }))).filter((plate) => plate.url).slice(0, 6);

  return <div className="inventory-plates" aria-label={`${inventory.plateCount} archived plates`}>
    {plates.map((plate) => <img key={plate.key} src={plate.url} alt={plate.title} />)}
    {!plates.length && <span className="inventory-plate-empty">No plates</span>}
    {inventory.plateCount > plates.length && <b>+{inventory.plateCount - plates.length}</b>}
  </div>;
}

export default function InventoriesView({ runs, inventories, cropUrls, openKey, onOpen, onOpenRun, onSetArtifactSerial }: Props) {
  const showLegacyRegisterFields: boolean = false;
  const [query, setQuery] = useState("");
  const inventory = openKey ? inventories.find((entry) => entry.key === openKey) ?? null : null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return inventories;
    return inventories.filter((entry) => [
      entry.name,
      entry.governorate,
      entry.archaeologicalArea,
      entry.registerName,
      entry.registerNumber,
      entry.firstSerial,
      entry.lastSerial,
    ].some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [inventories, query]);

  const totals = useMemo(() => ({
    pages: inventories.reduce((sum, entry) => sum + entry.runs.length, 0),
    artifacts: inventories.reduce((sum, entry) => sum + entry.artifactCount, 0),
    plates: inventories.reduce((sum, entry) => sum + entry.plateCount, 0),
    bytes: inventories.reduce((sum, entry) => sum + entry.bytes, 0),
  }), [inventories]);

  if (inventory) {
    const artifacts = inventoryArtifacts(runs, inventory.key);
    return <div className="chamber inventory-view inventory-detail">
      <button className="back-button" onClick={() => onOpen(null)}>← All inventories</button>

      <section className="inventory-masthead">
        <div>
          <p>{inventory.governorate}{inventory.archaeologicalArea ? ` · ${inventory.archaeologicalArea}` : ""}</p>
          <h1>{inventory.name}</h1>
          <span>{inventory.registerName || "Register name not recorded"}{inventory.registerNumber ? ` · ${inventory.registerNumber}` : ""}</span>
          <code className="inventory-permanent-id">Inventory ID · {inventory.key}</code>
        </div>
        <dl>
          <div><dt>Serial range</dt><dd>{inventory.firstSerial && inventory.lastSerial ? `${inventory.firstSerial} — ${inventory.lastSerial}` : "Not issued"}</dd></div>
          <div><dt>Register pages</dt><dd>{inventory.runs.length}</dd></div>
          <div><dt>Artefacts</dt><dd>{inventory.artifactCount}</dd></div>
          <div><dt>Plates</dt><dd>{inventory.plateCount}</dd></div>
        </dl>
      </section>

      <div className="inventory-detail-grid">
        <aside className="inventory-page-index">
          <div className="inventory-section-title">
            <h2>Register pages</h2>
            <span>{inventory.runs.length} saved</span>
          </div>
          <div className="inventory-page-list">
            {inventory.runs.map((run, index) => {
              const ownedCrops = run.crops.filter((crop) => {
                const item = run.manifest.items[crop.itemIndex];
                return item ? itemInventoryKey(run, item) === inventory.key : false;
              });
              const firstPlate = ownedCrops.find((crop) => cropUrls[cropKey(run.id, crop.name)]);
              const firstPlateUrl = firstPlate ? cropUrls[cropKey(run.id, firstPlate.name)] : undefined;
              return <button key={run.id} onClick={() => onOpenRun(run.id)}>
                <span className="inventory-page-number">{String(index + 1).padStart(2, "0")}</span>
                {firstPlateUrl ? <img src={firstPlateUrl} alt="" /> : <span className="inventory-page-placeholder" />}
                <span>
                  <strong>{run.label}</strong>
                  <small>{run.manifest.intake?.registerPageNumber ? `Page ${run.manifest.intake.registerPageNumber} · ` : ""}{formatDate(run.createdAt)} · {ownedCrops.length} extracted image{ownedCrops.length === 1 ? "" : "s"} in this inventory</small>
                </span>
                <b aria-hidden="true">→</b>
              </button>;
            })}
          </div>
        </aside>

        <section className="inventory-ledger-panel">
          <div className="inventory-section-title">
            <div><h2>Artefact ledger</h2><p>One continuous sequence for this storage.</p></div>
            <span>{artifacts.length} records</span>
          </div>
          {artifacts.length ? <div className="inventory-ledger">
            <div className="inventory-ledger-head" aria-hidden="true">
              <span>Serial</span><span>Plate</span><span>Catalogue record</span><span>Source page</span>
            </div>
            {artifacts.map(({ item, run }) => {
              const plateUrl = item.file ? cropUrls[cropKey(run.id, item.file)] : undefined;
              const registerRecord = showLegacyRegisterFields ? registerFieldsForPlate(run, item.file) : null;
              return <article key={`${run.id}-${item.id}`}>
                <input key={artifactDisplaySerial(item)} className="serial-editor" dir="rtl" lang="ar" aria-label={run.manifest.items[0]?.id === item.id ? "بداية ترقيم الدفعة" : "رقم القطعة"} defaultValue={artifactDisplaySerial(item)} onBlur={(event) => onSetArtifactSerial(run.id, item.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
                <div className="inventory-artifact-plate">
                  {plateUrl ? <img src={plateUrl} alt={item.title} /> : <span>No plate</span>}
                </div>
                <div className="inventory-artifact-copy">
                  <strong>{item.title || "Untitled extracted image"}</strong>
                  <small>{item.category || "Uncategorized"}</small>
                  {registerRecord?.fields.length ? <dl className="inventory-register-fields" dir="rtl" lang="ar">
                    {registerRecord.fields.map((field) => <div key={field.column}><dt>{field.column}{field.draft && <em>OCR draft</em>}</dt><dd className={field.draft ? "inventory-ocr-draft" : undefined}>{field.value}</dd></div>)}
                  </dl> : item.description && <p>{item.description}</p>}
                </div>
                <button onClick={() => onOpenRun(run.id)}>
                  <strong>{run.label}</strong>
                  <small>{taskLabel[run.manifest.task]} · {formatDate(run.createdAt)}</small>
                </button>
              </article>;
            })}
          </div> : <div className="inventory-empty-ledger">
            <strong>No artefacts have been sealed into this inventory.</strong>
            <p>The source pages are still available from the page index.</p>
          </div>}
        </section>
      </div>
    </div>;
  }

  return <div className="chamber inventory-view">
    <header className="inventory-intro">
      <div>
        <h1>Storage inventories</h1>
        <p>Each inventory follows one physical storehouse. Reopened work returns here and continues the same serial sequence.</p>
      </div>
      <dl aria-label="Inventory totals">
        <div><dt>Inventories</dt><dd>{inventories.length}</dd></div>
        <div><dt>Pages</dt><dd>{totals.pages}</dd></div>
        <div><dt>Artefacts</dt><dd>{totals.artifacts}</dd></div>
        <div><dt>Plates</dt><dd>{totals.plates}</dd></div>
        <div><dt>On disk</dt><dd>{formatSize(totals.bytes)}</dd></div>
      </dl>
    </header>

    <div className="inventory-toolbar">
      <label className="search-field">
        <span className="sr-only">Search inventories</span>
        <input type="search" placeholder="Search storehouse, governorate, register or serial…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <span>{filtered.length} of {inventories.length} inventories</span>
    </div>

    {filtered.length ? <div className="inventory-index">
      {filtered.map((entry, index) => <article className="inventory-register" key={entry.key}>
        <div className="inventory-register-mark">
          <span>{String(index + 1).padStart(2, "0")}</span>
          <b>{entry.registerNumber || entry.firstSerial?.split("-").slice(0, -1).join("-") || "STORE"}</b>
        </div>
        <div className="inventory-register-body">
          <div className="inventory-register-title">
            <div>
              <h2>{entry.name}</h2>
              <p>{entry.governorate}{entry.archaeologicalArea ? ` · ${entry.archaeologicalArea}` : ""}</p>
            </div>
            <span>Updated {formatFullDate(entry.updatedAt)}</span>
          </div>
          <div className="inventory-register-data">
            <dl>
              <div><dt>Serial range</dt><dd>{entry.firstSerial && entry.lastSerial ? `${entry.firstSerial} — ${entry.lastSerial}` : "No serials issued"}</dd></div>
              <div><dt>Inventory ID</dt><dd><code>{entry.key}</code></dd></div>
              <div><dt>Register</dt><dd>{entry.registerName || "Not recorded"}</dd></div>
              <div><dt>Contents</dt><dd>{entry.runs.length} page{entry.runs.length === 1 ? "" : "s"} · {entry.artifactCount} artefacts · {entry.plateCount} plates</dd></div>
            </dl>
            <InventoryPlates inventory={entry} cropUrls={cropUrls} />
          </div>
        </div>
        <button className="inventory-open" onClick={() => onOpen(entry.key)}>
          <span>Open inventory</span>
          <b aria-hidden="true">→</b>
        </button>
      </article>)}
    </div> : <div className="empty-row inventory-empty">
      <span className="glyph-mark" aria-hidden="true" />
      <div>
        <strong>{inventories.length ? "No inventory matches that search" : "No inventories yet"}</strong>
        <p>{inventories.length ? "Try a storehouse, governorate, register number or artefact serial." : "Save a document with a governorate and storehouse. Its inventory will be created here automatically."}</p>
      </div>
    </div>}
  </div>;
}
