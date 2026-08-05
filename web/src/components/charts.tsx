/** Lightweight SVG charts — no chart dependency, deterministic for tests. */

export interface RadarPoint {
  label: string;
  value: number; // 0-100
}

/** Pentagon radar chart for the five scoring dimensions (spec §5.4). */
export function RadarChart({ points, size = 220 }: { points: RadarPoint[]; size?: number }) {
  const center = size / 2;
  const radius = size / 2 - 32;
  const n = points.length;
  const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const coords = (i: number, value: number) => {
    const r = (radius * value) / 100;
    return [center + r * Math.cos(angleFor(i)), center + r * Math.sin(angleFor(i))];
  };

  const grid = [25, 50, 75, 100].map((v) => points.map((_, i) => coords(i, v).join(",")).join(" "));
  const polygon = points.map((p, i) => coords(i, p.value).join(",")).join(" ");
  const labels = points.map((p, i) => {
    const [x, y] = coords(i, 112);
    return (
      <text key={p.label} x={x} y={y} textAnchor="middle" fontSize="9" fill="#71717a">
        {p.label}
      </text>
    );
  });

  return (
    <svg width={size} height={size} role="img" aria-label="score radar">
      {grid.map((points, i) => (
        <polygon key={i} points={points} fill="none" stroke="#e4e4e7" />
      ))}
      <polygon points={polygon} fill="rgba(16,185,129,0.25)" stroke="#10b981" strokeWidth="2" />
      {points.map((_, i) => {
        const [x, y] = coords(i, points[i]?.value ?? 0);
        return <circle key={i} cx={x} cy={y} r="3" fill="#10b981" />;
      })}
      {labels}
    </svg>
  );
}

/** Simple line chart for score-over-time (spec §5.4 progress trend). */
export function TrendChart({
  points,
  width = 560,
  height = 160,
}: {
  points: Array<{ label: string; value: number }>;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <p className="text-sm text-zinc-400">Not enough data yet — keep scoring prompts!</p>;
  }
  const pad = 24;
  const max = 100;
  const stepX = (width - pad * 2) / (points.length - 1);
  const yFor = (v: number) => pad + ((max - v) / max) * (height - pad * 2);
  const line = points.map((p, i) => `${pad + i * stepX},${yFor(p.value)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;

  return (
    <svg width={width} height={height} role="img" aria-label="score trend">
      <polygon points={area} fill="rgba(16,185,129,0.12)" />
      <polyline points={line} fill="none" stroke="#10b981" strokeWidth="2.5" />
      {points.map((p, i) => (
        <text
          key={i}
          x={pad + i * stepX}
          y={yFor(p.value) - 8}
          textAnchor="middle"
          fontSize="9"
          fill="#71717a"
        >
          {p.value}
        </text>
      ))}
      {points.map((p, i) => (
        <text
          key={`l${i}`}
          x={pad + i * stepX}
          y={height - 6}
          textAnchor="middle"
          fontSize="9"
          fill="#a1a1aa"
        >
          {p.label}
        </text>
      ))}
    </svg>
  );
}

/** Horizontal bar list, e.g. common weaknesses (spec §5.5). */
export function BarList({ rows }: { rows: Array<{ label: string; count: number; pct?: number }> }) {
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 truncate text-zinc-600">{r.label}</span>
          <div className="h-4 flex-1 rounded bg-zinc-100">
            <div
              className="h-4 rounded bg-emerald-500"
              style={{ width: `${Math.round((r.count / maxCount) * 100)}%` }}
            />
          </div>
          <span className="w-16 text-right text-xs text-zinc-400">
            {r.pct ? `${r.pct}%` : r.count}
          </span>
        </li>
      ))}
    </ul>
  );
}
