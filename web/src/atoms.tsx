import { useMemo } from "react";

/* ------------------------------------------------------------------ */
/*  Shared atoms — presentational pieces used across dashboard views.  */
/*  Kept component-only so react-refresh stays happy.                  */
/* ------------------------------------------------------------------ */

export function SectionTag({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, margin: "26px 0 10px" }}>
      <span className="eyebrow" style={{ color: "var(--lamp)", display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 5, height: 5, background: "var(--lamp)", transform: "rotate(45deg)", display: "inline-block" }} />
        {children}
      </span>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Contour backdrop — faint ridge lines behind key panels             */
/* ------------------------------------------------------------------ */

export function Contours({ seed = 1, opacity = 0.1 }: { seed?: number; opacity?: number }) {
  const paths = useMemo(() => {
    const out: string[] = [];
    const cx = 50 + seed * 7;
    const cy = 50 + seed * 3;
    for (let r = 0; r < 12; r++) {
      const radius = 8 + r * 7;
      let d = "";
      for (let i = 0; i <= 60; i++) {
        const t = (i / 60) * Math.PI * 2;
        const k = Math.sin(t * (3 + (r % 3)) + seed * 1.3 + r * 0.4);
        const k2 = Math.cos(t * (2 + (seed % 4)) + r * 0.7);
        const rad = radius + k * 1.8 + k2 * 1.3;
        const x = cx + Math.cos(t) * rad;
        const y = cy + Math.sin(t) * rad * 0.7;
        d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
      }
      out.push(d + "Z");
    }
    return out;
  }, [seed]);

  return (
    <svg className="topo-bg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" style={{ opacity }} aria-hidden>
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--edge-bright)" strokeWidth={i % 4 === 0 ? 0.4 : 0.2} />
      ))}
    </svg>
  );
}
