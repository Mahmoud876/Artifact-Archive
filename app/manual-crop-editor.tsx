"use client";

import { PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisItem, Asset, CoordinateSpace } from "./types.ts";
import {
  bboxToNormalized, manualCropItem, normalizedBox, normalizedToBbox, type NormalizedBox,
} from "./crop-corrections.ts";

type Handle = "nw" | "ne" | "sw" | "se";
type DragState = {
  kind: "draw" | "move" | "resize";
  index: number | null;
  handle?: Handle;
  start: [number, number];
  origin: NormalizedBox;
};

type Props = {
  assets: Asset[];
  items: AnalysisItem[];
  coordinateSpace: CoordinateSpace;
  initialSourceIndex: number;
  dirty: boolean;
  saving: boolean;
  onItemsChange: (items: AnalysisItem[]) => void;
  onSave: () => Promise<boolean>;
  onClose: () => void;
};

const minimumBoxSize = 8;
const clamp = (value: number, minimum = 0, maximum = 1000) => Math.max(minimum, Math.min(maximum, value));

function pointInOverlay(event: PointerEvent, element: HTMLElement): [number, number] {
  const bounds = element.getBoundingClientRect();
  return [
    clamp((event.clientX - bounds.left) / Math.max(1, bounds.width) * 1000),
    clamp((event.clientY - bounds.top) / Math.max(1, bounds.height) * 1000),
  ];
}

function moveBox(origin: NormalizedBox, dx: number, dy: number): NormalizedBox {
  const width = origin[2] - origin[0];
  const height = origin[3] - origin[1];
  const x1 = clamp(origin[0] + dx, 0, 1000 - width);
  const y1 = clamp(origin[1] + dy, 0, 1000 - height);
  return [x1, y1, x1 + width, y1 + height];
}

function resizeBox(origin: NormalizedBox, handle: Handle, x: number, y: number): NormalizedBox {
  let [x1, y1, x2, y2] = origin;
  if (handle.includes("w")) x1 = clamp(x, 0, x2 - minimumBoxSize);
  if (handle.includes("e")) x2 = clamp(x, x1 + minimumBoxSize, 1000);
  if (handle.includes("n")) y1 = clamp(y, 0, y2 - minimumBoxSize);
  if (handle.includes("s")) y2 = clamp(y, y1 + minimumBoxSize, 1000);
  return [x1, y1, x2, y2];
}

function boxStyle(box: NormalizedBox) {
  return {
    left: `${box[0] / 10}%`,
    top: `${box[1] / 10}%`,
    width: `${(box[2] - box[0]) / 10}%`,
    height: `${(box[3] - box[1]) / 10}%`,
  };
}

export default function ManualCropEditor({
  assets, items, coordinateSpace, initialSourceIndex, dirty, saving, onItemsChange, onSave, onClose,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [sourceIndex, setSourceIndex] = useState(() => Math.max(0, Math.min(assets.length - 1, initialSourceIndex)));
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draft, setDraft] = useState<NormalizedBox | null>(null);
  const asset = assets[sourceIndex];
  const sourceItems = useMemo(() => items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.source_index ?? 0) === sourceIndex && item.bbox?.length === 4), [items, sourceIndex]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  const selectSource = (nextSourceIndex: number) => {
    setSourceIndex(nextSourceIndex);
    setActiveIndex(null);
    setDrawing(false);
    setDrag(null);
    setDraft(null);
  };

  const capture = (event: PointerEvent, state: DragState) => {
    event.preventDefault();
    event.stopPropagation();
    overlayRef.current?.setPointerCapture(event.pointerId);
    setDrag(state);
    setDraft(state.origin);
  };

  const beginOverlay = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawing || !overlayRef.current || event.button !== 0 || event.target !== event.currentTarget) return;
    const point = pointInOverlay(event, overlayRef.current);
    setActiveIndex(null);
    capture(event, { kind: "draw", index: null, start: point, origin: [point[0], point[1], point[0], point[1]] });
  };

  const beginItem = (event: PointerEvent<HTMLButtonElement>, index: number, box: NormalizedBox) => {
    if (drawing || !overlayRef.current || event.button !== 0) return;
    const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined;
    setActiveIndex(index);
    capture(event, {
      kind: handle ? "resize" : "move",
      index,
      handle,
      start: pointInOverlay(event, overlayRef.current),
      origin: box,
    });
  };

  const continueDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || !overlayRef.current) return;
    const point = pointInOverlay(event, overlayRef.current);
    if (drag.kind === "draw") {
      setDraft(normalizedBox([drag.start[0], drag.start[1], point[0], point[1]]));
    } else if (drag.kind === "move") {
      setDraft(moveBox(drag.origin, point[0] - drag.start[0], point[1] - drag.start[1]));
    } else if (drag.handle) {
      setDraft(resizeBox(drag.origin, drag.handle, point[0], point[1]));
    }
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (overlayRef.current?.hasPointerCapture(event.pointerId)) overlayRef.current.releasePointerCapture(event.pointerId);
    if (draft && draft[2] - draft[0] >= minimumBoxSize && draft[3] - draft[1] >= minimumBoxSize) {
      const bbox = normalizedToBbox(draft, asset, coordinateSpace);
      if (drag.kind === "draw") {
        const next = [...items, manualCropItem(bbox, sourceIndex)];
        onItemsChange(next);
        setActiveIndex(next.length - 1);
        setDrawing(false);
      } else if (drag.index !== null) {
        onItemsChange(items.map((item, index) => index === drag.index ? { ...item, bbox } : item));
      }
    }
    setDrag(null);
    setDraft(null);
  };

  const removeActive = () => {
    if (activeIndex === null) return;
    onItemsChange(items.filter((_, index) => index !== activeIndex));
    setActiveIndex(null);
  };

  const saveAndClose = async () => {
    if (await onSave()) onClose();
  };

  return <div className="manual-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-crop-title">
    <button type="button" className="manual-crop-scrim" aria-label="إغلاق تصحيح القصاصات" onClick={onClose} />
    <section className="manual-crop-panel">
      <header className="manual-crop-head">
        <div>
          <span>مراجعة بشرية</span>
          <h2 id="manual-crop-title">تصحيح القصاصات يدوياً</h2>
          <p>اسحب الإطار لتحريكه، واسحب الزوايا لتغيير حجمه، أو ارسم إطاراً جديداً حول صورة مفقودة.</p>
        </div>
        <button type="button" className="manual-crop-close" onClick={onClose} disabled={saving} aria-label="إغلاق">×</button>
      </header>

      <nav className="manual-crop-sources" aria-label="صور المصدر">
        {assets.map((source, index) => <button key={source.id} type="button" className={index === sourceIndex ? "active" : ""} onClick={() => selectSource(index)}>
          <b>{index + 1}</b><span>{source.name}</span><small>{items.filter((item) => (item.source_index ?? 0) === index).length} قصاصة</small>
        </button>)}
      </nav>

      <div className="manual-crop-toolbar">
        <button type="button" className={drawing ? "active" : ""} aria-pressed={drawing} onClick={() => { setDrawing((current) => !current); setActiveIndex(null); }}>
          + رسم قصاصة مفقودة
        </button>
        <button type="button" className="danger" onClick={removeActive} disabled={activeIndex === null}>حذف الإطار المحدد</button>
        <span>{drawing ? "اسحب فوق الصورة لرسم حدود القصاصة." : activeIndex === null ? "اختر إطاراً لتعديله." : "اسحب الإطار أو إحدى زواياه."}</span>
      </div>

      <div className="manual-crop-workspace">
        {asset?.preview ? <div className="manual-crop-canvas">
          <img src={asset.preview} alt={`المصدر ${sourceIndex + 1}: ${asset.name}`} draggable={false} />
          <div
            ref={overlayRef}
            className={`manual-crop-overlay ${drawing ? "drawing" : ""}`}
            onPointerDown={beginOverlay}
            onPointerMove={continueDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            {sourceItems.map(({ item, index }, position) => {
              const original = bboxToNormalized(item.bbox ?? [], asset, coordinateSpace);
              const box = drag?.index === index && draft ? draft : original;
              if (!box) return null;
              return <button
                key={item.id ?? `${sourceIndex}-${index}`}
                type="button"
                className={`manual-crop-box ${activeIndex === index ? "active" : ""}`}
                style={boxStyle(box)}
                onPointerDown={(event) => beginItem(event, index, box)}
                aria-label={`القصاصة ${position + 1}`}
              >
                <strong>{position + 1}</strong>
                {(["nw", "ne", "sw", "se"] as Handle[]).map((handle) => <i key={handle} data-handle={handle} className={`handle ${handle}`} />)}
              </button>;
            })}
            {drag?.kind === "draw" && draft && <div className="manual-crop-box draft" style={boxStyle(draft)} />}
          </div>
        </div> : <p className="manual-crop-empty">لا تتوفر معاينة لهذه الصورة.</p>}
      </div>

      <footer className="manual-crop-footer">
        <div><strong>{items.length} قصاصة في الدفعة</strong><small>{dirty ? "توجد تعديلات لم تُحفظ بعد." : "كل التصحيحات محفوظة."}</small></div>
        <button type="button" className="secondary" onClick={onClose} disabled={saving}>إغلاق</button>
        <button type="button" className="primary" onClick={() => void saveAndClose()} disabled={!dirty || saving}>{saving ? "جارٍ حفظ التصحيحات…" : "حفظ التصحيحات"}</button>
      </footer>
    </section>
  </div>;
}
