"use client";

import { FormEvent, useMemo, useState } from "react";
import { Asset, BatchRelationship, IntakeMetadata, InventoryRecord, SourceAssignmentDraft, UNFILED, formatSize, inventoriesInGovernorate, normalizeGovernorateName } from "../types";

type Props = {
  assets: Asset[];
  value: IntakeMetadata;
  series: string;
  seriesNames: string[];
  inventories: InventoryRecord[];
  selectedInventoryId: string | null;
  sourceAssignments: Record<string, SourceAssignmentDraft>;
  nextSerial: string;
  maxSources: number;
  onChange: (patch: Partial<IntakeMetadata>) => void;
  onRelationshipChange: (relationship: BatchRelationship) => void;
  onSourceGovernorateChange: (assetId: string, governorate: string) => void;
  onSourceInventoryChange: (assetId: string, inventoryId: string) => void;
  onGovernorateChange: (governorate: string) => void;
  onInventoryChange: (id: string) => void;
  onSeriesChange: (series: string) => void;
  onRemoveAsset: (id: string) => void;
  onMoveAsset: (id: string, direction: -1 | 1) => void;
  onContinue: () => void;
  onCancel: () => void;
  onSaveDefaults: () => void;
};

const relationshipOptions: Array<{ value: BatchRelationship; title: string; arabic: string; description: string }> = [
  { value: "same_register", title: "Same book or register", arabic: "نفس الكتاب أو السجل", description: "Ordered pages or scans from one register, volume, or book." },
  { value: "same_source", title: "Same source or inventory", arabic: "نفس المصدر أو المخزن", description: "Different pages or documents owned by the same physical inventory." },
  { value: "same_governorate", title: "Same governorate only", arabic: "نفس المحافظة فقط", description: "Different sources that share a governorate but may not share one book." },
  { value: "mixed", title: "Mixed or not sure", arabic: "مصادر مختلفة أو غير مؤكدة", description: "The relationship is unknown or the images were gathered from mixed sources." },
];

export default function IntakeView({ assets, value, series, seriesNames, inventories, selectedInventoryId, sourceAssignments, nextSerial, maxSources, onChange, onRelationshipChange, onSourceGovernorateChange, onSourceInventoryChange, onGovernorateChange, onInventoryChange, onSeriesChange, onRemoveAsset, onMoveAsset, onContinue, onCancel, onSaveDefaults }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const totalSize = useMemo(() => assets.reduce((sum, asset) => sum + asset.size, 0), [assets]);
  const governorates = useMemo(() => {
    const names = new Map<string, string>();
    for (const inventory of inventories) {
      const name = inventory.intake.governorate.trim();
      if (name) names.set(normalizeGovernorateName(name), name);
    }
    const current = value.governorate.trim();
    if (current) names.set(normalizeGovernorateName(current), current);
    return [...names.values()].sort((left, right) => left.localeCompare(right));
  }, [inventories, value.governorate]);
  const filteredInventories = useMemo(() => {
    return inventoriesInGovernorate(inventories, value.governorate);
  }, [inventories, value.governorate]);
  const relationship = value.batchRelationship ?? "same_register";
  const assignsSourcesIndividually = assets.length > 1 && (relationship === "mixed" || relationship === "same_governorate");
  const missingSourceAssignments = assignsSourcesIndividually && assets.some((asset) => !sourceAssignments[asset.id]?.inventoryId);
  const assignedGovernorates = new Set(assets.map((asset) => sourceAssignments[asset.id]?.governorate).filter(Boolean).map(normalizeGovernorateName));
  const conflictingGovernorates = relationship === "same_governorate" && assignedGovernorates.size > 1;
  const lowResolution = assets.some((asset) => asset.width && asset.height && (asset.width < 1200 || asset.height < 800));
  const titleMissing = !value.title.trim();
  const seriesMissing = !series.trim();
  const governorateMissing = !value.governorate.trim();
  const archaeologicalAreaMissing = !value.archaeologicalArea.trim();
  const storehouseMissing = !value.storehouseName.trim();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (titleMissing || seriesMissing || missingSourceAssignments || conflictingGovernorates || (!assignsSourcesIndividually && (governorateMissing || archaeologicalAreaMissing || storehouseMissing))) return;
    onContinue();
  };

  return <div className="intake-view">
    <header className="intake-heading">
      <div>
        <h1>Prepare an extraction batch</h1>
        <p>Set the source order, choose the inventory that owns the serial sequence, then review the crop settings.</p>
      </div>
      <span className="intake-local"><i /> Archive records stay on this device</span>
    </header>

    <div className="intake-layout">
      <aside className="intake-command" aria-label="Intake progress">
        <div className="intake-command-title"><span className="lotus-mark" aria-hidden="true" /><div><strong>New intake</strong><small>{assets.length} source{assets.length === 1 ? "" : "s"}</small></div></div>
        <ol>
          <li className="complete"><b>1</b><div><strong>Batch received</strong><small>{assets.length} of {maxSources} sources · {formatSize(totalSize)}</small></div></li>
          <li className="active"><b>2</b><div><strong>Order and identity</strong><small>Confirm source order and inventory</small></div></li>
          <li><b>3</b><div><strong>Extract and serialize</strong><small>Local crops plus manifest</small></div></li>
        </ol>
        <div className="intake-privacy"><strong>Controlled processing</strong><p>Archive records and crops are saved in this browser. Source images are processed only for extraction.</p></div>
        <button type="button" className="intake-back" onClick={onCancel}>Cancel this intake</button>
      </aside>

      <form className="intake-form" onSubmit={submit} noValidate>
        <section className="intake-source">
          <div className="intake-section-head"><div><h2>Ordered source batch</h2><p>Extraction follows this exact order. Every crop keeps its source name and source number.</p></div><label className="secondary file-trigger" htmlFor="source-file-input">Add images · {assets.length}/{maxSources}</label></div>
          <div className="batch-overview"><strong>{assets.length} source image{assets.length === 1 ? "" : "s"}</strong><span>{formatSize(totalSize)} total</span><small>Drag in or multi-select more files at any time before running.</small></div>
          {assets.length > 1 && <fieldset className="batch-relationship">
            <legend><strong>How are these images related?</strong><small lang="ar" dir="rtl">ما العلاقة بين صور هذه الدفعة؟</small></legend>
            <div className="batch-relationship-options">{relationshipOptions.map((option) => <label key={option.value} aria-label="Image relationship option" htmlFor={`batch-relationship-${option.value}`} className={(value.batchRelationship ?? "same_register") === option.value ? "selected" : ""}>
              <input id={`batch-relationship-${option.value}`} type="radio" name="batch-relationship" value={option.value} checked={(value.batchRelationship ?? "same_register") === option.value} onChange={() => onRelationshipChange(option.value)} />
              <span><span className="sr-only">Image relationship option: </span><strong>{option.title}</strong><b lang="ar" dir="rtl">{option.arabic}</b><small>{option.description}</small></span>
            </label>)}</div>
            <p>{assignsSourcesIndividually ? <><strong>Assign every image below.</strong> Each extracted artefact will use that image’s inventory and serial sequence.</> : <><strong>This batch uses one inventory and one serial sequence.</strong> Choose the shared storage location below.</>}</p>
          </fieldset>}
          <div className="intake-file-list">{assets.map((asset, index) => <article key={asset.id}>
            <div className="intake-file-order"><small>Source</small><strong>{String(index + 1).padStart(2, "0")}</strong></div>
            <span>{asset.preview ? <img src={asset.preview} alt="" /> : asset.name.split(".").pop()?.toUpperCase()}</span>
            <div><strong>{asset.name}</strong><small>{asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ""}{formatSize(asset.size)}</small></div>
            <div className="intake-file-actions"><button type="button" disabled={index === 0} onClick={() => onMoveAsset(asset.id, -1)}>Earlier</button><button type="button" disabled={index === assets.length - 1} onClick={() => onMoveAsset(asset.id, 1)}>Later</button><button type="button" className="remove" onClick={() => onRemoveAsset(asset.id)}>Remove</button></div>
            {assignsSourcesIndividually && <div className={`source-assignment ${submitted && !sourceAssignments[asset.id]?.inventoryId ? "invalid" : ""}`}>
              <label><span>Governorate <small lang="ar" dir="rtl">المحافظة</small></span><select aria-label={`Governorate for source ${index + 1}`} value={sourceAssignments[asset.id]?.governorate ?? ""} onChange={(event) => onSourceGovernorateChange(asset.id, event.target.value)}><option value="">Choose governorate</option>{governorates.map((governorate) => <option key={normalizeGovernorateName(governorate)} value={governorate}>{governorate}</option>)}</select></label>
              <label><span>Inventory <small lang="ar" dir="rtl">المخزن أو العهدة</small></span><select aria-label={`Inventory for source ${index + 1}`} value={sourceAssignments[asset.id]?.inventoryId ?? ""} disabled={!sourceAssignments[asset.id]?.governorate} onChange={(event) => onSourceInventoryChange(asset.id, event.target.value)}><option value="">Choose inventory</option>{inventoriesInGovernorate(inventories, sourceAssignments[asset.id]?.governorate ?? "").map((entry) => <option key={entry.id} value={entry.id}>{entry.intake.storehouseName} · {entry.intake.archaeologicalArea || "Area not recorded"} · next {entry.serialPrefix}-{String(entry.nextSerial).padStart(4, "0")}</option>)}</select></label>
              {sourceAssignments[asset.id]?.inventoryId && <small>{inventories.find((entry) => entry.id === sourceAssignments[asset.id]?.inventoryId)?.intake.archaeologicalArea || "Area not recorded"} · Permanent inventory ownership</small>}
              {submitted && !sourceAssignments[asset.id]?.inventoryId && <b>Select the inventory that owns this image.</b>}
            </div>}
          </article>)}</div>
          {submitted && conflictingGovernorates && <div className="scan-warning" role="alert"><strong>The selected images use different governorates.</strong><p>Choose “Mixed or not sure”, or assign every source to inventories in the same governorate.</p></div>}
          {lowResolution && <div className="scan-warning" role="status"><strong>One or more sources are small.</strong><p>Extraction still works, but crops from sources below 1200 × 800 pixels may not preserve enough detail for archival reuse.</p></div>}
        </section>

        <section className="intake-fields">
          <div className="intake-section-head"><div><h2>Catalogue identity</h2><p>Required fields are marked. Everything is included in the exported manifest.</p></div></div>
          <div className="intake-field-grid">
            <label className={`intake-field ${submitted && titleMissing ? "invalid" : ""}`}><span>Run title <em>Required</em><small lang="ar" dir="rtl">عنوان الدفعة</small></span><input value={value.title} onChange={(event) => onChange({ title: event.target.value })} aria-invalid={submitted && titleMissing} placeholder="Register page 12" />{submitted && titleMissing && <b>Enter a title for this run.</b>}</label>
            <label className={`intake-field ${submitted && seriesMissing ? "invalid" : ""}`}><span>Register series <em>Required</em><small lang="ar" dir="rtl">سلسلة السجل</small></span><input list="intake-series-options" value={series} onChange={(event) => onSeriesChange(event.target.value)} aria-invalid={submitted && seriesMissing} placeholder={UNFILED} /><datalist id="intake-series-options">{seriesNames.map((name) => <option key={name} value={name} />)}</datalist>{submitted && seriesMissing && <b>Choose a series or use “Unfiled”.</b>}</label>

            {assignsSourcesIndividually ? <>
            <div className="intake-field-group"><h3>Storage assignments</h3><small lang="ar" dir="rtl">توزيع الصور على المخازن</small></div>
            <div className={`source-assignment-summary ${submitted && missingSourceAssignments ? "invalid" : ""}`}><strong>{assets.length - assets.filter((asset) => sourceAssignments[asset.id]?.inventoryId).length ? `${assets.length - assets.filter((asset) => sourceAssignments[asset.id]?.inventoryId).length} image(s) still need an inventory` : "Every image has an inventory"}</strong><small>The source-level choices above replace one shared storage location. Inventory details and counters are copied into the saved manifest.</small>{submitted && missingSourceAssignments && <b>Complete every source assignment before continuing.</b>}</div>
            </> : <>
            <div className="intake-field-group"><h3>Storage location</h3><small lang="ar" dir="rtl">بيانات موقع المخزن</small></div>
            <label className={`intake-field wide ${submitted && governorateMissing ? "invalid" : ""}`}><span>Governorate <em>Required</em><small lang="ar" dir="rtl">اسم المحافظة</small></span><input required list="intake-governorate-options" dir="auto" value={value.governorate} onChange={(event) => onGovernorateChange(event.target.value)} aria-invalid={submitted && governorateMissing} placeholder="Choose or enter a governorate" /><datalist id="intake-governorate-options">{governorates.map((governorate) => <option key={normalizeGovernorateName(governorate)} value={governorate} />)}</datalist>{submitted && governorateMissing && <b>Enter the governorate.</b>}<small>Pick a governorate to show only the inventories stored there.</small></label>
            <label className="intake-field wide"><span>Inventory ownership<small>Permanent storage identity</small></span><select value={selectedInventoryId ?? ""} onChange={(event) => onInventoryChange(event.target.value)} disabled={!value.governorate.trim()}><option value="">{value.governorate.trim() ? `Create another inventory in ${value.governorate.trim()}` : "Choose a governorate first"}</option>{filteredInventories.map((inventory) => <option key={inventory.id} value={inventory.id}>{inventory.intake.storehouseName} · {inventory.intake.archaeologicalArea || "Area not recorded"} · {inventory.serialPrefix}</option>)}</select><small>{selectedInventoryId ? `Linked by permanent ID ${selectedInventoryId}. Its serial counter cannot be shared with another inventory.` : value.governorate.trim() && filteredInventories.length ? `${filteredInventories.length} saved ${filteredInventories.length === 1 ? "inventory" : "inventories"} in this governorate. Choose one, or create another.` : value.governorate.trim() ? "No saved inventories in this governorate yet. Enter the new inventory details below." : "Choose a governorate before selecting an inventory."}</small></label>
            <label className={`intake-field ${submitted && archaeologicalAreaMissing ? "invalid" : ""}`}><span>Archaeological area <em>Required</em><small lang="ar" dir="rtl">اسم المنطقة الأثرية</small></span><input required dir="auto" value={value.archaeologicalArea} onChange={(event) => onChange({ archaeologicalArea: event.target.value })} aria-invalid={submitted && archaeologicalAreaMissing} />{submitted && archaeologicalAreaMissing && <b>Enter the archaeological area.</b>}</label>
            <label className={`intake-field wide ${submitted && storehouseMissing ? "invalid" : ""}`}><span>Storehouse name <em>Required</em><small lang="ar" dir="rtl">اسم المخزن</small></span><input required readOnly={Boolean(selectedInventoryId)} dir="auto" value={value.storehouseName} onChange={(event) => onChange({ storehouseName: event.target.value })} aria-invalid={submitted && storehouseMissing} />{submitted && storehouseMissing && <b>Enter the storehouse that owns this serial sequence.</b>}</label>
            <div className="intake-serial-preview"><span>Next artefact serial</span><strong>{nextSerial}</strong><small>{selectedInventoryId ? "Reserved atomically when the completed run is sealed." : "A permanent inventory ID will be created when the first run is sealed."}</small></div>
            </>}

            <div className="intake-field-group"><h3>Store register</h3><small lang="ar" dir="rtl">بيانات سجل المخزن</small></div>
            <label className="intake-field wide"><span>Store register name<small lang="ar" dir="rtl">اسم سجل المخزن</small></span><input dir="auto" value={value.storeRegisterName} onChange={(event) => onChange({ storeRegisterName: event.target.value })} /></label>
            <label className="intake-field"><span>Store register number<small lang="ar" dir="rtl">رقم سجل المخزن</small></span><input dir="auto" value={value.storeRegisterNumber} onChange={(event) => onChange({ storeRegisterNumber: event.target.value })} inputMode="numeric" /></label>
            <label className="intake-field"><span>Register page number<small lang="ar" dir="rtl">رقم صفحة السجل</small></span><input dir="auto" value={value.registerPageNumber} onChange={(event) => onChange({ registerPageNumber: event.target.value })} inputMode="numeric" /></label>
            <label className="intake-field"><span>Store register type<small lang="ar" dir="rtl">نوع سجل المخزن</small></span><input dir="auto" value={value.storeRegisterType} onChange={(event) => onChange({ storeRegisterType: event.target.value })} /></label>
            <label className="intake-field"><span>Other language<small lang="ar" dir="rtl">لغة أخرى</small></span><input dir="auto" value={value.otherLanguage} onChange={(event) => onChange({ otherLanguage: event.target.value })} /></label>

            <div className="intake-field-group"><h3>Administrative context</h3><small lang="ar" dir="rtl">بيانات إدارية إضافية</small></div>
            <label className="intake-field"><span>Institution or authority<small lang="ar" dir="rtl">الجهة أو المؤسسة</small></span><input value={value.institution} onChange={(event) => onChange({ institution: event.target.value })} /></label>
            <label className="intake-field"><span>Collection or department<small lang="ar" dir="rtl">المجموعة أو الإدارة</small></span><input value={value.collection} onChange={(event) => onChange({ collection: event.target.value })} /></label>
            <label className="intake-field"><span>Document type<small lang="ar" dir="rtl">نوع الوثيقة</small></span><select value={value.documentType} onChange={(event) => onChange({ documentType: event.target.value as IntakeMetadata["documentType"] })}><option value="register">Ruled object register</option><option value="inventory">Inventory sheet</option><option value="photographic">Photographic register</option><option value="other">Other archival document</option></select></label>
            <label className="intake-field"><span>Language on page<small lang="ar" dir="rtl">لغة الوثيقة</small></span><select value={value.language} onChange={(event) => onChange({ language: event.target.value as IntakeMetadata["language"] })}><option value="ar">Arabic</option><option value="ar-en">Arabic and English</option><option value="ar-fr">Arabic and French</option><option value="mixed">Mixed or uncertain</option></select></label>
            <label className="intake-field wide"><span>Archivist’s note<small lang="ar" dir="rtl">ملاحظات أمين الأرشيف</small></span><textarea dir="auto" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} placeholder="Optional context, written in Arabic or English" /></label>
          </div>
        </section>

        <section className="intake-method">
          <div className="intake-section-head"><div><h2>What this batch will produce</h2><p>Handwriting and table processing are intentionally disabled in this version.</p></div></div>
          <div className="extraction-plan"><div><b>1</b><span><strong>Embedded images only</strong><small>Photographs, drawings, seals, maps, and illustrations are located locally.</small></span></div><div><b>2</b><span><strong>Original-pixel crops</strong><small>Each accepted region is cut from its source image without resizing.</small></span></div><div><b>3</b><span><strong>Permanent serialization</strong><small>Inventory serials become filenames and are recorded with coordinates in manifest.json.</small></span></div></div>
        </section>

        <footer className="intake-actions">
          <div><button type="button" className="secondary" onClick={() => { onSaveDefaults(); setDefaultsSaved(true); }}>Save these as defaults</button>{defaultsSaved && <span role="status">Defaults saved locally.</span>}</div>
          <button type="submit" className="primary">Open extraction workspace</button>
        </footer>
      </form>
    </div>
  </div>;
}
