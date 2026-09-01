"use client";

import { useMemo, useState } from "react";
import { ArchiveRun, SavedCrop, artifactDisplaySerial, batchRelationshipLabel, formatDate, formatFullDate, formatSize, matchPlateAssignments, runSeries, taskLabel } from "../types";
import ResultTable, { RowPlate } from "./result-table";
import RegisterRecords from "./register-records";
import ArtifactCatalogue, { artifactMatchesQuery } from "./artifact-catalogue";

export type ArchiveSort = "newest" | "oldest" | "images" | "label";
export type ArchiveMode = "collections" | "artifacts";

type Props = {
  runs: ArchiveRun[];
  cropUrls: Record<string, string>;
  sourceUrls: Record<string, string>;
  query: string;
  onQueryChange: (value: string) => void;
  sort: ArchiveSort;
  onSortChange: (value: ArchiveSort) => void;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onSetArtifactSerial: (runId: string, itemId: string, value: string) => void;
  onDownloadCrop: (crop: SavedCrop) => void;
  onDownloadManifest: (run: ArchiveRun) => void;
  onSaveTranscription: (id: string, text: string) => void;
  onDownloadCsv: (run: ArchiveRun, plates: Record<string, RowPlate>) => void;
  onSetRowPlate: (id: string, rowIndex: number, file: string | null) => void;
  onSetTableCell: (id: string, rowIndex: number, columnIndex: number, value: string) => void;
  mode: ArchiveMode;
  onModeChange: (value: ArchiveMode) => void;
  seriesFilter: string;
  onSeriesFilterChange: (value: string) => void;
  seriesList: Array<{ name: string; runs: number; artifacts: number; plates: number; bytes: number }>;
  onExportSeries: (name: string) => void;
  onMoveRun: (id: string, series: string) => void;
  message: string;
};

const cropKey = (runId: string, name: string) => `${runId}::${name}`;
const sourceKey = (runId: string, sourceIndex: number) => `${runId}::source::${sourceIndex}`;
const runGovernorates = (run: ArchiveRun) => [...new Set([
  ...run.manifest.sources.map((source) => source.governorate?.trim()).filter((value): value is string => Boolean(value)),
  run.manifest.intake?.governorate?.trim(),
].filter((value): value is string => Boolean(value)))];
const runGovernorateLabel = (run: ArchiveRun) => runGovernorates(run).join(" · ") || "غير مسجلة";

export default function ArchiveView(props: Props) {
  const { runs, cropUrls, query, onQueryChange, sort, onSortChange, openId, onOpen } = props;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState<string>("");
  const [showManifest, setShowManifest] = useState(false);
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [registerView, setRegisterView] = useState<"table" | "records">("table");
  const [governorateFilter, setGovernorateFilter] = useState("");
  const [focusedArtifactId, setFocusedArtifactId] = useState<string | null>(null);
  const showLegacyTextFeatures: boolean = false;

  const filtered = useMemo(() => {
    const needle = query.trim();
    const textNeedle = needle.toLocaleLowerCase();
    const matches = needle
      ? runs.filter((run) =>
        run.label.toLocaleLowerCase().includes(textNeedle) ||
        run.id.toLocaleLowerCase().includes(textNeedle) ||
        run.manifest.summary.toLocaleLowerCase().includes(textNeedle) ||
        run.manifest.items.some((item) => artifactMatchesQuery(item, run, needle)))
      : runs;
    const byGovernorate = governorateFilter
      ? matches.filter((run) => runGovernorates(run).includes(governorateFilter))
      : matches;
    const scoped = props.seriesFilter ? byGovernorate.filter((run) => runSeries(run) === props.seriesFilter) : byGovernorate;
    const ordered = [...scoped];
    if (sort === "newest") ordered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (sort === "oldest") ordered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (sort === "images") ordered.sort((a, b) => b.crops.length - a.crops.length);
    if (sort === "label") ordered.sort((a, b) => a.label.localeCompare(b.label));
    return ordered;
  }, [runs, query, sort, props.seriesFilter, governorateFilter]);

  const governorates = useMemo(() => [...new Set(runs.flatMap(runGovernorates))].sort((a, b) => a.localeCompare(b, "ar")), [runs]);

  const totals = useMemo(() => {
    const categories = new Set<string>();
    let images = 0;
    let bytes = 0;
    for (const run of runs) {
      images += run.crops.length;
      for (const crop of run.crops) bytes += crop.blob.size;
      for (const source of run.sources ?? []) bytes += source.blob.size;
      for (const item of run.manifest.items) if (item.category) categories.add(item.category.toLowerCase());
    }
    return { images, bytes, categories: categories.size };
  }, [runs]);

  const open = openId ? runs.find((run) => run.id === openId) ?? null : null;

  if (open) {
    const manifestJson = JSON.stringify(open.manifest, null, 2);
    const focusedIndex = focusedArtifactId ? open.manifest.items.findIndex((item) => item.id === focusedArtifactId) : -1;
    const focusedItem = focusedIndex >= 0 ? open.manifest.items[focusedIndex] : null;
    const focusedCrop = focusedIndex >= 0 ? open.crops.find((crop) => crop.itemIndex === focusedIndex) : undefined;
    const focusedCropUrl = focusedCrop ? cropUrls[cropKey(open.id, focusedCrop.name)] : undefined;
    const focusedSourceIndex = focusedItem?.source_index ?? 0;
    const focusedSource = open.sources?.find((source) => source.sourceIndex === focusedSourceIndex);
    const focusedSourceUrl = props.sourceUrls[sourceKey(open.id, focusedSourceIndex)];
    const sourceMeta = open.manifest.sources[focusedSourceIndex];
    const boxStyle = (() => {
      if (!focusedItem?.bbox || focusedItem.bbox.length !== 4) return null;
      const [x1, y1, x2, y2] = focusedItem.bbox;
      const denominatorX = open.manifest.coordinate_space === "normalized_1000" ? 1000 : focusedSource?.width ?? sourceMeta?.width ?? 0;
      const denominatorY = open.manifest.coordinate_space === "normalized_1000" ? 1000 : focusedSource?.height ?? sourceMeta?.height ?? 0;
      if (!denominatorX || !denominatorY) return null;
      return {
        left: `${Math.max(0, Math.min(100, x1 / denominatorX * 100))}%`,
        top: `${Math.max(0, Math.min(100, y1 / denominatorY * 100))}%`,
        width: `${Math.max(0.5, Math.min(100, (x2 - x1) / denominatorX * 100))}%`,
        height: `${Math.max(0.5, Math.min(100, (y2 - y1) / denominatorY * 100))}%`,
      };
    })();
    return <div className="chamber">
      <div className="detail-head">
        <button className="back-button" onClick={() => { onOpen(null); setFocusedArtifactId(null); setShowManifest(false); }}>العودة إلى نتائج البحث</button>
        <div className="detail-actions">
          <button className="secondary" onClick={() => props.onDownloadManifest(open)}>Download manifest</button>
          <button className="secondary gold" onClick={() => props.onExport(open.id)}>Export folder</button>
          <button className={`danger-button ${confirmId === open.id ? "armed" : ""}`} onClick={() => {
            if (confirmId === open.id) { props.onDelete(open.id); setConfirmId(null); } else setConfirmId(open.id);
          }}>{confirmId === open.id ? "Confirm delete" : "Delete run"}</button>
        </div>
      </div>

      {focusedItem && <section className="detail-panel artifact-context-panel" dir="rtl">
        <div className="artifact-context-heading">
          <div><span className="eyebrow">نتيجة البحث</span><h2>{artifactDisplaySerial(focusedItem)}</h2></div>
          <div><strong>{focusedItem.title}</strong><small>{focusedItem.category}</small></div>
        </div>
        <div className="artifact-context-grid">
          <figure className="artifact-context-crop">
            <figcaption><strong>صورة القطعة المستخرجة</strong><small>{focusedItem.description}</small></figcaption>
            {focusedCropUrl ? <img src={focusedCropUrl} alt={focusedItem.title} /> : <div className="source-unavailable">صورة القطعة غير متاحة في هذا السجل.</div>}
          </figure>
          <figure className="artifact-context-source">
            <figcaption><strong>صفحة السجل الأصلية</strong><small>{sourceMeta?.name ?? focusedItem.source_name ?? "المصدر"}</small></figcaption>
            {focusedSourceUrl ? <div className="source-page-canvas">
              <img src={focusedSourceUrl} alt={`صفحة السجل التي تحتوي على ${artifactDisplaySerial(focusedItem)}`} />
              {boxStyle && <span className="source-artifact-box" style={boxStyle}><b>{artifactDisplaySerial(focusedItem)}</b></span>}
            </div> : <div className="source-unavailable">هذه الصفحة حُفظت قبل إضافة حفظ صور المصادر. أعد استخراجها مرة واحدة لعرض الصفحة هنا.</div>}
          </figure>
        </div>
        <dl className="artifact-context-facts">
          <div><dt>المحافظة</dt><dd>{sourceMeta?.governorate || open.manifest.intake?.governorate || "غير مسجلة"}</dd></div>
          <div><dt>المنطقة الأثرية</dt><dd>{sourceMeta?.archaeological_area || open.manifest.intake?.archaeologicalArea || "غير مسجلة"}</dd></div>
          <div><dt>رقم صفحة السجل</dt><dd>{open.manifest.intake?.registerPageNumber || "غير مسجل"}</dd></div>
          <div><dt>الرقم الداخلي</dt><dd>{focusedItem.serial || "—"}</dd></div>
        </dl>
      </section>}

      <section className="detail-panel">
        <div className="detail-title">
          <span className="eyebrow">COLLECTION</span>
          <div className="rename-row">
            <input
              aria-label="Collection name"
              value={labelDraft || open.label}
              onChange={(event) => setLabelDraft(event.target.value)}
            />
            <button className="secondary" disabled={!labelDraft || labelDraft === open.label} onClick={() => { props.onRename(open.id, labelDraft); setLabelDraft(""); }}>Rename</button>
          </div>
          <label className="select-field series-move">
            <span>Filed under series</span>
            <select value={runSeries(open)} onChange={(event) => props.onMoveRun(open.id, event.target.value)}>
              {[...new Set([runSeries(open), ...props.seriesList.map((entry) => entry.name)])].map((name) =>
                <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <p className="detail-summary">{open.manifest.summary}</p>
        </div>

        <dl className="fact-grid">
          <div><dt>Run identifier</dt><dd>{open.id}</dd></div>
          <div><dt>Inventory identifier</dt><dd>{open.manifest.inventory_ids?.join(", ") || open.manifest.inventory_id || "Legacy record — migration pending"}</dd></div>
          <div><dt>Sealed</dt><dd>{formatFullDate(open.createdAt)}</dd></div>
          <div><dt>Operation</dt><dd>{taskLabel[open.manifest.task] ?? open.manifest.task}</dd></div>
          <div><dt>المحافظة</dt><dd>{runGovernorateLabel(open)}</dd></div>
          {open.manifest.sources.length > 1 && <div><dt>علاقة الصور</dt><dd>{batchRelationshipLabel(open.manifest.intake?.batchRelationship)}</dd></div>}
          <div><dt>Coordinate space</dt><dd>{open.manifest.coordinate_space}</dd></div>
          <div><dt>Sources</dt><dd>{open.manifest.sources.map((source) => source.name).join(", ") || "—"}</dd></div>
          <div><dt>Records</dt><dd>{open.manifest.items.length}</dd></div>
          <div><dt>Images on disk</dt><dd>{open.crops.length} · {formatSize(open.crops.reduce((sum, crop) => sum + crop.blob.size, 0))}</dd></div>
        </dl>
        {open.manifest.sources.some((source) => source.inventory_id) && <div className="source-ownership-list">
          <span className="eyebrow">SOURCE OWNERSHIP</span>
          {open.manifest.sources.map((source, index) => <div key={`${source.name}-${index}`}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            <span><strong>{source.name}</strong><small>{source.governorate || "Governorate not recorded"} · {source.storehouse_name || "Inventory not recorded"}{source.archaeological_area ? ` · ${source.archaeological_area}` : ""}</small></span>
            <code>{source.inventory_id || "—"}</code>
          </div>)}
        </div>}

        {open.manifest.options && <div className="option-recap">
          <span className="eyebrow">RUN SETTINGS</span>
          <div className="chip-row">
            <span className="chip">box ≥ {open.manifest.options.boxThreshold.toFixed(2)}</span>
            <span className="chip">text ≥ {open.manifest.options.textThreshold.toFixed(2)}</span>
            <span className="chip">confidence ≥ {Math.round(open.manifest.options.minConfidence * 100)}%</span>
            <span className="chip">padding {open.manifest.options.cropPadding}%</span>
            <span className="chip">{open.manifest.options.cropFormat.toUpperCase()}</span>
          </div>
        </div>}
      </section>

      {open.crops.length > 0 && <section className="detail-panel">
        <div className="panel-title"><span className="eyebrow">EXTRACTED IMAGES</span><h3>{open.crops.length} plate{open.crops.length === 1 ? "" : "s"}</h3></div>
        <div className="crop-gallery">
          {open.crops.map((crop) => {
            const item = open.manifest.items[crop.itemIndex];
            const url = cropUrls[cropKey(open.id, crop.name)];
            return <figure key={crop.name}>
              {url ? <img src={url} alt={item?.title ?? crop.name} /> : <div className="crop-placeholder" />}
              <figcaption>
                <strong>{item?.title ?? crop.name}</strong>
                <small>{item?.category ?? "Uncategorized"} · {formatSize(crop.blob.size)}</small>
                {item?.plate_serial && <small>Plate label · {item.plate_serial}</small>}
                <button className="text-button" onClick={() => props.onDownloadCrop(crop)}>Download plate</button>
              </figcaption>
            </figure>;
          })}
        </div>
      </section>}

      {showLegacyTextFeatures && open.manifest.table && (() => {
        const table = open.manifest.table;
        const allPlates: RowPlate[] = open.crops.map((crop) => ({
          file: crop.name,
          url: cropUrls[cropKey(open.id, crop.name)],
          title: open.manifest.items[crop.itemIndex]?.title ?? crop.name,
        }));
        // Prefer a unique label-to-row serial match; keep position and manual
        // links visible as separate provenance states.
        const automatic = matchPlateAssignments(open.manifest.items, table);
        const manual = open.manifest.table_plates ?? {};
        const assigned = { ...Object.fromEntries(Object.entries(automatic).map(([rowIndex, match]) => [rowIndex, match.file])), ...manual };
        const plates: Record<string, RowPlate> = {};
        for (const [rowIndex, file] of Object.entries(assigned)) {
          const plate = allPlates.find((candidate) => candidate.file === file);
          const match = automatic[rowIndex];
          if (plate) plates[rowIndex] = {
            ...plate,
            matchMethod: Object.prototype.hasOwnProperty.call(manual, rowIndex) && manual[rowIndex] !== match?.file ? "manual" : match?.method,
            plateSerial: match?.plateSerial,
            rowSerial: match?.rowSerial,
          };
        }
        return <section className="detail-panel register-section">
          <div className="panel-title register-panel-title">
            <div><span className="eyebrow">REGISTER TABLE</span><h3>Rows as written</h3></div>
            <div className="register-view-switch" role="group" aria-label="Register presentation">
              <button type="button" className={registerView === "table" ? "active" : ""} aria-pressed={registerView === "table"} onClick={() => setRegisterView("table")}>Table</button>
              <button type="button" className={registerView === "records" ? "active" : ""} aria-pressed={registerView === "records"} onClick={() => setRegisterView("records")}>Records</button>
            </div>
          </div>
          {registerView === "table" ? <ResultTable
            table={table}
            plates={plates}
            allPlates={allPlates}
            defaultShowUnverified
            onSetRowPlate={(rowIndex, file) => props.onSetRowPlate(open.id, rowIndex, file)}
            onSetCell={(rowIndex, columnIndex, value) => props.onSetTableCell(open.id, rowIndex, columnIndex, value)}
            onDownloadCsv={() => props.onDownloadCsv(open, plates)}
          /> : <RegisterRecords
              table={table}
              plates={plates}
              allPlates={allPlates}
              status={open.manifest.table_status ?? (table.review_cells?.length ? "needs_review" : "verified")}
              onSetRowPlate={(rowIndex, file) => props.onSetRowPlate(open.id, rowIndex, file)}
              onSetCell={(rowIndex, columnIndex, value) => props.onSetTableCell(open.id, rowIndex, columnIndex, value)}
              onDownloadCsv={() => props.onDownloadCsv(open, plates)}
            />}
        </section>;
      })()}

      <section className="detail-panel ledger-panel" dir="rtl">
        <div className="panel-title ledger-title"><div><span className="eyebrow">الصور المحفوظة</span><h3>سجل القطع المستخرجة</h3></div><small>{open.manifest.items.length} قطعة</small></div>
        <div className="ledger">
          {open.manifest.items.map((item, index) => {
            const plate = item.file ? cropUrls[cropKey(open.id, item.file)] : undefined;
            return <article key={item.id} className={plate ? "with-plate" : ""}>
            <div className="ledger-serial"><small>الرقم التسلسلي</small><input key={artifactDisplaySerial(item)} className="serial-editor ledger-index" dir="rtl" lang="ar" aria-label={index === 0 ? "بداية ترقيم الدفعة" : "رقم القطعة"} defaultValue={artifactDisplaySerial(item)} onBlur={(event) => props.onSetArtifactSerial(open.id, item.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div>
            {plate && <img className="ledger-plate" src={plate} alt={item.title} />}
            <div className="ledger-copy">
              <strong>{item.title}</strong>
              <small>{item.category}</small>
              {item.source_name && <small className="ledger-source">المصدر · {item.source_name}</small>}
              {item.plate_serial && <small>رقم البطاقة الظاهر · {item.plate_serial}</small>}
              {item.description && <p>{item.description}</p>}
              {item.bbox?.length === 4 && <code>الإحداثيات [{item.bbox.join(", ")}]</code>}
            </div>
            <div className="ledger-meta">
              {item.confidence !== null && <div><span>درجة الثقة</span><b>{Math.round(item.confidence * 100)}%</b></div>}
              {item.file && <small>{item.file}</small>}
            </div>
          </article>;
          })}
          {!open.manifest.items.length && <p className="hollow">لا توجد صور مستخرجة محفوظة في هذا السجل.</p>}
        </div>
      </section>

      {showLegacyTextFeatures && (open.manifest.transcription || open.manifest.task === "transcribe") && <section className="detail-panel">
        <div className="panel-title">
          <div><span className="eyebrow">TRANSCRIPTION</span><h3>Recovered text</h3></div>
          <div className="detail-actions">
            {textDraft === null
              ? <button className="secondary" onClick={() => setTextDraft(open.manifest.transcription ?? "")}>
                {open.manifest.transcription ? "Correct text" : "Type it yourself"}
              </button>
              : <>
                <button className="secondary" onClick={() => setTextDraft(null)}>Cancel</button>
                <button className="secondary gold" onClick={() => { props.onSaveTranscription(open.id, textDraft); setTextDraft(null); }}>Save text</button>
              </>}
            {open.manifest.transcription && textDraft === null &&
              <button className="secondary" onClick={() => void navigator.clipboard?.writeText(open.manifest.transcription ?? "")}>Copy</button>}
          </div>
        </div>

        {textDraft !== null
          ? <textarea className="transcript-editor arabic" dir="rtl" lang="ar" value={textDraft} rows={14}
              onChange={(event) => setTextDraft(event.target.value)}
              placeholder="Type the transcription as you read it. Use [؟] for characters you cannot make out." />
          : open.manifest.transcription
            ? <pre className="transcript arabic" dir="rtl" lang="ar">{open.manifest.transcription}</pre>
            : <p className="empty-note">This run sealed no transcription. The model either returned nothing or could not read the hand. You can enter the text yourself — it is stored with the collection and exported in manifest.json.</p>}
      </section>}

      <section className="detail-panel">
        <div className="panel-title">
          <div><span className="eyebrow">PROVENANCE</span><h3>manifest.json</h3></div>
          <button className="secondary" onClick={() => setShowManifest((current) => !current)}>{showManifest ? "Hide" : "Show"} manifest</button>
        </div>
        {showManifest && <pre className="manifest-view">{manifestJson}</pre>}
      </section>

      {props.message && <p className="export-message">{props.message}</p>}
    </div>;
  }

  return <div className="chamber">
    <div className="view-head">
      <div><span className="eyebrow">LOCAL ARCHIVE</span><h2>Chamber of records</h2></div>
      <small>Everything below is stored in this browser only</small>
    </div>

    <div className="stat-row">
      <div className="stat-card"><small>Collections</small><strong>{runs.length}</strong></div>
      <div className="stat-card"><small>Images archived</small><strong>{totals.images}</strong></div>
      <div className="stat-card"><small>Categories</small><strong>{totals.categories}</strong></div>
      <div className="stat-card"><small>On disk</small><strong>{formatSize(totals.bytes)}</strong></div>
    </div>

    {props.seriesList.length > 0 && <div className="series-band">
      {props.seriesList.map((entry) => <button
        key={entry.name}
        className={`series-chip ${props.seriesFilter === entry.name ? "active" : ""}`}
        onClick={() => props.onSeriesFilterChange(props.seriesFilter === entry.name ? "" : entry.name)}
      >
        <strong>{entry.name}</strong>
        <small>{entry.artifacts} artefacts · {entry.runs} page{entry.runs === 1 ? "" : "s"}</small>
      </button>)}
      {props.seriesFilter && <button className="secondary gold export-series" onClick={() => props.onExportSeries(props.seriesFilter)}>
        Export “{props.seriesFilter}” as one catalogue
      </button>}
    </div>}

    <div className="toolbar">
      <label className="search-field">
        <span className="sr-only">البحث في القطع والسجلات</span>
        <input dir="rtl" type="search" placeholder="ابحث بالرقم التسلسلي، مثل: 1 أو قطعة رقم 1" value={query} onChange={(event) => onQueryChange(event.target.value)} />
      </label>
      <div className="provider-toggle" role="group" aria-label="نوع عرض الأرشيف">
        <button className={props.mode === "collections" ? "active" : ""} aria-pressed={props.mode === "collections"} onClick={() => props.onModeChange("collections")}>صفحات السجل</button>
        <button className={props.mode === "artifacts" ? "active" : ""} aria-pressed={props.mode === "artifacts"} onClick={() => props.onModeChange("artifacts")}>القطع</button>
      </div>
      <label className="select-field">
        <span>المحافظة</span>
        <select dir="rtl" value={governorateFilter} onChange={(event) => setGovernorateFilter(event.target.value)}>
          <option value="">كل المحافظات</option>
          {governorates.map((governorate) => <option key={governorate} value={governorate}>{governorate}</option>)}
        </select>
      </label>
      <label className="select-field">
        <span>السلسلة</span>
        <select value={props.seriesFilter} onChange={(event) => props.onSeriesFilterChange(event.target.value)}>
          <option value="">كل السلاسل</option>
          {props.seriesList.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} ({entry.artifacts})</option>)}
        </select>
      </label>
      <label className="select-field">
        <span>الترتيب</span>
        <select value={sort} onChange={(event) => onSortChange(event.target.value as ArchiveSort)}>
          <option value="newest">الأحدث أولاً</option>
          <option value="oldest">الأقدم أولاً</option>
          <option value="images">الأكثر صورًا</option>
          <option value="label">حسب الاسم</option>
        </select>
      </label>
    </div>

    {props.message && <p className="export-message">{props.message}</p>}

    {(props.mode === "artifacts" || Boolean(query.trim())) ? <ArtifactCatalogue
      runs={runs}
      cropUrls={cropUrls}
      series={props.seriesFilter || null}
      governorate={governorateFilter}
      query={query}
      onOpenArtifact={(runId, itemId) => { setFocusedArtifactId(itemId); onOpen(runId); }}
    /> : filtered.length ? <div className="run-grid">
      {filtered.map((run, index) => <article key={run.id} className="run-card">
        <header>
          <span className="seal">{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{run.label}</strong>
            <small>{run.id} · {formatDate(run.createdAt)}</small>
          </div>
        </header>
        <div className="chip-row">
          <span className="chip governorate-chip">المحافظة · {runGovernorateLabel(run)}</span>
          {run.manifest.sources.length > 1 && <span className="chip relationship-chip">{batchRelationshipLabel(run.manifest.intake?.batchRelationship)}</span>}
          <span className={`chip task-chip task-${run.manifest.task}`}>{taskLabel[run.manifest.task] ?? run.manifest.task}</span>
          <span className="chip">{run.manifest.items.length} records</span>
          <span className="chip">{run.crops.length} images</span>
        </div>
        {run.crops.length > 0 && <div className="crop-strip">
          {run.crops.slice(0, 4).map((crop) => {
            const url = cropUrls[cropKey(run.id, crop.name)];
            return url
              ? <img key={crop.name} src={url} alt="" />
              : <div key={crop.name} className="crop-placeholder" />;
          })}
          {run.crops.length > 4 && <span className="crop-more">+{run.crops.length - 4}</span>}
        </div>}
        <p>{run.manifest.summary}</p>
        <footer>
          <button className="secondary" onClick={() => { onOpen(run.id); setLabelDraft(""); }}>Open</button>
          <button className="secondary gold" onClick={() => props.onExport(run.id)}>Export</button>
          <button className={`danger-button ${confirmId === run.id ? "armed" : ""}`} onClick={() => {
            if (confirmId === run.id) { props.onDelete(run.id); setConfirmId(null); } else setConfirmId(run.id);
          }}>{confirmId === run.id ? "Confirm" : "Delete"}</button>
        </footer>
      </article>)}
    </div> : <div className="empty-row">
      <span className="glyph-mark" aria-hidden="true" />
      <div>
        <strong>{runs.length ? "No collection matches that search" : "The chamber is empty"}</strong>
        <p>{runs.length ? "Try a different name, run id, or category." : "Run an extraction on the workbench and it will be sealed here."}</p>
      </div>
    </div>}
  </div>;
}
