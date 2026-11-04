"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import Image from "next/image";
import type { Region } from "@/lib/review-contract";
import { maskTransform, percentBox, textLang, unionBox, type FindingView } from "@/lib/review-view";

export type PosterImage = { file: File; url: string; width: number; height: number };
type Size = { width: number; height: number };

const clampPercent = (value: number) => `${Math.min(96, Math.max(4, value))}%`;

// Regions are drawn in the pixel space SAM 3.1 measured. The overlay's viewBox is that
// space and the frame keeps the image's own aspect ratio, so one transform maps both.
function Overlay({ size, regions, selected }: { size: Size; regions: Region[]; selected: Set<string> }) {
  const active = regions.filter((region) => selected.has(region.id));
  return <svg className="overlay" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
    {active.map((region) => region.mask
      ? <path key={region.id} className="mask" d={region.mask.path} transform={maskTransform(region.mask)} fillRule="evenodd" />
      : <rect key={region.id} className="mask" x={region.box.left} y={region.box.top} width={region.box.right - region.box.left} height={region.box.bottom - region.box.top} rx={6} />)}
  </svg>;
}

export function PosterStage(props: {
  image: PosterImage | null;
  copy: string;
  mode: "setup" | "reviewing" | "result" | "issue" | "compare";
  views: FindingView[];
  selected: number;
  onSelect: (index: number, focus?: boolean) => void;
  segmentationSize: Size | null;
  arrival: boolean;
  frameRef: Ref<HTMLDivElement>;
  dragging: boolean;
  onDragging: (value: boolean) => void;
  onFile: (file: File | undefined) => void;
  onImageError: () => void;
  fileInput: Ref<HTMLInputElement>;
  describedBy: string;
  invalid: boolean;
  layers?: ReactNode;
  hideRegions?: Set<string>;
  scanning?: boolean;
}) {
  const {
    image, copy, mode, views, selected, onSelect, segmentationSize, arrival, frameRef, dragging, onDragging,
    onFile, onImageError, fileInput, describedBy, invalid, layers, hideRegions, scanning,
  } = props;
  const setup = mode === "setup";
  const reticles = useRef<HTMLDivElement>(null);
  const regions = segmentationSize ? views.flatMap((view) => view.location.kind === "found" ? view.location.regions : [])
    .filter((region, index, all) => all.findIndex((other) => other.id === region.id) === index)
    .filter((region) => !hideRegions?.has(region.id)) : [];
  const current = views[selected];
  const focus = current?.location.kind === "found" ? current.location.regions.filter((region) => !hideRegions?.has(region.id)) : [];
  const selectedIds = new Set(focus.map((region) => region.id));
  const showMarks = (mode === "result" || mode === "compare") && regions.length > 0 && segmentationSize;
  // A comparison keeps only the frame around the edited area, so no outline sits on the variant.
  const comparing = mode === "compare";

  // Each new selection settles the frame once. Reduced motion skips the animation.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    reticles.current?.querySelectorAll(".reticle").forEach((element) => {
      element.classList.remove("settle"); void (element as HTMLElement).offsetWidth; element.classList.add("settle");
    });
  }, [selected]);

  const ar = image ? image.width / image.height : 0.8;
  return <div className="frame-wrap" style={{ "--ar": ar } as CSSProperties}
    onDragOver={(event) => { if (!setup) return; event.preventDefault(); onDragging(true); }}
    onDragLeave={() => onDragging(false)}
    onDrop={(event) => { if (!setup) return; event.preventDefault(); onDragging(false); onFile(event.dataTransfer.files[0]); }}>
    <div className="halo" aria-hidden="true" />
    <div className={`frame ${!image && setup ? "empty" : ""}`} ref={frameRef}>
      {image && <Image src={image.url} alt={`Poster under review, ${image.file.name}`} fill unoptimized sizes="60vw" onError={onImageError} />}
      {layers}
      {!image && !setup && <div className="copy-card">
        <span>Ad copy under review</span>
        <p lang={textLang(copy)}>{copy}</p>
      </div>}
      {!image && setup && <label className={`drop ${dragging ? "dragging" : ""}`} htmlFor="poster-file">
        <b>Drop a poster</b>
        <span>or choose an image</span>
        <small>JPEG, PNG or WebP, up to 4 MB</small>
      </label>}
      <input id="poster-file" className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" ref={fileInput}
        tabIndex={image ? -1 : 0} disabled={!setup} aria-label="Poster image" aria-describedby={describedBy} aria-invalid={invalid}
        onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} />
      {showMarks && <>
        {!comparing && <Overlay size={segmentationSize} regions={regions} selected={arrival ? new Set() : selectedIds} />}
        <div ref={reticles} style={{ opacity: arrival ? 0 : 1 }}>
          {focus.length > 0 && !comparing && <div className="spot" style={percentBox(unionBox(focus), segmentationSize)} />}
          {focus.map((region, index) => <div key={`r${index}`} className="reticle" style={percentBox(region.box, segmentationSize)}><i /><i /><i /><i /></div>)}
        </div>
        {!comparing && <div className="markers" role="group" aria-label="Outlined elements">
          {regions.map((region) => {
            const numbers = region.findingIndexes.map((index) => index + 1);
            const ofConcept = regions.filter((other) => other.concept === region.concept);
            const position = ofConcept.findIndex((other) => other.id === region.id) + 1;
            const delay = `${((region.box.top / segmentationSize.height) * 1.1).toFixed(2)}s`;
            return <button key={region.id} type="button" className={`mk ${arrival ? "pop ping" : ""}`}
              style={{ left: clampPercent((region.box.left / segmentationSize.width) * 100 + 1.5), top: clampPercent((region.box.top / segmentationSize.height) * 100 + 1.5), "--d": delay } as CSSProperties}
              aria-current={region.findingIndexes.includes(selected)}
              aria-label={`${region.concept}${ofConcept.length > 1 ? `, area ${position} of ${ofConcept.length}` : ""}, finding ${numbers.join(" and ")}`}
              onClick={() => onSelect(region.findingIndexes.includes(selected) ? selected : region.findingIndexes[0]!, true)}>
              <span aria-hidden="true">{numbers[0]}</span>
            </button>;
          })}
        </div>}
      </>}
      {(mode === "reviewing" || arrival || scanning) && <div className={`scan ${arrival ? "once" : ""}`} aria-hidden="true"><i /></div>}
    </div>
  </div>;
}
