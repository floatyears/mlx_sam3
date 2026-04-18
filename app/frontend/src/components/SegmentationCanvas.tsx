"use client";

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type { SegmentationResult, RLEMask } from "@/lib/api";

export type InteractionMode = "box" | "point";

interface Props {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  result: SegmentationResult | null;
  boxMode: "positive" | "negative";
  interactionMode: InteractionMode;
  onBoxDrawn: (box: number[]) => void;
  onPointClicked: (point: number[], label: boolean) => void;
  isLoading: boolean;
}

// Color palette for masks
const COLORS = [
  [59, 235, 161], // Emerald
  [96, 165, 250], // Blue
  [251, 191, 36], // Amber
  [248, 113, 113], // Red
  [167, 139, 250], // Violet
  [52, 211, 153], // Green
  [251, 146, 60], // Orange
  [147, 197, 253], // Light Blue
];

// --- UI Configuration Constants ---
export const UI_CONFIG = {
  PREVIEW_WIDTH: 180,           // Base width for calculating preview thumbnail scaling/size
  PREVIEW_TOP_MARGIN: 10,       // Top visual margin (px) inside the mask preview card
  HOVER_DELAY_MS: 80,           // Delay before showing overlap popup when hovering
};

/**
 * Decode RLE mask to ImageData for canvas rendering.
 * Returns an ImageData object with the mask color applied.
 */
function decodeRLEToImageData(rle: RLEMask, color: number[]): ImageData | null {
  const [height, width] = rle.size;
  if (height === 0 || width === 0) return null;

  const imageData = new ImageData(width, height);
  const data = imageData.data;
  const { counts } = rle;

  let pixelIdx = 0;
  let isForeground = false; // RLE starts with background count

  for (const count of counts) {
    if (isForeground) {
      // Fill foreground pixels with color
      for (let j = 0; j < count && pixelIdx < width * height; j++) {
        const idx = pixelIdx * 4;
        data[idx] = color[0];
        data[idx + 1] = color[1];
        data[idx + 2] = color[2];
        data[idx + 3] = 255; // Opaque
        pixelIdx++;
      }
    } else {
      // Skip background pixels (already transparent)
      pixelIdx += count;
    }
    isForeground = !isForeground;
  }

  return imageData;
}

/**
 * Decode RLE mask to a boolean array for hit-testing.
 * Returns a flat Uint8Array where 1 = foreground, 0 = background.
 */
function decodeRLEToBooleanArray(rle: RLEMask): Uint8Array | null {
  const [height, width] = rle.size;
  if (height === 0 || width === 0) return null;

  const arr = new Uint8Array(width * height);
  const { counts } = rle;

  let pixelIdx = 0;
  let isForeground = false;

  for (const count of counts) {
    if (isForeground) {
      for (let j = 0; j < count && pixelIdx < width * height; j++) {
        arr[pixelIdx] = 1;
        pixelIdx++;
      }
    } else {
      pixelIdx += count;
    }
    isForeground = !isForeground;
  }

  return arr;
}



export function SegmentationCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  result,
  boxMode,
  interactionMode,
  onBoxDrawn,
  onPointClicked,
  isLoading,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(
    null
  );
  const [currentPoint, setCurrentPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [displayScale, setDisplayScale] = useState(1);

  // Hover state for mask overlap popup
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [overlappingMaskIndices, setOverlappingMaskIndices] = useState<number[]>([]);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const popupRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Precompute decoded mask boolean arrays for hit-testing
  const maskBooleans = useMemo(() => {
    if (!result?.masks) return [];
    return result.masks.map((mask) => {
      if (mask && mask.counts && mask.size) {
        return decodeRLEToBooleanArray(mask);
      }
      return null;
    });
  }, [result?.masks]);

  // Calculate display scale to fit image in container
  useEffect(() => {
    if (!containerRef.current || !imageWidth || !imageHeight) return;

    const containerWidth = containerRef.current.clientWidth;
    const maxHeight = window.innerHeight * 0.7;

    const scaleX = containerWidth / imageWidth;
    const scaleY = maxHeight / imageHeight;
    const scale = Math.min(scaleX, scaleY, 1);

    setDisplayScale(scale);
  }, [imageWidth, imageHeight]);

  // Load and draw image
  useEffect(() => {
    if (!imageUrl || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      drawCanvas();
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Redraw when result changes
  const drawCanvas = useCallback(() => {
    if (!canvasRef.current || !imageRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Use integer dimensions for canvas
    const displayWidth = Math.floor(imageWidth * displayScale);
    const displayHeight = Math.floor(imageHeight * displayScale);

    canvas.width = displayWidth;
    canvas.height = displayHeight;

    // Clear canvas
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    // Draw image
    ctx.drawImage(imageRef.current, 0, 0, displayWidth, displayHeight);

    // Draw masks with semi-transparency using RLE decoding + canvas compositing
    if (result?.masks && result.masks.length > 0) {
      for (let i = 0; i < result.masks.length; i++) {
        const mask = result.masks[i];
        const box = result.boxes?.[i];
        const score = result.scores?.[i] ?? 0;
        const color = COLORS[i % COLORS.length];

        // Decode RLE mask and draw
        if (mask && mask.counts && mask.size) {
          const maskImageData = decodeRLEToImageData(mask, color);
          if (!maskImageData) continue;

          const [maskH, maskW] = mask.size;

          // Create offscreen canvas at mask resolution
          const offscreen = document.createElement("canvas");
          offscreen.width = maskW;
          offscreen.height = maskH;
          const offCtx = offscreen.getContext("2d");
          if (!offCtx) continue;

          // Put decoded mask to offscreen canvas
          offCtx.putImageData(maskImageData, 0, 0);

          // Composite onto main canvas with transparency (GPU-accelerated scaling & blending)
          ctx.globalAlpha = 0.5;
          ctx.drawImage(offscreen, 0, 0, displayWidth, displayHeight);
          ctx.globalAlpha = 1.0;
        }

        // Draw bounding box
        if (box) {
          const [x0, y0, x1, y1] = box;
          ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(
            x0 * displayScale,
            y0 * displayScale,
            (x1 - x0) * displayScale,
            (y1 - y0) * displayScale
          );

          // Draw score label
          ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
          ctx.fillRect(x0 * displayScale, y0 * displayScale - 24, 50, 20);
          ctx.fillStyle = "#000";
          ctx.font = "bold 12px JetBrains Mono, monospace";
          ctx.fillText(
            `${(score * 100).toFixed(0)}%`,
            x0 * displayScale + 4,
            y0 * displayScale - 8
          );
        }
      }
    }

    // Draw prompted boxes
    if (result?.prompted_boxes) {
      for (const promptedBox of result.prompted_boxes) {
        const [x0, y0, x1, y1] = promptedBox.box;
        ctx.strokeStyle = promptedBox.label ? "#3beba1" : "#f87171";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(
          x0 * displayScale,
          y0 * displayScale,
          (x1 - x0) * displayScale,
          (y1 - y0) * displayScale
        );
        ctx.setLineDash([]);
      }
    }

    // Draw prompted points
    if (result?.prompted_points) {
      for (const promptedPoint of result.prompted_points) {
        const [px, py] = promptedPoint.point;
        const cx = px * displayScale;
        const cy = py * displayScale;
        const isPositive = promptedPoint.label;
        const pointColor = isPositive ? "#3beba1" : "#f87171";

        // Outer circle with glow
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fillStyle = pointColor;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // Inner filled circle
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = pointColor;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Draw + or - symbol
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(isPositive ? "+" : "−", cx, cy);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
    }

    // Draw current drawing box
    if (isDrawing && startPoint && currentPoint && interactionMode === "box") {
      const x = Math.min(startPoint.x, currentPoint.x);
      const y = Math.min(startPoint.y, currentPoint.y);
      const width = Math.abs(currentPoint.x - startPoint.x);
      const height = Math.abs(currentPoint.y - startPoint.y);

      ctx.strokeStyle = boxMode === "positive" ? "#3beba1" : "#f87171";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(x, y, width, height);
      ctx.setLineDash([]);
    }
  }, [
    imageWidth,
    imageHeight,
    displayScale,
    result,
    isDrawing,
    startPoint,
    currentPoint,
    boxMode,
    interactionMode,
  ]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  const getCanvasCoordinates = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  // Check which masks overlap at a given image coordinate
  const getMasksAtPixel = useCallback(
    (imgX: number, imgY: number): number[] => {
      if (!result?.masks || maskBooleans.length === 0) return [];

      const indices: number[] = [];
      for (let i = 0; i < result.masks.length; i++) {
        const boolArr = maskBooleans[i];
        const mask: RLEMask = result.masks[i];
        if (!boolArr || !mask) continue;

        const maskH = mask.size[0];
        const maskW = mask.size[1];
        // Convert image coordinates to mask pixel coordinates
        const mx = Math.floor((imgX / imageWidth) * maskW);
        const my = Math.floor((imgY / imageHeight) * maskH);

        if (mx >= 0 && mx < maskW && my >= 0 && my < maskH) {
          const pixelIndex = my * maskW + mx;
          if (boolArr[pixelIndex] === 1) {
            indices.push(i);
          }
        }
      }
      return indices;
    },
    [result?.masks, maskBooleans, imageWidth, imageHeight]
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isLoading) return;
    const coords = getCanvasCoordinates(e);
    if (!coords) return;

    if (interactionMode === "box") {
      setIsDrawing(true);
      setStartPoint(coords);
      setCurrentPoint(coords);
    }
    // For point mode, we handle on mouseUp to avoid accidental triggers
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoordinates(e);
    if (!coords) return;

    // Handle box drawing
    if (isDrawing && interactionMode === "box") {
      setCurrentPoint(coords);
    }

    // Handle hover detection for mask overlap popup
    if (!isDrawing && result?.masks && result.masks.length > 0) {
      // Convert display coords to image coords
      const imgX = coords.x / displayScale;
      const imgY = coords.y / displayScale;

      // Debounce the hover check
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }

      hoverTimeoutRef.current = setTimeout(() => {
        const overlapping = getMasksAtPixel(imgX, imgY);
        if (overlapping.length > 0) {
          setOverlappingMaskIndices(overlapping);
          // Position popup at the right side of the canvas
          const canvas = canvasRef.current;
          if (canvas) {
            setPopupPos({
              x: canvas.width + 12,
              y: Math.max(0, coords.y - 40),
            });
          }
        } else {
          setOverlappingMaskIndices([]);
        }
      }, UI_CONFIG.HOVER_DELAY_MS);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isLoading) return;

    const coords = getCanvasCoordinates(e);
    if (!coords) {
      setIsDrawing(false);
      return;
    }

    if (interactionMode === "point") {
      // Point mode: single click sends a point prompt
      const imgX = coords.x / displayScale;
      const imgY = coords.y / displayScale;

      // Normalize to [0, 1]
      const normX = imgX / imageWidth;
      const normY = imgY / imageHeight;

      // Clamp to valid range
      const clampedX = Math.max(0, Math.min(1, normX));
      const clampedY = Math.max(0, Math.min(1, normY));

      onPointClicked([clampedX, clampedY], boxMode === "positive");
    } else if (interactionMode === "box") {
      if (!isDrawing || !startPoint) {
        setIsDrawing(false);
        return;
      }

      // Calculate box in original image coordinates
      const x0 = Math.min(startPoint.x, coords.x) / displayScale;
      const y0 = Math.min(startPoint.y, coords.y) / displayScale;
      const x1 = Math.max(startPoint.x, coords.x) / displayScale;
      const y1 = Math.max(startPoint.y, coords.y) / displayScale;

      // Minimum box size check
      if (Math.abs(x1 - x0) < 10 || Math.abs(y1 - y0) < 10) {
        setIsDrawing(false);
        setStartPoint(null);
        setCurrentPoint(null);
        return;
      }

      // Convert to normalized center x, center y, width, height format
      const centerX = (x0 + x1) / 2 / imageWidth;
      const centerY = (y0 + y1) / 2 / imageHeight;
      const width = (x1 - x0) / imageWidth;
      const height = (y1 - y0) / imageHeight;

      onBoxDrawn([centerX, centerY, width, height]);
    }

    setIsDrawing(false);
    setStartPoint(null);
    setCurrentPoint(null);
  };

  const handleMouseLeave = () => {
    if (isDrawing) {
      setIsDrawing(false);
      setStartPoint(null);
      setCurrentPoint(null);
    }
    // Clear hover state
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setOverlappingMaskIndices([]);
  };

  // Generate preview canvases for overlapping masks
  const maskPreviews = useMemo(() => {
    if (overlappingMaskIndices.length === 0 || !result?.masks || !imageRef.current) {
      return [];
    }

    const globalScale = UI_CONFIG.PREVIEW_WIDTH / imageWidth;

    return overlappingMaskIndices.map((maskIdx) => {
      const mask = result.masks![maskIdx];
      const color = COLORS[maskIdx % COLORS.length];
      const score = result.scores?.[maskIdx] ?? 0;

      // 1. Calculate the exact tight bounding box from RLE counts
      const maskW = mask.size[1];
      const maskH = mask.size[0];
      
      let minX = maskW, minY = maskH, maxX = 0, maxY = 0;
      let pixelIdx = 0;
      let isForeground = false;
      
      for (const count of mask.counts) {
        if (isForeground && count > 0) {
          const startIdx = pixelIdx;
          const endIdx = pixelIdx + count - 1;
          
          const startY = Math.floor(startIdx / maskW);
          const endY = Math.floor(endIdx / maskW);
          
          if (startY < minY) minY = startY;
          if (endY > maxY) maxY = endY;
          
          if (startY === endY) {
            const startX = startIdx % maskW;
            const endX = endIdx % maskW;
            if (startX < minX) minX = startX;
            if (endX > maxX) maxX = endX;
          } else {
            minX = 0;
            maxX = maskW - 1;
          }
        }
        pixelIdx += count;
        isForeground = !isForeground;
      }
      
      let sx = 0, sy = 0, sw = maskW, sh = maskH;
      if (minX <= maxX && minY <= maxY) {
        sx = minX;
        sy = minY;
        sw = maxX - minX + 1;
        sh = maxY - minY + 1;
      }

      // 2. Determine canvas size based on global image scale
      // This ensures all thumbnails share the same scaling proportion as the original image
      const dw = Math.max(1, Math.round(sw * globalScale));
      const dh = Math.max(1, Math.round(sh * globalScale));

      // Create preview canvas
      const canvas = document.createElement("canvas");
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext("2d")!;

      const maskImageData = decodeRLEToImageData(mask, color);
      if (maskImageData) {
        const offscreen = document.createElement("canvas");
        offscreen.width = maskW;
        offscreen.height = maskH;
        const offCtx = offscreen.getContext("2d")!;
        offCtx.putImageData(maskImageData, 0, 0);

        // 1. Draw the tight mask region to act as the alpha channel shape at 0, 0
        ctx.drawImage(offscreen, sx, sy, sw, sh, 0, 0, dw, dh);

        // 2. Map original image pixels onto that shape
        ctx.globalCompositeOperation = "source-in";
        ctx.drawImage(imageRef.current!, sx, sy, sw, sh, 0, 0, dw, dh);

        // 3. Overlay the mask color slightly to indicate which mask it is
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.35;
        ctx.drawImage(offscreen, sx, sy, sw, sh, 0, 0, dw, dh);
        ctx.globalAlpha = 1.0;
      } else {
        // Fallback
        ctx.drawImage(imageRef.current!, sx, sy, sw, sh, 0, 0, dw, dh);
      }

      return {
        dataUrl: canvas.toDataURL(),
        maskIdx,
        color,
        score,
      };
    });
  }, [overlappingMaskIndices, result, imageWidth, imageHeight]);

  if (!imageUrl) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center h-96 border-2 border-dashed border-border rounded-xl bg-card/50"
      >
        <p className="text-muted-foreground text-sm">
          Upload an image to begin segmentation
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        className={`rounded-lg shadow-xl ${isLoading ? "opacity-50 pointer-events-none" : ""
          }`}
        style={{
          cursor: isLoading
            ? "wait"
            : interactionMode === "point"
              ? "crosshair"
              : "crosshair",
        }}
      />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-3 bg-card/90 backdrop-blur-sm px-4 py-2 rounded-lg border border-border">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Processing...</span>
          </div>
        </div>
      )}

      {/* Overlapping Masks Popup */}
      {maskPreviews.length > 0 && (
        <div
          ref={popupRef}
          className="mask-overlap-popup"
          style={{
            position: "absolute",
            left: `${popupPos.x}px`,
            top: `${popupPos.y}px`,
          }}
          onMouseEnter={() => {
            // Keep popup visible while hovering over it
            if (hoverTimeoutRef.current) {
              clearTimeout(hoverTimeoutRef.current);
            }
          }}
          onMouseLeave={() => {
            setOverlappingMaskIndices([]);
          }}
        >
          <div className="mask-overlap-header">
            <div className="mask-overlap-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="13" height="13" rx="2" />
                <rect x="9" y="9" width="13" height="13" rx="2" />
              </svg>
            </div>
            <span>{maskPreviews.length} {maskPreviews.length === 1 ? "Mask" : "Overlapping Masks"}</span>
          </div>
          <div className="mask-overlap-list">
            {maskPreviews.map((preview) => (
              <div key={preview.maskIdx} className="mask-overlap-item">
                <img
                  src={preview.dataUrl}
                  alt={`Mask ${preview.maskIdx + 1}`}
                  className="mask-overlap-preview"
                  style={{ marginTop: `${UI_CONFIG.PREVIEW_TOP_MARGIN}px` }}
                />
                <div className="mask-overlap-info">
                  <div
                    className="mask-overlap-color-dot"
                    style={{
                      backgroundColor: `rgb(${preview.color[0]}, ${preview.color[1]}, ${preview.color[2]})`,
                    }}
                  />
                  <span className="mask-overlap-label">
                    Mask {preview.maskIdx + 1}
                  </span>
                  <span className="mask-overlap-score">
                    {(preview.score * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
