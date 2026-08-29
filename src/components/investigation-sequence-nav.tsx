import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

export const investigationSequenceSections = [
  {
    id: "conclusion",
    label: "Conclusion",
    description: "Confirmed root cause and confidence"
  },
  {
    id: "triggering-change",
    label: "Triggering change",
    description: "The deployment change that introduced the regression"
  },
  {
    id: "impact-signals",
    label: "Impact signals",
    description: "Cache and origin degradation over the incident window"
  },
  {
    id: "evidence-workspace",
    label: "Evidence",
    description: "Claims and their underlying source receipts"
  },
  {
    id: "ruled-out-record",
    label: "Ruled out & record",
    description: "Rejected hypotheses and the full investigation path"
  }
] as const;

export type InvestigationSequenceSectionId =
  (typeof investigationSequenceSections)[number]["id"];

const markerScales = [1, 0.78, 0.55, 0.34, 0.2] as const;
const markerColors = [
  "#5f5f66",
  "#8d8d94",
  "#aaaab0",
  "#bebec3",
  "#ceced2"
] as const;

export function InvestigationSequenceNav({
  activeSectionId,
  onSelect
}: {
  activeSectionId: InvestigationSequenceSectionId;
  onSelect: (sectionId: InvestigationSequenceSectionId) => void;
}) {
  const activeIndex = investigationSequenceSections.findIndex(
    (section) => section.id === activeSectionId
  );
  const [previewIndex, setPreviewIndex] = useState(Math.max(activeIndex, 0));
  const [isPreviewVisible, setIsPreviewVisible] = useState(false);
  const previewCloseTimer = useRef<number | undefined>(undefined);
  const focusIndex = isPreviewVisible ? previewIndex : Math.max(activeIndex, 0);
  const previewSection = investigationSequenceSections[previewIndex];

  useEffect(
    () => () => {
      if (previewCloseTimer.current !== undefined) {
        window.clearTimeout(previewCloseTimer.current);
      }
    },
    []
  );

  function showPreview(index: number) {
    if (previewCloseTimer.current !== undefined) {
      window.clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = undefined;
    }
    setPreviewIndex(index);
    setIsPreviewVisible(true);
  }

  function schedulePreviewClose() {
    if (previewCloseTimer.current !== undefined) {
      window.clearTimeout(previewCloseTimer.current);
    }
    previewCloseTimer.current = window.setTimeout(() => {
      setIsPreviewVisible(false);
      previewCloseTimer.current = undefined;
    }, 100);
  }

  return (
    <aside
      className="relative hidden @2xl/main:block"
      aria-label="Investigation sections"
    >
      <nav
        className="sticky top-[84px] z-40"
        aria-label="Investigation sequence"
      >
        <ol className="flex w-full list-none flex-col py-2">
          {investigationSequenceSections.map((section, index) => {
            const isActive = section.id === activeSectionId;
            const distance = Math.min(
              Math.abs(index - focusIndex),
              markerScales.length - 1
            );

            return (
              <li className="relative h-2" key={section.id}>
                <a
                  className="relative flex h-2 w-8 items-center pl-2 outline-none"
                  href={`#${section.id}`}
                  aria-current={isActive ? "location" : undefined}
                  aria-label={`${section.label}: ${section.description}`}
                  onBlur={schedulePreviewClose}
                  onFocus={() => showPreview(index)}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(section.id);
                  }}
                  onPointerEnter={() => showPreview(index)}
                  onPointerLeave={schedulePreviewClose}
                >
                  <span
                    className="h-px w-5 origin-left transition-[transform,background-color] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
                    style={{
                      backgroundColor: markerColors[distance],
                      transform: `scaleX(${markerScales[distance]})`
                    }}
                    aria-hidden="true"
                  />
                </a>
              </li>
            );
          })}
        </ol>

        <span
          className="pointer-events-none absolute top-0 left-8 z-50 transition-transform duration-150 ease-in-out motion-reduce:transition-none"
          style={{ transform: `translateY(${12 + previewIndex * 8}px)` }}
          aria-hidden="true"
        >
          <span
            className={cn(
              "flex w-[250px] -translate-x-1 -translate-y-1/2 scale-[0.985] flex-col gap-0.5 rounded-[10px] border border-[#e2e2e5] bg-white px-3 py-2 opacity-0 shadow-[0_7px_20px_rgb(0_0_0_/_8%),0_1px_2px_rgb(0_0_0_/_4%)] transition-[transform,opacity] duration-180 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
              isPreviewVisible && "translate-x-0 scale-100 opacity-100"
            )}
          >
            <strong className="truncate text-xs leading-4 font-medium text-[#34343a]">
              {previewSection.label}
            </strong>
            <span className="truncate text-[11px] leading-4 text-[#8a8a91]">
              {previewSection.description}
            </span>
          </span>
        </span>
      </nav>
    </aside>
  );
}
