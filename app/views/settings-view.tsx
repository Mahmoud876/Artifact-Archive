"use client";

import { useState } from "react";
import { CropFormat, RunOptions, SystemStatus, formatSize } from "../types";

type Props = {
  status: SystemStatus | null;
  statusLoading: boolean;
  statusError: string;
  onRefresh: () => void;
  options: RunOptions;
  onOptionsChange: (patch: Partial<RunOptions>) => void;
  onResetOptions: () => void;
  runCount: number;
  archiveBytes: number;
  onClearArchive: () => void;
  clearMessage: string;
};

function Slider({ label, hint, value, min, max, step, display, onChange }: {
  label: string; hint: string; value: number; min: number; max: number; step: number; display: string;
  onChange: (value: number) => void;
}) {
  return <label className="slider-row">
    <span className="slider-label">{label}<b>{display}</b></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <small>{hint}</small>
  </label>;
}

export default function SettingsView(props: Props) {
  const { status, options, onOptionsChange } = props;
  const [confirmClear, setConfirmClear] = useState(false);

  return <div className="chamber">
    <div className="view-head">
      <div><h2>Extraction settings</h2></div>
      <small>Detector, crops, and serialization</small>
    </div>

    <section className="detail-panel">
      <div className="panel-title">
        <div><span className="eyebrow">LOCAL SERVICES</span><h3>Connected instruments</h3></div>
        <button className="secondary" onClick={props.onRefresh} disabled={props.statusLoading}>{props.statusLoading ? "Checking…" : "Re-check"}</button>
      </div>
      {props.statusError && <div className="notice error"><strong>Could not read service status</strong><p>{props.statusError}</p></div>}
      <div className="service-grid extraction-services">
        <div className={`service-card ${status?.detector.ok ? "up" : "down"}`}>
          <header><span className="status-dot" /><strong>Region detector</strong><small>{status?.detector.ok ? status.detector.status ?? "Ready" : "Unreachable"}</small></header>
          <dl>
            <div><dt>Endpoint</dt><dd>{status?.detector.base ?? "—"}</dd></div>
            <div><dt>Model</dt><dd>{status?.detector.model ?? "—"}</dd></div>
            <div><dt>Device</dt><dd>{status?.detector.cuda ?? status?.detector.device ?? "—"}</dd></div>
          </dl>
          {status?.detector.error && <p className="service-error">{status.detector.error}</p>}
        </div>
      </div>
    </section>

    <section className="detail-panel">
      <div className="panel-title">
        <div><span className="eyebrow">DETECTION</span><h3>How hard the detector looks</h3></div>
        <button className="secondary" onClick={props.onResetOptions}>Restore defaults</button>
      </div>
      <div className="control-grid">
        <label className="text-field wide">
          <span>Detector prompt</span>
          <textarea
            rows={2}
            value={options.detectorPrompt}
            placeholder="photograph. illustration. drawing. carved artifact."
            onChange={(event) => onOptionsChange({ detectorPrompt: event.target.value })}
          />
          <small>Open-vocabulary prompt sent to Grounding DINO. Leave empty to use the safe default that excludes page stamps.</small>
        </label>
        <Slider
          label="Box threshold" display={options.boxThreshold.toFixed(2)} value={options.boxThreshold}
          min={0.05} max={0.6} step={0.01} onChange={(value) => onOptionsChange({ boxThreshold: value })}
          hint="Lower finds more regions and more false positives."
        />
        <Slider
          label="Text threshold" display={options.textThreshold.toFixed(2)} value={options.textThreshold}
          min={0.05} max={0.6} step={0.01} onChange={(value) => onOptionsChange({ textThreshold: value })}
          hint="How strongly a region must match the prompt wording."
        />
      </div>
    </section>

    <section className="detail-panel">
      <div className="panel-title"><span className="eyebrow">ARCHIVING</span><h3>How results are sealed</h3></div>
      <div className="control-grid">
        <Slider
          label="Minimum confidence" display={`${Math.round(options.minConfidence * 100)}%`} value={options.minConfidence}
          min={0} max={0.9} step={0.05} onChange={(value) => onOptionsChange({ minConfidence: value })}
          hint="Detections below this score are discarded before the run is saved."
        />
        <Slider
          label="Crop padding" display={`${options.cropPadding}%`} value={options.cropPadding}
          min={0} max={25} step={1} onChange={(value) => onOptionsChange({ cropPadding: value })}
          hint="Breathing room kept around each extracted region."
        />
        <label className="select-field">
          <span>Image format</span>
          <select value={options.cropFormat} onChange={(event) => onOptionsChange({ cropFormat: event.target.value as CropFormat })}>
            <option value="png">PNG · lossless</option>
            <option value="jpeg">JPEG · smaller</option>
            <option value="webp">WebP · smallest</option>
          </select>
          <small>PNG preserves archival fidelity; the others save disk space.</small>
        </label>
        <div className="toggle-stack">
          <label><input type="checkbox" checked={options.saveCrops} onChange={(event) => onOptionsChange({ saveCrops: event.target.checked })} /> Cut and save image crops</label>
          <label><input type="checkbox" checked={options.recordCoordinates} onChange={(event) => onOptionsChange({ recordCoordinates: event.target.checked })} /> Record source coordinates in the manifest</label>
          <label><input type="checkbox" checked={options.flagUncertain} onChange={(event) => onOptionsChange({ flagUncertain: event.target.checked })} /> Flag records under 40% confidence</label>
        </div>
      </div>
    </section>

    <section className="detail-panel danger-zone">
      <div className="panel-title"><span className="eyebrow">LOCAL STORAGE</span><h3>The archive on this machine</h3></div>
      <p className="hollow">{props.runCount} collection{props.runCount === 1 ? "" : "s"} holding {formatSize(props.archiveBytes)} of extracted images, stored in this browser&apos;s IndexedDB.</p>
      {props.clearMessage && <p className="export-message">{props.clearMessage}</p>}
      <button
        className={`danger-button ${confirmClear ? "armed" : ""}`}
        disabled={!props.runCount}
        onClick={() => { if (confirmClear) { props.onClearArchive(); setConfirmClear(false); } else setConfirmClear(true); }}
      >{confirmClear ? "Confirm — erase every collection" : "Erase the whole archive"}</button>
    </section>
  </div>;
}
